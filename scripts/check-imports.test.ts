import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir } from '../src/test-utils/setup-temp-dir';

// A temp directory standing in for a repo root for the checker to scan.
function setupTest() {
  const tmp = setupTempDir('check-imports-');

  return { dir: tmp.dir };
}

test('it passes a tree whose imports follow the directory rules', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'src/shared/session-id.ts'), 'export type SessionID = string;\n');

  await Bun.write(
    join(ctx.dir, 'src/protocol/hook-event.ts'),
    "import type { SessionID } from '../shared/session-id';\n\nexport interface HookEvent {\n  atcId: SessionID;\n}\n",
  );

  await Bun.write(
    join(ctx.dir, 'src/daemon/hooks.ts'),
    "import type { HookEvent } from '../protocol/hook-event';\n\nexport const HOOKS: HookEvent[] = [];\n",
  );

  const checked = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, 'check-imports.ts'), ctx.dir],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout.toString(),
    stderr: checked.stderr.toString(),
  }).toStrictEqual({
    exitCode: 0,
    stdout: 'check-imports: 3 files, 0 cycles, 0 other findings\n',
    stderr: '',
  });
});

test('it fails on a cycle closed by a type-only import', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'src/mcp/types.ts'),
    "import type { openAuth } from './open-auth';\n\nexport type Auth = ReturnType<typeof openAuth>;\n",
  );

  await Bun.write(
    join(ctx.dir, 'src/mcp/open-auth.ts'),
    "import type { Auth } from './types';\n\nexport function openAuth(): Auth | null {\n  return null;\n}\n",
  );

  const checked = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, 'check-imports.ts'), ctx.dir],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout.toString(),
    stderr: checked.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 2 files, 1 cycles, 0 other findings\n',
    stderr: 'cycle among: src/mcp/open-auth.ts, src/mcp/types.ts\n',
  });
});

test('it fails on an import of a directory the importer may not use', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'src/daemon/hooks.ts'), 'export interface HookEvent {}\n');

  await Bun.write(
    join(ctx.dir, 'src/store/state-store.ts'),
    "import type {\n  HookEvent,\n} from '../daemon/hooks';\n\nexport type Row = HookEvent;\n",
  );

  const checked = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, 'check-imports.ts'), ctx.dir],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout.toString(),
    stderr: checked.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 2 files, 0 cycles, 1 other findings\n',
    stderr:
      'forbidden edge: src/store/state-store.ts imports src/daemon/hooks.ts (store -> daemon)\n',
  });
});

test('it lets a sources module import workspace and the daemon import sources', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'src/workspace/probe.ts'), 'export const PROBE = 1;\n');

  await Bun.write(
    join(ctx.dir, 'src/sources/types.ts'),
    "export { PROBE } from '../workspace/probe';\n",
  );

  await Bun.write(
    join(ctx.dir, 'src/daemon/connection.ts'),
    "export { PROBE } from '../sources/types';\n",
  );

  const checked = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, 'check-imports.ts'), ctx.dir],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout.toString(),
    stderr: checked.stderr.toString(),
  }).toStrictEqual({
    exitCode: 0,
    stdout: 'check-imports: 3 files, 0 cycles, 0 other findings\n',
    stderr: '',
  });
});

test('it fails on a sources module importing the daemon', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'src/daemon/ids.ts'), 'export const ID = 1;\n');
  await Bun.write(join(ctx.dir, 'src/sources/types.ts'), "export { ID } from '../daemon/ids';\n");

  const checked = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, 'check-imports.ts'), ctx.dir],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout.toString(),
    stderr: checked.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 2 files, 0 cycles, 1 other findings\n',
    stderr: 'forbidden edge: src/sources/types.ts imports src/daemon/ids.ts (sources -> daemon)\n',
  });
});

test('it fails on a directory module importing a src root module', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'src/hook-report.ts'), 'export const REPORT = 1;\n');

  await Bun.write(
    join(ctx.dir, 'src/shared/config.ts'),
    "export { REPORT } from '../hook-report';\n",
  );

  const checked = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, 'check-imports.ts'), ctx.dir],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout.toString(),
    stderr: checked.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 2 files, 0 cycles, 1 other findings\n',
    stderr: 'forbidden edge: src/shared/config.ts imports src/hook-report.ts (shared -> root)\n',
  });
});

test('it lets the composition root and a test file import any directory', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'src/daemon/daemon.ts'), 'export const DAEMON = 1;\n');
  await Bun.write(join(ctx.dir, 'src/client/daemon-client.ts'), 'export const CLIENT = 1;\n');

  await Bun.write(
    join(ctx.dir, 'src/cli.ts'),
    "const daemon = await import('./daemon/daemon');\n\nexport const LOADED = daemon;\n",
  );

  await Bun.write(
    join(ctx.dir, 'src/daemon/daemon.test.ts'),
    "import { CLIENT } from '../client/daemon-client';\n\nexport const USED = CLIENT;\n",
  );

  const checked = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, 'check-imports.ts'), ctx.dir],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout.toString(),
    stderr: checked.stderr.toString(),
  }).toStrictEqual({
    exitCode: 0,
    stdout: 'check-imports: 4 files, 0 cycles, 0 other findings\n',
    stderr: '',
  });
});

test('it fails on a gateway entry that reaches an agent adapter through an allowed edge', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'src/agents/claude-adapter.ts'), 'export const CLAUDE = 1;\n');

  await Bun.write(
    join(ctx.dir, 'src/run-gateway.ts'),
    "import { CLAUDE } from './agents/claude-adapter';\n\nexport const GATEWAY = CLAUDE;\n",
  );

  await Bun.write(
    join(ctx.dir, 'src/gateway.ts'),
    "const gateway = await import('./run-gateway');\n\nexport const LOADED = gateway;\n",
  );

  const checked = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, 'check-imports.ts'), ctx.dir],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout.toString(),
    stderr: checked.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 3 files, 0 cycles, 1 other findings\n',
    stderr: 'unreachable module: src/gateway.ts reaches src/agents/claude-adapter.ts\n',
  });
});

test('it fails on a confined package imported outside the file that owns it', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'src/daemon/local-pty-provider.ts'),
    "import { spawn } from 'bun-pty';\n\nexport const SPAWN = spawn;\n",
  );

  await Bun.write(
    join(ctx.dir, 'src/daemon/imp-provider.ts'),
    "import type { IPty } from 'bun-pty';\n\nexport type Handle = IPty;\n",
  );

  const checked = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, 'check-imports.ts'), ctx.dir],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout.toString(),
    stderr: checked.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 2 files, 0 cycles, 1 other findings\n',
    stderr:
      'confined package: src/daemon/imp-provider.ts imports bun-pty, allowed only in src/daemon/local-pty-provider.ts, src/test-utils/create-stub-imp-port.ts, src/test-utils/start-tui-harness.ts, src/test-utils/create-stub-composer.test.ts, scripts/probe-pty-env.ts\n',
  });
});

test('it fails on a confined package imported outside src', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'src/daemon/imp-client-port.ts'),
    "import { ImpClient } from '@zgeoff/imp-client';\n\nexport const CLIENT = ImpClient;\n",
  );

  await Bun.write(
    join(ctx.dir, 'e2e/imp.test.ts'),
    "import { ImpClient } from '@zgeoff/imp-client';\n\nexport const CLIENT = ImpClient;\n",
  );

  await Bun.write(
    join(ctx.dir, 'scripts/probe.mjs'),
    "const client = await import('@zgeoff/imp-client');\n\nexport default client;\n",
  );

  await Bun.write(
    join(ctx.dir, 'mods/bridge/hooks/register.tsx'),
    "export { ImpClient } from '@zgeoff/imp-client';\n",
  );

  await Bun.write(
    join(ctx.dir, 'mods/bridge/node_modules/dep/index.js'),
    "export { ImpClient } from '@zgeoff/imp-client';\n",
  );

  const checked = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, 'check-imports.ts'), ctx.dir],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout.toString(),
    stderr: checked.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 4 files, 0 cycles, 3 other findings\n',
    stderr: [
      'confined package: e2e/imp.test.ts imports @zgeoff/imp-client, allowed only in src/daemon/imp-client-port.ts',
      'confined package: scripts/probe.mjs imports @zgeoff/imp-client, allowed only in src/daemon/imp-client-port.ts',
      'confined package: mods/bridge/hooks/register.tsx imports @zgeoff/imp-client, allowed only in src/daemon/imp-client-port.ts',
      '',
    ].join('\n'),
  });
});

test('it fails on a module in a directory with no import rule', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'src/elsewhere/registry.ts'), 'export const REGISTRY = 1;\n');

  const checked = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, 'check-imports.ts'), ctx.dir],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout.toString(),
    stderr: checked.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 1 files, 0 cycles, 1 other findings\n',
    stderr:
      'unknown directory: src/elsewhere/registry.ts is in src/elsewhere/, which has no import rule\n',
  });
});

test('it ignores import text inside a one-line string literal', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'src/daemon/daemon.ts'), 'export const DAEMON = 1;\n');

  await Bun.write(
    join(ctx.dir, 'src/agents/bridge-files.ts'),
    "export const FILES = {\n  'register.ts': \"import { DAEMON } from '../daemon/daemon';\\n\",\n};\n",
  );

  const checked = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, 'check-imports.ts'), ctx.dir],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout.toString(),
    stderr: checked.stderr.toString(),
  }).toStrictEqual({
    exitCode: 0,
    stdout: 'check-imports: 2 files, 0 cycles, 0 other findings\n',
    stderr: '',
  });
});

test('it fails on a src root module that is not the composition root importing the daemon', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'src/daemon/daemon.ts'), 'export const DAEMON = 1;\n');

  await Bun.write(
    join(ctx.dir, 'src/statusline.ts'),
    "import { DAEMON } from './daemon/daemon';\n\nexport const USED = DAEMON;\n",
  );

  const checked = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, 'check-imports.ts'), ctx.dir],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout.toString(),
    stderr: checked.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 2 files, 0 cycles, 1 other findings\n',
    stderr: 'forbidden edge: src/statusline.ts imports src/daemon/daemon.ts (root -> daemon)\n',
  });
});

test('it reads an import whose list holds a comment with an apostrophe', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'src/daemon/ids.ts'), 'export const ID = 1;\n');

  await Bun.write(
    join(ctx.dir, 'src/store/rows.ts'),
    "import {\n  ID, // the daemon's id, `quoted`\n} from '../daemon/ids';\n\nexport const USED = ID;\n",
  );

  const checked = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, 'check-imports.ts'), ctx.dir],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout.toString(),
    stderr: checked.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 2 files, 0 cycles, 1 other findings\n',
    stderr: 'forbidden edge: src/store/rows.ts imports src/daemon/ids.ts (store -> daemon)\n',
  });
});

test('it reads a require call', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'src/daemon/ids.ts'), 'export const ID = 1;\n');

  await Bun.write(
    join(ctx.dir, 'src/store/rows.ts'),
    "const ids = require('../daemon/ids');\n\nexport const USED = ids;\n",
  );

  const checked = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, 'check-imports.ts'), ctx.dir],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout.toString(),
    stderr: checked.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 2 files, 0 cycles, 1 other findings\n',
    stderr: 'forbidden edge: src/store/rows.ts imports src/daemon/ids.ts (store -> daemon)\n',
  });
});

test('it reads an import-equals require', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'src/daemon/ids.ts'), 'export const ID = 1;\n');

  await Bun.write(
    join(ctx.dir, 'src/store/rows.ts'),
    "import ids = require('../daemon/ids');\n\nexport const USED = ids;\n",
  );

  const checked = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, 'check-imports.ts'), ctx.dir],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout.toString(),
    stderr: checked.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 2 files, 0 cycles, 1 other findings\n',
    stderr: 'forbidden edge: src/store/rows.ts imports src/daemon/ids.ts (store -> daemon)\n',
  });
});

test('it reads a dynamic import whose specifier is a template literal', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'src/daemon/ids.ts'), 'export const ID = 1;\n');

  await Bun.write(
    join(ctx.dir, 'src/store/rows.ts'),
    'export const LOADED = await import(`../daemon/ids`);\n',
  );

  const checked = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, 'check-imports.ts'), ctx.dir],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout.toString(),
    stderr: checked.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 2 files, 0 cycles, 1 other findings\n',
    stderr: 'forbidden edge: src/store/rows.ts imports src/daemon/ids.ts (store -> daemon)\n',
  });
});

test('it fails on a dynamic import whose specifier is computed', async () => {
  const ctx = setupTest();

  // oxlint-disable-next-line no-template-curly-in-string -- the fixture is source text whose template literal holds a substitution
  const source = "const n = 'x';\nexport const L = import(`../daemon/${n}`);\n";

  await Bun.write(join(ctx.dir, 'src/store/rows.ts'), source);

  const checked = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, 'check-imports.ts'), ctx.dir],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout.toString(),
    stderr: checked.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 1 files, 0 cycles, 1 other findings\n',
    stderr: 'non-literal import: src/store/rows.ts:2 imports a computed specifier\n',
  });
});

test('it fails on a require call whose specifier is computed', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'src/store/rows.ts'),
    "const path = '../daemon/ids';\nexport const LOADED = require(path);\n",
  );

  const checked = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, 'check-imports.ts'), ctx.dir],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout.toString(),
    stderr: checked.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 1 files, 0 cycles, 1 other findings\n',
    stderr: 'non-literal import: src/store/rows.ts:2 imports a computed specifier\n',
  });
});

test('it reads an import that follows a regular expression holding a quote', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'src/daemon/ids.ts'), 'export const ID = 1;\n');

  await Bun.write(
    join(ctx.dir, 'src/store/rows.ts'),
    "export const QUOTE = /['\"`]/;\n\nexport { ID } from '../daemon/ids';\n",
  );

  const checked = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, 'check-imports.ts'), ctx.dir],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout.toString(),
    stderr: checked.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 2 files, 0 cycles, 1 other findings\n',
    stderr: 'forbidden edge: src/store/rows.ts imports src/daemon/ids.ts (store -> daemon)\n',
  });
});

test('it reads an import that follows a regular expression after a control condition', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'src/daemon/ids.ts'), 'export const ID = 1;\n');

  await Bun.write(
    join(ctx.dir, 'src/store/rows.ts'),
    "const ok = true;\nif (ok) /`/.test('a');\n\nexport { ID } from '../daemon/ids';\n",
  );

  const checked = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, 'check-imports.ts'), ctx.dir],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout.toString(),
    stderr: checked.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 2 files, 0 cycles, 1 other findings\n',
    stderr: 'forbidden edge: src/store/rows.ts imports src/daemon/ids.ts (store -> daemon)\n',
  });
});

test('it reads an import that follows a regular expression after a block', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'src/daemon/ids.ts'), 'export const ID = 1;\n');

  await Bun.write(
    join(ctx.dir, 'src/store/rows.ts'),
    "{\n  const a = 1;\n}\n/`/.test('a');\n\nexport { ID } from '../daemon/ids';\n",
  );

  const checked = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, 'check-imports.ts'), ctx.dir],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout.toString(),
    stderr: checked.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 2 files, 0 cycles, 1 other findings\n',
    stderr: 'forbidden edge: src/store/rows.ts imports src/daemon/ids.ts (store -> daemon)\n',
  });
});

test('it reads a literal module resolved through import.meta.resolve', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'src/daemon/ids.ts'), 'export const ID = 1;\n');

  await Bun.write(
    join(ctx.dir, 'src/store/rows.ts'),
    "export const PATH = import.meta.resolve('../daemon/ids');\n",
  );

  const checked = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, 'check-imports.ts'), ctx.dir],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout.toString(),
    stderr: checked.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 2 files, 0 cycles, 1 other findings\n',
    stderr: 'forbidden edge: src/store/rows.ts imports src/daemon/ids.ts (store -> daemon)\n',
  });
});

test('it reads a literal module resolved through Bun.resolveSync', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'src/daemon/ids.ts'), 'export const ID = 1;\n');

  await Bun.write(
    join(ctx.dir, 'src/store/rows.ts'),
    "export const PATH = Bun.resolveSync('../daemon/ids', import.meta.dir);\n",
  );

  const checked = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, 'check-imports.ts'), ctx.dir],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout.toString(),
    stderr: checked.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 2 files, 0 cycles, 1 other findings\n',
    stderr: 'forbidden edge: src/store/rows.ts imports src/daemon/ids.ts (store -> daemon)\n',
  });
});

test('it reads a literal module located with a URL relative to import.meta.url', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'src/daemon/ids.ts'), 'export const ID = 1;\n');

  await Bun.write(
    join(ctx.dir, 'src/store/rows.ts'),
    "export const PATH = new URL('../daemon/ids.ts', import.meta.url);\n",
  );

  const checked = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, 'check-imports.ts'), ctx.dir],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout.toString(),
    stderr: checked.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 2 files, 0 cycles, 1 other findings\n',
    stderr: 'forbidden edge: src/store/rows.ts imports src/daemon/ids.ts (store -> daemon)\n',
  });
});

test('it fails on a module resolved from a computed specifier', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'src/store/rows.ts'),
    "const name = '../daemon/ids';\nexport const A = import.meta.resolve(name);\nexport const B = Bun.resolveSync(name, import.meta.dir);\nexport const C = new URL(name, import.meta.url);\n",
  );

  const checked = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, 'check-imports.ts'), ctx.dir],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout.toString(),
    stderr: checked.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 1 files, 0 cycles, 3 other findings\n',
    stderr:
      'non-literal import: src/store/rows.ts:2 imports a computed specifier\nnon-literal import: src/store/rows.ts:3 imports a computed specifier\nnon-literal import: src/store/rows.ts:4 imports a computed specifier\n',
  });
});

test('it ignores a URL that is not relative to the module', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'src/store/rows.ts'),
    "const base = 'https://example.com';\nexport const SITE = new URL(base);\n",
  );

  const checked = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, 'check-imports.ts'), ctx.dir],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout.toString(),
    stderr: checked.stderr.toString(),
  }).toStrictEqual({
    exitCode: 0,
    stdout: 'check-imports: 1 files, 0 cycles, 0 other findings\n',
    stderr: '',
  });
});

test('it fails on a federation module that imports the mcp layer', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'src/mcp/types.ts'), 'export const TOOLS = 1;\n');

  await Bun.write(
    join(ctx.dir, 'src/federation/router.ts'),
    "import { TOOLS } from '../mcp/types';\nexport const ROUTER = TOOLS;\n",
  );

  const checked = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, 'check-imports.ts'), ctx.dir],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout.toString(),
    stderr: checked.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 2 files, 0 cycles, 1 other findings\n',
    stderr:
      'forbidden edge: src/federation/router.ts imports src/mcp/types.ts (federation -> mcp)\n',
  });
});
