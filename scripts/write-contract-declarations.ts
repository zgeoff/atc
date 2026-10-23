import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const CONTRACT_DIR = 'packages/contract';

export async function writeContractDeclarations(root: string, out: string): Promise<string[]> {
  const compiler = Bun.spawn(
    [
      join(root, 'node_modules/.bin/tsrs'),
      '-p',
      join(root, CONTRACT_DIR, 'tsconfig.build.json'),
      '--outDir',
      out,
    ],
    { cwd: root, stdout: 'pipe', stderr: 'pipe' },
  );

  if ((await compiler.exited) !== 0) {
    const output = `${await new Response(compiler.stdout).text()}${await new Response(compiler.stderr).text()}`;

    throw new Error(`tsrs could not emit the contract's declarations:\n${output}`);
  }

  const files = [...new Bun.Glob('**/*.d.ts').scanSync({ cwd: out })].toSorted();

  const emitted = new Set(files);

  for (const file of files) {
    const path = join(out, file);

    writeFileSync(path, toNodeSpecifiers(readFileSync(path, 'utf8'), dirname(file), emitted));
  }

  return files;
}

// Node's ESM resolution, which a consumer on `nodenext` type-checks with, takes
// no relative import without its file extension, and no folder import.
function toNodeSpecifiers(source: string, directory: string, emitted: ReadonlySet<string>): string {
  return source.replaceAll(
    /(?<quote>['"])(?<specifier>\.\.?\/[^'"]*)\k<quote>/gu,
    (_whole, quote: string, specifier: string) => {
      const resolved = emitted.has(join(directory, specifier, 'index.d.ts'))
        ? `${specifier}/index.js`
        : `${specifier}.js`;

      return `${quote}${resolved}${quote}`;
    },
  );
}
