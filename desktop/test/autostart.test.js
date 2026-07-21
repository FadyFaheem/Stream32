const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createLinuxDesktopEntry,
  quoteDesktopArgument,
} = require('../src/autostart');

test('quotes Linux desktop-entry executable paths', () => {
  assert.equal(
    quoteDesktopArgument('/opt/Stream 32/stream32'),
    '"/opt/Stream 32/stream32"',
  );
  assert.equal(
    quoteDesktopArgument('/tmp/100%/$stream32'),
    '"/tmp/100%%/\\$stream32"',
  );
});

test('rejects line breaks in Linux desktop-entry arguments', () => {
  assert.throws(
    () => quoteDesktopArgument('/tmp/stream32\nHidden=true'),
    /line breaks/,
  );
});

test('builds an XDG autostart entry that launches hidden', () => {
  const entry = createLinuxDesktopEntry('/opt/Stream 32/stream32');

  assert.match(entry, /^Type=Application$/m);
  assert.match(entry, /^Exec="\/opt\/Stream 32\/stream32" --hidden$/m);
  assert.match(entry, /^Terminal=false$/m);
});
