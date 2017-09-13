/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

var gSelectedTabs = {};

/* utilities */

function clearSelection(aWindowId, aState) {
  gSelectedTabs = {};
  browser.runtime.sendMessage(kTST_ID, {
    type:   kTSTAPI_REMOVE_TAB_STATE,
    tabs:   '*',
    window: aWindowId,
    state:  aState || 'selected'
  });
}

function setSelection(aTabs, aSelected, aState) {
  if (!Array.isArray(aTabs))
    aTabs = [aTabs];

  //console.log('setSelection ', ids, `${aState}=${aSelected}`);
  if (aSelected) {
    for (let tab of aTabs) {
      gSelectedTabs[tab.id] = tab;
    }
  }
  else {
    for (let tab of aTabs) {
      delete gSelectedTabs[tab.id];
    }
  }
  browser.runtime.sendMessage(kTST_ID, {
    type:  aSelected ? kTSTAPI_ADD_TAB_STATE : kTSTAPI_REMOVE_TAB_STATE,
    tabs:  aTabs.map(aTab => aTab.id),
    state: aState || 'selected'
  });
}

function retrieveTargetTabs(aSerializedTab) {
  var tabs = [aSerializedTab];
  if (aSerializedTab.children &&
      aSerializedTab.states.indexOf('subtree-collapsed') > -1) {
    for (let tab of aSerializedTab.children) {
      tabs = tabs.concat(retrieveTargetTabs(tab))
    }
  }
  return tabs;
}

function getTabsBetween(aBegin, aEnd, aAllTabs = []) {
  if (aBegin.id == aEnd.id)
    return [];
  var inRange = false;
  return aAllTabs.filter(aTab => {
    if (aTab.id == aBegin.id || aTab.id == aEnd.id) {
      inRange = !inRange;
      return false;
    }
    return inRange;
  });
}

function toggleStateOfDragOverTabs(aParams = {}) {
  if (gFirstHoverTarget) {
    // At first, toggle state to reset all existing items in the undetermined selection.
    for (let id of Object.keys(gUndeterminedRange)) {
      setSelection(gUndeterminedRange[id], !(id in gSelectedTabs), aParams.state);
    }
    gUndeterminedRange = {};

    let newUndeterminedRange = aParams.allTargets;
    if (newUndeterminedRange.every(aTab => aTab.id != gFirstHoverTarget.id))
      newUndeterminedRange.push(gFirstHoverTarget);

    let betweenTabs = getTabsBetween(gFirstHoverTarget, aParams.target, gAllTabsOnDragReady);
    newUndeterminedRange = newUndeterminedRange.concat(betweenTabs);
    for (let tab of newUndeterminedRange) {
      if (tab.id in gUndeterminedRange)
        continue;
      setSelection(tab, !(tab.id in gSelectedTabs), aParams.state);
      gUndeterminedRange[tab.id] = tab;
    }
  }
  else {
    for (let tab of aParams.allTargets) {
      gUndeterminedRange[tab.id] = tab;
    }
    setSelection(aParams.allTargets, !(aParams.target.id in gSelectedTabs), aParams.state);
  }
}


/* select tabs by clicking */

var gInSelectionSession = false;

async function onTSTTabClick(aMessage) {
  if (aMessage.button != 0)
    return false;

  if (!aMessage.ctrlKey && !aMessage.shiftKey) {
    clearSelection(aMessage.window, 'selected');
    clearSelection(aMessage.window, 'ready-to-close');
    gSelectedTabs = {};
    gInSelectionSession = false;
    reserveRefreshContextMenuItems();
    return;
  }

  let activeTab = (await browser.tabs.query({
    active:   true,
    windowId: aMessage.window
  }))[0];

  let tabs = retrieveTargetTabs(aMessage.tab);
  if (aMessage.ctrlKey) {
    // toggle selection of the tab and all collapsed descendants
    if (aMessage.tab.id != activeTab.id &&
        !gInSelectionSession) {
      setSelection(activeTab, true);
    }
    setSelection(tabs, aMessage.tab.states.indexOf('selected') < 0);
    gInSelectionSession = true;
    reserveRefreshContextMenuItems();
    return true;
  }
  else if (aMessage.shiftKey) {
    // select the clicked tab and tabs between last activated tab
    clearSelection(aMessage.window);
    let window = await browser.windows.get(aMessage.window, { populate: true });
    let betweenTabs = getTabsBetween(activeTab, aMessage.tab, window.tabs);
    tabs = tabs.concat(betweenTabs);
    tabs.push(activeTab);
    setSelection(tabs, true);
    gInSelectionSession = true;
    reserveRefreshContextMenuItems();
    return true;
  }
  return false;
}

async function onTSTTabbarClick(aMessage) {
  if (aMessage.button != 0)
    return;
  gSelectedTabs = {};
  clearSelection(aMessage.window, 'selected');
  clearSelection(aMessage.window, 'ready-to-close');
  reserveRefreshContextMenuItems();
}


/* select tabs by dragging */

var gWillCloseSelectedTabs = false;
var gAllTabsOnDragReady = [];
var gPendingTabs = null;
var gDragStartTarget = null;
var gLastHoverTarget = null;
var gFirstHoverTarget = null;
var gUndeterminedRange = {};
var gDragEnteredCount = 0;

async function onTSTTabDragReady(aMessage) {
  //console.log('onTSTTabDragReady', aMessage);
  gUndeterminedRange = {};
  gSelectedTabs = {};
  gDragEnteredCount = 1;
  gWillCloseSelectedTabs = aMessage.startOnClosebox;
  gPendingTabs = null;
  gDragStartTarget = gFirstHoverTarget = gLastHoverTarget = aMessage.tab;
  gAllTabsOnDragReady = await browser.tabs.query({ windowId: aMessage.window });

  clearSelection(aMessage.window, 'selected');
  clearSelection(aMessage.window, 'ready-to-close');

  var startTabs = retrieveTargetTabs(aMessage.tab);
  var state = gWillCloseSelectedTabs ? 'ready-to-close' : 'selected' ;
  setSelection(startTabs, true, state);

  for (let tab of startTabs) {
    gUndeterminedRange[tab.id] = tab;
  }
}

async function onTSTTabDragStart(aMessage) {
  //console.log('onTSTTabDragStart', aMessage);
}

async function onTSTTabDragEnter(aMessage) {
  //console.log('onTSTTabDragEnter', aMessage, aMessage.tab == gLastHoverTarget);
  gDragEnteredCount++;
  // processAutoScroll(aEvent);

  if (gLastHoverTarget &&
      aMessage.tab.id == gLastHoverTarget.id)
    return;

  var state = gWillCloseSelectedTabs ? 'ready-to-close' : 'selected' ;
  if (gPendingTabs) {
    setSelection(gPendingTabs, true, state);
    gPendingTabs = null;
  }
/*
  if (gWillCloseSelectedTabs || tabDragMode == TAB_DRAG_MODE_SELECT) {
*/
    let targetTabs = retrieveTargetTabs(aMessage.tab);
    toggleStateOfDragOverTabs({
      target:     aMessage.tab,
      allTargets: targetTabs,
      state:      state
    });
    if (gWillCloseSelectedTabs &&
        aMessage.tab.id == gDragStartTarget.id &&
        Object.keys(gSelectedTabs).length == targetTabs.length) {
      setSelection(targetTabs, false, state);
      for (let tab of targetTabs) {
        gUndeterminedRange[tab.id] = tab;
      }
      gPendingTabs = targetTabs;
    }
/*
  }
  else { // TAB_DRAG_MODE_SWITCH:
    browser.tabs.update(aMessage.tab.id, { active: true });
  }
*/
  gLastHoverTarget = aMessage.tab;
  if (!gFirstHoverTarget)
    gFirstHoverTarget = gLastHoverTarget;
}

async function onTSTTabDragExit(aMessage) {
  gDragEnteredCount--;
  dragExitAllWithDelay.reserve();
}

function dragExitAllWithDelay() {
  //console.log('dragExitAllWithDelay '+gDragEnteredCount);
  dragExitAllWithDelay.cancel();
  if (gDragEnteredCount <= 0) {
    gFirstHoverTarget = gLastHoverTarget = null;
    gUndeterminedRange = {};
  }
}
dragExitAllWithDelay.reserve = () => {
  dragExitAllWithDelay.cancel();
  dragExitAllWithDelay.timeout = setTimeout(() => {
    dragExitAllWithDelay();
  }, 10);
};
dragExitAllWithDelay.cancel = () => {
  if (dragExitAllWithDelay.timeout) {
    clearTimeout(dragExitAllWithDelay.timeout);
    delete dragExitAllWithDelay.timeout;
  }
};

async function onTSTTabDragEnd(aMessage) {
  //console.log('onTSTTabDragEnd', aMessage);
  gDragStartTarget = gFirstHoverTarget = gLastHoverTarget = null;

  if (gWillCloseSelectedTabs) {
    let allTabs = gAllTabsOnDragReady.slice(0);
    allTabs.reverse();
    for (let tab of allTabs) {
      if (tab.id in gSelectedTabs)
        await browser.tabs.remove(tab.id);
    }
    clearSelection(aMessage.window);
    gSelectedTabs = {};
  }
  else {
    refreshContextMenuItems().then(() => {
    browser.runtime.sendMessage(kTST_ID, {
      type: kTSTAPI_CONTEXT_MENU_OPEN,
      tab:  aMessage.tab && aMessage.tab.id,
      left: aMessage.clientX,
      top:  aMessage.clientY
    });
    });
    // don't clear selection state until menu command is processed.
  }
  gUndeterminedRange = {};
  gWillCloseSelectedTabs = false;
  gDragEnteredCount = 0;
  gAllTabsOnDragReady = [];
}


/*  listen events */

function onTSTAPIMessage(aMessage) {
  switch (aMessage.type) {
    case kTSTAPI_NOTIFY_READY:
      registerToTST();
      return Promise.resolve(true);

    case kTSTAPI_NOTIFY_TAB_CLICKED:
      return onTSTTabClick(aMessage);

    case kTSTAPI_NOTIFY_TABBAR_CLICKED:
      return onTSTTabbarClick(aMessage);

    case kTSTAPI_NOTIFY_TAB_DRAGREADY:
      return onTSTTabDragReady(aMessage);

    case kTSTAPI_NOTIFY_TAB_DRAGSTART:
      return onTSTTabDragStart(aMessage);

    case kTSTAPI_NOTIFY_TAB_DRAGENTER:
      return onTSTTabDragEnter(aMessage);

    case kTSTAPI_NOTIFY_TAB_DRAGEXIT:
      return onTSTTabDragExit(aMessage);

    case kTSTAPI_NOTIFY_TAB_DRAGEND:
      return onTSTTabDragEnd(aMessage);

    case kTSTAPI_CONTEXT_MENU_CLICK:
      return contextMenuClickListener(aMessage.info, aMessage.tab);
  }
}

function onMessageExternal(aMessage, aSender) {
  //console.log('onMessageExternal: ', aMessage, aSender);
  switch (aSender.id) {
    case kTST_ID:
      return onTSTAPIMessage(aMessage);
  }
}
browser.runtime.onMessageExternal.addListener(onMessageExternal);


async function registerToTST() {
  await browser.runtime.sendMessage(kTST_ID, {
    type:  kTSTAPI_REGISTER_SELF,
    name:  browser.i18n.getMessage('extensionName'),
    style: `
      .tab.selected::after {
        background: Highlight;
        bottom: 0;
        content: " ";
        display: block;
        left: 0;
        opacity: 0.5;
        pointer-events: none;
        position: absolute;
        right: 0;
        top: 0;
        z-index: 10;
      }

      /* ::after pseudo element prevents firing of dragstart event */
      .tab.ready-to-close .closebox {
        background: Highlight;
      }
    `
  });
  refreshContextMenuItems(); // force rebuild menu
}
registerToTST();

function wait(aTimeout) {
  return new Promise((aResolve, aReject) => {
    setTimeout(aResolve, aTimeout || 0);
  });
}

