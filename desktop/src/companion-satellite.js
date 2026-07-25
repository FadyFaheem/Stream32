const net = require('node:net');

const {
  MAX_SATELLITE_LINE_LENGTH,
  decodeText,
  encodeSatelliteMessage,
  normalizeColor,
  parseKeyReference,
  parseSatelliteLine,
} = require('./companion-protocol');
const { MAX_LABEL_LENGTH } = require('./deck-model');

const CONNECT_TIMEOUT_MS = 8000;
const PING_INTERVAL_MS = 2000;
// Companion recommends pinging every two seconds; give a stalled link a few
// missed round trips before tearing it down so a busy host is not dropped.
const PONG_TIMEOUT_MS = 12000;
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000];
// Companion added the stable SERIAL field, used to match a surface to its
// saved configuration across sessions, in Satellite API 1.10.
const SERIAL_API_MINOR = 10;

function parseApiVersion(value) {
  const [major, minor] = String(value || '').split('.').map(Number);
  return {
    major: Number.isInteger(major) ? major : 0,
    minor: Number.isInteger(minor) ? minor : 0,
  };
}

function createCompanionSatellite({
  onEvent = () => {},
  onKeyState = () => {},
  onKeysClear = () => {},
  onStatus = () => {},
}) {
  const surfaces = new Map();
  let config = { host: '127.0.0.1', port: 16622 };
  let socket = null;
  let buffer = '';
  let bufferOverflowed = false;
  let apiVersion = { major: 0, minor: 0 };
  let pingTimer = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let lastPongAt = 0;
  let disposed = false;
  let status = { state: 'idle', message: 'Companion mode is off.' };

  function setStatus(state, message) {
    status = { state, message };
    onStatus({ ...status, host: config.host, port: config.port });
  }

  function sendRaw(line) {
    if (!socket || socket.destroyed) {
      return false;
    }

    return socket.write(line);
  }

  function send(command, params) {
    return sendRaw(encodeSatelliteMessage(command, params));
  }

  function registerSurface(deviceId, surface) {
    send('ADD-DEVICE', {
      DEVICEID: deviceId,
      PRODUCT_NAME: surface.productName,
      KEYS_TOTAL: surface.rows * surface.cols,
      KEYS_PER_ROW: surface.cols,
      BITMAPS: surface.bitmapSize,
      COLORS: 'hex',
      TEXT: true,
      BRIGHTNESS: false,
      ...(apiVersion.major > 1 || apiVersion.minor >= SERIAL_API_MINOR
        ? { SERIAL: `stream32:${deviceId}` }
        : {}),
    });
  }

  function handleKeyState({ command, params }) {
    const deviceId = params.get('DEVICEID');
    const surface = surfaces.get(deviceId);

    if (!surface) {
      return;
    }

    const index = parseKeyReference(
      params.get('KEY') ?? params.get('CONTROLID'),
      surface.cols,
    );

    if (index === null || index >= surface.rows * surface.cols) {
      return;
    }

    const encoded = params.get('BITMAP');
    let bitmap = encoded ? Buffer.from(encoded, 'base64') : null;

    // A self-describing data url means Companion ignored the raw RGB request;
    // drop it rather than pushing an undecodable buffer to the board.
    if (
      bitmap &&
      bitmap.length !== surface.bitmapSize * surface.bitmapSize * 3
    ) {
      bitmap = null;
    }

    onKeyState({
      deviceId,
      index,
      bitmap,
      bitmapSize: surface.bitmapSize,
      color: normalizeColor(params.get('COLOR')),
      labelColor: normalizeColor(params.get('TEXTCOLOR')),
      label: decodeText(params.get('TEXT'), MAX_LABEL_LENGTH),
      command,
    });
  }

  function handleLine(line) {
    if (line.length === 0) {
      return;
    }

    const message = parseSatelliteLine(line);

    switch (message.command) {
      case 'BEGIN': {
        apiVersion = parseApiVersion(message.params.get('APIVERSION'));
        lastPongAt = Date.now();
        reconnectAttempt = 0;
        setStatus(
          'connected',
          `Connected to Companion ${message.params.get('COMPANIONVERSION') || ''}`
            .trim() + '.',
        );
        onEvent('connected', {
          apiVersion: `${apiVersion.major}.${apiVersion.minor}`,
        });

        for (const [deviceId, surface] of surfaces) {
          registerSurface(deviceId, surface);
        }
        break;
      }
      case 'PING':
        // The payload is a bare token that has to come back verbatim.
        sendRaw(`PONG ${(message.status || '').replace(/\s/g, '')}\n`);
        break;
      case 'PONG':
        lastPongAt = Date.now();
        break;
      case 'KEY-STATE':
        handleKeyState(message);
        break;
      case 'KEYS-CLEAR': {
        const deviceId = message.params.get('DEVICEID');

        if (surfaces.has(deviceId)) {
          onKeysClear(deviceId);
        }
        break;
      }
      case 'ADD-DEVICE':
        if (message.status?.toUpperCase() === 'ERROR') {
          const reason = message.params.get('MESSAGE') || 'unknown error';
          setStatus('error', `Companion rejected the surface: ${reason}`);
          onEvent('surface-rejected', { message: reason });
        } else {
          onEvent('surface-registered', {
            deviceId: message.params.get('DEVICEID'),
          });
        }
        break;
      default:
        // BRIGHTNESS, LOCKED-STATE, and future commands are not acted on;
        // Companion does not expect a reply to them.
        break;
    }
  }

  function consume(chunk) {
    buffer += chunk;

    let newline = buffer.indexOf('\n');

    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);

      if (bufferOverflowed) {
        bufferOverflowed = false;
      } else {
        handleLine(line);
      }

      newline = buffer.indexOf('\n');
    }

    if (buffer.length > MAX_SATELLITE_LINE_LENGTH) {
      buffer = '';
      bufferOverflowed = true;
      onEvent('line-dropped', { reason: 'oversized' });
    }
  }

  function stopTimers() {
    clearInterval(pingTimer);
    clearTimeout(reconnectTimer);
    pingTimer = null;
    reconnectTimer = null;
  }

  function closeSocket() {
    const current = socket;
    socket = null;
    buffer = '';
    bufferOverflowed = false;
    apiVersion = { major: 0, minor: 0 };
    current?.destroy();
  }

  function scheduleReconnect(reason) {
    if (disposed || surfaces.size === 0) {
      return;
    }

    const delay = RECONNECT_DELAYS_MS[
      Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)
    ];
    reconnectAttempt++;
    setStatus('error', `${reason} Retrying in ${Math.round(delay / 1000)}s.`);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, delay);
  }

  function connect() {
    if (disposed || socket || surfaces.size === 0) {
      return;
    }

    setStatus('connecting', `Connecting to ${config.host}:${config.port}…`);
    const pending = net.createConnection({
      host: config.host,
      port: config.port,
    });
    socket = pending;
    pending.setNoDelay(true);
    pending.setTimeout(CONNECT_TIMEOUT_MS);
    pending.setEncoding('utf8');
    pending.on('connect', () => {
      pending.setTimeout(0);
      lastPongAt = Date.now();
      clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (socket !== pending) {
          return;
        }

        if (Date.now() - lastPongAt > PONG_TIMEOUT_MS) {
          closeSocket();
          stopTimers();
          scheduleReconnect('Companion stopped responding.');
          return;
        }

        sendRaw(`PING ${Date.now()}\n`);
      }, PING_INTERVAL_MS);
      pingTimer.unref?.();
    });
    pending.on('timeout', () => {
      if (socket === pending) {
        closeSocket();
        stopTimers();
        scheduleReconnect('Companion did not answer.');
      }
    });
    pending.on('data', (chunk) => {
      if (socket === pending) {
        consume(chunk);
      }
    });
    pending.on('error', (error) => {
      if (socket === pending) {
        closeSocket();
        stopTimers();
        scheduleReconnect(`Companion connection failed: ${error.message}.`);
      }
    });
    pending.on('close', () => {
      if (socket === pending) {
        closeSocket();
        stopTimers();
        scheduleReconnect('Companion closed the connection.');
      }
    });
  }

  return {
    addSurface({ deviceId, productName, rows, cols, bitmapSize }) {
      surfaces.set(deviceId, { productName, rows, cols, bitmapSize });

      if (socket && apiVersion.major > 0) {
        registerSurface(deviceId, surfaces.get(deviceId));
      } else {
        clearTimeout(reconnectTimer);
        reconnectAttempt = 0;
        connect();
      }
    },
    dispose() {
      disposed = true;
      surfaces.clear();
      stopTimers();
      closeSocket();
    },
    getStatus() {
      return { ...status, host: config.host, port: config.port };
    },
    keyPress(deviceId, index, pressed) {
      if (!surfaces.has(deviceId)) {
        return;
      }

      send('KEY-PRESS', { DEVICEID: deviceId, KEY: index, PRESSED: pressed });
    },
    removeSurface(deviceId) {
      if (!surfaces.delete(deviceId)) {
        return;
      }

      send('REMOVE-DEVICE', { DEVICEID: deviceId });

      if (surfaces.size === 0) {
        stopTimers();
        closeSocket();
        setStatus('idle', 'Companion mode is off.');
      }
    },
    setConfig(next) {
      if (next.host === config.host && next.port === config.port) {
        return;
      }

      config = { host: next.host, port: next.port };
      stopTimers();
      closeSocket();
      reconnectAttempt = 0;
      connect();
    },
  };
}

module.exports = { createCompanionSatellite };
