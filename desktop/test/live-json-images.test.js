const assert = require('node:assert/strict');
const test = require('node:test');

const { LiveJsonImages } = require('../src/renderer/live-json-images');

function makeElement(tag = 'div') {
  return {
    tag,
    children: [],
    listeners: {},
    attributes: {},
    disabled: false,
    value: '',
    append(...nodes) {
      this.children.push(...nodes);
    },
    replaceChildren(...nodes) {
      this.children = [...nodes];
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    addEventListener(type, handler) {
      (this.listeners[type] ||= []).push(handler);
    },
  };
}

async function fire(node, type) {
  for (const handler of node.listeners[type] || []) {
    await handler();
  }
}

function imagesFixture(images) {
  const container = makeElement();
  const iconRequests = [];
  let current = images;
  const fields = new LiveJsonImages({
    document: { createElement: (tag) => makeElement(tag) },
    container,
    onChange: (mutate) => {
      const next = { ...current };

      if (mutate(next)) {
        current = next;
      }

      fields.render(current);
      return true;
    },
    readImageFile: async () => 'data:image/png;base64,AAAA',
    openIconLibrary: (apply) => iconRequests.push(apply),
    onError: () => {},
  });

  fields.render(current);
  return { container, fields, iconRequests, images: () => current };
}

// Row order is [name, remove, image row], and the image row is
// [icon library, file].
const nameInput = (row) => row.children[0];
const removeButton = (row) => row.children[1];
const imageRow = (row) => row.children[2];

test('each slot gets a row that edits only itself', async () => {
  const { container, images } = imagesFixture({
    logo: 'data:image/png;base64,AAAA',
    badge: 'data:image/png;base64,BBBB',
  });

  assert.equal(container.children.length, 2);
  assert.equal(nameInput(container.children[1]).value, 'badge');

  const name = nameInput(container.children[1]);
  name.value = '  ribbon  ';
  await fire(name, 'change');

  assert.deepEqual(images(), {
    logo: 'data:image/png;base64,AAAA',
    ribbon: 'data:image/png;base64,BBBB',
  });
});

test('a rename that collides or breaks the pattern is refused, not saved', async () => {
  const { container, images } = imagesFixture({
    logo: 'data:image/png;base64,AAAA',
    badge: 'data:image/png;base64,BBBB',
  });
  const before = images();

  for (const rejected of ['logo', 'Not A Name', '']) {
    const name = nameInput(container.children[1]);
    name.value = rejected;
    await fire(name, 'change');
    assert.deepEqual(images(), before);
  }

  // The refused value is put back to the slot's real name.
  assert.equal(nameInput(container.children[1]).value, 'badge');
});

test('adding picks the lowest free name and removing keeps the rest', async () => {
  const { container, fields, images } = imagesFixture({
    image2: 'data:image/png;base64,AAAA',
  });

  fields.add();
  assert.deepEqual(Object.keys(images()), ['image2', 'image1']);

  fields.add();
  assert.deepEqual(Object.keys(images()), ['image2', 'image1', 'image3']);

  await fire(removeButton(container.children[0]), 'click');
  assert.deepEqual(Object.keys(images()), ['image1', 'image3']);
});

test('slots stop being added once the bound is reached', () => {
  const { fields, images } = imagesFixture(
    Object.fromEntries(
      Array.from({ length: 8 }, (unused, index) => [
        `image${index + 1}`,
        'data:image/png;base64,AAAA',
      ]),
    ),
  );

  fields.add();
  assert.equal(Object.keys(images()).length, 8);
});

test('artwork picked from the library lands on the row that opened it', async () => {
  const { container, iconRequests, images } = imagesFixture({
    logo: 'data:image/png;base64,AAAA',
  });

  await fire(imageRow(container.children[0]).children[0], 'click');
  assert.equal(iconRequests.length, 1);
  iconRequests[0]('data:image/webp;base64,CCCC');

  assert.deepEqual(images(), { logo: 'data:image/webp;base64,CCCC' });
});

test('the artwork controls sit in the row the Appearance section is styled by', () => {
  const { container } = imagesFixture({ logo: 'data:image/png;base64,AAAA' });
  const row = imageRow(container.children[0]);

  assert.equal(row.tag, 'div');
  assert.equal(row.className, 'deck-image-row');
  assert.deepEqual(
    row.children.map((child) => child.tag),
    ['button', 'input'],
  );
  assert.equal(row.children[1].type, 'file');
});
