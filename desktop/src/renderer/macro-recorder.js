// Records a sequence of key presses into Multi Action steps.
//
// The hotkey field captures one chord. This captures a whole sequence, with the
// pauses between presses, and folds it into the smallest set of steps that
// reproduces it:
//
//   plain printable keys  accumulate into one Type Text step
//   modified or named     become their own hotkey step
//   gaps                  become delay steps
//
// Folding matters because a Multi Action holds at most 16 steps. Typing "git
// status" as one Type Text step costs one of them; as ten hotkey steps it would
// not fit at all.

const {
  MAX_DELAY_MS,
  MAX_MULTI_STEPS,
  MAX_TEXT_CHARACTERS,
  MAX_TOTAL_DELAY_MS,
} = require('../action-model');

// Below this a gap is indistinguishable from ordinary typing speed, and
// recording it would spend steps on delays nobody asked for.
const MIN_RECORDED_DELAY_MS = 120;
// Presses are rounded to this grid so a recording reads as round numbers
// instead of the recorder's own jitter.
const DELAY_ROUNDING_MS = 50;

function roundDelay(ms) {
  return Math.min(
    MAX_DELAY_MS,
    Math.round(ms / DELAY_ROUNDING_MS) * DELAY_ROUNDING_MS,
  );
}

// A press is "plain text" when it produces one printable character and carries
// no modifier that would change its meaning. Shift is allowed because it is
// already baked into the character the platform reported.
function printableCharacter(press) {
  if (press.ctrl || press.alt || press.meta) {
    return '';
  }

  const character = typeof press.char === 'string' ? press.char : '';
  return [...character].length === 1 && character >= ' ' && character !== ''
    ? character
    : '';
}

function describePress(press) {
  const parts = [];

  if (press.ctrl) parts.push('Ctrl');
  if (press.shift) parts.push('Shift');
  if (press.alt) parts.push('Alt');
  if (press.meta) parts.push('Win');
  parts.push(press.key);
  return parts.join('+');
}

function createMacroRecorder({
  maxSteps = MAX_MULTI_STEPS,
  minDelayMs = MIN_RECORDED_DELAY_MS,
  captureDelays = true,
} = {}) {
  let steps = [];
  let pendingText = '';
  let lastTime = null;
  let totalDelay = 0;
  let truncated = false;

  function room() {
    return steps.length < maxSteps;
  }

  function flushText() {
    if (!pendingText) {
      return;
    }

    if (room()) {
      steps.push({ type: 'text', text: pendingText });
    } else {
      truncated = true;
    }

    pendingText = '';
  }

  // A delay only earns a step when a step still remains for the press that
  // follows it, otherwise the recording would end on a pause.
  function recordDelay(gap) {
    if (!captureDelays || gap < minDelayMs) {
      return;
    }

    const ms = roundDelay(gap);

    if (totalDelay + ms > MAX_TOTAL_DELAY_MS) {
      return;
    }

    flushText();

    if (steps.length + 1 >= maxSteps) {
      truncated = true;
      return;
    }

    totalDelay += ms;
    steps.push({ type: 'delay', ms });
  }

  function press(event) {
    if (truncated || !event?.key) {
      return false;
    }

    if (lastTime !== null && Number.isFinite(event.time)) {
      recordDelay(event.time - lastTime);
    }

    if (Number.isFinite(event.time)) {
      lastTime = event.time;
    }

    if (truncated) {
      return false;
    }

    const character = printableCharacter(event);

    if (character) {
      if ([...pendingText].length >= MAX_TEXT_CHARACTERS) {
        flushText();
      }

      if (truncated) {
        return false;
      }

      pendingText += character;
      return true;
    }

    flushText();

    if (!room()) {
      truncated = true;
      return false;
    }

    steps.push({
      type: 'hotkey',
      key: event.key,
      alt: Boolean(event.alt),
      ctrl: Boolean(event.ctrl),
      meta: Boolean(event.meta),
      shift: Boolean(event.shift),
    });
    return true;
  }

  function result() {
    flushText();
    return { steps: [...steps], truncated };
  }

  function reset() {
    steps = [];
    pendingText = '';
    lastTime = null;
    totalDelay = 0;
    truncated = false;
  }

  // A live preview while recording must not flush the pending text into the
  // real step list, so it works on a copy.
  function preview() {
    const previewSteps = [...steps];

    if (pendingText) {
      previewSteps.push({ type: 'text', text: pendingText });
    }

    return previewSteps;
  }

  return { press, preview, reset, result };
}

function describeStep(step) {
  if (step.type === 'delay') {
    return `Wait ${step.ms} ms`;
  }

  if (step.type === 'text') {
    return `Type "${step.text}"`;
  }

  return describePress(step);
}

module.exports = {
  DELAY_ROUNDING_MS,
  MIN_RECORDED_DELAY_MS,
  createMacroRecorder,
  describePress,
  describeStep,
  printableCharacter,
  roundDelay,
};
