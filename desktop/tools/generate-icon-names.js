// Extracts the Material Symbols icon names from the package's typings into
// a JSON list the renderer bundle imports, and copies the icon font beside
// the renderer so the packaged app can load it. Runs as part of
// build:renderer; both outputs are gitignored.
const { copyFileSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

function parseIconNames(text) {
  const names = new Set();

  for (const match of text.matchAll(/^\s*"([a-z0-9_]+)",?$/gm)) {
    names.add(match[1]);
  }

  return [...names];
}

if (require.main === module) {
  const rendererDirectory = path.join(__dirname, '..', 'src', 'renderer');
  const typings = readFileSync(
    require.resolve('material-symbols/index.d.ts'),
    'utf8',
  );
  const names = parseIconNames(typings);

  if (names.length < 1000) {
    throw new Error(`Suspiciously few icon names parsed: ${names.length}`);
  }

  writeFileSync(
    path.join(rendererDirectory, 'icon-names.json'),
    JSON.stringify(names),
  );
  copyFileSync(
    path.join(
      path.dirname(require.resolve('material-symbols/package.json')),
      'material-symbols-rounded.woff2',
    ),
    path.join(rendererDirectory, 'material-symbols.woff2'),
  );
  console.log(`Wrote ${names.length} Material Symbols icon names.`);
}

module.exports = { parseIconNames };
