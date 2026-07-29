const assert = require('node:assert/strict');
const test = require('node:test');

const {
  listPullRequestChannels,
  normalizeChannel,
  resolveChannel,
} = require('../src/update-channel');

test('pull request channels need developer mode', () => {
  assert.equal(normalizeChannel('pr123', true), 'pr123');
  assert.equal(normalizeChannel('pr123', false), 'stable');
  assert.equal(normalizeChannel('nightly', false), 'nightly');
  assert.equal(normalizeChannel('pr0', true), 'stable');
  assert.equal(normalizeChannel('latest', true), 'stable');
  assert.equal(normalizeChannel(undefined, true), 'stable');
});

test('stable stays on the release feed and previews opt into prereleases', () => {
  assert.deepEqual(resolveChannel('stable', '1.2.0'), {
    allowDowngrade: false,
    allowPrerelease: false,
    channel: 'latest',
  });
  assert.deepEqual(resolveChannel('nightly', '1.2.1-nightly.20260729.4'), {
    allowDowngrade: false,
    allowPrerelease: true,
    channel: 'nightly',
  });
});

test('only a change of channel may roll the app backwards', () => {
  // Leaving nightly means installing an older stable build.
  assert.equal(
    resolveChannel('stable', '1.2.1-nightly.20260729.4').allowDowngrade,
    true,
  );
  assert.equal(resolveChannel('nightly', '1.2.0').allowDowngrade, true);
  assert.equal(
    resolveChannel('pr123', '1.2.1-pr123.9').allowDowngrade,
    false,
  );
});

test('pull request builds are read from release tags, newest first', () => {
  assert.deepEqual(
    listPullRequestChannels([
      { name: 'Stream32 nightly', tag_name: 'v1.2.1-nightly.20260729.4' },
      { name: 'PR #12 preview', tag_name: 'v1.2.1-pr12.8' },
      { name: 'PR #12 older', tag_name: 'v1.2.1-pr12.7' },
      { draft: true, name: 'Draft', tag_name: 'v1.2.1-pr99.1' },
      { name: 'Stream32 1.2.0', tag_name: 'v1.2.0' },
      { name: 'Board support', tag_name: 'boards-current' },
      null,
    ]),
    [{ channel: 'pr12', label: 'PR #12 preview', version: '1.2.1-pr12.8' }],
  );
  assert.deepEqual(listPullRequestChannels(undefined), []);
});
