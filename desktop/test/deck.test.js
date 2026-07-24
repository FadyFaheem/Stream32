const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  DeckController,
  removeProfilePage,
} = require('../src/renderer/deck');
const { DeckRuntime } = require('../src/renderer/deck-runtime');
const {
  keyPayload,
  pasteKey,
} = require('../src/renderer/key-clipboard');
const {
  selectPageForSnapshot,
  selectProfileForSnapshot,
} = require('../src/profile-rules');

function createRuntime() {
  let runtime;
  runtime = new DeckRuntime({
    api: {},
    getDevices: () => runtime.devices,
    getProfile: (deviceId, profileId) =>
      runtime.devices[deviceId]?.profiles?.[
        profileId || runtime.selectedProfileId(deviceId)
      ] || null,
    getSelectedProfileId: (deviceId) => runtime.selectedProfileId(deviceId),
    setDevice: (deviceId, device) => {
      runtime.devices[deviceId] = device;
    },
    persistProfile: (...args) => runtime.saveProfile(...args),
    renderPageImages: (...args) => runtime.renderImages(...args),
    limitsFor: (profile) => runtime.resolveLimits(profile),
    resolveProfileForSnapshot: selectProfileForSnapshot,
    resolvePageForSnapshot: selectPageForSnapshot,
    getFocusStatus: () => runtime.focusStatus,
    getFocusSnapshot: () => runtime.focusSnapshot,
    onDeviceRegistered: (deviceId) => {
      runtime.selectedDeviceId ||= deviceId;
    },
    onSelectedPage: (deviceId, page) => {
      if (deviceId === runtime.selectedDeviceId) {
        runtime.selectedPage = page;
        runtime.selectedKey = null;
        runtime.renderAll();
      }
    },
    onRenderAll: () => runtime.renderAll(),
    onRenderSelectedLive: (deviceId) => {
      if (deviceId === runtime.selectedDeviceId) {
        runtime.renderGrid();
        runtime.renderKeyEditor();
      }
    },
    onStatus: (...args) => runtime.setSyncStatus(...args),
    onProfileStatus: (...args) => runtime.setProfileMatchStatus(...args),
    onRenderSyncStatus: () => runtime.renderSyncStatus(),
  });
  runtime.devices = {};
  runtime.boardLimits = new Map();
  runtime.selectedDeviceId = null;
  runtime.selectedPage = 0;
  runtime.selectedKey = null;
  runtime.focusStatus = null;
  runtime.focusSnapshot = null;
  runtime.selectedProfileId = (deviceId) =>
    runtime.devices[deviceId]?.activeProfileId || null;
  runtime.saveProfile = () => {};
  runtime.renderImages = async () => new Map();
  runtime.resolveLimits = (profile) =>
    runtime.boardLimits.get(profile?.boardId) || {
      maxCols: 8,
      maxKeys: 30,
      maxPages: 8,
      maxRows: 8,
    };
  runtime.renderAll = () => {};
  runtime.renderGrid = () => {};
  runtime.renderKeyEditor = () => {};
  runtime.renderSyncStatus = () => {};
  runtime.setSyncStatus = () => {};
  runtime.setProfileMatchStatus = () => {};
  return runtime;
}

test('manual connection visibility follows the selected deck only', () => {
  const controller = Object.create(DeckController.prototype);
  const attributes = {};

  controller.connectPanel = {
    dataset: {},
    inert: false,
    setAttribute(name, value) {
      attributes[name] = value;
    },
  };
  controller.deviceSelect = {
    append() {},
    replaceChildren() {},
  };
  controller.deviceStatus = { dataset: {} };
  controller.deviceName = {};
  controller.emptyState = {};
  controller.editorPanel = {};
  controller.document = {
    createElement: () => ({}),
  };
  controller.devices = {
    aaaa11112222: {
      name: 'Connected deck',
      activeProfileId: 'default',
      profiles: { default: { name: 'Default' } },
    },
    bbbb33334444: {
      name: 'Offline deck',
      activeProfileId: 'default',
      profiles: { default: { name: 'Default' } },
    },
  };
  controller.runtime = {
    hasSession: (deviceId) => deviceId === 'aaaa11112222',
  };
  controller.selectedDeviceId = 'aaaa11112222';

  controller.renderDevicePicker();

  assert.equal(controller.deviceStatus.textContent, 'Connected');
  assert.equal(controller.connectPanel.dataset.hidden, 'true');
  assert.equal(controller.connectPanel.inert, true);
  assert.equal(attributes['aria-hidden'], 'true');

  controller.selectedDeviceId = 'bbbb33334444';
  controller.renderDevicePicker();

  assert.equal(controller.deviceStatus.textContent, 'Offline');
  assert.equal(controller.connectPanel.dataset.hidden, 'false');
  assert.equal(controller.connectPanel.inert, false);
  assert.equal(attributes['aria-hidden'], 'false');
});

test('page deletion remaps active and default fallbacks', () => {
  const profile = {
    activePage: 2,
    defaultPage: 1,
    pages: [
      { keys: [] },
      { keys: [{ index: 0, action: { type: 'page', page: 2 } }] },
      { keys: [] },
    ],
  };

  removeProfilePage(profile, 0);

  assert.equal(profile.activePage, 1);
  assert.equal(profile.defaultPage, 0);
  assert.equal(profile.pages[0].keys[0].action.page, 1);

  removeProfilePage(profile, 0);
  assert.equal(profile.activePage, 0);
  assert.equal(profile.defaultPage, 0);
});

test('clipboard preserves top-level and Multi profile actions', () => {
  const source = {
    index: 3,
    action: {
      type: 'multi',
      steps: [
        { type: 'profile', profileId: 'streaming' },
        { type: 'media', command: 'mute' },
      ],
    },
  };
  const payload = keyPayload(source);
  const [pasted] = pasteKey([], 7, payload, 1);

  assert.equal(pasted.index, 7);
  assert.deepEqual(pasted.action, source.action);
  assert.notEqual(pasted.action, source.action);
});

test('profile and page focus controls have distinct DOM ownership', () => {
  const html = readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'index.html'),
    'utf8',
  );

  assert.match(html, /Profile app match on this computer/);
  assert.match(html, /Page app match on this computer/);
  assert.match(html, /aria-label="Use focused app for profile"/);
  assert.match(html, /aria-label="Use focused app for page"/);
  assert.match(html, /id="deck-profile-match-status"/);
  assert.match(html, /id="deck-page-match-status"/);
});

test('profile create and rename use one accessible in-app dialog', () => {
  const html = readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'index.html'),
    'utf8',
  );
  const source = readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'deck.js'),
    'utf8',
  );
  const selectors = [
    'deck-profile-dialog',
    'deck-profile-form',
    'deck-profile-dialog-title',
    'deck-profile-name',
    'deck-profile-dialog-error',
    'deck-profile-dialog-cancel',
    'deck-profile-dialog-submit',
  ];

  assert.doesNotMatch(source, /window\.prompt\s*\(/);
  assert.match(html, /<dialog[^>]*id="deck-profile-dialog"[\s\S]*aria-labelledby=/);
  assert.match(html, /id="deck-profile-name"[\s\S]*maxlength="60"[\s\S]*autofocus/);
  assert.match(html, /id="deck-profile-dialog-cancel"[\s\S]*type="button"/);
  assert.match(source, /profileForm\.addEventListener\('submit'/);
  assert.match(source, /profileDialog\.addEventListener\('close'/);

  for (const id of selectors) {
    assert.equal(html.match(new RegExp(`id="${id}"`, 'g'))?.length, 1, id);
    assert.match(source, new RegExp(`querySelector\\('#${id}'\\)`), id);
  }
});

test('profile dialog creates, renames, and reports validation inline', async () => {
  const controller = Object.create(DeckController.prototype);
  const operations = [];
  let closes = 0;
  controller.devices = {
    aaaa11112222: {
      activeProfileId: 'default',
      profiles: {
        default: { name: 'Default' },
        streaming: { name: 'Streaming' },
      },
    },
  };
  controller.selectedDeviceId = 'aaaa11112222';
  controller.selectedDevice = () =>
    controller.devices[controller.selectedDeviceId];
  controller.selectedProfileId = () =>
    controller.selectedDevice().activeProfileId;
  controller.selectedProfile = () =>
    controller.selectedDevice().profiles[controller.selectedProfileId()];
  controller.document = { activeElement: null };
  controller.profileDialog = {
    showModal() {},
    close() {
      closes++;
    },
  };
  controller.profileDialogTitle = {};
  controller.profileDialogSubmit = {};
  controller.profileDialogError = {};
  controller.profileName = {
    value: '',
    focus() {},
    select() {},
    setAttribute(name, value) {
      this[name] = value;
    },
  };
  controller.runProfileOperation = async (operation, options) => {
    operations.push(operation);

    if (operation.name === 'Server error') {
      options.onError(new Error('Profile name is invalid.'));
      return false;
    }

    return true;
  };

  controller.openProfileDialog('create', null);
  assert.equal(controller.profileDialogTitle.textContent, 'Add profile');
  assert.equal(controller.profileName.value, 'Profile');
  controller.profileName.value = 'Studio';
  assert.equal(await controller.submitProfileDialog(), true);
  assert.deepEqual(operations.at(-1), { type: 'create', name: 'Studio' });

  controller.openProfileDialog('rename', null);
  assert.equal(controller.profileDialogTitle.textContent, 'Rename profile');
  assert.equal(controller.profileName.value, 'Default');
  controller.profileName.value = 'Renamed';
  assert.equal(await controller.submitProfileDialog(), true);
  assert.deepEqual(operations.at(-1), {
    type: 'rename',
    profileId: 'default',
    name: 'Renamed',
  });

  controller.openProfileDialog('create', null);
  controller.profileName.value = '  ';
  assert.equal(await controller.submitProfileDialog(), false);
  assert.match(controller.profileDialogError.textContent, /Enter/);
  controller.profileName.value = 'streaming';
  assert.equal(await controller.submitProfileDialog(), false);
  assert.match(controller.profileDialogError.textContent, /unique/);
  controller.profileName.value = 'Server error';
  assert.equal(await controller.submitProfileDialog(), false);
  assert.equal(
    controller.profileDialogError.textContent,
    'Profile name is invalid.',
  );
  assert.equal(closes, 2);
});

test('the full-width content pane owns Deck scrolling', () => {
  const css = readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'styles.css'),
    'utf8',
  );

  assert.match(
    css,
    /\.content:has\(\.view-deck:not\(\[hidden\]\)\)\s*\{[^}]*overflow-y:\s*auto;/s,
  );
  assert.doesNotMatch(
    css,
    /\.view-deck:not\(\[hidden\]\)\s*\{[^}]*overflow-y:\s*auto;/s,
  );
  assert.match(css, /\.deck-stage\s*\{[^}]*overflow:\s*auto;/s);
  assert.match(
    css,
    /\.deck-key-editor-body\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*0\.9fr\)\s+minmax\(0,\s*1\.25fr\);/s,
  );
  assert.match(
    css,
    /@media \(max-width:\s*940px\)[\s\S]*?\.deck-key-editor-body\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/s,
  );
  assert.match(
    css,
    /\.deck-live-helper,[\s\S]*?grid-column:\s*1\s*\/\s*-1;[\s\S]*?min-width:\s*0;/s,
  );
  assert.match(
    css,
    /\.deck-live-helper,[\s\S]*?overflow-wrap:\s*normal;[\s\S]*?word-break:\s*normal;/s,
  );
});

test('sync resolves the active named profile for a device', async () => {
  const controller = createRuntime();
  const synced = [];
  const sent = [];
  const session = { send: async (line) => sent.push(line) };
  controller.devices = {
    aaaa11112222: {
      name: 'Desk',
      boardId: 'test-board',
      activeProfileId: 'live',
      defaultProfileId: 'default',
      profiles: {
        default: {
          name: 'Default',
          boardId: 'test-board',
          activePage: 0,
          keyPx: {},
          pages: [{ name: 'Main', rows: 1, cols: 1, keys: [] }],
        },
        live: {
          name: 'Live',
          boardId: 'test-board',
          activePage: 1,
          keyPx: {},
          pages: [
            { name: 'One', rows: 1, cols: 1, keys: [] },
            { name: 'Two', rows: 1, cols: 1, keys: [] },
          ],
        },
      },
    },
  };
  controller.sessions = new Map([['aaaa11112222', session]]);
  controller.syncRunning = new Map();
  controller.liveRunning = new Set();
  controller.pending = new Map();
  controller.setSyncStatus = () => {};
  controller.refreshLiveStates = (deviceId) => synced.push(['live', 'reapply', deviceId]);
  controller.syncPage = async (
    _deviceId,
    _session,
    profileId,
    profile,
    pageIndex,
  ) => {
    synced.push([profileId, profile.name, pageIndex]);
  };

  await controller.syncDevice('aaaa11112222');

  assert.deepEqual(synced, [
    ['live', 'Live', 0],
    ['live', 'Live', 1],
    ['live', 'reapply', 'aaaa11112222'],
  ]);
  assert.match(Buffer.from(sent.at(-1)).toString('utf8'), /"index":1/);
  assert.equal(session.committedProfileId, 'live');
  assert.equal(session.profileInputBlocked, false);
});

test('manual page selection updates active but not default page', async () => {
  const controller = createRuntime();
  const saves = [];
  controller.devices = {
    aaaa11112222: {
      activeProfileId: 'default',
      profiles: {
        default: {
          activePage: 0,
          defaultPage: 0,
          pages: [{}, {}],
        },
      },
    },
  };
  controller.selectedDeviceId = 'aaaa11112222';
  controller.saveProfile = async (...args) => saves.push(args);
  controller.refreshLiveStates = () => {};
  controller.renderAll = () => {};

  assert.equal(
    await controller.switchDevicePage('aaaa11112222', 1, 'default'),
    true,
  );
  assert.equal(
    await controller.switchDevicePage('aaaa11112222', 1, 'default'),
    false,
  );
  assert.equal(
    controller.devices.aaaa11112222.profiles.default.activePage,
    1,
  );
  assert.equal(
    controller.devices.aaaa11112222.profiles.default.defaultPage,
    0,
  );
  assert.deepEqual(saves, [['aaaa11112222', 'default']]);
});

test('profile actions switch locally, clear selection, render, and sync once', async () => {
  const controller = createRuntime();
  const operations = [];
  const hostActions = [];
  const syncs = [];
  let renders = 0;
  controller.devices = {
    aaaa11112222: {
      activeProfileId: 'default',
      profiles: {
        default: { activePage: 0, pages: [{}] },
        streaming: { activePage: 2, pages: [{}, {}, {}] },
      },
    },
  };
  controller.selectedDeviceId = 'aaaa11112222';
  controller.selectedPage = 0;
  controller.selectedKey = 4;
  controller.liveValues.set('aaaa11112222:default:0:4', true);
  controller.api = {
    async runProfileOperation(deviceId, operation) {
      operations.push([deviceId, operation]);
      return {
        ...structuredClone(controller.devices[deviceId]),
        activeProfileId: operation.profileId,
      };
    },
    async runAction(action) {
      hostActions.push(action);
    },
  };
  controller.renderAll = () => {
    renders++;
  };
  controller.scheduleSync = (...args) => syncs.push(args);

  assert.equal(await controller.runKeyAction(
    'aaaa11112222',
    { type: 'profile', profileId: 'streaming' },
    { profileId: 'default', page: 0, index: 4 },
  ), true);

  assert.deepEqual(operations, [[
    'aaaa11112222',
    { type: 'select', profileId: 'streaming' },
  ]]);
  assert.deepEqual(hostActions, []);
  assert.equal(
    controller.devices.aaaa11112222.activeProfileId,
    'streaming',
  );
  assert.equal(controller.selectedPage, 2);
  assert.equal(controller.selectedKey, null);
  assert.equal(controller.liveValues.size, 0);
  assert.equal(renders, 1);
  assert.deepEqual(syncs, [['aaaa11112222', 0]]);
});

test('missing profile actions fail without privileged execution', async () => {
  const controller = createRuntime();
  const hostActions = [];
  const statuses = [];
  controller.devices = {
    aaaa11112222: {
      activeProfileId: 'default',
      profiles: { default: { activePage: 0, pages: [{}] } },
    },
  };
  controller.api = {
    async runProfileOperation() {
      throw new TypeError('Profile id is invalid.');
    },
    async runAction(action) {
      hostActions.push(action);
    },
  };
  controller.setSyncStatus = (...status) => statuses.push(status);

  assert.equal(await controller.runKeyAction(
    'aaaa11112222',
    { type: 'profile', profileId: 'deleted-profile' },
    { profileId: 'default', page: 0, index: 0 },
  ), false);
  assert.deepEqual(hostActions, []);
  assert.match(statuses[0][0], /Profile id is invalid/);
});

test('Multi profile switch cancels every later step', async () => {
  const controller = createRuntime();
  const hostActions = [];
  const syncs = [];
  const statuses = [];
  controller.devices = {
    aaaa11112222: {
      activeProfileId: 'default',
      profiles: {
        default: { activePage: 0, pages: [{}] },
        streaming: { activePage: 0, pages: [{}] },
      },
    },
  };
  controller.api = {
    async runProfileOperation(deviceId, operation) {
      return {
        ...structuredClone(controller.devices[deviceId]),
        activeProfileId: operation.profileId,
      };
    },
    async runAction(action) {
      hostActions.push(action);
    },
  };
  controller.scheduleSync = (...args) => syncs.push(args);
  controller.setSyncStatus = (...status) => statuses.push(status);

  assert.equal(await controller.runKeyAction(
    'aaaa11112222',
    {
      type: 'multi',
      steps: [
        { type: 'profile', profileId: 'streaming' },
        { type: 'media', command: 'mute' },
      ],
    },
    { profileId: 'default', page: 0, index: 0 },
  ), false);

  assert.deepEqual(hostActions, []);
  assert.deepEqual(syncs, [['aaaa11112222', 0]]);
  assert.match(statuses[0][0], /canceled before step 2/);
});

test('local toggle flips only after its action succeeds', async () => {
  const controller = createRuntime();
  const updates = [];
  controller.liveValues = new Map();
  controller.devices = {
    aaaa11112222: {
      activeProfileId: 'default',
      profiles: {
        default: {
          pages: [{
            keys: [{
              index: 0,
              action: { type: 'media', command: 'mute' },
              liveState: {
                provider: 'toggle',
                on: { label: 'On', color: '#00aa44' },
              },
            }],
          }],
        },
      },
    },
  };
  controller.sessions = new Map();
  controller.multiRuns = new Set();
  controller.selectedDeviceId = null;
  controller.queueLiveUpdate = (_deviceId, update) => updates.push(update);
  controller.setSyncStatus = () => {};
  controller.api = { runAction: async () => {} };

  assert.equal(await controller.runKeyAction(
    'aaaa11112222',
    { type: 'media', command: 'mute' },
    { profileId: 'default', page: 0, index: 0 },
  ), true);
  assert.equal(updates.at(-1).overlay.state, 'on');

  controller.api.runAction = async () => {
    throw new Error('cancelled');
  };
  assert.equal(await controller.runKeyAction(
    'aaaa11112222',
    { type: 'media', command: 'mute' },
    { profileId: 'default', page: 0, index: 0 },
  ), false);
  assert.equal(updates.length, 1);
});

test('unsupported firmware drops live updates without layout fallback', async () => {
  const controller = createRuntime();
  let sent = 0;
  controller.sessions = new Map([[
    'aaaa11112222',
    {
      hello: { features: [] },
      send: async () => {
        sent++;
      },
    },
  ]]);
  controller.liveQueues = new Map([[
    'aaaa11112222',
    new Map([['0:0', {
      profileId: 'default',
      page: 0,
      index: 0,
      overlay: { state: 'on' },
    }]]),
  ]]);
  controller.renderSyncStatus = () => {};

  await controller.flushLiveUpdates('aaaa11112222');

  assert.equal(sent, 0);
  assert.equal(controller.liveQueues.has('aaaa11112222'), false);
});

test('pending replies ignore unrelated acknowledgements and errors', async () => {
  const controller = createRuntime();
  const deviceId = 'aaaa11112222';
  const session = { hello: { deviceId } };
  controller.pending = new Map();
  const reply = controller.awaitReply(deviceId, {
    type: 'image-ack',
    identity: { page: 1, index: 2, seq: 3, mode: 'ephemeral' },
    errorCodes: ['image-invalid'],
  }, 1000);

  controller.handleDeviceMessage(session, {
    type: 'key-update-ack',
    page: 1,
    index: 2,
    needImage: false,
  });
  controller.handleDeviceMessage(session, {
    type: 'image-ack',
    page: 1,
    index: 2,
    seq: 4,
    mode: 'ephemeral',
  });
  controller.handleDeviceMessage(session, {
    type: 'error',
    code: 'display-brightness-failed',
  });
  assert.equal(controller.pending.has(deviceId), true);

  const expected = {
    type: 'image-ack',
    page: 1,
    index: 2,
    seq: 3,
    mode: 'ephemeral',
  };
  controller.handleDeviceMessage(session, expected);
  assert.equal(await reply, expected);
  assert.equal(controller.pending.has(deviceId), false);
});

test('live updates complete only after their correlated key ACK', async () => {
  const controller = createRuntime();
  const deviceId = 'aaaa11112222';
  const sent = [];
  controller.devices = {
    [deviceId]: {
      activeProfileId: 'default',
      profiles: {
        default: {
          keyPx: {},
          pages: [{ rows: 1, cols: 1, keys: [{ index: 0 }] }],
        },
      },
    },
  };
  const session = {
    hello: { deviceId, features: ['key-update'] },
    async send(bytes) {
      sent.push(JSON.parse(Buffer.from(bytes).toString('utf8')));
      queueMicrotask(() => {
        controller.handleDeviceMessage(session, {
          type: 'key-update-ack',
          page: 0,
          index: 1,
          needImage: false,
        });
        assert.equal(controller.pending.has(deviceId), true);
        controller.handleDeviceMessage(session, {
          type: 'key-update-ack',
          page: 0,
          index: 0,
          needImage: false,
        });
      });
    },
  };
  controller.sessions.set(deviceId, session);

  await controller.sendLiveUpdate(deviceId, session, {
    profileId: 'default',
    page: 0,
    index: 0,
    overlay: { label: 'Live', state: 'on' },
  });

  assert.equal(sent[0].type, 'key-update');
  assert.equal(sent[0].label, 'Live');
  assert.equal(controller.pending.has(deviceId), false);
});

test('an older timeout cannot delete a newer pending reply', async () => {
  const controller = createRuntime();
  const deviceId = 'aaaa11112222';
  const session = { hello: { deviceId } };
  controller.pending = new Map();
  controller.awaitReply(deviceId, {
    type: 'layout-ack',
    identity: { page: 0 },
  }, 10);
  controller.pending.delete(deviceId);

  const reply = controller.awaitReply(deviceId, {
    type: 'layout-ack',
    identity: { page: 1 },
  }, 1000);
  const newer = controller.pending.get(deviceId);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(controller.pending.get(deviceId), newer);

  const expected = { type: 'layout-ack', page: 1 };
  controller.handleDeviceMessage(session, expected);
  assert.equal(await reply, expected);
});

test('live update flushes serialize complete device transactions', async () => {
  const controller = createRuntime();
  const deviceId = 'aaaa11112222';
  let active = 0;
  let maximumActive = 0;
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const calls = [];
  controller.sessions = new Map([[
    deviceId,
    { hello: { features: ['key-update'] } },
  ]]);
  controller.pending = new Map();
  controller.syncRunning = new Map();
  controller.liveRunning = new Set();
  controller.liveQueues = new Map();
  controller.liveTimers = new Map();
  controller.selectedProfileId = () => 'default';
  controller.setSyncStatus = () => {};
  controller.sendLiveUpdate = async (_deviceId, _session, update) => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    calls.push(update.index);

    if (update.index === 0) {
      await firstBlocked;
    }

    active--;
  };
  const update = (index) => ({
    profileId: 'default',
    page: 0,
    index,
    overlay: { state: 'on' },
  });
  controller.liveQueues.set(deviceId, new Map([['0:0', update(0)]]));

  const first = controller.flushLiveUpdates(deviceId);
  await Promise.resolve();
  controller.liveQueues.set(deviceId, new Map([['0:1', update(1)]]));
  await controller.flushLiveUpdates(deviceId);
  assert.deepEqual(calls, [0]);

  releaseFirst();
  await first;
  clearTimeout(controller.liveTimers.get(deviceId));
  controller.liveTimers.delete(deviceId);
  await controller.flushLiveUpdates(deviceId);
  assert.deepEqual(calls, [0, 1]);
  assert.equal(maximumActive, 1);
});

test('cancelled Multi Action does not flip local toggle state', async () => {
  const controller = createRuntime();
  const updates = [];
  controller.liveValues = new Map();
  controller.multiRuns = new Set();
  controller.sessions = new Map();
  controller.devices = {
    aaaa11112222: {
      activeProfileId: 'default',
      profiles: {
        default: {
          pages: [{
            keys: [{
              index: 0,
              liveState: { provider: 'toggle', on: { label: 'On' } },
            }],
          }],
        },
        other: { pages: [{ keys: [] }] },
      },
    },
  };
  controller.api = {
    async runAction() {
      controller.devices.aaaa11112222.activeProfileId = 'other';
    },
  };
  controller.queueLiveUpdate = (...args) => updates.push(args);
  controller.setSyncStatus = () => {};

  assert.equal(await controller.runKeyAction(
    'aaaa11112222',
    {
      type: 'multi',
      steps: [
        { type: 'media', command: 'mute' },
        { type: 'media', command: 'volume-up' },
      ],
    },
    { profileId: 'default', page: 0, index: 0 },
  ), false);
  assert.deepEqual(updates, []);
  assert.equal(controller.liveValues.size, 0);
});

test('profile cleanup cancels queued live state and local values', () => {
  const controller = createRuntime();
  controller.liveValues = new Map([
    ['aaaa11112222:deleted:0:0', true],
    ['bbbb33334444:default:0:0', true],
  ]);
  controller.liveQueues = new Map([['aaaa11112222', new Map()]]);
  controller.liveTimers = new Map();

  controller.clearLiveRuntime('aaaa11112222');

  assert.deepEqual(
    [...controller.liveValues.keys()],
    ['bbbb33334444:default:0:0'],
  );
  assert.equal(controller.liveQueues.has('aaaa11112222'), false);
});

test('focused-app auto-switch selects every saved device idempotently', async () => {
  const controller = createRuntime();
  const calls = [];
  const syncs = [];
  const profile = (name, appMatches = {}) => ({
    name,
    activePage: name === 'OBS' ? 1 : 0,
    defaultPage: name === 'OBS' ? 1 : 0,
    appMatches,
    pages: [{}, {}],
  });
  controller.devices = {
    aaaa11112222: {
      name: 'Connected',
      activeProfileId: 'default',
      defaultProfileId: 'default',
      profiles: {
        default: profile('Default'),
        obs: profile('OBS', {
          linux: { kind: 'wmClass', value: 'obs' },
        }),
      },
    },
    bbbb33334444: {
      name: 'Offline',
      activeProfileId: 'default',
      defaultProfileId: 'default',
      profiles: {
        default: profile('Default'),
        obs: profile('OBS', {
          linux: { kind: 'wmClass', value: 'obs' },
        }),
      },
    },
  };
  controller.focusStatus = { platform: 'linux' };
  controller.selectedDeviceId = 'aaaa11112222';
  controller.selectedPage = 0;
  controller.selectedKey = 4;
  controller.api = {
    async runProfileOperation(deviceId, operation) {
      calls.push([deviceId, operation]);
      const device = structuredClone(controller.devices[deviceId]);
      device.activeProfileId = operation.profileId;
      return device;
    },
  };
  controller.profileSwitcher.api = controller.api;
  controller.scheduleSync = (deviceId, delay) => {
    syncs.push([deviceId, delay]);
  };
  controller.renderAll = () => {};
  controller.setProfileMatchStatus = () => {};
  const snapshot = {
    platform: 'linux',
    processId: 123,
    identities: [{ kind: 'wmClass', value: 'OBS' }],
  };

  controller.focusStatus.editorFocused = true;
  assert.deepEqual(
    await controller.profileSwitcher.switchProfiles(snapshot),
    [],
  );
  controller.focusStatus.editorFocused = false;
  assert.deepEqual(await controller.profileSwitcher.switchProfiles(snapshot), [
    'aaaa11112222',
    'bbbb33334444',
  ]);
  assert.deepEqual(
    await controller.profileSwitcher.switchProfiles(snapshot),
    [],
  );
  assert.equal(controller.devices.aaaa11112222.activeProfileId, 'obs');
  assert.equal(controller.devices.bbbb33334444.activeProfileId, 'obs');
  assert.equal(controller.selectedPage, 1);
  assert.equal(controller.selectedKey, null);
  assert.equal(calls.length, 2);
  assert.deepEqual(syncs, [
    ['aaaa11112222', 0],
    ['bbbb33334444', 0],
  ]);
});

test('page-only focus switches send one page without a full sync', async () => {
  const controller = createRuntime();
  const operations = [];
  const syncs = [];
  const sent = [];
  const profile = () => ({
    activePage: 0,
    defaultPage: 0,
    appMatches: {},
    pages: [
      { appMatches: {} },
      {
        appMatches: {
          linux: { kind: 'wmClass', value: 'obs' },
        },
      },
    ],
  });
  controller.devices = {
    aaaa11112222: {
      activeProfileId: 'default',
      defaultProfileId: 'default',
      profiles: { default: profile() },
    },
    bbbb33334444: {
      activeProfileId: 'default',
      defaultProfileId: 'default',
      profiles: { default: profile() },
    },
  };
  controller.selectedDeviceId = 'aaaa11112222';
  controller.focusStatus = { platform: 'linux', editorFocused: false };
  controller.refreshLiveStates = () => {};
  controller.renderAll = () => {};
  controller.api = {
    async runProfileOperation(deviceId, operation) {
      operations.push([deviceId, operation]);
      const device = structuredClone(controller.devices[deviceId]);
      device.profiles[operation.profileId].activePage = operation.page;
      return device;
    },
  };
  controller.profileSwitcher.api = controller.api;
  controller.scheduleSync = (...args) => syncs.push(args);
  controller.sessions.set('aaaa11112222', {
    committedProfileId: 'default',
    profileInputBlocked: false,
    async send(bytes) {
      sent.push(JSON.parse(Buffer.from(bytes).toString('utf8')));
    },
  });

  const changed = await controller.profileSwitcher.switchProfiles({
    platform: 'linux',
    processId: 123,
    identities: [{ kind: 'wmClass', value: 'OBS' }],
  });

  assert.deepEqual(changed, ['aaaa11112222', 'bbbb33334444']);
  assert.deepEqual(
    operations.map(([, operation]) => operation.type),
    ['set-active-page', 'set-active-page'],
  );
  assert.deepEqual(sent, [{ type: 'page', index: 1 }]);
  assert.deepEqual(syncs, []);
  assert.equal(
    controller.devices.bbbb33334444.profiles.default.activePage,
    1,
  );
});

test('profile focus switch stores its matched page before full sync', async () => {
  const controller = createRuntime();
  const syncs = [];
  const profile = (appMatches = {}, pageMatches = {}) => ({
    activePage: 0,
    defaultPage: 0,
    appMatches,
    pages: [
      { appMatches: {} },
      { appMatches: pageMatches },
    ],
  });
  controller.devices = {
    aaaa11112222: {
      activeProfileId: 'default',
      defaultProfileId: 'default',
      profiles: {
        default: profile(),
        obs: profile(
          { linux: { kind: 'wmClass', value: 'obs' } },
          { linux: { kind: 'wmClass', value: 'obs' } },
        ),
      },
    },
  };
  controller.focusStatus = { platform: 'linux', editorFocused: false };
  controller.renderAll = () => {};
  controller.api = {
    async runProfileOperation(deviceId, operation) {
      assert.deepEqual(operation, {
        type: 'focus-select',
        profileId: 'obs',
        page: 1,
      });
      const device = structuredClone(controller.devices[deviceId]);
      device.activeProfileId = operation.profileId;
      device.profiles[operation.profileId].activePage = operation.page;
      return device;
    },
  };
  controller.profileSwitcher.api = controller.api;
  controller.scheduleSync = (deviceId, delay) => {
    syncs.push([
      deviceId,
      delay,
      controller.devices[deviceId].profiles.obs.activePage,
    ]);
  };

  await controller.profileSwitcher.switchProfiles({
    platform: 'linux',
    processId: 123,
    identities: [{ kind: 'wmClass', value: 'obs' }],
  });

  assert.equal(controller.devices.aaaa11112222.activeProfileId, 'obs');
  assert.equal(controller.devices.aaaa11112222.profiles.obs.activePage, 1);
  assert.deepEqual(syncs, [['aaaa11112222', 0, 1]]);
});

test('page focus switching keeps only the latest queued snapshot', async () => {
  const controller = createRuntime();
  const calls = [];
  const sent = [];
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  controller.devices = {
    aaaa11112222: {
      activeProfileId: 'default',
      defaultProfileId: 'default',
      profiles: {
        default: {
          activePage: 0,
          defaultPage: 0,
          appMatches: {},
          pages: [
            { appMatches: {} },
            {
              appMatches: {
                linux: { kind: 'wmClass', value: 'obs' },
              },
            },
          ],
        },
      },
    },
  };
  controller.focusStatus = { platform: 'linux', editorFocused: false };
  controller.refreshLiveStates = () => {};
  controller.renderAll = () => {};
  controller.api = {
    async runProfileOperation(deviceId, operation) {
      calls.push(operation.page);

      if (calls.length === 1) {
        await firstBlocked;
      }

      const device = structuredClone(controller.devices[deviceId]);
      device.profiles.default.activePage = operation.page;
      return device;
    },
  };
  controller.profileSwitcher.api = controller.api;
  controller.sessions.set('aaaa11112222', {
    committedProfileId: 'default',
    profileInputBlocked: false,
    async send(bytes) {
      sent.push(JSON.parse(Buffer.from(bytes).toString('utf8')).index);
    },
  });
  const snapshot = (value) => ({
    platform: 'linux',
    processId: 123,
    identities: [{ kind: 'wmClass', value }],
  });

  const running = controller.queueAutoSwitch(snapshot('obs'));
  await Promise.resolve();
  controller.queueAutoSwitch(snapshot('browser'));
  releaseFirst();
  await running;

  assert.deepEqual(calls, [1]);
  assert.deepEqual(sent, [1]);
  assert.equal(
    controller.devices.aaaa11112222.profiles.default.activePage,
    1,
  );
});

test('focused-app auto-switch keeps only the latest queued snapshot', async () => {
  const controller = createRuntime();
  const calls = [];
  const syncs = [];
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const profile = (appMatches = {}) => ({
    activePage: 0,
    defaultPage: 0,
    appMatches,
    pages: [{}],
  });
  controller.devices = {
    aaaa11112222: {
      activeProfileId: 'default',
      defaultProfileId: 'default',
      profiles: {
        default: profile(),
        obs: profile({ linux: { kind: 'wmClass', value: 'obs' } }),
        code: profile({ linux: { kind: 'processName', value: 'code' } }),
      },
    },
  };
  controller.focusStatus = { platform: 'linux', editorFocused: false };
  controller.api = {
    async runProfileOperation(deviceId, operation) {
      calls.push(operation.profileId);

      if (calls.length === 1) {
        await firstBlocked;
      }

      return {
        ...structuredClone(controller.devices[deviceId]),
        activeProfileId: operation.profileId,
      };
    },
  };
  controller.profileSwitcher.api = controller.api;
  controller.scheduleSync = (deviceId, delay) => {
    syncs.push([deviceId, delay, controller.devices[deviceId].activeProfileId]);
  };
  const snapshot = (identities) => ({
    platform: 'linux',
    processId: 123,
    identities,
  });

  const running = controller.queueAutoSwitch(snapshot([
    { kind: 'wmClass', value: 'OBS' },
  ]));
  await Promise.resolve();
  controller.queueAutoSwitch(snapshot([
    { kind: 'processName', value: 'code' },
  ]));
  controller.queueAutoSwitch(snapshot([
    { kind: 'wmClass', value: 'browser' },
  ]));
  releaseFirst();
  await running;

  assert.deepEqual(calls, ['obs']);
  assert.deepEqual(syncs, [['aaaa11112222', 0, 'obs']]);
  assert.equal(controller.devices.aaaa11112222.activeProfileId, 'obs');
});

test('session attach and detach own runtime state and cleanup', async () => {
  const controller = createRuntime();
  const deviceId = 'aaaa11112222';
  const syncs = [];
  let renders = 0;
  controller.api = {
    async registerDeck(id, boardId, name) {
      return {
        name,
        boardId,
        activeProfileId: 'default',
        profiles: { default: { activePage: 0, pages: [] } },
      };
    },
  };
  controller.scheduleSync = (...args) => syncs.push(args);
  controller.renderAll = () => {
    renders++;
  };
  const session = {
    hello: { deviceId, boardId: 'test-board', features: [] },
  };

  await controller.attachSession(session, { name: 'Test' });

  assert.equal(controller.sessionFor(deviceId), session);
  assert.equal(session.committedProfileId, null);
  assert.equal(session.profileInputBlocked, true);
  assert.equal(controller.selectedDeviceId, deviceId);
  assert.deepEqual(syncs, [[deviceId, 0]]);

  controller.liveQueues.set(deviceId, new Map([['0:0', {}]]));
  controller.detachSession(session);

  assert.equal(controller.hasSession(deviceId), false);
  assert.equal(controller.liveQueues.has(deviceId), false);
  assert.equal(renders, 2);
});

test('presses are gated until the first profile sync commits', async () => {
  const controller = createRuntime();
  let releaseSync;
  let markStarted;
  const syncStarted = new Promise((resolve) => {
    markStarted = resolve;
  });
  const slowSync = new Promise((resolve) => {
    releaseSync = resolve;
  });
  const actions = [];
  const session = {
    hello: { deviceId: 'aaaa11112222' },
    committedProfileId: null,
    profileInputBlocked: true,
    send: async () => {},
  };
  controller.devices = {
    aaaa11112222: {
      activeProfileId: 'default',
      profiles: {
        default: {
          activePage: 0,
          keyPx: {},
          pages: [{
            rows: 1,
            cols: 1,
            keys: [{
              index: 0,
              action: { type: 'media', command: 'volume-up' },
            }],
          }],
        },
      },
    },
  };
  controller.sessions = new Map([['aaaa11112222', session]]);
  controller.syncRunning = new Map();
  controller.liveRunning = new Set();
  controller.pending = new Map();
  controller.setSyncStatus = () => {};
  controller.refreshLiveStates = () => {};
  controller.syncPage = async () => {
    markStarted();
    await slowSync;
  };
  controller.runKeyAction = (_deviceId, action) => actions.push(action);

  const syncing = controller.syncDevice('aaaa11112222');
  await syncStarted;
  controller.handleDeviceMessage(session, {
    type: 'press',
    page: 0,
    index: 0,
    phase: 'down',
  });
  assert.deepEqual(actions, []);

  releaseSync();
  await syncing;
  controller.handleDeviceMessage(session, {
    type: 'press',
    page: 0,
    index: 0,
    phase: 'down',
  });
  assert.deepEqual(actions, [{ type: 'media', command: 'volume-up' }]);
});

test('slow profile switches never resolve old pixels against new actions', async () => {
  const controller = createRuntime();
  let releaseSync;
  let markStarted;
  const syncStarted = new Promise((resolve) => {
    markStarted = resolve;
  });
  const slowSync = new Promise((resolve) => {
    releaseSync = resolve;
  });
  const actions = [];
  const profile = (command) => ({
    activePage: 0,
    keyPx: {},
    pages: [
      {
        rows: 1,
        cols: 1,
        keys: [{ index: 0, action: { type: 'media', command } }],
      },
      { rows: 1, cols: 1, keys: [] },
    ],
  });
  const session = {
    hello: { deviceId: 'aaaa11112222' },
    committedProfileId: 'default',
    profileInputBlocked: false,
    send: async () => {},
  };
  controller.devices = {
    aaaa11112222: {
      activeProfileId: 'live',
      profiles: {
        default: profile('mute'),
        live: profile('volume-up'),
      },
    },
  };
  controller.sessions = new Map([['aaaa11112222', session]]);
  controller.syncRunning = new Map();
  controller.liveRunning = new Set();
  controller.pending = new Map();
  controller.setSyncStatus = () => {};
  controller.refreshLiveStates = () => {};
  controller.syncPage = async () => {
    markStarted();
    await slowSync;
  };
  controller.runKeyAction = (_deviceId, action, origin) =>
    actions.push([action.command, origin.profileId]);

  const syncing = controller.syncDevice('aaaa11112222');
  await syncStarted;
  controller.handleDeviceMessage(session, {
    type: 'press',
    page: 0,
    index: 0,
    phase: 'down',
  });
  assert.deepEqual(actions, []);

  releaseSync();
  await syncing;
  assert.equal(session.committedProfileId, 'live');
  controller.handleDeviceMessage(session, {
    type: 'press',
    page: 0,
    index: 0,
    phase: 'down',
  });
  assert.deepEqual(actions, [['volume-up', 'live']]);

  session.committedProfileId = 'default';
  session.profileInputBlocked = false;
  controller.devices.aaaa11112222.activeProfileId = 'default';
  const persisted = [];
  controller.persistProfile = (...args) => persisted.push(args);
  controller.handleDeviceMessage(session, {
    type: 'page',
    index: 1,
  });
  assert.equal(
    controller.devices.aaaa11112222.profiles.default.activePage,
    1,
  );
  assert.equal(
    controller.devices.aaaa11112222.profiles.live.activePage,
    0,
  );
  assert.deepEqual(persisted, [['aaaa11112222', 'default']]);
});

test('same Multi Action key cannot overlap while other keys may run', async () => {
  const controller = createRuntime();
  let release;
  const firstRun = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  controller.multiRuns = new Set();
  controller.sessions = new Map();
  controller.devices = {
    aaaa11112222: {
      activeProfileId: 'default',
      profiles: { default: { pages: [{}] } },
    },
  };
  controller.api = {
    async runAction(action) {
      calls.push(action.command);

      if (calls.length === 1) {
        await firstRun;
      }
    },
  };
  controller.setSyncStatus = () => {};
  const action = {
    type: 'multi',
    steps: [{ type: 'media', command: 'mute' }],
  };
  const origin = { profileId: 'default', page: 0, index: 1 };

  const running = controller.runKeyAction('aaaa11112222', action, origin);
  await Promise.resolve();
  await controller.runKeyAction('aaaa11112222', action, origin);
  await controller.runKeyAction('aaaa11112222', action, {
    ...origin,
    index: 2,
  });
  assert.deepEqual(calls, ['mute', 'mute']);

  release();
  await running;
  assert.equal(controller.multiRuns.size, 0);
});

test('Multi Actions cancel when their profile changes or device disconnects', async () => {
  for (const cancellation of ['profile', 'disconnect']) {
    const controller = createRuntime();
    const session = {};
    const calls = [];
    const statuses = [];
    controller.multiRuns = new Set();
    controller.sessions = new Map([['aaaa11112222', session]]);
    controller.devices = {
      aaaa11112222: {
        activeProfileId: 'default',
        profiles: {
          default: { pages: [{}] },
          other: { pages: [{}] },
        },
      },
    };
    controller.api = {
      async runAction(action) {
        calls.push(action.command);

        if (cancellation === 'profile') {
          controller.devices.aaaa11112222.activeProfileId = 'other';
        } else {
          controller.sessions.delete('aaaa11112222');
        }
      },
    };
    controller.setSyncStatus = (...status) => statuses.push(status);

    await controller.runKeyAction(
      'aaaa11112222',
      {
        type: 'multi',
        steps: [
          { type: 'media', command: 'mute' },
          { type: 'media', command: 'volume-up' },
        ],
      },
      { profileId: 'default', page: 0, index: 1 },
    );

    assert.deepEqual(calls, ['mute']);
    assert.match(statuses[0][0], /canceled before step 2/);
  }
});

test('Multi Action keys do not emit firmware goPage targets', async () => {
  const controller = createRuntime();
  const sent = [];
  controller.boardLimits = new Map();
  controller.awaitReply = () => Promise.resolve({
    type: 'layout-ack',
    page: 0,
    rows: 1,
    cols: 1,
    keyPx: 64,
    needImages: [],
  });
  const profile = {
    boardId: 'test-board',
    pages: [{
      name: 'Main',
      rows: 1,
      cols: 1,
      keys: [{
        index: 0,
        action: {
          type: 'multi',
          steps: [{ type: 'page', page: 0 }],
        },
      }],
    }],
  };

  await controller.sendLayout(
    'aaaa11112222',
    { send: async (bytes) => sent.push(bytes) },
    profile,
    0,
    profile.pages[0],
    new Map(),
  );

  const layout = JSON.parse(Buffer.from(sent[0]).toString('utf8'));
  assert.equal(layout.keys[0].goPage, undefined);
});
