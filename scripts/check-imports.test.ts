import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { runCommand, setupTempDir } from '@atc/test-utils';

// A temp directory standing in for a repo root.
function setupTest() {
  const tmp = setupTempDir('check-imports-');

  return { dir: tmp.path };
}

test('it passes a tree whose imports follow the directory rules', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'packages/app/src/shared/session-id.ts'),
    'export type SessionID = string;\n',
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/plugins/hook-event.ts'),
    "import type { SessionID } from '../shared/session-id';\n\nexport interface HookEvent {\n  atcId: SessionID;\n}\n",
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/agents/hooks.ts'),
    "import type { HookEvent } from '../plugins/hook-event';\n\nexport const HOOKS: HookEvent[] = [];\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-imports.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 0,
    stdout: 'check-imports: 3 files, 0 cycles, 0 other findings\n',
    stderr: '',
  });
});

test('it fails on a cycle closed by a type-only import', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'packages/app/src/mcp/types.ts'),
    "import type { openAuth } from './open-auth';\n\nexport type Auth = ReturnType<typeof openAuth>;\n",
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/mcp/open-auth.ts'),
    "import type { Auth } from './types';\n\nexport function openAuth(): Auth | null {\n  return null;\n}\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-imports.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 2 files, 1 cycles, 0 other findings\n',
    stderr: 'cycle among: packages/app/src/mcp/open-auth.ts, packages/app/src/mcp/types.ts\n',
  });
});

test('it fails on an import of a directory the importer may not use', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'packages/app/src/client/hooks.ts'),
    'export interface HookEvent {}\n',
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/mcp/state-store.ts'),
    "import type {\n  HookEvent,\n} from '../client/hooks';\n\nexport type Row = HookEvent;\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-imports.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 2 files, 0 cycles, 1 other findings\n',
    stderr:
      'forbidden edge: packages/app/src/mcp/state-store.ts imports packages/app/src/client/hooks.ts (mcp -> client)\n',
  });
});

test('it lets an agents module import plugins and a source root module import agents', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'packages/app/src/plugins/probe.ts'), 'export const PROBE = 1;\n');

  await Bun.write(
    join(ctx.dir, 'packages/app/src/agents/types.ts'),
    "export { PROBE } from '../plugins/probe';\n",
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/hook-report.ts'),
    "export { PROBE } from './agents/types';\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-imports.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 0,
    stdout: 'check-imports: 3 files, 0 cycles, 0 other findings\n',
    stderr: '',
  });
});

test('it fails on a sources module importing the client', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'packages/app/src/client/ids.ts'), 'export const ID = 1;\n');

  await Bun.write(
    join(ctx.dir, 'packages/app/src/sources/types.ts'),
    "export { ID } from '../client/ids';\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-imports.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 2 files, 0 cycles, 1 other findings\n',
    stderr:
      'forbidden edge: packages/app/src/sources/types.ts imports packages/app/src/client/ids.ts (sources -> client)\n',
  });
});

test('it fails on a directory module importing a source root module', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'packages/app/src/hook-report.ts'), 'export const REPORT = 1;\n');

  await Bun.write(
    join(ctx.dir, 'packages/app/src/shared/config.ts'),
    "export { REPORT } from '../hook-report';\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-imports.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 2 files, 0 cycles, 1 other findings\n',
    stderr:
      'forbidden edge: packages/app/src/shared/config.ts imports packages/app/src/hook-report.ts (shared -> root)\n',
  });
});

test('it lets the composition root and a test file import any directory', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'packages/app/src/sources/discover.ts'),
    'export const SOURCES = 1;\n',
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/client/daemon-client.ts'),
    'export const CLIENT = 1;\n',
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/cli.ts'),
    "const sources = await import('./sources/discover');\n\nexport const LOADED = sources;\n",
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/sources/discover.test.ts'),
    "import { CLIENT } from '../client/daemon-client';\n\nexport const USED = CLIENT;\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-imports.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 0,
    stdout: 'check-imports: 4 files, 0 cycles, 0 other findings\n',
    stderr: '',
  });
});

test('it leaves a confined package and a computed specifier to the other gates', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'packages/app/src/agents/imp-provider.ts'),
    "import type { IPty } from 'bun-pty';\n\nconst name = './ids';\n\nexport const IDS = await import(name);\nexport type Handle = IPty;\n",
  );

  await Bun.write(
    join(ctx.dir, 'e2e/imp.test.ts'),
    "import { ImpClient } from '@impz/client';\n\nexport const CLIENT = ImpClient;\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-imports.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 0,
    stdout: 'check-imports: 1 files, 0 cycles, 0 other findings\n',
    stderr: '',
  });
});

test('it fails on a module in a directory with no import rule', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'packages/app/src/elsewhere/registry.ts'),
    'export const REGISTRY = 1;\n',
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-imports.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 1 files, 0 cycles, 1 other findings\n',
    stderr:
      'unknown directory: packages/app/src/elsewhere/registry.ts is in packages/app/src/elsewhere/, which has no import rule\n',
  });
});

test('it ignores import text inside a one-line string literal', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'packages/app/src/sources/discover.ts'),
    'export const SOURCES = 1;\n',
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/agents/bridge-files.ts'),
    "export const FILES = {\n  'register.ts': \"import { SOURCES } from '../sources/discover';\\n\",\n};\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-imports.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 0,
    stdout: 'check-imports: 2 files, 0 cycles, 0 other findings\n',
    stderr: '',
  });
});

test('it fails on a source root module that is not the composition root importing a sources module', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'packages/app/src/sources/discover.ts'),
    'export const SOURCES = 1;\n',
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/statusline.ts'),
    "import { SOURCES } from './sources/discover';\n\nexport const USED = SOURCES;\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-imports.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 2 files, 0 cycles, 1 other findings\n',
    stderr:
      'forbidden edge: packages/app/src/statusline.ts imports packages/app/src/sources/discover.ts (root -> sources)\n',
  });
});

test('it reads an import whose list holds a comment with an apostrophe', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'packages/app/src/client/ids.ts'), 'export const ID = 1;\n');

  await Bun.write(
    join(ctx.dir, 'packages/app/src/mcp/rows.ts'),
    "import {\n  ID, // the client's id, `quoted`\n} from '../client/ids';\n\nexport const USED = ID;\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-imports.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 2 files, 0 cycles, 1 other findings\n',
    stderr:
      'forbidden edge: packages/app/src/mcp/rows.ts imports packages/app/src/client/ids.ts (mcp -> client)\n',
  });
});

test('it reads a require call', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'packages/app/src/client/ids.ts'), 'export const ID = 1;\n');

  await Bun.write(
    join(ctx.dir, 'packages/app/src/mcp/rows.ts'),
    "const ids = require('../client/ids');\n\nexport const USED = ids;\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-imports.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 2 files, 0 cycles, 1 other findings\n',
    stderr:
      'forbidden edge: packages/app/src/mcp/rows.ts imports packages/app/src/client/ids.ts (mcp -> client)\n',
  });
});

test('it reads an import-equals require', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'packages/app/src/client/ids.ts'), 'export const ID = 1;\n');

  await Bun.write(
    join(ctx.dir, 'packages/app/src/mcp/rows.ts'),
    "import ids = require('../client/ids');\n\nexport const USED = ids;\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-imports.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 2 files, 0 cycles, 1 other findings\n',
    stderr:
      'forbidden edge: packages/app/src/mcp/rows.ts imports packages/app/src/client/ids.ts (mcp -> client)\n',
  });
});

test('it reads a dynamic import whose specifier is a template literal', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'packages/app/src/client/ids.ts'), 'export const ID = 1;\n');

  await Bun.write(
    join(ctx.dir, 'packages/app/src/mcp/rows.ts'),
    'export const LOADED = await import(`../client/ids`);\n',
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-imports.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 2 files, 0 cycles, 1 other findings\n',
    stderr:
      'forbidden edge: packages/app/src/mcp/rows.ts imports packages/app/src/client/ids.ts (mcp -> client)\n',
  });
});

test('it reads an import that follows a regular expression holding a quote', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'packages/app/src/client/ids.ts'), 'export const ID = 1;\n');

  await Bun.write(
    join(ctx.dir, 'packages/app/src/mcp/rows.ts'),
    "export const QUOTE = /['\"`]/;\n\nexport { ID } from '../client/ids';\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-imports.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 2 files, 0 cycles, 1 other findings\n',
    stderr:
      'forbidden edge: packages/app/src/mcp/rows.ts imports packages/app/src/client/ids.ts (mcp -> client)\n',
  });
});

test('it reads an import that follows a regular expression after a control condition', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'packages/app/src/client/ids.ts'), 'export const ID = 1;\n');

  await Bun.write(
    join(ctx.dir, 'packages/app/src/mcp/rows.ts'),
    "const ok = true;\nif (ok) /`/.test('a');\n\nexport { ID } from '../client/ids';\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-imports.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 2 files, 0 cycles, 1 other findings\n',
    stderr:
      'forbidden edge: packages/app/src/mcp/rows.ts imports packages/app/src/client/ids.ts (mcp -> client)\n',
  });
});

test('it reads an import that follows a regular expression after a block', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'packages/app/src/client/ids.ts'), 'export const ID = 1;\n');

  await Bun.write(
    join(ctx.dir, 'packages/app/src/mcp/rows.ts'),
    "{\n  const a = 1;\n}\n/`/.test('a');\n\nexport { ID } from '../client/ids';\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-imports.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 2 files, 0 cycles, 1 other findings\n',
    stderr:
      'forbidden edge: packages/app/src/mcp/rows.ts imports packages/app/src/client/ids.ts (mcp -> client)\n',
  });
});

test('it reads a literal module resolved through import.meta.resolve', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'packages/app/src/client/ids.ts'), 'export const ID = 1;\n');

  await Bun.write(
    join(ctx.dir, 'packages/app/src/mcp/rows.ts'),
    "export const PATH = import.meta.resolve('../client/ids');\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-imports.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 2 files, 0 cycles, 1 other findings\n',
    stderr:
      'forbidden edge: packages/app/src/mcp/rows.ts imports packages/app/src/client/ids.ts (mcp -> client)\n',
  });
});

test('it reads a literal module resolved through Bun.resolveSync', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'packages/app/src/client/ids.ts'), 'export const ID = 1;\n');

  await Bun.write(
    join(ctx.dir, 'packages/app/src/mcp/rows.ts'),
    "export const PATH = Bun.resolveSync('../client/ids', import.meta.dir);\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-imports.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 2 files, 0 cycles, 1 other findings\n',
    stderr:
      'forbidden edge: packages/app/src/mcp/rows.ts imports packages/app/src/client/ids.ts (mcp -> client)\n',
  });
});

test('it reads a literal module located with a URL relative to import.meta.url', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'packages/app/src/client/ids.ts'), 'export const ID = 1;\n');

  await Bun.write(
    join(ctx.dir, 'packages/app/src/mcp/rows.ts'),
    "export const PATH = new URL('../client/ids.ts', import.meta.url);\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-imports.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 2 files, 0 cycles, 1 other findings\n',
    stderr:
      'forbidden edge: packages/app/src/mcp/rows.ts imports packages/app/src/client/ids.ts (mcp -> client)\n',
  });
});

test('it ignores a URL that is not relative to the module', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'packages/app/src/mcp/rows.ts'),
    "const base = 'https://example.com';\nexport const SITE = new URL(base);\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-imports.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 0,
    stdout: 'check-imports: 1 files, 0 cycles, 0 other findings\n',
    stderr: '',
  });
});

test('it fails on a federation module that imports the mcp layer', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'packages/app/src/mcp/types.ts'), 'export const TOOLS = 1;\n');

  await Bun.write(
    join(ctx.dir, 'packages/app/src/federation/router.ts'),
    "import { TOOLS } from '../mcp/types';\nexport const ROUTER = TOOLS;\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-imports.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-imports: 2 files, 0 cycles, 1 other findings\n',
    stderr:
      'forbidden edge: packages/app/src/federation/router.ts imports packages/app/src/mcp/types.ts (federation -> mcp)\n',
  });
});
