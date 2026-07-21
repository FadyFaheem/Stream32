const { dialog } = require('electron');
const { readSettings, updateSettings } = require('./settings');

const ESPRESSIF_USB_SERIAL_JTAG = {
  productId: 0x1001,
  vendorId: 0x303a,
};

function normalizeUsbId(value) {
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 0xffff
  ) {
    return value;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  let parsed;

  if (/^0x[a-f0-9]+$/.test(normalized)) {
    parsed = Number.parseInt(normalized.slice(2), 16);
  } else if (/^[a-f0-9]*[a-f][a-f0-9]*$/.test(normalized)) {
    parsed = Number.parseInt(normalized, 16);
  } else if (/^\d+$/.test(normalized)) {
    // Electron's SerialPort metadata exposes VID/PID as decimal strings.
    parsed = Number.parseInt(normalized, 10);
  } else {
    return null;
  }

  return parsed >= 0 && parsed <= 0xffff ? parsed : null;
}

function decodeTokenToPortId(token) {
  if (typeof token !== 'string' || token.length === 0) {
    return null;
  }

  let bytes;

  try {
    bytes = Buffer.from(token, 'base64');
  } catch {
    return null;
  }

  if (bytes.length !== 16) {
    return null;
  }

  // Electron encodes the port token as two native-endian (little-endian on
  // every supported platform) uint64s, while the picker's portId is the
  // big-endian hex form of the same token.
  const high = Buffer.from(bytes.subarray(0, 8)).reverse();
  const low = Buffer.from(bytes.subarray(8, 16)).reverse();
  return `${high.toString('hex')}${low.toString('hex')}`.toUpperCase();
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }

  return null;
}

// Devices arrive in two shapes: camelCase SerialPort objects from the picker
// and snake_case PortInfoToValue dictionaries during permission checks at
// SerialPort.open() time (name + device_instance_id on Windows, name +
// vendor_id/product_id/serial_number elsewhere, or name + token when the
// entry is not persistent).
function serialDeviceIdentity(device) {
  const vendorId = normalizeUsbId(device?.vendorId ?? device?.vendor_id);
  const productId = normalizeUsbId(device?.productId ?? device?.product_id);
  const serialNumber = firstString(
    device?.serialNumber,
    device?.serial_number,
  );
  const deviceInstanceId = firstString(
    device?.deviceInstanceId,
    device?.device_instance_id,
  );
  const portName = firstString(device?.portName, device?.name);
  const portId = firstString(
    device?.portId,
    decodeTokenToPortId(device?.token),
  );

  if (
    !vendorId &&
    !productId &&
    !serialNumber &&
    !deviceInstanceId &&
    !portName &&
    !portId
  ) {
    return null;
  }

  return {
    vendorId,
    productId,
    serialNumber,
    deviceInstanceId,
    portName,
    portId,
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
  const identityVendorId = normalizeUsbId(identity?.vendorId);
  const identityProductId = normalizeUsbId(identity?.productId);

  if (
    !identity ||
    !candidate ||
    (identityVendorId !== null &&
      candidate.vendorId !== null &&
      identityVendorId !== candidate.vendorId) ||
    (identityProductId !== null &&
      candidate.productId !== null &&
      identityProductId !== candidate.productId)
  ) {
    return false;
  }

  if (identity.deviceInstanceId && candidate.deviceInstanceId) {
    return identity.deviceInstanceId === candidate.deviceInstanceId;
  }

  if (identity.serialNumber && candidate.serialNumber) {
    return identity.serialNumber === candidate.serialNumber;
  }

  if (identity.portId && candidate.portId) {
    return identity.portId === candidate.portId;
  }

  if (identity.portName && candidate.portName) {
    return identity.portName === candidate.portName;
  }

  return (
    identityVendorId !== null &&
    identityProductId !== null &&
    identityVendorId === candidate.vendorId &&
    identityProductId === candidate.productId
  );
}

function getRememberedSerialDevice() {
  return readSettings().serialDevice || null;
}

function rememberSerialDevice(device) {
  const identity = serialDeviceIdentity(device);

  if (!identity) {
    throw new TypeError('The selected serial device has no stable identity.');
  }

  updateSettings({ serialDevice: identity });
  return identity;
}

function portLabel(port) {
  const name = port.displayName || port.portName || 'ESP32-S3';
  const details = [
    port.portName && port.portName !== name ? port.portName : null,
    port.serialNumber || null,
  ].filter(Boolean);
  const suffix = details.length > 0 ? ` (${details.join(' · ')})` : '';

  return `${name}${suffix}`;
}

function configureSerialAccess(
  window,
  {
    getRememberedDevice = getRememberedSerialDevice,
    rememberDevice = rememberSerialDevice,
    showMessageBox = (...args) => dialog.showMessageBox(...args),
  } = {},
) {
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
      details.origin !== 'file://'
    ) {
      return false;
    }

    return (
      serialDeviceMatches(pendingIdentity, details.device) ||
      serialDeviceMatches(getRememberedDevice(), details.device)
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
        const ports = portList.filter((port) =>
          Boolean(serialDeviceIdentity(port)),
        );

        if (ports.length === 0) {
          settle();
          return;
        }

        const cancelId = ports.length;
        const result = await showMessageBox(window, {
          type: 'question',
          title: 'Select a USB or COM port',
          message: 'Choose the serial port connected to your ESP32-S3.',
          detail:
            'Stream32 shows the USB name, COM port, and serial number when ' +
            'the operating system provides them.',
          buttons: [...ports.map(portLabel), 'Cancel'],
          cancelId,
          defaultId: 0,
          noLink: true,
        });

        if (result.response === cancelId) {
          settle();
          return;
        }

        const selected = ports[result.response];
        pendingIdentity = rememberDevice(selected);
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
