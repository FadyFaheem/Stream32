const assert = require('node:assert/strict');
const test = require('node:test');

const {
  configureSerialAccess,
  isEspressifUsbSerialJtag,
  normalizeUsbId,
  serialDeviceIdentity,
  serialDeviceMatches,
} = require('../src/serial');

test('publishes an empty inline port list and settles cancellation', async () => {
  let selectionHandler;
  const messages = [];
  const session = {
    on(eventName, handler) {
      if (eventName === 'select-serial-port') {
        selectionHandler = handler;
      }
    },
    setDevicePermissionHandler() {},
    setPermissionCheckHandler() {},
  };
  const window = {
    webContents: {
      send(channel, payload) {
        messages.push({ channel, payload });
      },
      session,
    },
  };
  const selected = [];

  const access = configureSerialAccess(window, {
    getRememberedDevice: () => null,
  });
  await selectionHandler(
    { preventDefault() {} },
    [],
    null,
    (portId) => selected.push(portId),
  );

  assert.deepEqual(messages, [
    {
      channel: 'serial:port-list',
      payload: { ports: [], requestId: 1 },
    },
  ]);
  assert.deepEqual(selected, []);
  assert.equal(access.selectPort(1, ''), true);
  assert.deepEqual(selected, ['']);
});

test('selects a USB port from the inline renderer list', async () => {
  let selectionHandler;
  const messages = [];
  const session = {
    on(eventName, handler) {
      if (eventName === 'select-serial-port') {
        selectionHandler = handler;
      }
    },
    setDevicePermissionHandler() {},
    setPermissionCheckHandler() {},
  };
  const window = {
    webContents: {
      send(channel, payload) {
        messages.push({ channel, payload });
      },
      session,
    },
  };
  const port = {
    displayName: 'USB-SERIAL CH340',
    portId: 'port-1',
    portName: 'COM7',
    productId: '29987',
    serialNumber: 'aabbccddeeff',
    vendorId: '6790',
  };
  const selected = [];

  const access = configureSerialAccess(window, {
    getRememberedDevice: () => null,
    rememberDevice: serialDeviceIdentity,
  });
  await selectionHandler(
    { preventDefault() {} },
    [port],
    null,
    (portId) => selected.push(portId),
  );

  assert.deepEqual(messages, [
    {
      channel: 'serial:port-list',
      payload: {
        ports: [
          {
            id: 'port-1',
            label: 'USB-SERIAL CH340 (COM7 · aabbccddeeff)',
          },
        ],
        requestId: 1,
      },
    },
  ]);
  assert.equal(access.selectPort(1, 'not-a-port'), false);
  assert.deepEqual(selected, []);
  assert.equal(access.selectPort(1, 'port-1'), true);
  assert.deepEqual(selected, ['port-1']);
});

test('normalizes USB IDs from Electron metadata', () => {
  assert.equal(normalizeUsbId('0x303A'), 0x303a);
  assert.equal(normalizeUsbId(0x1001), 0x1001);
  assert.equal(normalizeUsbId('12346'), 0x303a);
  assert.equal(normalizeUsbId('4097'), 0x1001);
  assert.equal(normalizeUsbId('not-an-id'), null);
});

test('recognizes only the ESP32-S3 USB Serial/JTAG interface', () => {
  assert.equal(
    isEspressifUsbSerialJtag({
      productId: '4097',
      vendorId: '12346',
    }),
    true,
  );
  assert.equal(
    isEspressifUsbSerialJtag({
      productId: '1',
      vendorId: '12346',
    }),
    false,
  );
});

test('matches remembered devices by stable serial identity', () => {
  const remembered = serialDeviceIdentity({
    portName: 'COM4',
    productId: '4097',
    serialNumber: 'device-a',
    vendorId: '12346',
  });

  assert.equal(
    serialDeviceMatches(remembered, {
      portName: 'COM9',
      productId: '0x1001',
      serialNumber: 'device-a',
      vendorId: '0x303a',
    }),
    true,
  );
  assert.equal(
    serialDeviceMatches(remembered, {
      portName: 'COM4',
      productId: '4097',
      serialNumber: 'device-b',
      vendorId: '12346',
    }),
    false,
  );
});

test('supports serial ports without USB VID/PID metadata', () => {
  const remembered = serialDeviceIdentity({ portName: 'COM8' });

  assert.deepEqual(remembered, {
    deviceInstanceId: null,
    portName: 'COM8',
    portId: null,
    productId: null,
    serialNumber: null,
    vendorId: null,
  });
  assert.equal(
    serialDeviceMatches(remembered, { portName: 'COM8' }),
    true,
  );
});

test('matches when Electron omits serial metadata during permission checks', () => {
  const remembered = serialDeviceIdentity({
    deviceInstanceId: 'USB\\VID_303A&PID_1001\\device',
    portName: 'COM5',
    productId: '4097',
    serialNumber: 'device-a',
    vendorId: '12346',
  });

  assert.equal(
    serialDeviceMatches(remembered, {
      deviceInstanceId: 'USB\\VID_303A&PID_1001\\device',
      portName: 'COM5',
      productId: '4097',
      vendorId: '12346',
    }),
    true,
  );
});

test('matches the snake_case device shape used by SerialPort.open checks', () => {
  const remembered = serialDeviceIdentity({
    deviceInstanceId: 'USB\\VID_303A&PID_1001&MI_00\\7&27970455&0&0000',
    displayName: 'USB JTAG/serial debug unit',
    portId: '5D3F6E9C65834BBB438D07DFC1E632A9',
    portName: 'COM5',
    productId: '4097',
    serialNumber: null,
    vendorId: '12346',
  });

  // Windows open-time shape: only name + device_instance_id.
  assert.equal(
    serialDeviceMatches(remembered, {
      device_instance_id: 'USB\\VID_303A&PID_1001&MI_00\\7&27970455&0&0000',
      name: 'USB JTAG/serial debug unit',
    }),
    true,
  );

  // Non-Windows open-time shape: name + vendor/product/serial numbers.
  const posixRemembered = serialDeviceIdentity({
    portId: 'AABBCCDDEEFF00112233445566778899',
    portName: 'ttyACM0',
    productId: '4097',
    serialNumber: 'device-a',
    vendorId: '12346',
  });
  assert.equal(
    serialDeviceMatches(posixRemembered, {
      name: 'USB JTAG/serial debug unit',
      product_id: 4097,
      serial_number: 'device-a',
      vendor_id: 12346,
    }),
    true,
  );

  // Ephemeral open-time shape: name + base64 token of the picker portId.
  const portIdHex = '5D3F6E9C65834BBB438D07DFC1E632A9';
  const token = Buffer.concat([
    Buffer.from(portIdHex.slice(0, 16), 'hex').reverse(),
    Buffer.from(portIdHex.slice(16), 'hex').reverse(),
  ]).toString('base64');
  const ephemeralRemembered = serialDeviceIdentity({
    portId: portIdHex,
    portName: 'COM5',
  });
  assert.equal(
    serialDeviceMatches(ephemeralRemembered, {
      name: 'USB JTAG/serial debug unit',
      token,
    }),
    true,
  );
});
