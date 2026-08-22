const assert = require('node:assert/strict');
const test = require('node:test');

const { MAX_MULTI_STEPS } = require('../src/action-model');
const { validateAction } = require('../src/deck-model');
const {
  createMacroRecorder,
  describeStep,
  printableCharacter,
  roundDelay,
} = require('../src/renderer/macro-recorder');

function type(recorder, text, startTime = 0, gap = 10) {
  let time = startTime;

  for (const character of text) {
    recorder.press({ key: character.toUpperCase(), char: character, time });
    time += gap;
  }

  return time;
}

test('plain typing folds into a single Type Text step', () => {
  const recorder = createMacroRecorder();
  type(recorder, 'hello');
  assert.deepEqual(recorder.result(), {
    steps: [{ type: 'text', text: 'hello' }],
    truncated: false,
  });
});

test('a modified press becomes its own hotkey step and splits the text', () => {
  const recorder = createMacroRecorder();
  const time = type(recorder, 'ab');
  recorder.press({ key: 'C', char: 'c', ctrl: true, time: time + 10 });
  type(recorder, 'de', time + 20);
  assert.deepEqual(recorder.result().steps, [
    { type: 'text', text: 'ab' },
    { type: 'hotkey', key: 'C', alt: false, ctrl: true, meta: false, shift: false },
    { type: 'text', text: 'de' },
  ]);
});

test('a named key is recorded as a hotkey rather than typed text', () => {
  const recorder = createMacroRecorder();
  type(recorder, 'hi');
  recorder.press({ key: 'Enter', char: 'Enter', time: 30 });
  assert.deepEqual(recorder.result().steps, [
    { type: 'text', text: 'hi' },
    {
      type: 'hotkey',
      key: 'Enter',
      alt: false,
      ctrl: false,
      meta: false,
      shift: false,
    },
  ]);
});

test('only pauses longer than the floor become delay steps', () => {
  const recorder = createMacroRecorder();
  recorder.press({ key: 'A', char: 'a', time: 0 });
  // 40 ms is ordinary typing speed and must not cost a step.
  recorder.press({ key: 'B', char: 'b', time: 40 });
  recorder.press({ key: 'C', char: 'c', time: 1240 });
  assert.deepEqual(recorder.result().steps, [
    { type: 'text', text: 'ab' },
    { type: 'delay', ms: 1200 },
    { type: 'text', text: 'c' },
  ]);
});

test('recording pauses can be turned off', () => {
  const recorder = createMacroRecorder({ captureDelays: false });
  recorder.press({ key: 'A', char: 'a', time: 0 });
  recorder.press({ key: 'B', char: 'b', time: 5000 });
  assert.deepEqual(recorder.result().steps, [{ type: 'text', text: 'ab' }]);
});

test('a recording stops at the step limit and says so', () => {
  const recorder = createMacroRecorder({ maxSteps: 3 });

  for (let index = 0; index < 10; index++) {
    recorder.press({ key: 'F5', char: 'F5', time: index * 10 });
  }

  const { steps, truncated } = recorder.result();
  assert.equal(steps.length, 3);
  assert.equal(truncated, true);
});

test('a recording is a valid Multi Action', () => {
  const recorder = createMacroRecorder();
  const time = type(recorder, 'git status');
  recorder.press({ key: 'Enter', char: 'Enter', time: time + 500 });
  const { steps } = recorder.result();
  assert.equal(steps.length <= MAX_MULTI_STEPS, true);
  assert.deepEqual(validateAction({ type: 'multi', steps }, 1).steps, steps);
});

test('the preview does not consume the pending text', () => {
  const recorder = createMacroRecorder();
  type(recorder, 'ab');
  assert.deepEqual(recorder.preview(), [{ type: 'text', text: 'ab' }]);
  type(recorder, 'c', 100);
  assert.deepEqual(recorder.result().steps, [{ type: 'text', text: 'abc' }]);
});

test('reset clears a recording in progress', () => {
  const recorder = createMacroRecorder();
  type(recorder, 'abc');
  recorder.reset();
  assert.deepEqual(recorder.result(), { steps: [], truncated: false });
});

test('modifiers other than Shift disqualify a press from typed text', () => {
  assert.equal(printableCharacter({ char: 'a' }), 'a');
  assert.equal(printableCharacter({ char: 'A', shift: true }), 'A');
  assert.equal(printableCharacter({ char: 'a', ctrl: true }), '');
  assert.equal(printableCharacter({ char: 'a', alt: true }), '');
  assert.equal(printableCharacter({ char: 'Enter' }), '');
  assert.equal(printableCharacter({ char: '' }), '');
});

test('recorded delays round to a readable grid', () => {
  assert.equal(roundDelay(1234), 1250);
  assert.equal(roundDelay(10), 0);
  assert.equal(roundDelay(999_999), 30_000);
});

test('steps describe themselves for the recording preview', () => {
  assert.equal(describeStep({ type: 'delay', ms: 250 }), 'Wait 250 ms');
  assert.equal(describeStep({ type: 'text', text: 'hi' }), 'Type "hi"');
  assert.equal(
    describeStep({ type: 'hotkey', key: 'S', ctrl: true, shift: true }),
    'Ctrl+Shift+S',
  );
});
