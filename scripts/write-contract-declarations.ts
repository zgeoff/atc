import { dirname, join } from 'node:path';

export interface DeclarationTools {
  readonly runCompiler: (
    command: readonly string[],
    cwd: string,
  ) => Promise<{ readonly exitCode: number; readonly output: string }>;
  readonly listDeclarations: (directory: string) => readonly string[];
  readonly readText: (path: string) => string;
  readonly writeText: (path: string, text: string) => void;
}

const CONTRACT_DIR = 'packages/contract';

// Compiles one published package's declarations into the out folder. The package defaults to the
// contract.
export async function writeContractDeclarations(
  root: string,
  out: string,
  tools: DeclarationTools,
  packageDir: string = CONTRACT_DIR,
): Promise<string[]> {
  const compiled = await tools.runCompiler(
    [
      join(root, 'node_modules/.bin/tsrs'),
      '-p',
      join(root, packageDir, 'tsconfig.build.json'),
      '--outDir',
      out,
    ],
    root,
  );

  if (compiled.exitCode !== 0) {
    throw new Error(`tsrs could not emit the declarations of ${packageDir}:\n${compiled.output}`);
  }

  const files = tools.listDeclarations(out).toSorted();

  const emitted = new Set(files);

  for (const file of files) {
    const path = join(out, file);

    tools.writeText(path, toNodeSpecifiers(tools.readText(path), dirname(file), emitted));
  }

  return files;
}

// Node's ESM resolution, which a consumer on `nodenext` type-checks with, takes
// no relative import without its file extension, and no folder import.
function toNodeSpecifiers(source: string, directory: string, emitted: ReadonlySet<string>): string {
  return source.replaceAll(
    /(?<quote>['"])(?<specifier>\.\.?\/[^'"]*|(?<=(?:from |import\()['"])\.\.?(?=['"]))\k<quote>/gu,
    (_whole, quote: string, specifier: string) => {
      const resolved = emitted.has(join(directory, specifier, 'index.d.ts'))
        ? `${specifier}/index.js`
        : `${specifier}.js`;

      return `${quote}${resolved}${quote}`;
    },
  );
}
