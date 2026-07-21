// Canonical hotkey names shared by the renderer capture field, the deck
// store validator, and the per-OS action executor. Values: Windows virtual-key
// codes (ext = extended-key flag), X11 keysyms for xdotool, and macOS key
// codes for keys AppleScript cannot type as characters.

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';

const SPECIAL_KEYS = {
  Backquote: { vk: 0xc0, x: 'grave', mac: 50 },
  Backslash: { vk: 0xdc, x: 'backslash', mac: 42 },
  Backspace: { vk: 0x08, x: 'BackSpace', mac: 51 },
  BracketLeft: { vk: 0xdb, x: 'bracketleft', mac: 33 },
  BracketRight: { vk: 0xdd, x: 'bracketright', mac: 30 },
  Comma: { vk: 0xbc, x: 'comma', mac: 43 },
  Delete: { vk: 0x2e, ext: true, x: 'Delete', mac: 117 },
  Down: { vk: 0x28, ext: true, x: 'Down', mac: 125 },
  End: { vk: 0x23, ext: true, x: 'End', mac: 119 },
  Enter: { vk: 0x0d, x: 'Return', mac: 36 },
  Equal: { vk: 0xbb, x: 'equal', mac: 24 },
  Escape: { vk: 0x1b, x: 'Escape', mac: 53 },
  Home: { vk: 0x24, ext: true, x: 'Home', mac: 115 },
  Left: { vk: 0x25, ext: true, x: 'Left', mac: 123 },
  Minus: { vk: 0xbd, x: 'minus', mac: 27 },
  PageDown: { vk: 0x22, ext: true, x: 'Next', mac: 121 },
  PageUp: { vk: 0x21, ext: true, x: 'Prior', mac: 116 },
  Period: { vk: 0xbe, x: 'period', mac: 47 },
  Quote: { vk: 0xde, x: 'apostrophe', mac: 39 },
  Right: { vk: 0x27, ext: true, x: 'Right', mac: 124 },
  Semicolon: { vk: 0xba, x: 'semicolon', mac: 41 },
  Slash: { vk: 0xbf, x: 'slash', mac: 44 },
  Space: { vk: 0x20, x: 'space', mac: 49 },
  Tab: { vk: 0x09, x: 'Tab', mac: 48 },
  Up: { vk: 0x26, ext: true, x: 'Up', mac: 126 },
};

const MAC_FUNCTION_KEYCODES = {
  F1: 122,
  F2: 120,
  F3: 99,
  F4: 118,
  F5: 96,
  F6: 97,
  F7: 98,
  F8: 100,
  F9: 101,
  F10: 109,
  F11: 103,
  F12: 111,
};

const KEY_TABLE = {};

for (const letter of LETTERS) {
  KEY_TABLE[letter] = {
    vk: 0x41 + LETTERS.indexOf(letter),
    x: letter.toLowerCase(),
    char: letter.toLowerCase(),
  };
}

for (const digit of DIGITS) {
  KEY_TABLE[digit] = { vk: 0x30 + DIGITS.indexOf(digit), x: digit, char: digit };
}

for (let index = 1; index <= 12; index++) {
  KEY_TABLE[`F${index}`] = {
    vk: 0x70 + index - 1,
    x: `F${index}`,
    mac: MAC_FUNCTION_KEYCODES[`F${index}`],
  };
}

Object.assign(KEY_TABLE, SPECIAL_KEYS);

const HOTKEY_KEY_NAMES = new Set(Object.keys(KEY_TABLE));

const MODIFIER_VK = { alt: 0x12, ctrl: 0x11, meta: 0x5b, shift: 0x10 };
const MODIFIER_X = { alt: 'alt', ctrl: 'ctrl', meta: 'super', shift: 'shift' };
const MODIFIER_MAC = {
  alt: 'option down',
  ctrl: 'control down',
  meta: 'command down',
  shift: 'shift down',
};

const MEDIA_VK = {
  mute: 0xad,
  next: 0xb0,
  'play-pause': 0xb3,
  previous: 0xb1,
  'volume-down': 0xae,
  'volume-up': 0xaf,
};

const MEDIA_COMMANDS = new Set(Object.keys(MEDIA_VK));

// KeyboardEvent.code → canonical key name for the renderer capture field.
function canonicalKeyFromCode(code) {
  if (/^Key[A-Z]$/.test(code)) {
    return code.slice(3);
  }

  if (/^Digit[0-9]$/.test(code)) {
    return code.slice(5);
  }

  if (/^F([1-9]|1[0-2])$/.test(code)) {
    return code;
  }

  if (/^Arrow(Up|Down|Left|Right)$/.test(code)) {
    return code.slice(5);
  }

  return HOTKEY_KEY_NAMES.has(code) ? code : null;
}

module.exports = {
  HOTKEY_KEY_NAMES,
  KEY_TABLE,
  MEDIA_COMMANDS,
  MEDIA_VK,
  MODIFIER_MAC,
  MODIFIER_VK,
  MODIFIER_X,
  canonicalKeyFromCode,
};
