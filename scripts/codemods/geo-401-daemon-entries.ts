// Gives @atc/daemon its two entry points once the wave 7 move has run with a
// wildcard exports map. Each import of `@atc/daemon/<module>` outside the
// package becomes an import of `@atc/daemon`, or of `@atc/daemon/testing`
// for a module under testing/, and the matching index re-exports the
// module. The exports map then lists the two entries alone. A second run
// finds no deep import and changes nothing.
// Usage: bun scripts/codemods/geo-401-daemon-entries.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const PACKAGE_DIR = 'packages/daemon';
const DEEP_IMPORT = /(?<quote>['"])@atc\/daemon\/(?<module>(?!testing\k<quote>)[^'"]+)\k<quote>/g;

function main(): void {
  const root = { '.': new Set<string>(), testing: new Set<string>() };
  let rewritten = 0;

  for (const file of new Bun.Glob('{packages,e2e}/**/*.{ts,tsx}').scanSync({ cwd: ROOT })) {
    if (file.split('/').includes('node_modules') || file.startsWith(`${PACKAGE_DIR}/`)) {
      continue;
    }

    const source = readFileSync(join(ROOT, file), 'utf8');

    const updated = source.replaceAll(DEEP_IMPORT, (_match, quote: string, module: string) => {
      if (module.startsWith('testing/')) {
        root.testing.add(`./${module.slice('testing/'.length)}`);

        return `${quote}@atc/daemon/testing${quote}`;
      }

      root['.'].add(`./${module}`);

      return `${quote}@atc/daemon${quote}`;
    });

    if (updated !== source) {
      writeFileSync(join(ROOT, file), updated);

      rewritten += 1;
    }
  }

  writeIndex(join(ROOT, PACKAGE_DIR, 'src/index.ts'), root['.']);
  writeIndex(join(ROOT, PACKAGE_DIR, 'src/testing/index.ts'), root.testing);
  writeExports(join(ROOT, PACKAGE_DIR, 'package.json'));

  console.log(`geo-401-daemon-entries: ${rewritten} files rewritten`);
}

// Adds a re-export of each module to the index, keeping the ones it holds.
function writeIndex(path: string, modules: ReadonlySet<string>): void {
  const held = existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line.startsWith('export'))
    : [];

  const lines = new Set([...held, ...[...modules].map((module) => `export * from '${module}';`)]);

  writeFileSync(path, `${[...lines].toSorted().join('\n')}\n`);
}

function writeExports(path: string): void {
  const manifest: unknown = JSON.parse(readFileSync(path, 'utf8'));

  if (typeof manifest !== 'object' || manifest === null) {
    throw new Error(`${path} holds no manifest object`);
  }

  const exports = { '.': './src/index.ts', './testing': './src/testing/index.ts' };

  writeFileSync(path, `${JSON.stringify({ ...manifest, exports }, null, 2)}\n`);
}

main();
