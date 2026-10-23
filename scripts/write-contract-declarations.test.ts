import { expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import { DECLARATION_TOOLS } from './declaration-tools';
import { writeContractDeclarations } from './write-contract-declarations';
import type { DeclarationTools } from './write-contract-declarations';

function setupTest() {
  const temporaryDirectory = setupTempDir('write-contract-declarations-');

  return { out: temporaryDirectory.path };
}

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

test('it lists the emitted declaration files in order', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.out, 'session-id.d.ts'), 'export type SessionID = string;\n');
  await Bun.write(join(ctx.out, 'light/index.d.ts'), 'export declare const SOCKET: string;\n');
  await Bun.write(join(ctx.out, 'index.d.ts'), "export * from './light';\n");

  const files = await writeContractDeclarations('/repo', ctx.out, {
    ...DECLARATION_TOOLS,
    runCompiler: () => Promise.resolve({ exitCode: 0, output: '' }),
  });

  expect(files).toStrictEqual(['index.d.ts', 'light/index.d.ts', 'session-id.d.ts']);
});

test('it rewrites each relative import in the emitted files to the file Node resolves', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.out, 'index.d.ts'),
    "export * from './light';\nexport * from './session-id';\n",
  );

  await Bun.write(
    join(ctx.out, 'light/index.d.ts'),
    "export type { SessionID } from '../session-id';\n",
  );

  await Bun.write(
    join(ctx.out, 'session-id.d.ts'),
    "import type { z } from 'zod';\nexport type SessionID = string;\n",
  );

  await writeContractDeclarations('/repo', ctx.out, {
    ...DECLARATION_TOOLS,
    runCompiler: () => Promise.resolve({ exitCode: 0, output: '' }),
  });

  expect({
    index: readFileSync(join(ctx.out, 'index.d.ts'), 'utf8'),
    light: readFileSync(join(ctx.out, 'light/index.d.ts'), 'utf8'),
    sessionID: readFileSync(join(ctx.out, 'session-id.d.ts'), 'utf8'),
  }).toStrictEqual({
    index: "export * from './light/index.js';\nexport * from './session-id.js';\n",
    light: "export type { SessionID } from '../session-id.js';\n",
    sessionID: "import type { z } from 'zod';\nexport type SessionID = string;\n",
  });
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
