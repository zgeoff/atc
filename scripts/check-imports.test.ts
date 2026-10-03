import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'check-imports-'));

  return {
    dir,
    run() {
      const result = Bun.spawnSync(
        [process.execPath, join(import.meta.dir, 'check-imports.ts'), dir],
        {
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );

      return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      };
    },
    async [Symbol.asyncDispose]() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('it passes a tree whose imports follow the directory rules', async () => {
  await using tree = await setupTest();

  await Bun.write(join(tree.dir, 'src/shared/session-id.ts'), 'export type SessionID = string;\n');

  await Bun.write(
    join(tree.dir, 'src/protocol/hook-event.ts'),
    "import type { SessionID } from '../shared/session-id';\n\nexport interface HookEvent {\n  atcId: SessionID;\n}\n",
  );

  await Bun.write(
    join(tree.dir, 'src/daemon/hooks.ts'),
    "import type { HookEvent } from '../protocol/hook-event';\n\nexport const HOOKS: HookEvent[] = [];\n",
  );

  expect(tree.run()).toStrictEqual({
    exitCode: 0,
    stdout: 'check-imports: 3 files, 0 cycles, 0 other findings\n',
    stderr: '',
  });
});

test('it fails on a cycle closed by a type-only import', async () => {
  await using tree = await setupTest();

  await Bun.write(
    join(tree.dir, 'src/mcp/types.ts'),
    "import type { openAuth } from './open-auth';\n\nexport type Auth = ReturnType<typeof openAuth>;\n",
  );

  await Bun.write(
    join(tree.dir, 'src/mcp/open-auth.ts'),
    "import type { Auth } from './types';\n\nexport function openAuth(): Auth | null {\n  return null;\n}\n",
  );

  expect(tree.run()).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 2 files, 1 cycles, 0 other findings\n',
    stderr: 'cycle among: src/mcp/open-auth.ts, src/mcp/types.ts\n',
  });
});

test('it fails on an import of a directory the importer may not use', async () => {
  await using tree = await setupTest();

  await Bun.write(join(tree.dir, 'src/daemon/hooks.ts'), 'export interface HookEvent {}\n');

  await Bun.write(
    join(tree.dir, 'src/store/state-store.ts'),
    "import type {\n  HookEvent,\n} from '../daemon/hooks';\n\nexport type Row = HookEvent;\n",
  );

  expect(tree.run()).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 2 files, 0 cycles, 1 other findings\n',
    stderr:
      'forbidden edge: src/store/state-store.ts imports src/daemon/hooks.ts (store -> daemon)\n',
  });
});

test('it fails on a directory module importing a src root module', async () => {
  await using tree = await setupTest();

  await Bun.write(join(tree.dir, 'src/hook-report.ts'), 'export const REPORT = 1;\n');

  await Bun.write(
    join(tree.dir, 'src/shared/config.ts'),
    "export { REPORT } from '../hook-report';\n",
  );

  expect(tree.run()).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 2 files, 0 cycles, 1 other findings\n',
    stderr:
      'forbidden edge: src/shared/config.ts imports src/hook-report.ts (shared -> the src root)\n',
  });
});

test('it lets a src root module and a test file import any directory', async () => {
  await using tree = await setupTest();

  await Bun.write(join(tree.dir, 'src/daemon/daemon.ts'), 'export const DAEMON = 1;\n');
  await Bun.write(join(tree.dir, 'src/client/daemon-client.ts'), 'export const CLIENT = 1;\n');

  await Bun.write(
    join(tree.dir, 'src/cli.ts'),
    "const daemon = await import('./daemon/daemon');\n\nexport const LOADED = daemon;\n",
  );

  await Bun.write(
    join(tree.dir, 'src/daemon/daemon.test.ts'),
    "import { CLIENT } from '../client/daemon-client';\n\nexport const USED = CLIENT;\n",
  );

  expect(tree.run()).toStrictEqual({
    exitCode: 0,
    stdout: 'check-imports: 4 files, 0 cycles, 0 other findings\n',
    stderr: '',
  });
});

test('it fails on a confined package imported outside the file that owns it', async () => {
  await using tree = await setupTest();

  await Bun.write(
    join(tree.dir, 'src/daemon/local-pty-provider.ts'),
    "import { spawn } from 'bun-pty';\n\nexport const SPAWN = spawn;\n",
  );

  await Bun.write(
    join(tree.dir, 'src/daemon/imp-provider.ts'),
    "import type { IPty } from 'bun-pty';\n\nexport type Handle = IPty;\n",
  );

  expect(tree.run()).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 2 files, 0 cycles, 1 other findings\n',
    stderr:
      'confined package: src/daemon/imp-provider.ts imports bun-pty, allowed only in src/daemon/local-pty-provider.ts\n',
  });
});

test('it fails on a module in a directory with no import rule', async () => {
  await using tree = await setupTest();

  await Bun.write(join(tree.dir, 'src/federation/registry.ts'), 'export const REGISTRY = 1;\n');

  expect(tree.run()).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 1 files, 0 cycles, 1 other findings\n',
    stderr:
      'unknown directory: src/federation/registry.ts is in src/federation/, which has no import rule\n',
  });
});

test('it ignores import text inside a one-line string literal', async () => {
  await using tree = await setupTest();

  await Bun.write(join(tree.dir, 'src/daemon/daemon.ts'), 'export const DAEMON = 1;\n');

  await Bun.write(
    join(tree.dir, 'src/agents/bridge-files.ts'),
    "export const FILES = {\n  'register.ts': \"import { DAEMON } from '../daemon/daemon';\\n\",\n};\n",
  );

  expect(tree.run()).toStrictEqual({
    exitCode: 0,
    stdout: 'check-imports: 2 files, 0 cycles, 0 other findings\n',
    stderr: '',
  });
});
