const assert = require('node:assert/strict');
const test = require('node:test');

const {
  configureSerialAccess,
  isEspressifUsbSerialJtag,
  normalizeUsbId,
  serialDeviceIdentity,
  serialDeviceMatches,
} = require('../src/serial');

test('serial selection always settles when no supported port exists', async () => {
  let selectionHandler;
  const session = {
    on(eventName, handler) {
      if (eventName === 'select-serial-port') {
        selectionHandler = handler;
      }
    },
    setDevicePermissionHandler() {},
    setPermissionCheckHandler() {},
  };
  const window = { webContents: { session } };
  const selected = [];

  configureSerialAccess(window);
  await selectionHandler(
    { preventDefault() {} },
    [],
    null,
    (portId) => selected.push(portId),
  );

  assert.deepEqual(selected, ['']);
});

test('normalizes USB IDs from Electron metadata', () => {
  assert.equal(normalizeUsbId('0x303A'), '303a');
  assert.equal(normalizeUsbId(0x1001), '1001');
  assert.equal(normalizeUsbId('not-an-id'), null);
});

test('recognizes only the ESP32-S3 USB Serial/JTAG interface', () => {
  assert.equal(
    isEspressifUsbSerialJtag({
      productId: '1001',
      vendorId: '303A',
    }),
    true,
  );
  assert.equal(
    isEspressifUsbSerialJtag({
      productId: '0001',
      vendorId: '303A',
    }),
    false,
  );
});

test('matches remembered devices by stable serial identity', () => {
  const remembered = serialDeviceIdentity({
    portName: 'COM4',
    productId: '1001',
    serialNumber: 'device-a',
    vendorId: '303a',
  });

  assert.equal(
    serialDeviceMatches(remembered, {
      portName: 'COM9',
      productId: '1001',
      serialNumber: 'device-a',
      vendorId: '303a',
    }),
    true,
  );
  assert.equal(
    serialDeviceMatches(remembered, {
      portName: 'COM4',
      productId: '1001',
      serialNumber: 'device-b',
      vendorId: '303a',
    }),
    false,
  );
});
