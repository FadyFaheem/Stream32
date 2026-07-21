const MAX_PROTOCOL_LINE_LENGTH = 4096;
const BOARD_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DEVICE_ID_PATTERN = /^[a-f0-9]{12}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function normalizeChipName(value) {
  return String(value)
    .trim()
    .toUpperCase()
    .replace(/[\s_]+/g, '-');
}

function isExpectedChip(actual, expected) {
  const actualName = normalizeChipName(actual);
  const expectedName = normalizeChipName(expected);

  return (
    actualName === expectedName ||
    actualName.startsWith(`${expectedName}-`) ||
    actualName.startsWith(`${expectedName}(`)
  );
}

function encodeHostHello(protocolVersion = 1) {
  return new TextEncoder().encode(
    `${JSON.stringify({ type: 'hello', protocol: protocolVersion })}\n`,
  );
}

function validateDeviceHello(
  message,
  expectedBoardId,
  protocolVersion = 1,
  expectedFirmwareVersion = null,
) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new TypeError('Device response must be an object.');
  }

  if (message.type !== 'hello') {
    throw new TypeError('Device did not send a hello response.');
  }

  if (message.protocol !== protocolVersion) {
    throw new TypeError(
      `Device protocol ${message.protocol} is not supported.`,
    );
  }

  if (
    typeof message.boardId !== 'string' ||
    !BOARD_ID_PATTERN.test(message.boardId)
  ) {
    throw new TypeError('Device board id is invalid.');
  }

  if (expectedBoardId && message.boardId !== expectedBoardId) {
    throw new TypeError(
      `Connected device is ${message.boardId}, not ${expectedBoardId}.`,
    );
  }

  if (
    typeof message.firmwareVersion !== 'string' ||
    !VERSION_PATTERN.test(message.firmwareVersion)
  ) {
    throw new TypeError('Device firmware version is invalid.');
  }

  if (
    expectedFirmwareVersion &&
    message.firmwareVersion !== expectedFirmwareVersion
  ) {
    throw new TypeError(
      `Device reported firmware ${message.firmwareVersion}, expected ` +
        `${expectedFirmwareVersion}.`,
    );
  }

  if (
    typeof message.deviceId !== 'string' ||
    !DEVICE_ID_PATTERN.test(message.deviceId)
  ) {
    throw new TypeError('Device identity is invalid.');
  }

  return {
    boardId: message.boardId,
    deviceId: message.deviceId,
    firmwareVersion: message.firmwareVersion,
    protocol: message.protocol,
    type: 'hello',
  };
}

function validateTouchMessage(message) {
  if (
    !message ||
    message.type !== 'touch' ||
    !['down', 'up'].includes(message.phase) ||
    !Number.isInteger(message.x) ||
    !Number.isInteger(message.y) ||
    message.x < 0 ||
    message.x > 479 ||
    message.y < 0 ||
    message.y > 479
  ) {
    throw new TypeError('Device touch message is invalid.');
  }

  return {
    phase: message.phase,
    x: message.x,
    y: message.y,
  };
}

function createLineDecoder({ onError, onMessage }) {
  const decoder = new TextDecoder();
  let buffer = '';
  let droppingOversizedLine = false;

  function finishLine() {
    if (droppingOversizedLine) {
      onError(new Error('Device message exceeded the protocol limit.'));
    } else if (buffer.length > 0) {
      try {
        const message = JSON.parse(buffer);

        if (!message || typeof message !== 'object' || Array.isArray(message)) {
          throw new TypeError('Device message must be a JSON object.');
        }

        onMessage(message);
      } catch (error) {
        onError(error);
      }
    }

    buffer = '';
    droppingOversizedLine = false;
  }

  return {
    push(chunk) {
      const text = decoder.decode(chunk, { stream: true });

      for (const character of text) {
        if (character === '\n') {
          finishLine();
        } else if (character !== '\r' && !droppingOversizedLine) {
          if (buffer.length < MAX_PROTOCOL_LINE_LENGTH) {
            buffer += character;
          } else {
            droppingOversizedLine = true;
          }
        }
      }
    },
    reset() {
      buffer = '';
      droppingOversizedLine = false;
    },
  };
}

module.exports = {
  MAX_PROTOCOL_LINE_LENGTH,
  createLineDecoder,
  encodeHostHello,
  isExpectedChip,
  normalizeChipName,
  validateDeviceHello,
  validateTouchMessage,
};
