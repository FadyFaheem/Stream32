const MAX_MULTI_STEPS = 16;
const MAX_DELAY_MS = 30_000;
const MAX_TOTAL_DELAY_MS = 120_000;
const MAX_TEXT_CHARACTERS = 512;
const MAX_MOUSE_COORDINATE = 32_767;
const MAX_MOUSE_DELTA = 10_000;
const MAX_SCROLL_DELTA = 100;
const MOUSE_BUTTONS = new Set(['left', 'middle', 'right']);
const MOUSE_OPERATIONS = new Set([
  'click',
  'move-absolute',
  'move-relative',
  'scroll',
]);
const AUDIO_OPERATIONS = new Set([
  'set-volume',
  'mute',
  'set-output-device',
  'app-volume',
  'app-mute',
]);
const MUTE_STATES = new Set(['on', 'off', 'toggle']);
const MAX_DEVICE_NAME_LENGTH = 256;
const MAX_APP_NAME_LENGTH = 256;
const UNSAFE_TEXT_CONTROL_PATTERN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;

function boundedInteger(value, field, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${field} is outside the supported range.`);
  }

  return value;
}

function validateTextAction(action) {
  if (
    action?.type !== 'text' ||
    typeof action.text !== 'string' ||
    action.text.length === 0 ||
    [...action.text].length > MAX_TEXT_CHARACTERS
  ) {
    throw new TypeError(
      `Type Text content must contain 1-${MAX_TEXT_CHARACTERS} Unicode characters.`,
    );
  }

  if (UNSAFE_TEXT_CONTROL_PATTERN.test(action.text)) {
    throw new TypeError(
      'Type Text content contains an unsafe control character.',
    );
  }

  return { type: 'text', text: action.text };
}

function validateMouseAction(action) {
  if (
    action?.type !== 'mouse' ||
    !MOUSE_OPERATIONS.has(action.operation)
  ) {
    throw new TypeError('Mouse operation is invalid.');
  }

  switch (action.operation) {
    case 'click':
      if (!MOUSE_BUTTONS.has(action.button)) {
        throw new TypeError('Mouse button is invalid.');
      }

      return {
        type: 'mouse',
        operation: 'click',
        button: action.button,
        clicks: boundedInteger(action.clicks, 'Mouse click count', 1, 2),
      };
    case 'move-absolute':
      return {
        type: 'mouse',
        operation: 'move-absolute',
        x: boundedInteger(
          action.x,
          'Mouse X coordinate',
          -MAX_MOUSE_COORDINATE,
          MAX_MOUSE_COORDINATE,
        ),
        y: boundedInteger(
          action.y,
          'Mouse Y coordinate',
          -MAX_MOUSE_COORDINATE,
          MAX_MOUSE_COORDINATE,
        ),
      };
    case 'move-relative':
      return {
        type: 'mouse',
        operation: 'move-relative',
        x: boundedInteger(
          action.x,
          'Mouse X delta',
          -MAX_MOUSE_DELTA,
          MAX_MOUSE_DELTA,
        ),
        y: boundedInteger(
          action.y,
          'Mouse Y delta',
          -MAX_MOUSE_DELTA,
          MAX_MOUSE_DELTA,
        ),
      };
    case 'scroll': {
      const vertical = boundedInteger(
        action.vertical,
        'Vertical scroll delta',
        -MAX_SCROLL_DELTA,
        MAX_SCROLL_DELTA,
      );
      const horizontal = boundedInteger(
        action.horizontal,
        'Horizontal scroll delta',
        -MAX_SCROLL_DELTA,
        MAX_SCROLL_DELTA,
      );

      if (vertical === 0 && horizontal === 0) {
        throw new TypeError('Mouse scroll needs a non-zero delta.');
      }

      return {
        type: 'mouse',
        operation: 'scroll',
        vertical,
        horizontal,
      };
    }
    default:
      throw new TypeError(`Unknown mouse operation: ${action.operation}`);
  }
}

function boundedPercent(value, field) {
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new TypeError(`${field} must be a whole number between 0 and 100.`);
  }

  return value;
}

function boundedName(value, field, maximumLength) {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > maximumLength
  ) {
    throw new TypeError(`${field} must be 1-${maximumLength} characters.`);
  }

  return value.trim();
}

// Audio actions address the real mixer rather than sending volume keys, so a
// saved key carries an exact level, an explicit mute state, or the name of a
// device or application. Names are stored as typed: the target may be absent
// when the key is edited and present when it is pressed.
function validateAudioAction(action) {
  if (action?.type !== 'audio' || !AUDIO_OPERATIONS.has(action.operation)) {
    throw new TypeError('Audio operation is invalid.');
  }

  switch (action.operation) {
    case 'set-volume':
      return {
        type: 'audio',
        operation: 'set-volume',
        level: boundedPercent(action.level, 'Audio volume'),
      };
    case 'mute':
      if (!MUTE_STATES.has(action.state)) {
        throw new TypeError('Audio mute state must be on, off, or toggle.');
      }

      return { type: 'audio', operation: 'mute', state: action.state };
    case 'set-output-device':
      return {
        type: 'audio',
        operation: 'set-output-device',
        device: boundedName(
          action.device,
          'Audio output device',
          MAX_DEVICE_NAME_LENGTH,
        ),
      };
    case 'app-volume':
      return {
        type: 'audio',
        operation: 'app-volume',
        app: boundedName(action.app, 'Audio application', MAX_APP_NAME_LENGTH),
        level: boundedPercent(action.level, 'Audio volume'),
      };
    case 'app-mute':
      if (!MUTE_STATES.has(action.state)) {
        throw new TypeError('Audio mute state must be on, off, or toggle.');
      }

      return {
        type: 'audio',
        operation: 'app-mute',
        app: boundedName(action.app, 'Audio application', MAX_APP_NAME_LENGTH),
        state: action.state,
      };
    default:
      throw new TypeError(`Unknown audio operation: ${action.operation}`);
  }
}

function actionPageTargets(action) {
  if (action?.type === 'page') {
    return [action.page];
  }

  if (action?.type === 'multi' && Array.isArray(action.steps)) {
    return action.steps
      .filter((step) => step?.type === 'page')
      .map((step) => step.page);
  }

  return [];
}

function remapActionAfterPageDeletion(action, removedPage) {
  if (action?.type === 'page') {
    if (action.page === removedPage) {
      return null;
    }

    return action.page > removedPage
      ? { ...action, page: action.page - 1 }
      : action;
  }

  if (action?.type !== 'multi' || !Array.isArray(action.steps)) {
    return action;
  }

  const steps = action.steps
    .filter((step) => step?.type !== 'page' || step.page !== removedPage)
    .map((step) =>
      step?.type === 'page' && step.page > removedPage
        ? { ...step, page: step.page - 1 }
        : step);

  return steps.length > 0 ? { ...action, steps } : null;
}

module.exports = {
  AUDIO_OPERATIONS,
  MAX_APP_NAME_LENGTH,
  MAX_DELAY_MS,
  MAX_DEVICE_NAME_LENGTH,
  MAX_MOUSE_COORDINATE,
  MAX_MOUSE_DELTA,
  MAX_MULTI_STEPS,
  MAX_SCROLL_DELTA,
  MAX_TEXT_CHARACTERS,
  MAX_TOTAL_DELAY_MS,
  MOUSE_BUTTONS,
  MOUSE_OPERATIONS,
  MUTE_STATES,
  actionPageTargets,
  remapActionAfterPageDeletion,
  validateAudioAction,
  validateMouseAction,
  validateTextAction,
};
