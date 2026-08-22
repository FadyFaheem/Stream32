const assert = require('node:assert/strict');
const test = require('node:test');

const { LiveStatusFields } = require('../src/renderer/live-status-fields');

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

function fieldsFixture(states) {
  const container = makeElement();
  const iconRequests = [];
  let current = states;
  const fields = new LiveStatusFields({
    document: { createElement: (tag) => makeElement(tag) },
    container,
    onChange: (mutate) => {
      const next = current.map((state) => ({ ...state }));

      if (mutate(next)) {
        current = next;
      }

      fields.render(current);
    },
    readImageFile: async () => 'data:image/png;base64,AAAA',
    openIconLibrary: (apply) => iconRequests.push(apply),
    onError: () => {},
  });

  fields.render(current);
  return { container, fields, iconRequests, states: () => current };
}

// Row order is [code, label, color, labelColor, remove, image row], and the
// image row is [icon library, file, clear image].
const codeInput = (row) => row.children[0];
const labelInput = (row) => row.children[1];
const removeButton = (row) => row.children[4];
const imageRow = (row) => row.children[5];

test('each exit code gets a row that edits only itself', async () => {
  const { container, states } = fieldsFixture([
    { code: 0, label: 'Speakers' },
    { code: 1, label: 'Headset' },
  ]);

  assert.equal(container.children.length, 2);
  assert.equal(codeInput(container.children[1]).value, '1');

  const label = labelInput(container.children[1]);
  label.value = '  Headphones  ';
  await fire(label, 'change');

  assert.deepEqual(states(), [
    { code: 0, label: 'Speakers' },
    { code: 1, label: 'Headphones' },
  ]);
});

test('a duplicate or out-of-range exit code is refused, not saved', async () => {
  const { container, states } = fieldsFixture([{ code: 0 }, { code: 1 }]);
  const before = states();

  // Two rows on one code would leave the second one unreachable.
  const code = codeInput(container.children[1]);
  code.value = '0';
  await fire(code, 'change');
  assert.deepEqual(states(), before);
  assert.equal(codeInput(container.children[1]).value, '1');

  // Windows exit codes are 32-bit, so the bound is that rather than a byte.
  for (const rejected of ['2147483648', '-1', 'nine']) {
    code.value = rejected;
    await fire(code, 'change');
    assert.deepEqual(states(), before);
  }
});

test('adding picks the lowest free code and removing keeps the rest', async () => {
  const { container, fields, states } = fieldsFixture([
    { code: 0 },
    { code: 2 },
  ]);

  fields.add();
  assert.deepEqual(states().map((state) => state.code), [0, 2, 1]);

  await fire(removeButton(container.children[0]), 'click');
  assert.deepEqual(states().map((state) => state.code), [2, 1]);
});

test('the last row cannot be removed, since a key needs a state to show', async () => {
  const { container, states } = fieldsFixture([{ code: 0, label: 'Only' }]);

  await fire(removeButton(container.children[0]), 'click');
  assert.deepEqual(states(), [{ code: 0, label: 'Only' }]);
});

test('the image controls sit in the row the Appearance section is styled by', () => {
  const { container } = fieldsFixture([{ code: 0 }]);
  const row = imageRow(container.children[0]);

  assert.equal(row.tag, 'div');
  assert.equal(row.className, 'deck-image-row');
  assert.deepEqual(
    row.children.map((child) => child.tag),
    ['button', 'input', 'button'],
  );
  assert.equal(row.children[1].type, 'file');
});

test('an icon chosen from the library lands on the row that opened it', async () => {
  const { container, iconRequests, states } = fieldsFixture([
    { code: 0, label: 'Speakers' },
    { code: 1, label: 'Headset' },
  ]);

  await fire(imageRow(container.children[1]).children[0], 'click');
  assert.equal(iconRequests.length, 1);
  iconRequests[0]('data:image/webp;base64,BBBB');

  assert.deepEqual(states(), [
    { code: 0, label: 'Speakers' },
    { code: 1, label: 'Headset', image: 'data:image/webp;base64,BBBB' },
  ]);
});

test('states stop being added once the bound is reached', () => {
  const { fields, states } = fieldsFixture(
    Array.from({ length: 8 }, (unused, code) => ({ code })),
  );

  fields.add();
  assert.equal(states().length, 8);
});
