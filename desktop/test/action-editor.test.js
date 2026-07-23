const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ActionEditor,
  CORE_ACTIONS,
  actionKey,
  filterActions,
  multiDraftError,
} = require('../src/renderer/action-editor');
const {
  FIELD_BUILDERS,
  buildLeafAction,
  fieldBuilderForDefinition,
  renderActionFields,
} = require('../src/renderer/action-fields');

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
  assert.equal(actionKey({ type: 'text', text: 'Hi' }), 'core:text');
  assert.equal(
    actionKey({
      type: 'mouse',
      operation: 'click',
      button: 'left',
      clicks: 1,
    }),
    'core:mouse',
  );
  assert.equal(actionKey({ type: 'multi', steps: [] }), 'core:multi');
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

  renderActionFields({
    action: editor.draft,
    commit: () => editor.emit(),
    container: editor.config,
    definition: CORE_ACTIONS.find((action) => action.coreType === 'hotkey'),
    document,
    pages: [],
  });
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

test('adds, reorders, duplicates, removes, and builds Multi Action steps', () => {
  const editor = Object.create(ActionEditor.prototype);
  editor.actions = CORE_ACTIONS;
  editor.pages = [{ name: 'Main' }, { name: 'Media' }];
  editor.draft = { steps: [] };
  editor.selectedDefinition = () => ({
    available: true,
    coreType: 'multi',
  });
  editor.emit = () => {};

  editor.addMultiStep({ type: 'media', command: 'mute' });
  editor.addMultiStep({ type: 'delay', ms: 500 });
  editor.addMultiStep({ type: 'page', page: 1 });
  editor.moveMultiStep(2, -1);
  editor.duplicateMultiStep(0);
  editor.removeMultiStep(1);

  assert.deepEqual(editor.buildAction(), {
    type: 'multi',
    steps: [
      { type: 'media', command: 'mute' },
      { type: 'page', page: 1 },
      { type: 'delay', ms: 500 },
    ],
  });
});

test('Multi Action editor validates inline and preserves missing plugins', () => {
  assert.match(
    multiDraftError(
      [{ type: 'delay', ms: 30_001 }],
      CORE_ACTIONS,
      [{ name: 'Main' }],
    ),
    /Step 1.*30,000/,
  );
  assert.match(
    multiDraftError(
      [{ type: 'multi', steps: [] }],
      CORE_ACTIONS,
      [{ name: 'Main' }],
    ),
    /cannot be nested/,
  );

  const missing = {
    type: 'plugin',
    pluginId: 'missing-plugin',
    actionId: 'kept',
    settings: { value: 'unchanged' },
  };
  const editor = Object.create(ActionEditor.prototype);
  editor.actions = CORE_ACTIONS;
  editor.pages = [{ name: 'Main' }];
  editor.draft = { steps: [missing] };
  editor.selectedDefinition = () => ({
    available: true,
    coreType: 'multi',
  });

  assert.deepEqual(editor.buildAction(), {
    type: 'multi',
    steps: [missing],
  });
});

test('accepts bounded Type Text and Mouse Multi steps', () => {
  assert.equal(
    multiDraftError(
      [
        { type: 'text', text: 'Hello 👋\n' },
        {
          type: 'mouse',
          operation: 'move-relative',
          x: -10,
          y: 20,
        },
      ],
      CORE_ACTIONS,
      [{ name: 'Main' }],
    ),
    '',
  );
  assert.match(
    multiDraftError(
      [{ type: 'text', text: 'bad\u0000text' }],
      CORE_ACTIONS,
      [{ name: 'Main' }],
    ),
    /control character/,
  );
});

test('applies explicit host capability reasons to core actions', () => {
  const editor = Object.create(ActionEditor.prototype);
  editor.actions = [...CORE_ACTIONS];
  editor.capabilities = {};
  editor.renderSummary = () => {};
  editor.renderConfig = () => {};

  editor.setCapabilities({
    text: { available: false, reason: 'X11 is required.' },
    mouse: { available: true, reason: 'Requires xdotool.' },
  });

  const text = editor.actions.find((action) => action.coreType === 'text');
  const mouse = editor.actions.find((action) => action.coreType === 'mouse');
  assert.equal(text.available, false);
  assert.equal(text.limitation, 'X11 is required.');
  assert.equal(mouse.available, true);
  assert.equal(mouse.limitation, 'Requires xdotool.');
});

test('builds bounded Type Text and Mouse editor actions', () => {
  const editor = Object.create(ActionEditor.prototype);
  editor.action = null;
  editor.selectedDefinition = () => ({
    available: true,
    coreType: 'text',
  });
  editor.draft = { type: 'text', text: 'Hello\nworld' };
  assert.deepEqual(editor.buildAction(), {
    type: 'text',
    text: 'Hello\nworld',
  });
  editor.draft.text = 'bad\u0000text';
  assert.equal(editor.buildAction(), null);

  editor.selectedDefinition = () => ({
    available: true,
    coreType: 'mouse',
  });
  editor.draft = {
    type: 'mouse',
    operation: 'click',
    button: 'left',
    clicks: 2,
  };
  assert.deepEqual(editor.buildAction(), editor.draft);
  editor.draft.clicks = 3;
  assert.equal(editor.buildAction(), null);
});

test('top-level and Multi leaves resolve every action type to shared builders', () => {
  const plugin = {
    key: 'plugin:test:action',
    source: 'Test',
    category: 'Test',
    name: 'Plugin action',
    available: true,
    pluginId: 'test',
    actionId: 'action',
    fields: [
      {
        id: 'mode',
        type: 'select',
        label: 'Mode',
        default: 'one',
        options: [{ value: 'one', label: 'One' }],
      },
      {
        id: 'enabled',
        type: 'toggle',
        label: 'Enabled',
        default: false,
      },
      {
        id: 'name',
        type: 'text',
        label: 'Name',
        default: '',
        maxLength: 20,
      },
    ],
  };
  const definitions = [
    ...CORE_ACTIONS.filter((definition) => definition.coreType !== 'multi'),
    plugin,
  ];
  const document = {
    createElement() {
      return {
        append() {},
        addEventListener() {},
      };
    },
  };
  const drafts = {
    hotkey: { type: 'hotkey', key: 'A' },
    launch: { type: 'launch', command: 'notepad.exe' },
    media: { type: 'media', command: 'mute' },
    mouse: {
      type: 'mouse',
      operation: 'click',
      button: 'left',
      clicks: 1,
    },
    page: { type: 'page', page: 0 },
    plugin: {
      type: 'plugin',
      pluginId: 'test',
      actionId: 'action',
      settings: {},
    },
    text: { type: 'text', text: 'Hello' },
    url: { type: 'url', url: 'https://example.com' },
  };

  for (const definition of definitions) {
    const type = definition.coreType || 'plugin';
    const expected = FIELD_BUILDERS[type];
    const options = {
      action: structuredClone(drafts[type]),
      commit() {},
      definition,
      document,
      pages: [{ name: 'Main' }],
    };

    assert.equal(fieldBuilderForDefinition(definition), expected);
    assert.equal(
      renderActionFields({ ...options, container: { append() {} } }),
      expected,
    );
    assert.equal(
      renderActionFields({
        ...options,
        action: structuredClone(drafts[type]),
        container: { append() {} },
      }),
      expected,
    );
  }
});

test('top-level and Multi leaves share canonical validation for every type', () => {
  const plugin = {
    key: 'plugin:test:action',
    source: 'Test',
    category: 'Test',
    name: 'Plugin action',
    available: true,
    pluginId: 'test',
    actionId: 'action',
    fields: [{
      id: 'value',
      type: 'text',
      label: 'Value',
      default: '',
      maxLength: 20,
      required: true,
    }],
  };
  const actions = [...CORE_ACTIONS, plugin];
  const pages = [{ name: 'Main' }, { name: 'Second' }];
  const cases = [
    [
      'media',
      { type: 'media', command: 'mute' },
      { type: 'media', command: 'invalid' },
    ],
    ['url', { type: 'url', url: 'https://example.com' }, { type: 'url', url: '' }],
    ['launch', { type: 'launch', command: 'app' }, { type: 'launch', command: '' }],
    [
      'hotkey',
      { type: 'hotkey', key: 'A' },
      { type: 'hotkey', key: '' },
    ],
    ['text', { type: 'text', text: 'Hello' }, { type: 'text', text: '' }],
    [
      'mouse',
      { type: 'mouse', operation: 'click', button: 'left', clicks: 1 },
      { type: 'mouse', operation: 'click', button: 'left', clicks: 3 },
    ],
    ['page', { type: 'page', page: 1 }, { type: 'page', page: 2 }],
    [
      'plugin',
      {
        type: 'plugin',
        pluginId: 'test',
        actionId: 'action',
        settings: { value: 'ready' },
      },
      {
        type: 'plugin',
        pluginId: 'test',
        actionId: 'action',
        settings: { value: ' ' },
      },
    ],
  ];

  for (const [type, valid, invalid] of cases) {
    const definition = type === 'plugin'
      ? plugin
      : actions.find((candidate) => candidate.coreType === type);

    assert.ok(buildLeafAction(valid, definition, pages.length), type);
    assert.equal(multiDraftError([valid], actions, pages), '', type);
    assert.equal(buildLeafAction(invalid, definition, pages.length), null, type);
    assert.notEqual(multiDraftError([invalid], actions, pages), '', type);
  }
});
