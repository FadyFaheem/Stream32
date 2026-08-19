const { MAX_LABEL_LENGTH, MAX_STATUS_STATES } = require('../dynamic-state');

const DEFAULT_COLOR = '#2f8f5b';
const DEFAULT_LABEL_COLOR = '#ffffff';
const MAX_EXIT_CODE = 255;

// One row per exit code the key knows how to look like. The rows are built
// rather than written into index.html because their number is the user's
// choice, unlike every other field in the key editor.
class LiveStatusFields {
  constructor({ document, container, onChange, readImageFile, onError }) {
    this.document = document;
    this.container = container;
    this.onChange = onChange;
    this.readImageFile = readImageFile;
    this.onError = onError;
  }

  // Codes stay in the order the user added them, so editing one never moves
  // the row under the pointer.
  render(states) {
    this.container.replaceChildren();

    for (const [position, state] of states.entries()) {
      this.container.append(this.renderState(position, state));
    }
  }

  renderState(position, state) {
    const { document } = this;
    const row = document.createElement('div');
    row.className = 'deck-live-status-state';

    const code = document.createElement('input');
    code.type = 'number';
    code.min = '0';
    code.max = String(MAX_EXIT_CODE);
    code.step = '1';
    code.value = String(state.code);
    code.className = 'deck-live-status-code';
    code.setAttribute('aria-label', 'Exit code');
    code.addEventListener('change', () => {
      const parsed = Number.parseInt(code.value, 10);

      if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_EXIT_CODE) {
        code.value = String(state.code);
        return;
      }

      this.change(position, (entry) => {
        entry.code = parsed;
      });
    });

    const label = document.createElement('input');
    label.type = 'text';
    label.maxLength = MAX_LABEL_LENGTH;
    label.value = state.label || '';
    label.placeholder = 'Label';
    label.setAttribute('aria-label', 'Label');
    label.addEventListener('change', () => {
      const text = label.value.trim().slice(0, MAX_LABEL_LENGTH);
      this.change(position, (entry) => {
        if (text) {
          entry.label = text;
        } else {
          delete entry.label;
        }
      });
    });

    const color = this.colorInput('Key color', state.color || DEFAULT_COLOR);
    color.addEventListener('change', () => {
      this.change(position, (entry) => {
        entry.color = color.value;
      });
    });

    const labelColor = this.colorInput(
      'Text color',
      state.labelColor || DEFAULT_LABEL_COLOR,
    );
    labelColor.addEventListener('change', () => {
      this.change(position, (entry) => {
        entry.labelColor = labelColor.value;
      });
    });

    const image = document.createElement('input');
    image.type = 'file';
    image.accept = 'image/*';
    image.setAttribute('aria-label', 'Image');
    image.addEventListener('change', async () => {
      const file = image.files?.[0];
      image.value = '';

      if (!file) {
        return;
      }

      try {
        const data = await this.readImageFile(file);
        this.change(position, (entry) => {
          entry.image = data;
        });
      } catch (error) {
        this.onError(error);
      }
    });

    const clearImage = this.button('Remove image', () => {
      this.change(position, (entry) => {
        delete entry.image;
      });
    });
    clearImage.disabled = !state.image;

    const remove = this.button('Remove', () => this.change(position, null));

    row.append(code, label, color, labelColor, image, clearImage, remove);
    return row;
  }

  colorInput(name, value) {
    const input = this.document.createElement('input');
    input.type = 'color';
    input.value = value;
    input.setAttribute('aria-label', name);
    return input;
  }

  button(text, onClick) {
    const button = this.document.createElement('button');
    button.type = 'button';
    button.className = 'button button-quiet';
    button.textContent = text;
    button.addEventListener('click', onClick);
    return button;
  }

  // A null mutation removes the row. Duplicate codes are refused here rather
  // than at save time, since the second one would silently never be shown.
  change(position, mutate) {
    this.onChange((states) => {
      if (!mutate) {
        states.splice(position, 1);
        return states.length > 0;
      }

      const entry = { ...states[position] };
      mutate(entry);

      if (states.some((other, index) =>
        index !== position && other.code === entry.code)) {
        return false;
      }

      states[position] = entry;
      return true;
    });
  }

  add() {
    this.onChange((states) => {
      if (states.length >= MAX_STATUS_STATES) {
        return false;
      }

      const used = new Set(states.map((state) => state.code));
      let code = 0;

      while (used.has(code) && code <= MAX_EXIT_CODE) {
        code++;
      }

      if (code > MAX_EXIT_CODE) {
        return false;
      }

      states.push({
        code,
        color: DEFAULT_COLOR,
        labelColor: DEFAULT_LABEL_COLOR,
      });
      return true;
    });
  }
}

module.exports = { LiveStatusFields };
