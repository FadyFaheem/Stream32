const assert = require('node:assert/strict');
const test = require('node:test');

const {
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
