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
  MAX_DELAY_MS,
  MAX_MOUSE_COORDINATE,
  MAX_MOUSE_DELTA,
  MAX_MULTI_STEPS,
  MAX_SCROLL_DELTA,
  MAX_TEXT_CHARACTERS,
  MAX_TOTAL_DELAY_MS,
  MOUSE_BUTTONS,
  MOUSE_OPERATIONS,
  actionPageTargets,
  remapActionAfterPageDeletion,
  validateMouseAction,
  validateTextAction,
};
