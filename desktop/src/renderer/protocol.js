const MAX_PROTOCOL_LINE_LENGTH = 4096;
const BOARD_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DEVICE_ID_PATTERN = /^[a-f0-9]{12}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const FEATURE_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
// Sanity bound only: panels differ per board (480x480, 1024x600, ...), and
// the coordinates are just echoed in the touch test UI.
const MAX_TOUCH_COORDINATE = 4095;

// A page layout is one protocol line, and the firmware persists that raw
// line to flash. A fully decorated key costs about 131 bytes, so:
// - up to 30 keys fit the baseline 4096-byte line every firmware accepts;
// - 31-40 keys need a board whose firmware takes the extended layout line
//   (8 KB receive buffer, two 4 KB flash sectors per page). The board
//   advertises this by setting deck.maxKeys above 30.
// Grids are otherwise free-form: up to 10 in either direction, bounded by
// the per-board key budget (e.g. 9x4, 4x9, or 10x3).
const MAX_DECK_PAGES = 8;
const MAX_DECK_ROWS = 10;
const MAX_DECK_COLS = 10;
const MAX_DECK_KEYS = 40;
const MAX_EXTENDED_LAYOUT_LINE_LENGTH = 8180;
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
    `${JSON.stringify({
      type: 'hello',
      protocol: protocolVersion,
      features: ['key-update'],
    })}\n`,
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

  let features;

  if (message.features !== undefined) {
    if (
      !Array.isArray(message.features) ||
      message.features.length > 16 ||
      message.features.some(
        (feature) =>
          typeof feature !== 'string' || !FEATURE_PATTERN.test(feature),
      ) ||
      new Set(message.features).size !== message.features.length
    ) {
      throw new TypeError('Device features are invalid.');
    }

    features = [...message.features];
  }

  return {
    boardId: message.boardId,
    deviceId: message.deviceId,
    ...(features ? { features } : {}),
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
    message.x > MAX_TOUCH_COORDINATE ||
    message.y < 0 ||
    message.y > MAX_TOUCH_COORDINATE
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

function encodeLine(message, maxLineLength = MAX_PROTOCOL_LINE_LENGTH) {
  const line = `${JSON.stringify(message)}\n`;
  const encoded = new TextEncoder().encode(line);

  if (encoded.byteLength > maxLineLength) {
    throw new RangeError('Encoded protocol line exceeds the limit.');
  }

  return encoded;
}

function validLabel(value) {
  return (
    typeof value === 'string' &&
    new TextEncoder().encode(value).byteLength <= MAX_KEY_LABEL_LENGTH
  );
}

function encodeLayoutMessage(
  { page, of, rows, cols, keys },
  maxLineLength = MAX_PROTOCOL_LINE_LENGTH,
) {
  requireProtocolInteger(page, 'layout page', 0, MAX_DECK_PAGES - 1);
  requireProtocolInteger(of, 'layout page count', 1, MAX_DECK_PAGES);
  requireProtocolInteger(rows, 'layout rows', 1, MAX_DECK_ROWS);
  requireProtocolInteger(cols, 'layout cols', 1, MAX_DECK_COLS);
  requireProtocolInteger(rows * cols, 'layout keys per page', 1, MAX_DECK_KEYS);

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
      if (!validLabel(key.label)) {
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

  return encodeLine(
    {
      type: 'layout',
      page,
      of,
      rows,
      cols,
      keys: encodedKeys,
    },
    maxLineLength,
  );
}

// Boards advertising more than 30 keys per page run firmware that accepts
// the extended layout line; everything else gets the baseline limit.
function layoutLineLimitFor(deckLimits) {
  return (deckLimits?.maxKeys ?? 0) > 30
    ? MAX_EXTENDED_LAYOUT_LINE_LENGTH
    : MAX_PROTOCOL_LINE_LENGTH;
}

function toBase64(bytes) {
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

// Each tuple is uint16-le run length followed by one little-endian RGB565
// pixel. Runs are capped so tuple boundaries stay independently decodable.
function encodeRle565(pixels) {
  if (!(pixels instanceof Uint8Array) || pixels.length % 2 !== 0) {
    throw new TypeError('RLE input must be RGB565 bytes.');
  }

  const encoded = new Uint8Array(pixels.length * 2);
  let output = 0;

  for (let offset = 0; offset < pixels.length; ) {
    const low = pixels[offset];
    const high = pixels[offset + 1];
    let count = 1;

    while (
      count < 0xffff &&
      offset + count * 2 < pixels.length &&
      pixels[offset + count * 2] === low &&
      pixels[offset + count * 2 + 1] === high
    ) {
      count++;
    }

    encoded[output++] = count & 0xff;
    encoded[output++] = count >>> 8;
    encoded[output++] = low;
    encoded[output++] = high;
    offset += count * 2;
  }

  return encoded.slice(0, output);
}

function encodeImageChunks({
  page,
  index,
  width,
  height,
  pixels,
  mode = 'persisted',
  rleSupported = false,
}) {
  requireProtocolInteger(page, 'image page', 0, MAX_DECK_PAGES - 1);
  requireProtocolInteger(index, 'image key index', 0, MAX_DECK_KEYS - 1);
  requireProtocolInteger(width, 'image width', 1, MAX_KEY_PIXELS);
  requireProtocolInteger(height, 'image height', 1, MAX_KEY_PIXELS);

  if (!(pixels instanceof Uint8Array) || pixels.length !== width * height * 2) {
    throw new TypeError('Image pixels must be RGB565 bytes.');
  }

  if (!['persisted', 'ephemeral'].includes(mode)) {
    throw new TypeError('Image mode is invalid.');
  }

  const rle = rleSupported ? encodeRle565(pixels) : null;
  const useRle = rle !== null && rle.length < pixels.length;
  const payload = useRle ? rle : pixels;
  const total = Math.ceil(payload.length / IMAGE_CHUNK_RAW_BYTES);
  const chunks = [];

  for (let seq = 0; seq < total; seq++) {
    const slice = payload.subarray(
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
        ...(mode === 'ephemeral' ? { mode } : {}),
        ...(useRle ? { encoding: 'rle565' } : {}),
        data: toBase64(slice),
      }),
    );
  }

  return chunks;
}

function encodeKeyUpdateMessage({ page, index, label, color, labelColor, state, imageCrc, clear }) {
  requireProtocolInteger(page, 'key-update page', 0, MAX_DECK_PAGES - 1);
  requireProtocolInteger(index, 'key-update key index', 0, MAX_DECK_KEYS - 1);
  const message = { type: 'key-update', page, index };

  if (clear !== undefined) {
    if (clear !== true) {
      throw new TypeError('key-update clear must be true.');
    }
    message.clear = true;
  }

  if (label !== undefined) {
    if (!validLabel(label)) {
      throw new TypeError('key-update label is invalid.');
    }
    message.label = label;
  }

  for (const [field, value] of [['color', color], ['labelColor', labelColor]]) {
    if (value !== undefined) {
      if (typeof value !== 'string' || !KEY_COLOR_PATTERN.test(value)) {
        throw new TypeError(`key-update ${field} is invalid.`);
      }
      message[field] = value;
    }
  }

  if (state !== undefined) {
    if (!['on', 'off', 'unknown'].includes(state)) {
      throw new TypeError('key-update state is invalid.');
    }
    message.state = state;
  }

  if (imageCrc !== undefined) {
    if (typeof imageCrc !== 'string' || !IMAGE_CRC_PATTERN.test(imageCrc)) {
      throw new TypeError('key-update image CRC is invalid.');
    }
    message.imageCrc = imageCrc;
  }

  if (
    clear !== true &&
    label === undefined &&
    color === undefined &&
    labelColor === undefined &&
    state === undefined &&
    imageCrc === undefined
  ) {
    throw new TypeError('key-update patch is empty.');
  }

  return encodeLine(message);
}

function validateKeyUpdateAck(message) {
  if (typeof message.needImage !== 'boolean') {
    throw new TypeError('key-update-ack needImage must be a boolean.');
  }

  return {
    page: requireProtocolInteger(
      message.page,
      'key-update-ack page',
      0,
      MAX_DECK_PAGES - 1,
    ),
    index: requireProtocolInteger(
      message.index,
      'key-update-ack index',
      0,
      MAX_DECK_KEYS - 1,
    ),
    needImage: message.needImage,
  };
}

function encodePageMessage(index) {
  requireProtocolInteger(index, 'page index', 0, MAX_DECK_PAGES - 1);
  return encodeLine({ type: 'page', index });
}

function encodeDisplayMessage({ awake, idleTimeoutSeconds, brightness }) {
  if (typeof awake !== 'boolean') {
    throw new TypeError('Display awake state must be a boolean.');
  }

  requireProtocolInteger(
    idleTimeoutSeconds,
    'display idle timeout',
    0,
    86400,
  );

  const message = { type: 'display', awake, idleTimeoutSeconds };

  if (brightness !== undefined) {
    message.brightness = requireProtocolInteger(
      brightness,
      'display brightness',
      0,
      100,
    );
  }

  return encodeLine(message);
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
  requireProtocolInteger(
    rows * cols,
    'layout-ack keys per page',
    1,
    MAX_DECK_KEYS,
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
  if (
    message.mode !== undefined &&
    !['persisted', 'ephemeral'].includes(message.mode)
  ) {
    throw new TypeError('image-ack mode is invalid.');
  }

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
      MAX_DECK_KEYS - 1,
    ),
    seq: requireProtocolInteger(message.seq, 'image-ack seq', 0, 65535),
    ...(message.mode !== undefined ? { mode: message.mode } : {}),
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
      MAX_DECK_KEYS - 1,
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
  MAX_DECK_KEYS,
  MAX_DECK_PAGES,
  MAX_DECK_ROWS,
  MAX_KEY_LABEL_LENGTH,
  MAX_PROTOCOL_LINE_LENGTH,
  crc32,
  layoutLineLimitFor,
  createLineDecoder,
  encodeDisplayMessage,
  encodeHostHello,
  encodeImageChunks,
  encodeKeyUpdateMessage,
  encodeLayoutMessage,
  encodePageMessage,
  encodeRle565,
  isExpectedChip,
  normalizeChipName,
  validateDeviceHello,
  validateImageAck,
  validateKeyUpdateAck,
  validateLayoutAck,
  validatePageMessage,
  validatePressMessage,
  validateTouchMessage,
};
