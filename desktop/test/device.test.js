const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const loadModule = Module._load;
Module._load = function loadWithoutEsptool(request, ...arguments_) {
  return request === 'esptool-js'
    ? { ESPLoader: class {}, Transport: class {} }
    : loadModule.call(this, request, ...arguments_);
};
const { DeviceController } = require('../src/renderer/device');
Module._load = loadModule;

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
