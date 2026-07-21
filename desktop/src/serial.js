const { dialog } = require('electron');
const { readSettings, updateSettings } = require('./settings');

const ESPRESSIF_USB_SERIAL_JTAG = {
  productId: '1001',
  vendorId: '303a',
};

function normalizeUsbId(value) {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value.toString(16).padStart(4, '0');
  }

  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.toLowerCase().replace(/^0x/, '').padStart(4, '0');
  return /^[a-f0-9]{4}$/.test(normalized) ? normalized : null;
}

function serialDeviceIdentity(device) {
  const vendorId = normalizeUsbId(device?.vendorId);
  const productId = normalizeUsbId(device?.productId);

  if (!vendorId || !productId) {
    return null;
  }

  return {
    vendorId,
    productId,
    serialNumber:
      typeof device.serialNumber === 'string' ? device.serialNumber : null,
    deviceInstanceId:
      typeof device.deviceInstanceId === 'string'
        ? device.deviceInstanceId
        : null,
    portName: typeof device.portName === 'string' ? device.portName : null,
  };
}

function isEspressifUsbSerialJtag(device) {
  const identity = serialDeviceIdentity(device);

  return (
    identity?.vendorId === ESPRESSIF_USB_SERIAL_JTAG.vendorId &&
    identity?.productId === ESPRESSIF_USB_SERIAL_JTAG.productId
  );
}

function serialDeviceMatches(identity, device) {
  const candidate = serialDeviceIdentity(device);

  if (
    !identity ||
    !candidate ||
    identity.vendorId !== candidate.vendorId ||
    identity.productId !== candidate.productId
  ) {
    return false;
  }

  if (identity.serialNumber) {
    return identity.serialNumber === candidate.serialNumber;
  }

  if (identity.deviceInstanceId) {
    return identity.deviceInstanceId === candidate.deviceInstanceId;
  }

  return Boolean(identity.portName && identity.portName === candidate.portName);
}

function getRememberedSerialDevice() {
  return readSettings().serialDevice || null;
}

function rememberSerialDevice(device) {
  const identity = serialDeviceIdentity(device);

  if (!identity || !isEspressifUsbSerialJtag(identity)) {
    throw new TypeError('Only the supported Espressif USB device can be saved.');
  }

  updateSettings({ serialDevice: identity });
  return identity;
}

function portLabel(port) {
  const name = port.displayName || port.portName || 'ESP32-S3';
  const suffix = port.serialNumber
    ? ` (${port.serialNumber})`
    : port.portName && port.displayName
      ? ` (${port.portName})`
      : '';

  return `${name}${suffix}`;
}

function configureSerialAccess(window) {
  const session = window.webContents.session;
  let pendingIdentity = null;

  session.setPermissionCheckHandler(
    (_webContents, permission, requestingOrigin, details) =>
      permission === 'serial' &&
      (requestingOrigin === 'file://' ||
        details?.securityOrigin === 'file:///'),
  );

  session.setDevicePermissionHandler((details) => {
    if (
      details.deviceType !== 'serial' ||
      details.origin !== 'file://' ||
      !isEspressifUsbSerialJtag(details.device)
    ) {
      return false;
    }

    return (
      serialDeviceMatches(pendingIdentity, details.device) ||
      serialDeviceMatches(getRememberedSerialDevice(), details.device)
    );
  });

  session.on(
    'select-serial-port',
    async (event, portList, _webContents, callback) => {
      event.preventDefault();
      let settled = false;

      function settle(portId = '') {
        if (!settled) {
          settled = true;
          callback(portId);
        }
      }

      try {
        const ports = portList.filter(isEspressifUsbSerialJtag);

        if (ports.length === 0) {
          settle();
          return;
        }

        let selected = ports[0];

        if (ports.length > 1) {
          const cancelId = ports.length;
          const result = await dialog.showMessageBox(window, {
            type: 'question',
            title: 'Select an ESP32-S3',
            message: 'Choose the ESP32-S3 to flash.',
            detail: 'The board revision is selected separately in Stream32.',
            buttons: [...ports.map(portLabel), 'Cancel'],
            cancelId,
            defaultId: 0,
            noLink: true,
          });

          if (result.response === cancelId) {
            settle();
            return;
          }

          selected = ports[result.response];
        }

        pendingIdentity = rememberSerialDevice(selected);
        settle(selected.portId);
      } catch (error) {
        console.error('Serial port selection failed:', error);
        settle();
      }
    },
  );
}

module.exports = {
  ESPRESSIF_USB_SERIAL_JTAG,
  configureSerialAccess,
  getRememberedSerialDevice,
  isEspressifUsbSerialJtag,
  normalizeUsbId,
  rememberSerialDevice,
  serialDeviceIdentity,
  serialDeviceMatches,
};
