const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const loaderInstances = [];
const transportInstances = [];
class FakeTransport {
  constructor(port) {
    this.port = port;
    transportInstances.push(this);
  }

  async disconnect() {}
}
class FakeLoader {
  constructor(options) {
    this.options = options;
    this.chip = { CHIP_NAME: 'ESP32-P4' };
    loaderInstances.push(this);
  }

  async main() {
    return 'ESP32-P4';
  }

  async writeFlash(options) {
    this.writeOptions = options;
  }
}

const loadModule = Module._load;
Module._load = function loadWithoutEsptool(request, ...arguments_) {
  return request === 'esptool-js'
    ? { ESPLoader: FakeLoader, Transport: FakeTransport }
    : loadModule.call(this, request, ...arguments_);
};
const {
  DeviceController,
  runFlashWithFallback,
} = require('../src/renderer/device');
Module._load = loadModule;

const TEST_BOARD_ID = 'elecrow-crowpanel-advanced-10-1-esp32-p4';
const TEST_FIRMWARE_VERSION = '0.1.7';

function protocolController() {
  const controller = Object.create(DeviceController.prototype);
  controller.sessions = new Map();
  controller.boards = new Map([[TEST_BOARD_ID, {}]]);
  controller.touchStatus = {};
  controller.appendLog = () => {};
  controller.updateDeviceStatusSummary = () => {};
  controller.deckRuntime = null;
  return controller;
}

function fakeProtocolPort(onWrite = () => {}) {
  let readableController;
  const state = { closes: 0, opens: 0, writes: 0 };
  const port = {
    readable: null,
    writable: null,
    async close() {
      state.closes++;
    },
    async open(options) {
      state.opens++;
      state.openOptions = options;
      this.readable = new ReadableStream({
        start(controller) {
          readableController = controller;
        },
      });
      this.writable = new WritableStream({
        write: async (bytes) => {
          state.writes++;
          await onWrite({
            bytes,
            readableController,
            writeCount: state.writes,
          });
        },
      });
    },
    state,
  };

  return port;
}

test('restarts a failed high-speed flash once at the safe baud', async () => {
  const attempts = [];
  const fallbacks = [];
  const result = await runFlashWithFallback({
    preferredBaud: 921600,
    runAttempt: async (baudrate) => {
      attempts.push(baudrate);

      if (baudrate === 921600) {
        throw new Error('link lost after a partial write');
      }

      return 'complete';
    },
    onFallback: async (error) => fallbacks.push(error.message),
  });

  assert.equal(result, 'complete');
  assert.deepEqual(attempts, [921600, 460800]);
  assert.deepEqual(fallbacks, ['link lost after a partial write']);
});

test('does not retry a wrong-chip validation failure', async () => {
  const error = new Error('wrong chip');
  error.noBaudFallback = true;
  let attempts = 0;

  await assert.rejects(
    runFlashWithFallback({
      preferredBaud: 921600,
      runAttempt: async () => {
        attempts++;
        throw error;
      },
    }),
    /wrong chip/,
  );
  assert.equal(attempts, 1);
});

test('sector-erases by default and keeps explicit full erase available', async () => {
  const controller = Object.create(DeviceController.prototype);
  controller.flashStatus = {};
  controller.appendLog = () => {};
  controller.setProgress = () => {};
  const firmware = {
    board: { chip: 'ESP32-P4' },
    images: [{ address: 0, data: new Uint8Array([0xe9]) }],
  };

  loaderInstances.length = 0;
  transportInstances.length = 0;
  await controller.flashFirmwareAttempt({}, firmware, 921600, false);
  await controller.flashFirmwareAttempt({}, firmware, 460800, true);

  assert.deepEqual(
    loaderInstances.map((loader) => loader.options.baudrate),
    [921600, 460800],
  );
  assert.equal(loaderInstances[0].writeOptions.eraseAll, false);
  assert.equal(loaderInstances[0].writeOptions.compress, true);
  assert.equal(loaderInstances[1].writeOptions.eraseAll, true);
  assert.equal(transportInstances.length, 2);
});

test('manual post-flash reset skips RTS and uses one 90-second session', async () => {
  const controller = Object.create(DeviceController.prototype);
  const board = {
    chip: 'ESP32-P4',
    firmwareVersion: TEST_FIRMWARE_VERSION,
    id: TEST_BOARD_ID,
    postFlashReset: 'manual',
  };
  const loader = {
    afterCalls: [],
    async after(...arguments_) {
      this.afterCalls.push(arguments_);
    },
  };
  const transport = {
    disconnectCalls: 0,
    async disconnect() {
      this.disconnectCalls++;
    },
  };
  const opened = [];
  const statuses = [];
  const progress = [];
  const logs = [];

  controller.selectedBoard = () => board;
  controller.selectedPort = {};
  controller.selectedPortBoardId = board.id;
  controller.confirmRevision = { checked: true };
  controller.fullErase = { checked: false };
  controller.flashStatus = {};
  controller.beginOperation = () => true;
  controller.endOperation = () => {};
  controller.clearLog = () => {};
  controller.setProgress = (value) => progress.push(value);
  controller.setDeviceStatus = (...arguments_) => statuses.push(arguments_);
  controller.appendLog = (message) => logs.push(message);
  controller.closeSessionForPort = async () => {};
  controller.api = {
    getBoardFirmware: async () => ({
      board: { ...board, preferredFlashBaud: 921600 },
      images: [{ address: 0, data: new Uint8Array([0xe9]) }],
    }),
  };
  controller.flashFirmwareAttempt = async () => ({ loader, transport });
  controller.openSession = async (...arguments_) => {
    opened.push(arguments_);
    const error = new Error('Timed out waiting for the device hello.');
    error.code = 'DEVICE_HANDSHAKE_TIMEOUT';
    throw error;
  };
  controller.showTouchTest = () => {
    throw new Error('Touch test must not open after a timeout.');
  };

  await controller.flashSelectedBoard();

  assert.deepEqual(loader.afterCalls, []);
  assert.equal(transport.disconnectCalls, 1);
  assert.deepEqual(opened, [
    [controller.selectedPort, board.id, board.firmwareVersion, 90000],
  ]);
  assert.equal(progress.at(-1), 100);
  assert.equal(
    controller.flashStatus.textContent,
    'Firmware was written and verified; press RST or power-cycle, then Reconnect',
  );
  assert.deepEqual(statuses.at(-1), [
    'Firmware was written and verified; press RST or power-cycle, then Reconnect',
    'error',
  ]);
  assert.match(logs.join('\n'), /Press and release RST now/);
  assert.doesNotMatch(controller.flashStatus.textContent, /Flash failed/);
});

test('one open session accepts a delayed hello after retrying', async () => {
  const controller = protocolController();
  const hello = new TextEncoder().encode(
    `${JSON.stringify({
      boardId: TEST_BOARD_ID,
      deviceId: '0123456789ab',
      features: [],
      firmwareVersion: TEST_FIRMWARE_VERSION,
      protocol: 1,
      type: 'hello',
    })}\n`,
  );
  const port = fakeProtocolPort(({ readableController, writeCount }) => {
    if (writeCount === 2) {
      readableController.enqueue(hello);
    }
  });

  const result = await controller.openSession(
    port,
    TEST_BOARD_ID,
    TEST_FIRMWARE_VERSION,
    2000,
  );

  assert.equal(result.boardId, TEST_BOARD_ID);
  assert.equal(port.state.opens, 1);
  assert.equal(port.state.writes, 2);
  assert.deepEqual(port.state.openOptions, {
    baudRate: 115200,
    bufferSize: 4096,
  });

  await controller.closeSessionForPort(port);
  assert.equal(port.state.closes, 1);
});

test('handshake timeout closes the port and releases stream locks', async () => {
  const controller = protocolController();
  const port = fakeProtocolPort();

  await assert.rejects(
    controller.openSession(
      port,
      TEST_BOARD_ID,
      TEST_FIRMWARE_VERSION,
      100,
    ),
    (error) =>
      error.code === 'DEVICE_HANDSHAKE_TIMEOUT' &&
      /Timed out waiting/.test(error.message),
  );

  assert.equal(port.state.opens, 1);
  assert.equal(port.state.closes, 1);
  assert.equal(port.readable.locked, false);
  assert.equal(port.writable.locked, false);
  assert.equal(controller.sessions.size, 0);
});

test('connects a manually selected COM port to the deck session', async () => {
  const port = {};
  const controller = Object.create(DeviceController.prototype);
  const operations = [];
  let opened;

  controller.document = {
    createElement: () => ({}),
  };
  controller.deckConnectButton = {};
  controller.deckPortSelect = {
    replaceChildren() {},
    selectedOptions: [{ textContent: 'USB Serial Device (COM7)' }],
  };
  controller.deckPortStatus = { dataset: {} };
  controller.serial = {
    requestPort: async () => port,
  };
  controller.beginOperation = (operation) => {
    controller.operation = operation;
    operations.push(`begin:${operation}`);
    return true;
  };
  controller.endOperation = (operation) => {
    operations.push(`end:${operation}`);
    controller.operation = null;
  };
  controller.openSession = async (...arguments_) => {
    opened = arguments_;
  };

  await controller.connectSelectedDevice();

  assert.deepEqual(opened, [port, null]);
  assert.equal(
    controller.deckPortStatus.textContent,
    'If auto-connect misses your deck, choose its USB / COM port.',
  );
  assert.equal(controller.deckPortStatus.dataset.state, 'idle');
  assert.deepEqual(operations, ['begin:deck-select', 'end:deck-select']);
});

test('sends lock and idle policy only to capable devices', async () => {
  const controller = Object.create(DeviceController.prototype);
  const supportedMessages = [];
  const dimmableMessages = [];
  const legacyMessages = [];
  const supported = {
    handshakeComplete: true,
    hello: { features: ['display-control'] },
    send: async (bytes) => {
      supportedMessages.push(JSON.parse(new TextDecoder().decode(bytes)));
    },
  };
  const dimmable = {
    handshakeComplete: true,
    hello: { features: ['display-control', 'display-brightness'] },
    send: async (bytes) => {
      dimmableMessages.push(JSON.parse(new TextDecoder().decode(bytes)));
    },
  };
  const legacy = {
    handshakeComplete: true,
    hello: {},
    send: async (bytes) => {
      legacyMessages.push(bytes);
    },
  };

  controller.sessions = new Map([
    ['supported', supported],
    ['dimmable', dimmable],
    ['legacy', legacy],
  ]);
  controller.displayPolicy = {
    brightnessPercent: 80,
    idleTimeoutMinutes: 10,
    sleepWhenLocked: true,
  };
  controller.machineLocked = false;
  controller.appendLog = () => {};

  await controller.setMachineLocked(true);
  assert.deepEqual(supportedMessages, [
    {
      type: 'display',
      awake: false,
      idleTimeoutSeconds: 600,
    },
  ]);
  assert.deepEqual(dimmableMessages, [
    {
      type: 'display',
      awake: false,
      idleTimeoutSeconds: 600,
      brightness: 80,
    },
  ]);
  assert.deepEqual(legacyMessages, []);

  await controller.setDisplayPolicy({
    brightnessPercent: 35,
    idleTimeoutMinutes: 30,
    sleepWhenLocked: false,
  });
  assert.deepEqual(supportedMessages[1], {
    type: 'display',
    awake: true,
    idleTimeoutSeconds: 1800,
  });
  assert.deepEqual(dimmableMessages[1], {
    type: 'display',
    awake: true,
    idleTimeoutSeconds: 1800,
    brightness: 35,
  });
});

test('applies a locked display policy immediately after reconnect', async () => {
  const controller = Object.create(DeviceController.prototype);
  const messages = [];
  const session = {
    handshakeComplete: true,
    hello: { features: ['display-control', 'display-brightness'] },
    send: async (bytes) => {
      messages.push(JSON.parse(new TextDecoder().decode(bytes)));
    },
  };

  controller.displayPolicy = {
    brightnessPercent: 60,
    idleTimeoutMinutes: 5,
    sleepWhenLocked: true,
  };
  controller.machineLocked = true;

  await controller.applyDisplayPolicyToSession(session);
  assert.deepEqual(messages, [
    {
      type: 'display',
      awake: false,
      idleTimeoutSeconds: 300,
      brightness: 60,
    },
  ]);
});
