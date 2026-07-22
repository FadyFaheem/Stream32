const assert = require('node:assert/strict');
const test = require('node:test');

const { DeckController } = require('../src/renderer/deck');

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
    aaaa11112222: { name: 'Connected deck' },
    bbbb33334444: { name: 'Offline deck' },
  };
  controller.sessions = new Map([['aaaa11112222', {}]]);
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
