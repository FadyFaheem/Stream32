const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ActionSequenceCancelledError,
  runActionSequence,
} = require('../src/renderer/action-sequence');

test('runs Multi Action leaves, delays, and pages in order', async () => {
  const calls = [];
  const steps = [
    { type: 'media', command: 'mute' },
    { type: 'delay', ms: 250 },
    { type: 'page', page: 2 },
    { type: 'url', url: 'https://stream32.dev' },
  ];

  await runActionSequence(steps, {
    runLeaf: async (step) => calls.push(`leaf:${step.type}`),
    switchPage: async (page) => calls.push(`page:${page}`),
    sleep: async (ms) => calls.push(`delay:${ms}`),
  });

  assert.deepEqual(calls, [
    'leaf:media',
    'delay:250',
    'page:2',
    'leaf:url',
  ]);
});

test('stops on the first error and reports its step number', async () => {
  const calls = [];

  await assert.rejects(
    runActionSequence(
      [
        { type: 'media', command: 'mute' },
        { type: 'launch', command: 'broken' },
        { type: 'page', page: 1 },
      ],
      {
        runLeaf: async (step) => {
          calls.push(step.type);

          if (step.type === 'launch') {
            throw new Error('launch failed');
          }
        },
        switchPage: async (page) => calls.push(`page:${page}`),
      },
    ),
    /step 2 failed: launch failed/,
  );
  assert.deepEqual(calls, ['media', 'launch']);
});

test('cancels remaining steps without waiting in tests', async () => {
  const calls = [];
  let canceled = false;

  await assert.rejects(
    runActionSequence(
      [
        { type: 'delay', ms: 10_000 },
        { type: 'media', command: 'mute' },
      ],
      {
        runLeaf: async (step) => calls.push(step.type),
        switchPage: async () => {},
        sleep: async (ms) => {
          calls.push(`delay:${ms}`);
          canceled = true;
        },
        isCancelled: () => canceled,
      },
    ),
    ActionSequenceCancelledError,
  );
  assert.deepEqual(calls, ['delay:10000']);
});
