const {
  MAX_DELAY_MS,
  MAX_MULTI_STEPS,
} = require('../action-model');
const { validateAction } = require('../deck-model');
const {
  buildLeafAction,
  newActionForDefinition,
  pluginDraftError,
  renderActionFields,
} = require('./action-fields');

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
    key: 'core:text',
    source: 'Stream32',
    category: 'System',
    name: 'Type Text',
    description: 'Type bounded text into the focused application.',
    icon: 'keyboard',
    keywords: ['type', 'text', 'paste', 'input'],
    available: true,
    coreType: 'text',
    appearance: {
      label: 'Type',
      icon: 'keyboard',
      color: '#38556b',
    },
  },
  {
    key: 'core:mouse',
    source: 'Stream32',
    category: 'System',
    name: 'Mouse',
    description: 'Click, move, or scroll the system pointer.',
    icon: 'mouse',
    keywords: ['click', 'pointer', 'move', 'scroll'],
    available: true,
    coreType: 'mouse',
    appearance: {
      label: 'Mouse',
      icon: 'mouse',
      color: '#4c496d',
    },
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
  {
    key: 'core:multi',
    source: 'Stream32',
    category: 'Deck',
    name: 'Multi Action',
    description: 'Run an ordered sequence of actions and bounded delays.',
    icon: 'playlist_play',
    keywords: ['sequence', 'steps', 'delay', 'ordered'],
    available: true,
    coreType: 'multi',
    appearance: {
      label: 'Multi',
      icon: 'playlist_play',
      color: '#34445c',
    },
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

function multiStepError(step, actions, pages) {
  const definition = actions.find((entry) => entry.key === actionKey(step));
  const settingsError = pluginDraftError(step, definition);

  if (settingsError) {
    return settingsError;
  }

  try {
    validateAction({ type: 'multi', steps: [step] }, pages.length);
    return '';
  } catch (error) {
    return error.message.replace(/^Step 1:\s*/, '');
  }
}

function multiDraftError(steps, actions, pages) {
  if (Array.isArray(steps)) {
    for (const [index, step] of steps.entries()) {
      const definition = actions.find((entry) => entry.key === actionKey(step));
      const error = pluginDraftError(step, definition);

      if (error) {
        return `Step ${index + 1}: ${error}`;
      }
    }
  }

  try {
    validateAction({ type: 'multi', steps }, pages.length);
    return '';
  } catch (error) {
    return error.message;
  }
}

class ActionEditor {
  constructor({ document, onChange, onReload }) {
    this.document = document;
    this.onChange = onChange;
    this.onReload = onReload;
    this.actions = [...CORE_ACTIONS];
    this.capabilities = {};
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
    this.applyCapabilities();
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

  setCapabilities(capabilities) {
    this.capabilities = capabilities || {};
    this.applyCapabilities();
    this.renderSummary();
    this.renderConfig();
  }

  applyCapabilities() {
    this.actions = this.actions.map((definition) => {
      const capability = this.capabilities[definition.coreType];

      return capability
        ? {
            ...definition,
            available: Boolean(capability.available),
            limitation: capability.reason || '',
          }
        : definition;
    });
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
        : `${action.description} ${action.limitation ||
            'Not supported on this platform.'}`;
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
    this.draft = newActionForDefinition(definition);
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

    if (definition?.coreType === 'multi') {
      this.renderMultiConfig();
      return;
    }

    renderActionFields({
      action: this.draft,
      capability: definition?.coreType
        ? this.capabilities[definition.coreType]
        : undefined,
      commit: () => this.emit(),
      container: this.config,
      definition,
      document: this.document,
      pages: this.pages,
      reportMessage: (message) => {
        this.message.textContent = message;
      },
    });
  }

  addMultiStep(step) {
    this.draft.steps ||= [];

    if (this.draft.steps.length >= MAX_MULTI_STEPS) {
      return;
    }

    this.draft.steps.push(structuredClone(step));
    this.emit();
  }

  moveMultiStep(index, offset) {
    const destination = index + offset;

    if (
      !Array.isArray(this.draft.steps) ||
      destination < 0 ||
      destination >= this.draft.steps.length
    ) {
      return;
    }

    const [step] = this.draft.steps.splice(index, 1);
    this.draft.steps.splice(destination, 0, step);
    this.emit();
  }

  duplicateMultiStep(index) {
    if (
      !Array.isArray(this.draft.steps) ||
      !this.draft.steps[index] ||
      this.draft.steps.length >= MAX_MULTI_STEPS
    ) {
      return;
    }

    this.draft.steps.splice(
      index + 1,
      0,
      structuredClone(this.draft.steps[index]),
    );
    this.emit();
  }

  removeMultiStep(index) {
    if (!Array.isArray(this.draft.steps) || !this.draft.steps[index]) {
      return;
    }

    this.draft.steps.splice(index, 1);
    this.emit();
  }

  makeStepButton(text, label, onClick, disabled = false) {
    const button = this.document.createElement('button');
    button.type = 'button';
    button.className = 'button button-quiet multi-step-button';
    button.textContent = text;
    button.setAttribute('aria-label', label);
    button.disabled = disabled;
    button.addEventListener('click', onClick);
    return button;
  }

  renderMultiConfig() {
    const steps = Array.isArray(this.draft.steps) ? this.draft.steps : [];
    const list = this.document.createElement('ol');
    list.className = 'multi-step-list';
    list.setAttribute('aria-label', 'Ordered Multi Action steps');

    for (const [index, step] of steps.entries()) {
      const item = this.document.createElement('li');
      item.className = 'multi-step';
      const header = this.document.createElement('div');
      header.className = 'multi-step-header';
      const title = this.document.createElement('strong');
      title.textContent = `Step ${index + 1}`;
      const controls = this.document.createElement('div');
      controls.className = 'multi-step-controls';
      controls.append(
        this.makeStepButton(
          '↑',
          `Move step ${index + 1} up`,
          () => this.moveMultiStep(index, -1),
          index === 0,
        ),
        this.makeStepButton(
          '↓',
          `Move step ${index + 1} down`,
          () => this.moveMultiStep(index, 1),
          index === steps.length - 1,
        ),
        this.makeStepButton(
          'Duplicate',
          `Duplicate step ${index + 1}`,
          () => this.duplicateMultiStep(index),
          steps.length >= MAX_MULTI_STEPS,
        ),
        this.makeStepButton(
          'Remove',
          `Remove step ${index + 1}`,
          () => this.removeMultiStep(index),
        ),
      );
      header.append(title, controls);
      item.append(header);

      if (step.type === 'delay') {
        const input = this.document.createElement('input');
        input.type = 'number';
        input.min = '0';
        input.max = String(MAX_DELAY_MS);
        input.step = '100';
        input.value = String(step.ms);
        input.addEventListener('change', () => {
          step.ms = Number(input.value);
          this.emit();
        });
        item.append(this.makeField('Delay (milliseconds)', input));
      } else {
        const definitions = this.actions.filter(
          (definition) => definition.coreType !== 'multi',
        );
        const selectedKey = actionKey(step);
        const definition =
          definitions.find((entry) => entry.key === selectedKey) || null;
        const select = this.document.createElement('select');

        if (!definition) {
          const missing = this.document.createElement('option');
          missing.value = selectedKey;
          missing.textContent =
            `Missing plugin · ${step.pluginId} / ${step.actionId}`;
          select.append(missing);
        }

        for (const candidate of definitions) {
          const option = this.document.createElement('option');
          option.value = candidate.key;
          option.textContent = `${candidate.source} · ${candidate.name}`;
          option.disabled = !candidate.available && candidate.key !== selectedKey;
          select.append(option);
        }

        select.value = selectedKey;
        select.addEventListener('change', () => {
          const next = definitions.find(
            (candidate) => candidate.key === select.value,
          );

          if (next) {
            this.draft.steps[index] = newActionForDefinition(next);
            this.emit();
          }
        });
        item.append(this.makeField('Action', select));

        const fields = this.document.createElement('div');
        fields.className = 'multi-step-fields';
        renderActionFields({
          action: step,
          capability: definition?.coreType
            ? this.capabilities[definition.coreType]
            : undefined,
          commit: () => this.emit(),
          container: fields,
          definition,
          document: this.document,
          pages: this.pages,
          reportMessage: (text) => {
            const message = this.document.createElement('p');
            message.className = 'helper';
            message.textContent = text.replace(
              'This action is preserved',
              'This step is preserved',
            );
            fields.append(message);
          },
          showLimitation: false,
        });
        item.append(fields);
      }

      const error = multiStepError(step, this.actions, this.pages);

      if (error) {
        const message = this.document.createElement('p');
        message.className = 'helper multi-step-error';
        message.textContent = error;
        message.setAttribute('role', 'alert');
        item.append(message);
      }

      list.append(item);
    }

    const toolbar = this.document.createElement('div');
    toolbar.className = 'multi-step-toolbar';
    const full = steps.length >= MAX_MULTI_STEPS;
    toolbar.append(
      this.makeStepButton(
        'Add action',
        'Add action step',
        () => this.addMultiStep({ type: 'media', command: 'play-pause' }),
        full,
      ),
      this.makeStepButton(
        'Add delay',
        'Add delay step',
        () => this.addMultiStep({ type: 'delay', ms: 1000 }),
        full,
      ),
    );
    this.config.append(list, toolbar);
    this.message.textContent = multiDraftError(
      steps,
      this.actions,
      this.pages,
    );
  }

  buildAction() {
    const definition = this.selectedDefinition();

    if (!definition || !definition.available) {
      return this.action;
    }

    if (definition.coreType === 'multi') {
      return multiDraftError(this.draft.steps, this.actions, this.pages)
        ? null
        : { type: 'multi', steps: structuredClone(this.draft.steps) };
    }

    return buildLeafAction(this.draft, definition, this.pages?.length ?? 0);
  }

  emit(appearance = this.selectedDefinition()?.appearance) {
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
  multiDraftError,
};
