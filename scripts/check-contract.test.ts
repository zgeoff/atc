import { expect, test } from 'bun:test';
import { mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand, setupTempDir } from '@atc/test-utils';

// A temp directory standing in for a repo root, which takes the compiler from
// this checkout's node_modules.
function setupTest() {
  const temporaryDirectory = setupTempDir('check-contract-');

  symlinkSync(
    join(import.meta.dir, '../node_modules'),
    join(temporaryDirectory.path, 'node_modules'),
  );

  return { directory: temporaryDirectory.path };
}

test('it writes each declaration file to the snapshot with the specifiers Node resolves', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.directory, 'packages/contract/tsconfig.build.json'),
    JSON.stringify({
      compilerOptions: {
        declaration: true,
        emitDeclarationOnly: true,
        module: 'preserve',
        rootDir: 'src',
        types: [],
      },
      include: ['src/**/*.ts'],
    }),
  );

  await Bun.write(
    join(ctx.directory, 'packages/contract/src/index.ts'),
    "export * from './light';\nexport * from './session-id';\n",
  );

  await Bun.write(
    join(ctx.directory, 'packages/contract/src/session-id.ts'),
    'export type SessionID = string;\n',
  );

  await Bun.write(
    join(ctx.directory, 'packages/contract/src/light/index.ts'),
    "export const SOCKET_NAME = 'atc.sock';\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-contract.ts'),
    ctx.directory,
    '--update',
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 0,
    stdout: 'check-contract: wrote 3 declaration files to packages/contract/declarations.snap\n',
    stderr: '',
  });

  const snapshot = await Bun.file(
    join(ctx.directory, 'packages/contract/declarations.snap'),
  ).text();

  expect(snapshot).toMatchInlineSnapshot(`
    "// index.d.ts
    export * from './light/index.js';
    export * from './session-id.js';

    // light/index.d.ts
    export declare const SOCKET_NAME = "atc.sock";

    // session-id.d.ts
    export type SessionID = string;
    "
  `);
});

test('it passes declarations that match the snapshot', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.directory, 'packages/contract/tsconfig.build.json'),
    JSON.stringify({
      compilerOptions: {
        declaration: true,
        emitDeclarationOnly: true,
        module: 'preserve',
        rootDir: 'src',
        types: [],
      },
      include: ['src/**/*.ts'],
    }),
  );

  await Bun.write(
    join(ctx.directory, 'packages/contract/src/index.ts'),
    'export type SessionID = string;\n',
  );

  await Bun.write(
    join(ctx.directory, 'packages/contract/declarations.snap'),
    '// index.d.ts\nexport type SessionID = string;\n',
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-contract.ts'),
    ctx.directory,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 0,
    stdout: 'check-contract: 1 declaration files match packages/contract/declarations.snap\n',
    stderr: '',
  });
});

test('it fails on declarations that differ from the snapshot, naming the first line that differs', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.directory, 'packages/contract/tsconfig.build.json'),
    JSON.stringify({
      compilerOptions: {
        declaration: true,
        emitDeclarationOnly: true,
        module: 'preserve',
        rootDir: 'src',
        types: [],
      },
      include: ['src/**/*.ts'],
    }),
  );

  await Bun.write(
    join(ctx.directory, 'packages/contract/src/index.ts'),
    'export type SessionID = number;\n',
  );

  await Bun.write(
    join(ctx.directory, 'packages/contract/declarations.snap'),
    '// index.d.ts\nexport type SessionID = string;\n',
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-contract.ts'),
    ctx.directory,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr:
      'stale snapshot: packages/contract/declarations.snap differs from the emitted declarations at line 2; run bun run check:contract --update and review the diff\n',
  });
});

test('it removes the declarations it emitted when the check fails', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.directory, 'packages/contract/tsconfig.build.json'),
    JSON.stringify({
      compilerOptions: {
        declaration: true,
        emitDeclarationOnly: true,
        module: 'preserve',
        rootDir: 'src',
        types: [],
      },
      include: ['src/**/*.ts'],
    }),
  );

  await Bun.write(
    join(ctx.directory, 'packages/contract/src/index.ts'),
    'export type SessionID = number;\n',
  );

  mkdirSync(join(ctx.directory, 'tmp'));

  await runCommand([process.execPath, join(import.meta.dir, 'check-contract.ts'), ctx.directory], {
    env: { ...process.env, TMPDIR: join(ctx.directory, 'tmp') },
  });

  expect(readdirSync(join(ctx.directory, 'tmp'))).toStrictEqual([]);
});
