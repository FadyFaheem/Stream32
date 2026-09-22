const {
  MAX_STATUS_JSON_IMAGES,
  STATUS_JSON_IMAGE_NAME_PATTERN,
} = require('../dynamic-state');

// One row per artwork slot a JSON status key offers its answers. Named for
// what the command will write, so "image": "logo" is a whole sentence: show
// the logo this row holds. Rows are built rather than written into index.html
// because their number is the user's choice, like exit-code states.
class LiveJsonImages {
  constructor({
    document,
    container,
    onChange,
    readImageFile,
    openIconLibrary,
    onError,
  }) {
    this.document = document;
    this.container = container;
    this.onChange = onChange;
    this.readImageFile = readImageFile;
    this.openIconLibrary = openIconLibrary;
    this.onError = onError;
  }

  // Object key order is insertion order, so slots stay in the order they were
  // added and renaming one keeps its place in the list.
  render(images) {
    this.container.replaceChildren();

    for (const [name, image] of Object.entries(images || {})) {
      this.container.append(this.renderSlot(name, image));
    }
  }

  renderSlot(name) {
    const { document } = this;
    const row = document.createElement('div');
    row.className = 'deck-live-json-image';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.maxLength = 32;
    nameInput.value = name;
    nameInput.placeholder = 'name';
    nameInput.className = 'deck-live-json-image-name';
    nameInput.setAttribute('aria-label', 'Image name');
    nameInput.addEventListener('change', () => {
      const next = nameInput.value.trim();

      if (!STATUS_JSON_IMAGE_NAME_PATTERN.test(next) || next === name) {
        nameInput.value = name;
        return;
      }

      // A rename that collides with another slot could never be shown, so it
      // is refused here rather than silently shadowing at save time.
      if (!this.rename(name, next)) {
        nameInput.value = name;
      }
    });

    // Named for what it removes, matching "Add image" that puts one back.
    const remove = this.button('Remove', () => this.change(name, null));

    const icon = this.button('Icon library', () => {
      this.openIconLibrary((data) => {
        this.change(name, (images) => {
          images[name] = data;
        });
      });
    }, 'secondary');

    const upload = document.createElement('input');
    upload.type = 'file';
    upload.accept = 'image/*';
    upload.setAttribute('aria-label', 'Image');
    upload.addEventListener('change', async () => {
      const file = upload.files?.[0];
      upload.value = '';

      if (!file) {
        return;
      }

      try {
        const data = await this.readImageFile(file);
        this.change(name, (images) => {
          images[name] = data;
        });
      } catch (error) {
        this.onError(error);
      }
    });

    // The same row the Appearance section uses, so the file control is styled
    // by the same rule rather than falling back to the browser's own look.
    const imageRow = document.createElement('div');
    imageRow.className = 'deck-image-row';
    imageRow.append(icon, upload);

    row.append(nameInput, remove, imageRow);
    return row;
  }

  button(text, onClick, variant = 'quiet') {
    const button = this.document.createElement('button');
    button.type = 'button';
    button.className = `button button-${variant}`;
    button.textContent = text;
    button.addEventListener('click', onClick);
    return button;
  }

  // A null mutation removes the slot. Names are the identity, so every other
  // mutation rewrites the named slot's value and leaves the rest alone.
  change(name, mutate) {
    return this.onChange((images) => {
      if (!mutate) {
        delete images[name];
        return true;
      }

      mutate(images);
      return true;
    });
  }

  rename(from, to) {
    return this.onChange((images) => {
      if (Object.prototype.hasOwnProperty.call(images, to)) {
        return false;
      }

      const renamed = {};

      for (const [name, image] of Object.entries(images)) {
        renamed[name === from ? to : name] = image;
      }

      for (const key of Object.keys(images)) {
        delete images[key];
      }

      Object.assign(images, renamed);
      return true;
    });
  }

  add() {
    this.onChange((images) => {
      if (Object.keys(images).length >= MAX_STATUS_JSON_IMAGES) {
        return false;
      }

      // The lowest unused "imageN", so a second click never collides and the
      // name is a placeholder the user is free to rename. The empty value is
      // a pending slot: it stays in the editor's draft and is dropped before
      // anything is saved, so a row is never hidden from the user editing it.
      let suffix = 1;

      while (
        Object.prototype.hasOwnProperty.call(images, `image${suffix}`) &&
        suffix <= MAX_STATUS_JSON_IMAGES
      ) {
        suffix++;
      }

      images[`image${suffix}`] = '';
      return true;
    });
  }
}

module.exports = { LiveJsonImages };
