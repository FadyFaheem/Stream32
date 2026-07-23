const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_TEXT_CHARACTERS,
  actionPageTargets,
  remapActionAfterPageDeletion,
  validateMouseAction,
  validateTextAction,
} = require('../src/action-model');

test('finds and remaps page targets inside Multi Actions', () => {
  const action = {
    type: 'multi',
    steps: [
      { type: 'page', page: 1 },
      { type: 'delay', ms: 100 },
      { type: 'page', page: 3 },
      { type: 'media', command: 'mute' },
    ],
  };

  assert.deepEqual(actionPageTargets(action), [1, 3]);
  assert.deepEqual(remapActionAfterPageDeletion(action, 1), {
    type: 'multi',
    steps: [
      { type: 'delay', ms: 100 },
      { type: 'page', page: 2 },
      { type: 'media', command: 'mute' },
    ],
  });
  assert.deepEqual(action, {
    type: 'multi',
    steps: [
      { type: 'page', page: 1 },
      { type: 'delay', ms: 100 },
      { type: 'page', page: 3 },
      { type: 'media', command: 'mute' },
    ],
  });
});

test('deleting the only page step removes the action safely', () => {
  assert.equal(
    remapActionAfterPageDeletion(
      { type: 'multi', steps: [{ type: 'page', page: 0 }] },
      0,
    ),
    null,
  );
  assert.equal(
    remapActionAfterPageDeletion({ type: 'page', page: 0 }, 0),
    null,
  );
});

test('validates Unicode text bounds and safe controls', () => {
  assert.deepEqual(
    validateTextAction({ type: 'text', text: 'Hello 👋\nnext\tcell' }),
    { type: 'text', text: 'Hello 👋\nnext\tcell' },
  );
  assert.doesNotThrow(() =>
    validateTextAction({
      type: 'text',
      text: '😀'.repeat(MAX_TEXT_CHARACTERS),
    }));
  assert.throws(
    () => validateTextAction({
      type: 'text',
      text: 'a'.repeat(MAX_TEXT_CHARACTERS + 1),
    }),
    /Unicode characters/,
  );

  for (const text of ['', 'unsafe\u0000text', 'escape\u001btext', 'carriage\rreturn']) {
    assert.throws(() => validateTextAction({ type: 'text', text }));
  }
});

test('validates operation-specific mouse fields and bounds', () => {
  const actions = [
    { type: 'mouse', operation: 'click', button: 'right', clicks: 2 },
    { type: 'mouse', operation: 'move-absolute', x: 32767, y: 0 },
    { type: 'mouse', operation: 'move-relative', x: -10000, y: 10000 },
    { type: 'mouse', operation: 'scroll', vertical: -100, horizontal: 100 },
  ];

  for (const action of actions) {
    assert.deepEqual(validateMouseAction(action), action);
  }

  assert.throws(
    () => validateMouseAction({
      type: 'mouse',
      operation: 'click',
      button: 'back',
      clicks: 1,
    }),
    /button/,
  );
  assert.throws(
    () => validateMouseAction({
      type: 'mouse',
      operation: 'move-absolute',
      x: -32768,
      y: 0,
    }),
    /coordinate/,
  );
  assert.throws(
    () => validateMouseAction({
      type: 'mouse',
      operation: 'scroll',
      vertical: 0,
      horizontal: 0,
    }),
    /non-zero/,
  );
});
