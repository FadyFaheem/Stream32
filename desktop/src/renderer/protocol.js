const MAX_PROTOCOL_LINE_LENGTH = 4096;
const BOARD_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DEVICE_ID_PATTERN = /^[a-f0-9]{12}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const MAX_DECK_PAGES = 8;
const MAX_DECK_ROWS = 5;
const MAX_DECK_COLS = 5;
const MAX_KEY_LABEL_LENGTH = 32;
const MAX_KEY_PIXELS = 512;
const KEY_COLOR_PATTERN = /^#[0-9a-f]{6}$/;
const IMAGE_CRC_PATTERN = /^[0-9a-f]{8}$/;
// 2688 raw bytes → 3584 base64 characters, keeping every image line (JSON
// envelope included) under MAX_PROTOCOL_LINE_LENGTH.
const IMAGE_CHUNK_RAW_BYTES = 2688;

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

let crc32Table = null;

// Matches the standard reflected CRC-32 (zlib) used by esp_rom_crc32_le(0, …)
// on the device; returned as 8 lowercase hex characters.
function crc32(bytes) {
  if (!crc32Table) {
    crc32Table = new Uint32Array(256);

    for (let index = 0; index < 256; index++) {
      let value = index;

      for (let bit = 0; bit < 8; bit++) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }

      crc32Table[index] = value >>> 0;
    }
  }

  let crc = 0xffffffff;

  for (const byte of bytes) {
    crc = crc32Table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

function requireProtocolInteger(value, field, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${field} is outside the supported range.`);
  }

  return value;
}

function encodeLine(message) {
  const line = `${JSON.stringify(message)}\n`;

  if (line.length > MAX_PROTOCOL_LINE_LENGTH) {
    throw new RangeError('Encoded protocol line exceeds the limit.');
  }

  return new TextEncoder().encode(line);
}

function encodeLayoutMessage({ page, of, rows, cols, keys }) {
  requireProtocolInteger(page, 'layout page', 0, MAX_DECK_PAGES - 1);
  requireProtocolInteger(of, 'layout page count', 1, MAX_DECK_PAGES);
  requireProtocolInteger(rows, 'layout rows', 1, MAX_DECK_ROWS);
  requireProtocolInteger(cols, 'layout cols', 1, MAX_DECK_COLS);

  if (page >= of || !Array.isArray(keys)) {
    throw new TypeError('Layout pages are inconsistent.');
  }

  const keyCount = rows * cols;
  const seen = new Set();
  const encodedKeys = keys.map((key) => {
    const index = requireProtocolInteger(
      key.index,
      'layout key index',
      0,
      keyCount - 1,
    );

    if (seen.has(index)) {
      throw new TypeError('Layout keys must have unique indexes.');
    }

    seen.add(index);

    const encoded = { index };

    if (key.label !== undefined) {
      if (
        typeof key.label !== 'string' ||
        key.label.length > MAX_KEY_LABEL_LENGTH
      ) {
        throw new TypeError('Layout key label is invalid.');
      }

      encoded.label = key.label;
    }

    if (key.color !== undefined) {
      if (
        typeof key.color !== 'string' ||
        !KEY_COLOR_PATTERN.test(key.color)
      ) {
        throw new TypeError('Layout key color is invalid.');
      }

      encoded.color = key.color;
    }

    if (key.labelColor !== undefined) {
      if (
        typeof key.labelColor !== 'string' ||
        !KEY_COLOR_PATTERN.test(key.labelColor)
      ) {
        throw new TypeError('Layout key label color is invalid.');
      }

      encoded.labelColor = key.labelColor;
    }

    if (key.imageCrc !== undefined) {
      if (
        typeof key.imageCrc !== 'string' ||
        !IMAGE_CRC_PATTERN.test(key.imageCrc)
      ) {
        throw new TypeError('Layout key image CRC is invalid.');
      }

      encoded.imageCrc = key.imageCrc;
    }

    if (key.goPage !== undefined) {
      encoded.goPage = requireProtocolInteger(
        key.goPage,
        'layout key goPage',
        0,
        of - 1,
      );
    }

    return encoded;
  });

  return encodeLine({
    type: 'layout',
    page,
    of,
    rows,
    cols,
    keys: encodedKeys,
  });
}

function toBase64(bytes) {
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function encodeImageChunks({ page, index, width, height, pixels }) {
  requireProtocolInteger(page, 'image page', 0, MAX_DECK_PAGES - 1);
  requireProtocolInteger(index, 'image key index', 0, MAX_DECK_ROWS * MAX_DECK_COLS - 1);
  requireProtocolInteger(width, 'image width', 1, MAX_KEY_PIXELS);
  requireProtocolInteger(height, 'image height', 1, MAX_KEY_PIXELS);

  if (!(pixels instanceof Uint8Array) || pixels.length !== width * height * 2) {
    throw new TypeError('Image pixels must be RGB565 bytes.');
  }

  const total = Math.ceil(pixels.length / IMAGE_CHUNK_RAW_BYTES);
  const chunks = [];

  for (let seq = 0; seq < total; seq++) {
    const slice = pixels.subarray(
      seq * IMAGE_CHUNK_RAW_BYTES,
      (seq + 1) * IMAGE_CHUNK_RAW_BYTES,
    );
    chunks.push(
      encodeLine({
        type: 'image',
        page,
        index,
        seq,
        of: total,
        w: width,
        h: height,
        data: toBase64(slice),
      }),
    );
  }

  return chunks;
}

function encodePageMessage(index) {
  requireProtocolInteger(index, 'page index', 0, MAX_DECK_PAGES - 1);
  return encodeLine({ type: 'page', index });
}

function validateLayoutAck(message) {
  const page = requireProtocolInteger(
    message.page,
    'layout-ack page',
    0,
    MAX_DECK_PAGES - 1,
  );
  const rows = requireProtocolInteger(
    message.rows,
    'layout-ack rows',
    1,
    MAX_DECK_ROWS,
  );
  const cols = requireProtocolInteger(
    message.cols,
    'layout-ack cols',
    1,
    MAX_DECK_COLS,
  );
  const keyPx = requireProtocolInteger(
    message.keyPx,
    'layout-ack keyPx',
    16,
    MAX_KEY_PIXELS,
  );

  if (!Array.isArray(message.needImages)) {
    throw new TypeError('layout-ack needImages must be an array.');
  }

  const needImages = message.needImages.map((index) =>
    requireProtocolInteger(index, 'layout-ack needImages', 0, rows * cols - 1),
  );

  return { page, rows, cols, keyPx, needImages };
}

function validateImageAck(message) {
  return {
    page: requireProtocolInteger(
      message.page,
      'image-ack page',
      0,
      MAX_DECK_PAGES - 1,
    ),
    index: requireProtocolInteger(
      message.index,
      'image-ack index',
      0,
      MAX_DECK_ROWS * MAX_DECK_COLS - 1,
    ),
    seq: requireProtocolInteger(message.seq, 'image-ack seq', 0, 65535),
  };
}

function validatePageMessage(message) {
  return {
    index: requireProtocolInteger(
      message.index,
      'page index',
      0,
      MAX_DECK_PAGES - 1,
    ),
  };
}

function validatePressMessage(message) {
  if (!['down', 'up'].includes(message.phase)) {
    throw new TypeError('Device press message is invalid.');
  }

  return {
    page: requireProtocolInteger(message.page, 'press page', 0, MAX_DECK_PAGES - 1),
    index: requireProtocolInteger(
      message.index,
      'press index',
      0,
      MAX_DECK_ROWS * MAX_DECK_COLS - 1,
    ),
    phase: message.phase,
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
  MAX_DECK_COLS,
  MAX_DECK_PAGES,
  MAX_DECK_ROWS,
  MAX_KEY_LABEL_LENGTH,
  MAX_PROTOCOL_LINE_LENGTH,
  crc32,
  createLineDecoder,
  encodeHostHello,
  encodeImageChunks,
  encodeLayoutMessage,
  encodePageMessage,
  isExpectedChip,
  normalizeChipName,
  validateDeviceHello,
  validateImageAck,
  validateLayoutAck,
  validatePageMessage,
  validatePressMessage,
  validateTouchMessage,
};
