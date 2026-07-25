// Codec for the Bitfocus Companion Satellite surface API (TCP 16622).
// Messages are single lines of `COMMAND KEY=value KEY2="value with spaces"`.
// Kept free of Electron and Node IO so it can be unit tested directly.

// A single KEY-STATE line carries a base64 RGB bitmap, so the ceiling has to
// hold the largest button we ever request (MAX_BITMAP_PIXELS square) plus its
// parameters, while still bounding memory for a hostile peer.
const MAX_SATELLITE_LINE_LENGTH = 4 * 1024 * 1024;
const MAX_BITMAP_PIXELS = 128;
const SATELLITE_PORT = 16622;

const ESCAPES = new Map([
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
]);
const UNSAFE_VALUE_PATTERN = /[\s"\\]/;
const HEX_COLOR_PATTERN = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB_COLOR_PATTERN =
  /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,[^)]*)?\)$/i;

function encodeValue(value) {
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  const text = String(value);

  if (text.length > 0 && !UNSAFE_VALUE_PATTERN.test(text)) {
    return text;
  }

  return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function encodeSatelliteMessage(command, params = {}) {
  const parts = [command];

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) {
      continue;
    }

    parts.push(`${key}=${encodeValue(value)}`);
  }

  return `${parts.join(' ')}\n`;
}

// Mirrors Companion's own line parser: double quotes group a value, a
// backslash makes the next character literal, and unquoted spaces separate
// fragments. Bare fragments after the command are status words (OK / ERROR).
function parseSatelliteLine(line) {
  const fragments = [];
  let current = '';
  let started = false;
  let quoted = false;

  for (let index = 0; index < line.length; index++) {
    const character = line[index];

    if (character === '\\' && index + 1 < line.length) {
      const escaped = line[++index];
      current += ESCAPES.get(escaped) ?? escaped;
      started = true;
    } else if (character === '"') {
      quoted = !quoted;
      started = true;
    } else if (character === ' ' && !quoted) {
      if (started) {
        fragments.push(current);
      }

      current = '';
      started = false;
    } else {
      current += character;
      started = true;
    }
  }

  if (started) {
    fragments.push(current);
  }

  const command = (fragments.shift() || '').toUpperCase();
  const params = new Map();
  let status = null;

  for (const fragment of fragments) {
    const separator = fragment.indexOf('=');

    if (separator === -1) {
      // Kept verbatim: this is either a status word or a ping payload that
      // has to be echoed back exactly as it arrived.
      status ??= fragment;
    } else {
      params.set(
        fragment.slice(0, separator).toUpperCase(),
        fragment.slice(separator + 1),
      );
    }
  }

  return { command, status, params };
}

// Companion identifies a control either by flat index or by `row/column`
// within the surface it was told about.
function parseKeyReference(value, cols) {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }

  const separator = value.indexOf('/');

  if (separator === -1) {
    const index = Number(value);
    return Number.isInteger(index) && index >= 0 ? index : null;
  }

  const row = Number(value.slice(0, separator));
  const col = Number(value.slice(separator + 1));

  if (
    !Number.isInteger(row) ||
    !Number.isInteger(col) ||
    row < 0 ||
    col < 0 ||
    col >= cols
  ) {
    return null;
  }

  return row * cols + col;
}

function clampChannel(value) {
  return Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0');
}

// The board protocol only accepts `#rrggbb`, so normalize whichever notation
// the surface was configured to receive.
function normalizeColor(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const text = value.trim();
  const hex = HEX_COLOR_PATTERN.exec(text);

  if (hex) {
    const digits = hex[1].toLowerCase();
    return digits.length === 3
      ? `#${digits[0]}${digits[0]}${digits[1]}${digits[1]}${digits[2]}${digits[2]}`
      : `#${digits}`;
  }

  const rgb = RGB_COLOR_PATTERN.exec(text);

  if (!rgb) {
    return null;
  }

  return `#${clampChannel(Number(rgb[1]))}${clampChannel(Number(rgb[2]))}` +
    `${clampChannel(Number(rgb[3]))}`;
}

// Labels are bounded in UTF-8 bytes on the wire to the board, so trim whole
// code points until the encoded form fits rather than slicing mid-character.
function truncateLabel(text, maxBytes) {
  const characters = [...text];
  let result = '';

  for (const character of characters) {
    const candidate = result + character;

    if (Buffer.byteLength(candidate, 'utf8') > maxBytes) {
      break;
    }

    result = candidate;
  }

  return result;
}

function decodeText(value, maxBytes) {
  if (typeof value !== 'string' || value.length === 0) {
    return '';
  }

  // Companion base64-encodes button text so spaces and newlines never need
  // escaping. Everything past the first line is dropped: the board draws a
  // single label.
  const decoded = Buffer.from(value, 'base64')
    .toString('utf8')
    .split(/[\r\n]/, 1)[0]
    .trim();
  return truncateLabel(decoded, maxBytes);
}

module.exports = {
  MAX_BITMAP_PIXELS,
  MAX_SATELLITE_LINE_LENGTH,
  SATELLITE_PORT,
  decodeText,
  encodeSatelliteMessage,
  normalizeColor,
  parseKeyReference,
  parseSatelliteLine,
  truncateLabel,
};
