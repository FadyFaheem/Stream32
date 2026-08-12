const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  DeviceManager,
  deviceInventory,
  deviceMetaText,
  firmwareStatus,
  summarizeInventory,
  syncProgressText,
} = require('../src/renderer/device-manager');

const WAVESHARE = 'waveshare-esp32-s3-touch-lcd-4-v3';
const ELECROW = 'elecrow-crowpanel-advanced-10-1-esp32-p4';

function inventoryFixture() {
  const devices = {
    aaaaaaaaaaaa: { name: 'Studio', boardId: WAVESHARE },
    bbbbbbbbbbbb: { name: 'Booth', boardId: ELECROW },
    cccccccccccc: { name: 'Desk', boardId: ELECROW },
    dddddddddddd: { name: 'Spare', boardId: 'retired-board' },
  };
  const sessions = new Map([
    [
      'aaaaaaaaaaaa',
      { hello: { firmwareVersion: '0.2.8', features: ['display-control'] } },
    ],
    [
      'bbbbbbbbbbbb',
      { hello: { firmwareVersion: '0.1.9', features: ['display-blank'] } },
    ],
  ]);
  const boards = new Map([
    [WAVESHARE, { name: 'Waveshare 4in', firmwareVersion: '0.2.9', compatible: true }],
    [ELECROW, { name: 'CrowPanel 10.1in', firmwareVersion: '0.1.9', compatible: true }],
  ]);

  return { devices, sessions, boards };
}

test('device inventory sorts connected boards first and detects updates', () => {
  const rows = deviceInventory(inventoryFixture());

  assert.deepEqual(
    rows.map((row) => row.name),
    ['Booth', 'Studio', 'Desk', 'Spare'],
  );

  const studio = rows.find((row) => row.name === 'Studio');
  assert.equal(studio.connected, true);
  assert.equal(studio.firmwareVersion, '0.2.8');
  assert.equal(studio.latestVersion, '0.2.9');
  assert.equal(studio.updateAvailable, true);
  assert.deepEqual(studio.features, ['display-control']);

  const booth = rows.find((row) => row.name === 'Booth');
  assert.equal(booth.connected, true);
  assert.equal(booth.updateAvailable, false); // installed already matches catalog

  const desk = rows.find((row) => row.name === 'Desk');
  assert.equal(desk.connected, false);
  assert.equal(desk.updateAvailable, false); // offline never advertises updates
  assert.equal(desk.boardName, 'CrowPanel 10.1in');

  const spare = rows.find((row) => row.name === 'Spare');
  assert.equal(spare.hasCatalogBoard, false);
  assert.equal(spare.boardName, 'retired-board'); // falls back to the board id
});

test('firmware status and meta text describe each board state', () => {
  const rows = deviceInventory(inventoryFixture());
  const byName = Object.fromEntries(rows.map((row) => [row.name, row]));

  assert.deepEqual(firmwareStatus(byName.Studio), {
    state: 'update',
    label: 'Update available · 0.2.8 → 0.2.9',
  });
  assert.deepEqual(firmwareStatus(byName.Booth), {
    state: 'current',
    label: 'Up to date · 0.1.9',
  });
  assert.deepEqual(firmwareStatus(byName.Desk), {
    state: 'unknown',
    label: 'Latest 0.1.9',
  });
  assert.deepEqual(firmwareStatus(byName.Spare), {
    state: 'unknown',
    label: 'Firmware unknown',
  });

  assert.equal(
    deviceMetaText(byName.Studio),
    'Waveshare 4in · #aaaa · firmware 0.2.8',
  );
  assert.equal(deviceMetaText(byName.Desk), 'CrowPanel 10.1in · #cccc · offline');
});

test('inventory summary counts boards, connections, and updates', () => {
  assert.deepEqual(summarizeInventory([]), { label: '', state: 'idle' });
  assert.deepEqual(summarizeInventory(deviceInventory(inventoryFixture())), {
    label: '4 boards · 2 connected · 1 update available',
    state: 'working',
  });
});

function makeElement(tag) {
  return {
    tag,
    children: [],
    dataset: {},
    attributes: {},
    listeners: {},
    hidden: false,
    disabled: false,
    append(...nodes) {
      this.children.push(...nodes);
    },
    replaceChildren(...nodes) {
      this.children = [...nodes];
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    addEventListener(type, handler) {
      (this.listeners[type] ||= []).push(handler);
    },
  };
}

function findByText(node, text) {
  if (node.textContent === text) {
    return node;
  }

  for (const child of node.children || []) {
    const found = findByText(child, text);

    if (found) {
      return found;
    }
  }

  return null;
}

function findByClass(node, className) {
  if (node.className === className) {
    return node;
  }

  for (const child of node.children || []) {
    const found = findByClass(child, className);

    if (found) {
      return found;
    }
  }

  return null;
}

async function fire(node, type) {
  for (const handler of node.listeners[type] || []) {
    await handler();
  }
}

function managerFixture() {
  const { devices, sessions, boards } = inventoryFixture();
  const calls = {
    prepared: [],
    disconnected: [],
    selected: [],
    shown: [],
    reconnects: 0,
    renamed: [],
    removed: [],
    confirms: [],
    confirmAnswer: false,
    cleaned: [],
    calibrated: [],
    invertedTo: [],
    rotatedTo: [],
    flippedTo: [],
    colorOrderedTo: [],
    iconSizedTo: [],
    labelLinedTo: [],
  };
  const manager = Object.create(DeviceManager.prototype);
  const document = { createElement: (tag) => makeElement(tag) };
  const cleaning = new Set();
  const calibrating = new Set();
  const syncProgress = new Map();
  const inverted = new Map();
  const rotation = new Map();
  const flipX = new Map();
  const flipY = new Map();
  const colorOrder = new Map();
  const iconSize = new Map();
  const labelLines = new Map();

  manager.document = document;
  manager.expanded = new Set();
  manager.syncNodes = new Map();
  manager.companionSettings = { enabled: false, host: '127.0.0.1', port: 16622 };
  manager.list = makeElement('div');
  manager.empty = makeElement('p');
  manager.status = makeElement('p');
  manager.cleanAllButton = makeElement('button');
  manager.showView = (name) => calls.shown.push(name);
  manager.deck = {
    devices,
    runtime: {
      sessions,
      syncProgress,
      cleaning,
      setCleanMode: async (deviceId, active) => {
        calls.cleaned.push([deviceId, active]);

        if (devices[deviceId].refusesCleaning) {
          throw new Error('The device did not acknowledge in time.');
        }

        cleaning[active ? 'add' : 'delete'](deviceId);
      },
      calibrating,
      inverted,
      rotation,
      flipX,
      flipY,
      colorOrder,
      iconSize,
      labelLines,
      setCalibrating: async (deviceId, active) => {
        calls.calibrated.push([deviceId, active]);
        calibrating[active ? 'add' : 'delete'](deviceId);
      },
    },
    api: {
      renameDeck: async (deviceId, name) => {
        calls.renamed.push([deviceId, name]);
        return { name, boardId: devices[deviceId].boardId };
      },
      removeDeck: async (deviceId) => {
        calls.removed.push(deviceId);
      },
    },
    selectDevice: (deviceId) => {
      calls.selected.push(deviceId);
      return true;
    },
    renderDevicePicker: () => {},
    renderAll: () => {},
    openConfirmDialog: async (options) => {
      calls.confirms.push(options);
      return calls.confirmAnswer;
    },
  };
  manager.deviceController = {
    boards,
    prepareFirmwareUpdate: (boardId) => {
      calls.prepared.push(boardId);
      return true;
    },
    disconnectDevice: async (deviceId) => {
      calls.disconnected.push(deviceId);
    },
    reconnectAuthorizedDevice: async () => {
      calls.reconnects++;
    },
    setDisplayInvert: async (deviceId, invert) => {
      calls.invertedTo.push([deviceId, invert]);
      inverted.set(deviceId, invert);
    },
    setDisplayRotation: async (deviceId, degrees) => {
      calls.rotatedTo.push([deviceId, degrees]);
      rotation.set(deviceId, degrees);
    },
    setDisplayFlip: async (deviceId, x, y) => {
      calls.flippedTo.push([deviceId, x, y]);
      flipX.set(deviceId, x);
      flipY.set(deviceId, y);
    },
    setDisplayColorOrder: async (deviceId, order) => {
      calls.colorOrderedTo.push([deviceId, order]);
      colorOrder.set(deviceId, order);
    },
    setDisplayIconSize: async (deviceId, percent) => {
      calls.iconSizedTo.push([deviceId, percent]);
      iconSize.set(deviceId, percent);
    },
    setDisplayLabelLines: async (deviceId, lines) => {
      calls.labelLinedTo.push([deviceId, lines]);
      labelLines.set(deviceId, lines);
    },
  };

  return { manager, calls };
}

test('renders one actionable card per device with a live summary', () => {
  const { manager } = managerFixture();
  manager.render();

  assert.equal(manager.list.children.length, 4);
  assert.equal(manager.empty.hidden, true);
  assert.equal(manager.status.textContent, '4 boards · 2 connected · 1 update available');
});

test('firmware update routes through the guarded flash flow', async () => {
  const { manager, calls } = managerFixture();
  manager.render();

  const update = findByText(manager.list, 'Update to 0.2.9');
  assert.ok(update, 'expected an update button for the outdated board');
  await fire(update, 'click');

  assert.deepEqual(calls.prepared, [WAVESHARE]);
  assert.deepEqual(calls.shown, ['flash']);
});

test('open in deck and disconnect wire to their controllers', async () => {
  const { manager, calls } = managerFixture();
  manager.render();

  const openButtons = [];
  const collectOpen = (node) => {
    if (node.textContent === 'Open in Deck') {
      openButtons.push(node);
    }

    for (const child of node.children || []) {
      collectOpen(child);
    }
  };
  collectOpen(manager.list);
  assert.equal(openButtons.length, 4);
  await fire(openButtons[0], 'click');
  assert.deepEqual(calls.shown, ['deck']);
  assert.equal(calls.selected.length, 1);

  const disconnect = findByText(manager.list, 'Disconnect');
  assert.ok(disconnect, 'connected boards expose a Disconnect action');
  await fire(disconnect, 'click');
  assert.equal(calls.disconnected.length, 1);
});

test('offline boards reconnect and renaming persists the new name', async () => {
  const { manager, calls } = managerFixture();
  manager.render();

  const reconnect = findByText(manager.list, 'Reconnect');
  assert.ok(reconnect, 'offline boards expose a Reconnect action');
  await fire(reconnect, 'click');
  assert.equal(calls.reconnects, 1);

  // The first card is a connected board; rename its name input.
  const nameInput = manager.list.children[0].children[0].children[0];
  assert.equal(nameInput.tag, 'input');
  nameInput.value = 'Renamed booth';
  await fire(nameInput, 'change');
  assert.equal(calls.renamed.length, 1);
  assert.equal(manager.deck.devices[calls.renamed[0][0]].name, 'Renamed booth');
});

test('cleaning locks capable boards and keeps going when one refuses', async () => {
  const { manager, calls } = managerFixture();
  const sessions = manager.deck.runtime.sessions;

  manager.render();
  assert.equal(findByText(manager.list, 'Clean screen'), null);
  assert.equal(manager.cleanAllButton.hidden, true);

  sessions.get('aaaaaaaaaaaa').hello.features = ['clean-mode'];
  sessions.get('bbbbbbbbbbbb').hello.features = ['clean-mode'];
  manager.render();
  assert.equal(manager.cleanAllButton.hidden, false);
  assert.equal(manager.cleanAllButton.textContent, 'Clean all screens');

  // Connected boards sort by name, so the first card is Booth.
  await fire(findByText(manager.list, 'Clean screen'), 'click');
  assert.deepEqual(calls.cleaned, [['bbbbbbbbbbbb', true]]);
  assert.ok(findByText(manager.list, 'Stop cleaning'));
  assert.match(manager.status.textContent, /Booth is locked for cleaning/);

  await manager.cleanAll();
  assert.deepEqual(calls.cleaned.slice(1), [
    ['bbbbbbbbbbbb', true],
    ['aaaaaaaaaaaa', true],
  ]);
  assert.equal(manager.cleanAllButton.textContent, 'Unlock all screens');
  assert.equal(manager.cleanAllButton.disabled, false);

  // A board that will not answer must not strand the others still locked.
  manager.deck.devices.aaaaaaaaaaaa.refusesCleaning = true;
  await manager.cleanAll();
  assert.deepEqual(calls.cleaned.slice(3), [
    ['bbbbbbbbbbbb', false],
    ['aaaaaaaaaaaa', false],
  ]);
  assert.equal(manager.deck.runtime.cleaning.has('bbbbbbbbbbbb'), false);
  assert.equal(manager.status.dataset.state, 'error');
  assert.match(manager.status.textContent, /Studio: The device did not/);
});

test('calibration and inversion appear only on boards that support them', async () => {
  const { manager, calls } = managerFixture();
  const sessions = manager.deck.runtime.sessions;

  // A GT911 board has nothing to calibrate, so neither control belongs there.
  manager.render();
  assert.equal(findByText(manager.list, 'Calibrate touch'), null);
  assert.equal(findByText(manager.list, 'Invert display colours'), null);

  sessions.get('bbbbbbbbbbbb').hello.features = [
    'touch-calibration',
    'display-invert',
  ];
  manager.render();

  // Connected boards sort by name, so the first card is Booth.
  await fire(findByText(manager.list, 'Calibrate touch'), 'click');
  assert.deepEqual(calls.calibrated, [['bbbbbbbbbbbb', true]]);
  assert.ok(findByText(manager.list, 'Cancel calibration'));
  assert.match(manager.status.textContent, /Follow the markers on Booth/);

  await fire(findByText(manager.list, 'Cancel calibration'), 'click');
  assert.deepEqual(calls.calibrated.at(-1), ['bbbbbbbbbbbb', false]);
  assert.ok(findByText(manager.list, 'Calibrate touch'));

  // The board owns the stored value, so the checkbox follows what it reported.
  const invertToggle = () =>
    findByClass(manager.list, 'device-invert').children[0].children[0];

  assert.equal(invertToggle().checked, false);

  const toggle = invertToggle();
  toggle.checked = true;
  await fire(toggle, 'change');
  assert.deepEqual(calls.invertedTo, [['bbbbbbbbbbbb', true]]);
  assert.equal(invertToggle().checked, true);
});

test('label lines appear only on firmware that can wrap them', async () => {
  const { manager, calls } = managerFixture();
  const sessions = manager.deck.runtime.sessions;

  manager.render();
  assert.equal(findByClass(manager.list, 'device-label-lines'), null);

  sessions.get('bbbbbbbbbbbb').hello.features = ['display-label-lines'];
  manager.render();

  const picker = () =>
    findByClass(manager.list, 'device-label-lines').children[1];

  // Nothing announced yet means labels are still ellipsized on one line.
  assert.equal(picker().value, '1');
  assert.deepEqual(
    picker().children.map((option) => option.value),
    ['1', '2', '3'],
  );

  const select = picker();
  select.value = '2';
  await fire(select, 'change');
  assert.deepEqual(calls.labelLinedTo, [['bbbbbbbbbbbb', 2]]);
  assert.equal(picker().value, '2');
});

test('icon size appears only on firmware that can inset artwork', async () => {
  const { manager, calls } = managerFixture();
  const sessions = manager.deck.runtime.sessions;

  manager.render();
  assert.equal(findByClass(manager.list, 'device-icon-size'), null);

  sessions.get('bbbbbbbbbbbb').hello.features = ['display-icon-size'];
  manager.render();

  const picker = () =>
    findByClass(manager.list, 'device-icon-size').children[1];

  // Nothing announced yet means the board is still filling its keys.
  assert.equal(picker().value, '100');
  assert.deepEqual(
    picker().children.map((option) => option.value),
    ['100', '85', '70', '55', '40'],
  );

  const select = picker();
  select.value = '70';
  await fire(select, 'change');
  assert.deepEqual(calls.iconSizedTo, [['bbbbbbbbbbbb', 70]]);
  assert.equal(picker().value, '70');
});

test('mirroring appears only on boards that can flip an axis', async () => {
  const { manager, calls } = managerFixture();
  const sessions = manager.deck.runtime.sessions;

  manager.render();
  assert.equal(findByClass(manager.list, 'device-flip'), null);

  sessions.get('bbbbbbbbbbbb').hello.features = ['display-flip'];
  manager.deck.runtime.flipY.set('bbbbbbbbbbbb', true);
  manager.render();

  const axis = (index) =>
    findByClass(manager.list, 'device-flip').children[index].children[0];

  // The board owns both values, so the checkboxes show what it reported.
  assert.equal(axis(0).checked, false);
  assert.equal(axis(1).checked, true);

  // Either box sends the pair, because the board takes them as one control.
  const x = axis(0);
  x.checked = true;
  await fire(x, 'change');
  assert.deepEqual(calls.flippedTo, [['bbbbbbbbbbbb', true, true]]);
  assert.equal(axis(0).checked, true);
  assert.equal(axis(1).checked, true);
});

test('colour order appears only on boards whose glass can disagree', async () => {
  const { manager, calls } = managerFixture();
  const sessions = manager.deck.runtime.sessions;

  manager.render();
  assert.equal(findByClass(manager.list, 'device-color-order'), null);

  sessions.get('bbbbbbbbbbbb').hello.features = ['display-color-order'];
  manager.deck.runtime.colorOrder.set('bbbbbbbbbbbb', 'bgr');
  manager.render();

  const picker = () =>
    findByClass(manager.list, 'device-color-order').children[1];

  // The board owns the stored value, so the control shows what it reported.
  assert.equal(picker().value, 'bgr');
  assert.deepEqual(
    picker().children.map((option) => option.value),
    ['rgb', 'bgr'],
  );

  const select = picker();
  select.value = 'rgb';
  await fire(select, 'change');
  assert.deepEqual(calls.colorOrderedTo, [['bbbbbbbbbbbb', 'rgb']]);
  assert.equal(picker().value, 'rgb');

  // The panel re-initialises, so the status has to explain the restart
  // rather than looking like the board dropped off on its own.
  assert.match(manager.status.textContent, /RGB colour order/);
});

test('screen rotation appears only on boards that can turn the panel', async () => {
  const { manager, calls } = managerFixture();
  const sessions = manager.deck.runtime.sessions;

  // A fixed-orientation panel offers no control at all.
  manager.render();
  assert.equal(findByClass(manager.list, 'device-rotation'), null);

  sessions.get('bbbbbbbbbbbb').hello.features = ['display-rotation'];
  manager.deck.runtime.rotation.set('bbbbbbbbbbbb', 90);
  manager.render();

  const picker = () =>
    findByClass(manager.list, 'device-rotation').children[1];

  // The board owns the value, so the control shows what it reported.
  assert.equal(picker().value, '90');
  assert.deepEqual(
    picker().children.map((option) => option.value),
    ['0', '90', '180', '270'],
  );

  const select = picker();
  select.value = '270';
  await fire(select, 'change');
  assert.deepEqual(calls.rotatedTo, [['bbbbbbbbbbbb', 270]]);
  assert.equal(picker().value, '270');

  // Turning the screen resizes the keys, so the artwork goes again and the
  // status line has to say so rather than looking like nothing happened.
  assert.match(manager.status.textContent, /rotated to 270/);
  assert.match(manager.status.textContent, /artwork/);
});

test('removing a device asks first and forgets its saved profiles', async () => {
  const { manager, calls } = managerFixture();
  manager.render();

  // Connected boards keep their session, so only offline cards offer it.
  const removeButtons = [];
  const collect = (node) => {
    if (node.textContent === 'Remove…') {
      removeButtons.push(node);
    }

    for (const child of node.children || []) {
      collect(child);
    }
  };
  collect(manager.list);
  assert.equal(removeButtons.length, 2, 'both offline boards offer removal');
  assert.equal(findByText(manager.list.children[0], 'Remove…'), null);

  // Offline boards sort after connected ones, so the third card is Desk.
  const keep = findByText(manager.list.children[2], 'Remove…');
  await fire(keep, 'click');
  assert.equal(calls.confirms.length, 1);
  assert.match(calls.confirms[0].title, /Remove Desk\?/);
  assert.match(calls.confirms[0].message, /deletes its saved profiles/);
  assert.deepEqual(calls.removed, [], 'cancelling keeps the device');
  assert.equal(keep.disabled, false);

  calls.confirmAnswer = true;
  manager.render();
  await fire(findByText(manager.list.children[2], 'Remove…'), 'click');
  assert.deepEqual(calls.removed, ['cccccccccccc']);
  assert.equal(manager.deck.devices.cccccccccccc, undefined);
  assert.equal(manager.list.children.length, 3);
  assert.match(manager.status.textContent, /Desk was removed/);
});

test('the board reports how a calibration ended', () => {
  const { manager } = managerFixture();

  manager.showCalibrateOutcome('bbbbbbbbbbbb', 'done');
  assert.match(manager.status.textContent, /Booth touch calibration saved/);
  assert.equal(manager.status.dataset.state, 'ready');

  manager.showCalibrateOutcome('bbbbbbbbbbbb', 'failed');
  assert.match(manager.status.textContent, /did not check out/);
  assert.match(manager.status.textContent, /previous calibration is still/);
  assert.equal(manager.status.dataset.state, 'error');

  manager.showCalibrateOutcome('bbbbbbbbbbbb', 'cancelled');
  assert.match(manager.status.textContent, /timed out/);
});

test('Companion controls appear only once the setting turns them on', () => {
  const { manager } = managerFixture();
  manager.render();
  assert.equal(findByText(manager.list, 'Companion surface'), null);

  manager.companionSettings.enabled = true;
  manager.render();
  assert.ok(
    findByText(manager.list, 'Companion surface'),
    'each card offers the surface toggle while Companion is on',
  );
});

test('per-device settings fold into a panel that remembers being open', async () => {
  const { manager } = managerFixture();
  const sessions = manager.deck.runtime.sessions;

  sessions.get('bbbbbbbbbbbb').hello.features = [
    'display-invert',
    'display-rotation',
  ];
  manager.render();

  // Connected boards sort by name, so Booth is first and Studio second.
  const card = manager.list.children[0];
  const panel = card.children[4];

  assert.equal(panel.tag, 'details');
  assert.equal(panel.className, 'device-settings');
  assert.equal(panel.children[0].tag, 'summary');
  assert.equal(panel.children[0].textContent, 'Settings (2)');
  assert.equal(panel.open, false);

  // The controls belong to the panel, not the card, so a card is only its
  // name, meta, firmware badge, sync line, the panel, and the actions.
  assert.equal(card.children.length, 6);
  assert.ok(findByClass(panel, 'device-rotation'));
  assert.ok(findByClass(panel, 'device-invert'));

  // Studio configures nothing, so it is not given an empty panel.
  assert.equal(findByClass(manager.list.children[1], 'device-settings'), null);

  // Every change re-renders the list, so opening it has to survive that.
  panel.open = true;
  await fire(panel, 'toggle');
  manager.render();
  assert.equal(manager.list.children[0].children[4].open, true);

  panel.open = false;
  await fire(panel, 'toggle');
  manager.render();
  assert.equal(manager.list.children[0].children[4].open, false);
});

test('a re-syncing board counts its progress down on its own card', () => {
  const { manager } = managerFixture();
  const { syncProgress } = manager.deck.runtime;

  manager.render();

  // Connected boards sort by name, so Booth is first and Studio second.
  const line = manager.list.children[0].children[3];
  const other = manager.list.children[1].children[3];

  assert.equal(line.className, 'device-sync');
  assert.equal(line.hidden, true, 'an idle board shows no progress line');

  syncProgress.set('bbbbbbbbbbbb', { page: 1, pages: 2, sent: 0, images: 4 });
  manager.renderSyncProgress();
  assert.equal(line.hidden, false);
  assert.equal(line.textContent, 'Resyncing page 1 of 2 · icon 1 of 4…');

  // Only the board that is syncing says so.
  assert.equal(other.hidden, true);

  syncProgress.set('bbbbbbbbbbbb', { page: 2, pages: 2, sent: 3, images: 4 });
  manager.renderSyncProgress();
  assert.equal(line.textContent, 'Resyncing page 2 of 2 · icon 4 of 4…');

  // A rebuild mid-sync has to pick the count back up rather than blank it.
  manager.render();
  assert.equal(
    manager.list.children[0].children[3].textContent,
    'Resyncing page 2 of 2 · icon 4 of 4…',
  );

  syncProgress.delete('bbbbbbbbbbbb');
  manager.renderSyncProgress();
  assert.equal(manager.list.children[0].children[3].hidden, true);
});

test('progress text drops the parts a sync has nothing to say about', () => {
  // A single page is not worth counting, and a layout-only page sends no art.
  assert.equal(
    syncProgressText({ page: 1, pages: 1, sent: 0, images: 0 }),
    'Resyncing…',
  );
  assert.equal(
    syncProgressText({ page: 1, pages: 1, sent: 2, images: 6 }),
    'Resyncing icon 3 of 6…',
  );
  assert.equal(
    syncProgressText({ page: 3, pages: 4, sent: 0, images: 0 }),
    'Resyncing page 3 of 4…',
  );
  // The last icon must not read as "icon 7 of 6" once it lands.
  assert.equal(
    syncProgressText({ page: 1, pages: 1, sent: 6, images: 6 }),
    'Resyncing icon 6 of 6…',
  );
});

test('device manager view and nav are wired accessibly', () => {
  const html = readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'index.html'),
    'utf8',
  );
  const renderer = readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'),
    'utf8',
  );

  assert.match(html, /data-view="devices"/);
  assert.match(
    html,
    /id="view-devices"[\s\S]*aria-label="Device manager"/,
  );
  assert.match(
    html,
    /id="device-manager-status"[\s\S]*aria-live="polite"/,
  );
  assert.match(html, /id="device-manager-list"/);
  assert.match(html, /id="device-manager-clean-all"/);
  assert.match(html, /id="companion-enabled"/);
  // Hidden in the markup so the Companion block never flashes before the
  // setting is read.
  assert.match(html, /id="companion-link"[^>]*hidden/);
  assert.match(renderer, /\['deck', 'devices', 'flash', 'settings'\]/);
  assert.match(renderer, /new DeviceManager\(/);
});
