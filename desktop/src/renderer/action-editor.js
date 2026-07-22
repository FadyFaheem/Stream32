const { canonicalKeyFromCode } = require('../keymap');

const MEDIA_OPTIONS = [
  ['play-pause', 'Play / Pause'],
  ['previous', 'Previous track'],
  ['next', 'Next track'],
  ['mute', 'Mute'],
  ['volume-down', 'Volume down'],
  ['volume-up', 'Volume up'],
];

const CORE_ACTIONS = [
  {
    key: 'core:media',
    source: 'Stream32',
    category: 'System',
    name: 'Media control',
    description: 'Playback, volume, and system audio controls.',
    icon: 'play_circle',
    keywords: ['music', 'volume', 'play', 'pause'],
    available: true,
    coreType: 'media',
  },
  {
    key: 'core:hotkey',
    source: 'Stream32',
    category: 'System',
    name: 'Keyboard shortcut',
    description: 'Send a custom keyboard shortcut.',
    icon: 'keyboard',
    keywords: ['hotkey', 'keys', 'shortcut'],
    available: true,
    coreType: 'hotkey',
  },
  {
    key: 'core:url',
    source: 'Stream32',
    category: 'Open',
    name: 'Open website',
    description: 'Open an HTTP or HTTPS address in the default browser.',
    icon: 'language',
    keywords: ['browser', 'link', 'website', 'url'],
    available: true,
    coreType: 'url',
  },
  {
    key: 'core:launch',
    source: 'Stream32',
    category: 'Open',
    name: 'Launch app / command',
    description: 'Run a command line configured by the deck owner.',
    icon: 'rocket_launch',
    keywords: ['app', 'command', 'program', 'run'],
    available: true,
    coreType: 'launch',
  },
  {
    key: 'core:page',
    source: 'Stream32',
    category: 'Deck',
    name: 'Go to page',
    description: 'Switch this deck to another page.',
    icon: 'tab_move',
    keywords: ['navigation', 'page', 'switch'],
    available: true,
    coreType: 'page',
  },
];

function actionKey(action) {
  if (!action) {
    return null;
  }

  return action.type === 'plugin'
    ? `plugin:${action.pluginId}:${action.actionId}`
    : `core:${action.type}`;
}

function searchableText(action) {
  return [
    action.name,
    action.description,
    action.source,
    action.category,
    ...action.keywords,
  ].join(' ').toLowerCase();
}

function filterActions(actions, query) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);

  return actions
    .map((action, index) => {
      const text = searchableText(action);

      if (!terms.every((term) => text.includes(term))) {
        return null;
      }

      const name = action.name.toLowerCase();
      const score = terms.reduce((total, term) => {
        if (name.startsWith(term)) return total + 4;
        if (name.includes(term)) return total + 2;
        return total + 1;
      }, action.available ? 2 : 0);

      return { action, index, score };
    })
    .filter(Boolean)
    .sort((left, right) =>
      right.score - left.score || left.index - right.index)
    .map(({ action }) => action);
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

function pluginActions(catalog) {
  return catalog.plugins.flatMap((plugin) =>
    plugin.actions.map((action) => ({
      ...action,
      key: `plugin:${plugin.id}:${action.id}`,
      source: plugin.name,
      pluginId: plugin.id,
      actionId: action.id,
    })));
}

class ActionEditor {
  constructor({ document, onChange, onReload }) {
    this.document = document;
    this.onChange = onChange;
    this.onReload = onReload;
    this.actions = [...CORE_ACTIONS];
    this.action = null;
    this.context = null;
    this.draftKey = null;
    this.draft = {};
    this.pages = [];

    this.openButton = document.querySelector('#deck-action-open');
    this.clearButton = document.querySelector('#deck-action-clear');
    this.summaryIcon = document.querySelector('#deck-action-summary-icon');
    this.summaryName = document.querySelector('#deck-action-summary-name');
    this.summarySource = document.querySelector('#deck-action-summary-source');
    this.config = document.querySelector('#deck-action-config');
    this.message = document.querySelector('#deck-action-message');
    this.dialog = document.querySelector('#deck-action-dialog');
    this.search = document.querySelector('#deck-action-search');
    this.list = document.querySelector('#deck-action-list');
    this.closeButton = document.querySelector('#deck-action-close');
    this.reloadButton = document.querySelector('#deck-action-reload');
    this.pluginStatus = document.querySelector('#deck-plugin-status');

    this.bindEvents();
  }

  bindEvents() {
    this.openButton.addEventListener('click', () => {
      this.search.value = '';
      this.renderList('');
      this.dialog.showModal();
      this.search.focus();
    });
    this.clearButton.addEventListener('click', () => {
      this.draftKey = null;
      this.draft = {};
      this.action = null;
      this.onChange(null);
    });
    this.search.addEventListener('input', () => {
      this.renderList(this.search.value);
    });
    this.closeButton.addEventListener('click', () => this.dialog.close());
    this.dialog.addEventListener('click', (event) => {
      if (event.target === this.dialog) {
        this.dialog.close();
      }
    });
    this.reloadButton.addEventListener('click', async () => {
      this.reloadButton.disabled = true;

      try {
        this.setCatalog(await this.onReload());
        this.renderList(this.search.value);
      } catch (error) {
        this.setCatalogError(error.message);
      } finally {
        this.reloadButton.disabled = false;
      }
    });
  }

  setCatalog(catalog) {
    this.actions = [...CORE_ACTIONS, ...pluginActions(catalog)];
    const invalid = catalog.errors.length;
    const errorSummary = catalog.errors
      .slice(0, 3)
      .map((error) => `${error.file}: ${error.message}`)
      .join('; ');
    this.pluginStatus.textContent = invalid
      ? `${invalid} plugin manifest${invalid === 1 ? '' : 's'} could not be loaded: ` +
        `${errorSummary}${invalid > 3 ? '; …' : ''}. ` +
        `Install JSON manifests in ${catalog.userDirectory}`
      : `Install JSON manifests in ${catalog.userDirectory}`;
    this.renderSummary();
    this.renderConfig();
  }

  setCatalogError(message) {
    this.pluginStatus.textContent = `Plugins could not be loaded: ${message}`;
  }

  render({ action, context, pages }) {
    if (context !== this.context) {
      this.context = context;
      this.draftKey = actionKey(action);
      this.draft = action ? structuredClone(action) : {};
    } else if (action) {
      this.draftKey = actionKey(action);
      this.draft = structuredClone(action);
    } else if (!this.draftKey) {
      this.draft = {};
    }

    this.action = action;
    this.pages = pages;
    this.renderSummary();
    this.renderConfig();
  }

  selectedDefinition() {
    return this.actions.find((action) => action.key === this.draftKey) || null;
  }

  renderSummary() {
    const definition = this.selectedDefinition();
    const missing = this.action?.type === 'plugin' && !definition;

    this.summaryIcon.textContent = definition?.icon || (missing ? 'extension_off' : 'add');
    this.summaryName.textContent = definition?.name ||
      (missing ? 'Missing plugin action' : 'Choose an action');
    this.summarySource.textContent = definition
      ? `${definition.source} · ${definition.category}`
      : missing
        ? `${this.action.pluginId} / ${this.action.actionId}`
        : 'Search Stream32 and installed plugins';
    this.clearButton.hidden = !this.action && !this.draftKey;
  }

  renderList(query) {
    const matches = filterActions(this.actions, query);
    this.list.replaceChildren();

    if (matches.length === 0) {
      const empty = this.document.createElement('p');
      empty.className = 'helper action-list-empty';
      empty.textContent = 'No actions match that search.';
      this.list.append(empty);
      return;
    }

    let currentSource = null;
    let group = null;

    for (const action of matches) {
      if (action.source !== currentSource) {
        currentSource = action.source;
        const heading = this.document.createElement('h3');
        heading.className = 'action-group-title';
        heading.textContent = currentSource;
        group = this.document.createElement('div');
        group.className = 'action-list-group';
        this.list.append(heading, group);
      }

      const button = this.document.createElement('button');
      button.type = 'button';
      button.className = 'action-choice';
      button.disabled = !action.available;
      button.dataset.selected = String(action.key === this.draftKey);

      const icon = this.document.createElement('span');
      icon.className = 'ms-icon action-choice-icon';
      icon.textContent = action.icon;

      const copy = this.document.createElement('span');
      copy.className = 'action-choice-copy';
      const name = this.document.createElement('strong');
      name.textContent = action.name;
      const description = this.document.createElement('span');
      description.textContent = action.available
        ? action.description
        : `${action.description} Not supported on this platform.`;
      copy.append(name, description);

      const category = this.document.createElement('span');
      category.className = 'action-choice-category';
      category.textContent = action.category;
      button.append(icon, copy, category);
      button.addEventListener('click', () => this.choose(action));
      group.append(button);
    }
  }

  choose(definition) {
    this.draftKey = definition.key;
    this.draft = definition.coreType
      ? {}
      : {
        type: 'plugin',
        pluginId: definition.pluginId,
        actionId: definition.actionId,
        settings: Object.fromEntries(
          definition.fields.map((field) => [field.id, field.default]),
        ),
      };
    this.dialog.close();
    this.emit(definition.appearance);
  }

  makeField(labelText, control) {
    const label = this.document.createElement('label');
    label.className = 'deck-field';
    label.append(labelText, control);
    return label;
  }

  renderConfig() {
    const definition = this.selectedDefinition();
    this.config.replaceChildren();
    this.message.textContent = '';

    if (!definition) {
      if (this.action?.type === 'plugin') {
        this.message.textContent =
          'This action is kept in the deck, but its plugin is not installed.';
      }
      return;
    }

    if (!definition.available) {
      this.message.textContent = 'This action is not supported on this platform.';
      return;
    }

    if (definition.coreType) {
      this.renderCoreConfig(definition.coreType);
    } else {
      this.renderPluginConfig(definition);
    }
  }

  renderCoreConfig(type) {
    if (type === 'media') {
      const select = this.document.createElement('select');

      for (const [value, label] of MEDIA_OPTIONS) {
        const option = this.document.createElement('option');
        option.value = value;
        option.textContent = label;
        select.append(option);
      }

      select.value = this.draft.command || 'play-pause';
      select.addEventListener('change', () => {
        this.draft.command = select.value;
        this.emit();
      });
      this.config.append(this.makeField('Media command', select));
      return;
    }

    if (type === 'url' || type === 'launch') {
      const input = this.document.createElement('input');
      input.type = type === 'url' ? 'url' : 'text';
      input.maxLength = type === 'url' ? 2048 : 1024;
      input.placeholder = type === 'url'
        ? 'https://example.com'
        : 'notepad.exe or any command line';
      input.value = this.draft[type === 'url' ? 'url' : 'command'] || '';
      input.addEventListener('change', () => {
        this.draft[type === 'url' ? 'url' : 'command'] = input.value.trim();
        this.emit();
      });
      this.config.append(
        this.makeField(type === 'url' ? 'Website address' : 'Command', input),
      );
      return;
    }

    if (type === 'hotkey') {
      const input = this.document.createElement('input');
      input.type = 'text';
      input.readOnly = true;
      input.placeholder = 'Click, then press keys';
      input.value = this.draft.key ? describeHotkey(this.draft) : '';
      input.addEventListener('keydown', (event) => {
        event.preventDefault();
        const key = canonicalKeyFromCode(event.code);

        if (!key) {
          return;
        }

        this.draft = {
          key,
          alt: event.altKey,
          ctrl: event.ctrlKey,
          meta: event.metaKey,
          shift: event.shiftKey,
        };
        input.value = describeHotkey(this.draft);
        this.emit();
      });
      this.config.append(this.makeField('Keyboard shortcut', input));
      return;
    }

    const select = this.document.createElement('select');

    for (const [index, page] of this.pages.entries()) {
      const option = this.document.createElement('option');
      option.value = String(index);
      option.textContent = page.name;
      select.append(option);
    }

    select.value = String(this.draft.page ?? 0);
    select.addEventListener('change', () => {
      this.draft.page = Number(select.value);
      this.emit();
    });
    this.config.append(this.makeField('Target page', select));
  }

  renderPluginConfig(definition) {
    for (const field of definition.fields) {
      let control;

      if (field.type === 'select') {
        control = this.document.createElement('select');

        for (const optionDefinition of field.options) {
          const option = this.document.createElement('option');
          option.value = optionDefinition.value;
          option.textContent = optionDefinition.label;
          control.append(option);
        }

        control.value = this.draft.settings?.[field.id] ?? field.default;
      } else {
        control = this.document.createElement('input');
        control.type = field.type === 'toggle' ? 'checkbox' : 'text';

        if (field.type === 'toggle') {
          control.className = 'switch';
          control.checked = this.draft.settings?.[field.id] ?? field.default;
        } else {
          control.maxLength = field.maxLength;
          control.placeholder = field.placeholder || '';
          control.value = this.draft.settings?.[field.id] ?? field.default;
        }
      }

      control.addEventListener('change', () => {
        this.draft.settings[field.id] = field.type === 'toggle'
          ? control.checked
          : control.value;
        this.emit();
      });
      this.config.append(this.makeField(field.label, control));
    }

    if (definition.fields.length === 0) {
      const ready = this.document.createElement('p');
      ready.className = 'helper';
      ready.textContent = 'This action is ready to use.';
      this.config.append(ready);
    }
  }

  buildAction() {
    const definition = this.selectedDefinition();

    if (!definition || !definition.available) {
      return this.action;
    }

    if (!definition.coreType) {
      const settings = { ...this.draft.settings };

      for (const field of definition.fields) {
        const value = settings[field.id] ?? field.default;

        if (field.required && field.type === 'text' && !value.trim()) {
          return null;
        }

        settings[field.id] = value;
      }

      return {
        type: 'plugin',
        pluginId: definition.pluginId,
        actionId: definition.actionId,
        settings,
      };
    }

    switch (definition.coreType) {
      case 'media':
        return { type: 'media', command: this.draft.command || 'play-pause' };
      case 'url':
        return this.draft.url ? { type: 'url', url: this.draft.url } : null;
      case 'launch':
        return this.draft.command
          ? { type: 'launch', command: this.draft.command }
          : null;
      case 'hotkey':
        return this.draft.key ? { type: 'hotkey', ...this.draft } : null;
      case 'page':
        return { type: 'page', page: this.draft.page ?? 0 };
      default:
        throw new TypeError(`Unknown core action: ${definition.coreType}`);
    }
  }

  emit(appearance) {
    const action = this.buildAction();
    this.action = action;
    this.onChange(action, action ? appearance : undefined);
  }
}

module.exports = {
  ActionEditor,
  CORE_ACTIONS,
  actionKey,
  filterActions,
};
