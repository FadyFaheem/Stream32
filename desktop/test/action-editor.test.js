const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ActionEditor,
  CORE_ACTIONS,
  actionKey,
  filterActions,
} = require('../src/renderer/action-editor');

test('ranks action names ahead of keyword-only matches', () => {
  const actions = [
    ...CORE_ACTIONS,
    {
      key: 'plugin:teams:mute',
      source: 'Microsoft Teams',
      category: 'Meetings',
      name: 'Toggle mute / unmute',
      description: 'Toggle the microphone.',
      icon: 'mic_off',
      keywords: ['audio'],
      available: true,
    },
  ];

  assert.equal(filterActions(actions, 'mute')[0].key, 'plugin:teams:mute');
  assert.deepEqual(
    filterActions(actions, 'stream32 keyboard').map((action) => action.key),
    ['core:hotkey'],
  );
  assert.deepEqual(filterActions(actions, 'does-not-exist'), []);
});

test('maps native and plugin actions to stable catalog keys', () => {
  assert.equal(actionKey({ type: 'media', command: 'mute' }), 'core:media');
  assert.equal(
    actionKey({
      type: 'plugin',
      pluginId: 'microsoft-teams',
      actionId: 'toggle-mute',
      settings: {},
    }),
    'plugin:microsoft-teams:toggle-mute',
  );
  assert.equal(actionKey(null), null);
});

test('applies plugin appearance after required settings become valid', () => {
  const appearance = { label: 'Search', icon: 'search' };
  const action = {
    type: 'plugin',
    pluginId: 'search-tools',
    actionId: 'search',
    settings: { query: 'Stream32' },
  };
  let change;
  const editor = Object.create(ActionEditor.prototype);
  editor.selectedDefinition = () => ({ appearance });
  editor.buildAction = () => action;
  editor.onChange = (...values) => {
    change = values;
  };

  editor.emit();

  assert.deepEqual(change, [action, appearance]);
});

test('records the Windows modifier separately from a reserved shortcut', () => {
  const elements = [];
  const document = {
    createElement() {
      const listeners = {};
      const element = {
        listeners,
        append(...children) {
          this.children = children;
        },
        addEventListener(type, listener) {
          listeners[type] = listener;
        },
      };
      elements.push(element);
      return element;
    },
  };
  const editor = Object.create(ActionEditor.prototype);
  editor.document = document;
  editor.draft = {};
  editor.config = { append() {} };
  let changes = 0;
  editor.emit = () => {
    changes++;
  };

  editor.renderCoreConfig('hotkey');
  const shortcut = elements.find((element) => element.type === 'text');
  const windowsKey = elements.find((element) => element.type === 'checkbox');
  const keyboardEvent = (code) => ({
    code,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault() {},
  });

  shortcut.listeners.keydown(keyboardEvent('MetaLeft'));
  shortcut.listeners.keydown(keyboardEvent('KeyL'));

  assert.equal(changes, 1);
  assert.deepEqual(editor.draft, {
    key: 'L',
    alt: false,
    ctrl: false,
    meta: true,
    shift: false,
  });
  assert.equal(shortcut.value, 'Win+L');
  assert.equal(windowsKey.checked, true);
});
