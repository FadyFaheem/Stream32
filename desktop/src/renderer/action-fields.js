const {
  MAX_MOUSE_COORDINATE,
  MAX_MOUSE_DELTA,
  MAX_SCROLL_DELTA,
  MAX_TEXT_CHARACTERS,
} = require('../action-model');
const { validateAction } = require('../deck-model');
const { canonicalKeyFromCode } = require('../keymap');

const MEDIA_OPTIONS = [
  ['play-pause', 'Play / Pause'],
  ['previous', 'Previous track'],
  ['next', 'Next track'],
  ['mute', 'Mute'],
  ['volume-down', 'Volume down'],
  ['volume-up', 'Volume up'],
];

function makeField(document, labelText, control) {
  const label = document.createElement('label');
  label.className = 'deck-field';
  label.append(labelText, control);
  return label;
}

function describeHotkey(hotkey) {
  const parts = [];

  if (hotkey.ctrl) parts.push('Ctrl');
  if (hotkey.shift) parts.push('Shift');
  if (hotkey.alt) parts.push('Alt');
  if (hotkey.meta) parts.push('Win');
  parts.push(hotkey.key);
  return parts.join('+');
}

function newActionForDefinition(definition, profiles = []) {
  if (!definition.coreType) {
    return {
      type: 'plugin',
      pluginId: definition.pluginId,
      actionId: definition.actionId,
      settings: Object.fromEntries(
        definition.fields.map((field) => [field.id, field.default]),
      ),
    };
  }

  switch (definition.coreType) {
    case 'media':
      return { type: 'media', command: 'play-pause' };
    case 'hotkey':
      return {
        type: 'hotkey',
        key: '',
        alt: false,
        ctrl: false,
        meta: false,
        shift: false,
      };
    case 'text':
      return { type: 'text', text: '' };
    case 'mouse':
      return {
        type: 'mouse',
        operation: 'click',
        button: 'left',
        clicks: 1,
      };
    case 'url':
      return { type: 'url', url: '' };
    case 'launch':
      return { type: 'launch', command: '' };
    case 'page':
      return { type: 'page', page: 0 };
    case 'profile':
      return { type: 'profile', profileId: profiles[0]?.id || '' };
    case 'multi':
      return { type: 'multi', steps: [] };
    default:
      throw new TypeError(`Unknown core action: ${definition.coreType}`);
  }
}

function pluginDraftError(action, definition) {
  if (action?.type !== 'plugin' || !definition || definition.coreType) {
    return '';
  }

  for (const field of definition.fields) {
    const value = action.settings?.[field.id] ?? field.default;

    if (
      field.required &&
      field.type === 'text' &&
      (typeof value !== 'string' || !value.trim())
    ) {
      return `${field.label} is required.`;
    }
  }

  return '';
}

function buildLeafAction(draft, definition, pageCount) {
  if (!definition || definition.available === false) {
    return null;
  }

  if (!definition.coreType) {
    if (pluginDraftError(draft, definition)) {
      return null;
    }

    const settings = { ...draft.settings };

    for (const field of definition.fields) {
      settings[field.id] = settings[field.id] ?? field.default;
    }

    return {
      type: 'plugin',
      pluginId: definition.pluginId,
      actionId: definition.actionId,
      settings,
    };
  }

  let candidate;

  switch (definition.coreType) {
    case 'media':
      candidate = { type: 'media', command: draft.command || 'play-pause' };
      break;
    case 'url':
      candidate = draft.url ? { type: 'url', url: draft.url } : null;
      break;
    case 'launch':
      candidate = draft.command
        ? { type: 'launch', command: draft.command }
        : null;
      break;
    case 'hotkey':
      candidate = draft.key ? { type: 'hotkey', ...draft } : null;
      break;
    case 'text':
      candidate = { type: 'text', text: draft.text };
      break;
    case 'mouse':
      candidate = { type: 'mouse', ...draft };
      break;
    case 'page':
      candidate = { type: 'page', page: draft.page ?? 0 };
      break;
    case 'profile':
      candidate = { type: 'profile', profileId: draft.profileId };
      break;
    default:
      throw new TypeError(`Expected a leaf action, received ${definition.coreType}.`);
  }

  if (!candidate) {
    return null;
  }

  try {
    return validateAction(candidate, pageCount);
  } catch {
    return null;
  }
}

function renderMedia({ action, commit, container, document }) {
  const select = document.createElement('select');

  for (const [value, label] of MEDIA_OPTIONS) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.append(option);
  }

  select.value = action.command || 'play-pause';
  select.addEventListener('change', () => {
    action.command = select.value;
    commit();
  });
  container.append(makeField(document, 'Media command', select));
}

function renderText({ action, commit, container, document }) {
  const input = document.createElement('textarea');
  input.maxLength = MAX_TEXT_CHARACTERS * 2;
  input.rows = 4;
  input.placeholder = 'Text to type into the focused application';
  input.value = action.text || '';
  input.addEventListener('input', () => {
    const characters = [...input.value];

    if (characters.length > MAX_TEXT_CHARACTERS) {
      input.value = characters.slice(0, MAX_TEXT_CHARACTERS).join('');
    }
  });
  input.addEventListener('change', () => {
    action.text = input.value;
    commit();
  });
  container.append(makeField(document, 'Text', input));
}

function renderMouse({ action, commit, container, document }) {
  const operation = document.createElement('select');
  const operations = [
    ['click', 'Click'],
    ['move-absolute', 'Move to position'],
    ['move-relative', 'Move by offset'],
    ['scroll', 'Scroll'],
  ];

  for (const [value, label] of operations) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    operation.append(option);
  }

  operation.value = action.operation || 'click';
  operation.addEventListener('change', () => {
    const defaults = operation.value === 'click'
      ? { operation: 'click', button: 'left', clicks: 1 }
      : operation.value === 'scroll'
        ? { operation: 'scroll', vertical: 1, horizontal: 0 }
        : { operation: operation.value, x: 0, y: 0 };
    Object.assign(action, defaults);
    commit();
  });
  container.append(makeField(document, 'Mouse operation', operation));

  if (operation.value === 'click') {
    const button = document.createElement('select');

    for (const value of ['left', 'right', 'middle']) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = `${value[0].toUpperCase()}${value.slice(1)}`;
      button.append(option);
    }

    button.value = action.button || 'left';
    button.addEventListener('change', () => {
      action.button = button.value;
      commit();
    });
    const clicks = document.createElement('select');

    for (const [value, label] of [['1', 'Single'], ['2', 'Double']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      clicks.append(option);
    }

    clicks.value = String(action.clicks || 1);
    clicks.addEventListener('change', () => {
      action.clicks = Number(clicks.value);
      commit();
    });
    container.append(
      makeField(document, 'Button', button),
      makeField(document, 'Clicks', clicks),
    );
    return;
  }

  const addNumber = (property, label, minimum, maximum) => {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = String(minimum);
    input.max = String(maximum);
    input.step = '1';
    input.value = String(action[property] ?? 0);
    input.addEventListener('change', () => {
      action[property] = Number(input.value);
      commit();
    });
    container.append(makeField(document, label, input));
  };

  if (operation.value === 'scroll') {
    addNumber('vertical', 'Vertical delta', -MAX_SCROLL_DELTA, MAX_SCROLL_DELTA);
    addNumber(
      'horizontal',
      'Horizontal delta',
      -MAX_SCROLL_DELTA,
      MAX_SCROLL_DELTA,
    );
    return;
  }

  const relative = operation.value === 'move-relative';
  const minimum = relative ? -MAX_MOUSE_DELTA : -MAX_MOUSE_COORDINATE;
  const maximum = relative ? MAX_MOUSE_DELTA : MAX_MOUSE_COORDINATE;
  addNumber(
    'x',
    relative ? 'Horizontal delta' : 'X coordinate',
    minimum,
    maximum,
  );
  addNumber(
    'y',
    relative ? 'Vertical delta' : 'Y coordinate',
    minimum,
    maximum,
  );
}

function renderString({ action, commit, container, definition, document }) {
  const isUrl = definition.coreType === 'url';
  const property = isUrl ? 'url' : 'command';
  const input = document.createElement('input');
  input.type = isUrl ? 'url' : 'text';
  input.maxLength = isUrl ? 2048 : 1024;
  input.placeholder = isUrl
    ? 'https://example.com'
    : 'notepad.exe or any command line';
  input.value = action[property] || '';
  input.addEventListener('change', () => {
    action[property] = input.value.trim();
    commit();
  });
  container.append(
    makeField(document, isUrl ? 'Website address' : 'Command', input),
  );
}

function renderHotkey({ action, commit, container, document }) {
  const input = document.createElement('input');
  const windowsKey = document.createElement('input');
  const windowsKeyLabel = document.createElement('label');
  input.type = 'text';
  input.readOnly = true;
  input.placeholder = 'Click, then press a key';
  input.value = action.key ? describeHotkey(action) : '';
  windowsKey.type = 'checkbox';
  windowsKey.checked = Boolean(action.meta);
  windowsKeyLabel.className = 'hotkey-modifier';
  windowsKeyLabel.append(windowsKey, 'Windows key');
  input.addEventListener('keydown', (event) => {
    event.preventDefault();

    if (/^Meta(Left|Right)$/.test(event.code)) {
      windowsKey.checked = true;
      action.meta = true;

      if (action.key) {
        input.value = describeHotkey(action);
        commit();
      }

      return;
    }

    const key = canonicalKeyFromCode(event.code);

    if (!key) {
      return;
    }

    Object.assign(action, {
      key,
      alt: event.altKey,
      ctrl: event.ctrlKey,
      meta: event.metaKey || windowsKey.checked,
      shift: event.shiftKey,
    });
    windowsKey.checked = action.meta;
    input.value = describeHotkey(action);
    commit();
  });
  windowsKey.addEventListener('change', () => {
    action.meta = windowsKey.checked;

    if (action.key) {
      input.value = describeHotkey(action);
      commit();
    }
  });
  container.append(
    makeField(document, 'Keyboard shortcut', input),
    windowsKeyLabel,
  );
}

function renderPage({ action, commit, container, document, pages }) {
  const select = document.createElement('select');

  for (const [index, page] of pages.entries()) {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = page.name;
    select.append(option);
  }

  select.value = String(action.page ?? 0);
  select.addEventListener('change', () => {
    action.page = Number(select.value);
    commit();
  });
  container.append(makeField(document, 'Target page', select));
}

function renderProfile({ action, commit, container, document, profiles }) {
  const select = document.createElement('select');
  const target = profiles.find((profile) => profile.id === action.profileId);

  if (!target && action.profileId) {
    const missing = document.createElement('option');
    missing.value = action.profileId;
    missing.textContent = `Missing profile · ${action.profileId}`;
    select.append(missing);
  }

  for (const profile of profiles) {
    const option = document.createElement('option');
    option.value = profile.id;
    option.textContent = profile.name;
    select.append(option);
  }

  select.value = action.profileId || profiles[0]?.id || '';
  select.addEventListener('change', () => {
    action.profileId = select.value;
    commit();
  });
  container.append(makeField(document, 'Target profile', select));

  const note = document.createElement('p');
  note.className = 'helper action-host-note';
  note.textContent =
    'Requires the Stream32 desktop app to be running on this computer.';
  container.append(note);
}

function renderPlugin({ action, commit, container, definition, document }) {
  action.settings ||= {};

  for (const field of definition.fields) {
    let control;

    if (field.type === 'select') {
      control = document.createElement('select');

      for (const optionDefinition of field.options) {
        const option = document.createElement('option');
        option.value = optionDefinition.value;
        option.textContent = optionDefinition.label;
        control.append(option);
      }

      control.value = action.settings[field.id] ?? field.default;
    } else {
      control = document.createElement('input');
      control.type = field.type === 'toggle' ? 'checkbox' : 'text';

      if (field.type === 'toggle') {
        control.className = 'switch';
        control.checked = action.settings[field.id] ?? field.default;
      } else {
        control.maxLength = field.maxLength;
        control.placeholder = field.placeholder || '';
        control.value = action.settings[field.id] ?? field.default;
      }
    }

    control.addEventListener('change', () => {
      action.settings[field.id] = field.type === 'toggle'
        ? control.checked
        : control.value;
      commit();
    });
    container.append(makeField(document, field.label, control));
  }

  if (definition.fields.length === 0) {
    const ready = document.createElement('p');
    ready.className = 'helper';
    ready.textContent = 'This action is ready to use.';
    container.append(ready);
  }
}

const FIELD_BUILDERS = Object.freeze({
  hotkey: renderHotkey,
  launch: renderString,
  media: renderMedia,
  mouse: renderMouse,
  page: renderPage,
  profile: renderProfile,
  plugin: renderPlugin,
  text: renderText,
  url: renderString,
});

function fieldBuilderForDefinition(definition) {
  return definition
    ? FIELD_BUILDERS[definition.coreType || 'plugin'] || null
    : null;
}

function renderActionFields({
  action,
  capability,
  commit,
  container,
  definition,
  document,
  pages,
  profiles = [],
  reportMessage = () => {},
  showLimitation = true,
}) {
  if (!definition) {
    if (action) {
      reportMessage(
        action.type === 'plugin'
          ? 'This action is preserved, but its plugin is not installed.'
          : 'Choose a supported action.',
      );
    }

    return null;
  }

  const available = capability?.available ?? definition.available;
  const limitation = capability?.reason || definition.limitation || '';

  if (!available) {
    reportMessage(
      limitation || 'This action is not supported on this platform.',
    );
    return null;
  }

  const builder = fieldBuilderForDefinition(definition);

  if (!builder) {
    throw new TypeError(`Unknown leaf action: ${definition.coreType}`);
  }

  builder({
    action,
    commit,
    container,
    definition,
    document,
    pages,
    profiles,
  });

  if (showLimitation && limitation) {
    const message = document.createElement('p');
    message.className = 'helper';
    message.textContent = limitation;
    container.append(message);
  }

  return builder;
}

module.exports = {
  FIELD_BUILDERS,
  MEDIA_OPTIONS,
  buildLeafAction,
  fieldBuilderForDefinition,
  newActionForDefinition,
  pluginDraftError,
  renderActionFields,
};
