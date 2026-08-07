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
    cleaned: [],
    calibrated: [],
    invertedTo: [],
    rotatedTo: [],
  };
  const manager = Object.create(DeviceManager.prototype);
  const document = { createElement: (tag) => makeElement(tag) };
  const cleaning = new Set();
  const calibrating = new Set();
  const inverted = new Map();
  const rotation = new Map();

  manager.document = document;
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
    },
    selectDevice: (deviceId) => {
      calls.selected.push(deviceId);
      return true;
    },
    renderDevicePicker: () => {},
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
