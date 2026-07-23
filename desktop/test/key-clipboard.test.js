const assert = require('node:assert/strict');
const test = require('node:test');

const {
  isEditableTarget,
  keyPayload,
  moveKey,
  pasteKey,
} = require('../src/renderer/key-clipboard');

test('keyboard shortcuts leave text editing controls alone', () => {
  assert.equal(isEditableTarget({ tagName: 'INPUT' }), true);
  assert.equal(isEditableTarget({ tagName: 'TEXTAREA' }), true);
  assert.equal(isEditableTarget({ tagName: 'SELECT' }), true);
  assert.equal(isEditableTarget({ isContentEditable: true }), true);
  assert.equal(isEditableTarget({ tagName: 'BUTTON' }), false);
});

test('clipboard payload drops identity and paste rewrites the destination index', () => {
  const payload = keyPayload({
    index: 7,
    label: 'Record',
    action: { type: 'media', command: 'play-pause' },
  });

  assert.deepEqual(payload, {
    label: 'Record',
    action: { type: 'media', command: 'play-pause' },
  });
  assert.deepEqual(
    pasteKey([{ index: 2, label: 'Old' }], 2, payload, 1),
    [{
      index: 2,
      label: 'Record',
      action: { type: 'media', command: 'play-pause' },
    }],
  );
});

test('moving onto an occupied key swaps payloads across pages', () => {
  const moved = moveKey({
    sourceKeys: [{ index: 0, label: 'Source' }],
    sourceIndex: 0,
    sourcePageCount: 2,
    destinationKeys: [{ index: 3, label: 'Destination' }],
    destinationIndex: 3,
    destinationPageCount: 2,
  });

  assert.deepEqual(moved.sourceKeys, [{ index: 0, label: 'Destination' }]);
  assert.deepEqual(moved.destinationKeys, [{ index: 3, label: 'Source' }]);
});

test('same-page moves replace empty slots and swap occupied slots', () => {
  const moved = moveKey({
    sourceKeys: [
      { index: 0, label: 'One' },
      { index: 1, label: 'Two' },
    ],
    sourceIndex: 0,
    sourcePageCount: 1,
    destinationKeys: [
      { index: 0, label: 'One' },
      { index: 1, label: 'Two' },
    ],
    destinationIndex: 1,
    destinationPageCount: 1,
    samePage: true,
  });
  assert.deepEqual(moved.sourceKeys, [
    { index: 0, label: 'Two' },
    { index: 1, label: 'One' },
  ]);

  const toEmpty = moveKey({
    sourceKeys: [{ index: 0, label: 'One' }],
    sourceIndex: 0,
    sourcePageCount: 1,
    destinationKeys: [{ index: 0, label: 'One' }],
    destinationIndex: 2,
    destinationPageCount: 1,
    samePage: true,
  });
  assert.deepEqual(toEmpty.sourceKeys, [{ index: 2, label: 'One' }]);
});

test('cross-profile paste and swaps reject invalid page targets', () => {
  const payload = keyPayload({
    index: 0,
    action: { type: 'page', page: 2 },
  });

  assert.throws(() => pasteKey([], 0, payload, 2), /does not exist/);
  assert.throws(
    () => moveKey({
      sourceKeys: [{ index: 0, action: { type: 'page', page: 2 } }],
      sourceIndex: 0,
      sourcePageCount: 3,
      destinationKeys: [],
      destinationIndex: 0,
      destinationPageCount: 2,
    }),
    /does not exist/,
  );
});

test('cross-profile clipboard validation inspects Multi Action pages', () => {
  const payload = keyPayload({
    index: 0,
    action: {
      type: 'multi',
      steps: [
        { type: 'media', command: 'mute' },
        { type: 'page', page: 2 },
      ],
    },
  });

  assert.throws(() => pasteKey([], 0, payload, 2), /does not exist/);
  assert.deepEqual(pasteKey([], 0, payload, 3), [{
    index: 0,
    action: {
      type: 'multi',
      steps: [
        { type: 'media', command: 'mute' },
        { type: 'page', page: 2 },
      ],
    },
  }]);
});
