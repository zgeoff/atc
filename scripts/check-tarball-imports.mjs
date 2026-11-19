// Fails when a packed package imports a module that its dependencies do not provide, or uses Bun's
// global: a consumer installs only the package and its dependencies, on Node or on Bun.
//   node check-tarball-imports.mjs <extracted package folder>
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const folder = process.argv.at(2);

if (folder === undefined) {
  console.error('usage: node check-tarball-imports.mjs <extracted package folder>');
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'));
const allowed = new Set(Object.keys(manifest.dependencies ?? {}));
const failures = [];

const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"](?<specifier>[^'"]+)['"]/gu;

for (const file of listFiles(join(folder, 'dist'))) {
  const text = readFileSync(file, 'utf8');

  for (const match of text.matchAll(SPECIFIER)) {
    const specifier = match.groups.specifier;

    if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) {
      continue;
    }

    const name = specifier.startsWith('@')
      ? specifier.split('/').slice(0, 2).join('/')
      : specifier.split('/')[0];

    if (!allowed.has(name)) {
      failures.push(`${file} imports ${specifier}, which is no dependency of ${manifest.name}`);
    }
  }

  if (file.endsWith('.js') && /\bBun\./u.test(text)) {
    failures.push(`${file} uses the Bun global, which Node does not have`);
  }
}

for (const failure of failures) {
  console.error(`::error::${failure}`);
}

if (failures.length > 0) {
  process.exit(1);
}

console.log(`${manifest.name} imports only its dependencies and node: modules`);

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    return entry.isDirectory() ? listFiles(path) : [path];
  });
}
