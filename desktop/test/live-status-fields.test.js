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
    onError: () => {},
  });

  fields.render(current);
  return { container, fields, states: () => current };
}

// Row order is [code, label, color, labelColor, image, clear image, remove].
const codeInput = (row) => row.children[0];
const labelInput = (row) => row.children[1];
const removeButton = (row) => row.children[6];

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

  for (const rejected of ['256', '-1', 'nine']) {
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

test('states stop being added once the bound is reached', () => {
  const { fields, states } = fieldsFixture(
    Array.from({ length: 8 }, (unused, code) => ({ code })),
  );

  fields.add();
  assert.equal(states().length, 8);
});
