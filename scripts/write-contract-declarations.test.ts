import { expect, mock, test } from 'bun:test';
import { writeContractDeclarations } from './write-contract-declarations';
import type { DeclarationTools } from './write-contract-declarations';

test('it compiles the contract with its build config into the out folder', async () => {
  const runCompiler = mock<DeclarationTools['runCompiler']>(() =>
    Promise.resolve({ exitCode: 0, output: '' }),
  );

  await writeContractDeclarations('/repo', '/out', {
    runCompiler,
    listDeclarations: () => [],
    readText: () => '',
    writeText: () => {},
  });

  expect(runCompiler.mock.calls).toStrictEqual([
    [
      [
        '/repo/node_modules/.bin/tsrs',
        '-p',
        '/repo/packages/contract/tsconfig.build.json',
        '--outDir',
        '/out',
      ],
      '/repo',
    ],
  ]);
});

test('it rewrites each relative import to the file Node resolves and lists the files in order', async () => {
  const sources: ReadonlyMap<string, string> = new Map([
    ['/out/index.d.ts', "export * from './light';\nexport * from './session-id';\n"],
    ['/out/light/index.d.ts', "export type { SessionID } from '../session-id';\n"],
    ['/out/session-id.d.ts', "import type { z } from 'zod';\nexport type SessionID = string;\n"],
  ]);

  const writeText = mock<(path: string, text: string) => void>();

  const files = await writeContractDeclarations('/repo', '/out', {
    runCompiler: () => Promise.resolve({ exitCode: 0, output: '' }),
    listDeclarations: () => ['session-id.d.ts', 'light/index.d.ts', 'index.d.ts'],
    readText: (path) => sources.get(path) ?? '',
    writeText,
  });

  expect(files).toStrictEqual(['index.d.ts', 'light/index.d.ts', 'session-id.d.ts']);

  expect(writeText.mock.calls).toStrictEqual([
    ['/out/index.d.ts', "export * from './light/index.js';\nexport * from './session-id.js';\n"],
    ['/out/light/index.d.ts', "export type { SessionID } from '../session-id.js';\n"],
    ['/out/session-id.d.ts', "import type { z } from 'zod';\nexport type SessionID = string;\n"],
  ]);
});

test('it throws with the compiler output when the compiler fails', () => {
  expect(
    writeContractDeclarations('/repo', '/out', {
      runCompiler: () =>
        Promise.resolve({
          exitCode: 2,
          output: "src/index.ts(1,15): error TS2307: Cannot find module './gone'.\n",
        }),
      listDeclarations: () => ['index.d.ts'],
      readText: () => '',
      writeText: () => {},
    }),
  ).rejects.toThrow(
    "tsrs could not emit the contract's declarations:\nsrc/index.ts(1,15): error TS2307: Cannot find module './gone'.\n",
  );
});
