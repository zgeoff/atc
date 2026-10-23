import { expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { toAgentSessionID, toSessionID } from '@atc/core';
import { buildStubMessageBridgeHost, registerTestCleanup, setupTempDir } from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { startCodexAppServerBridge } from './start-codex-app-server-bridge';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-codex-app-server-');

  // The real CLI refuses a CODEX_HOME that does not exist, and every file it
  // writes must stay inside the test's tree.
  const codexHome = join(temporaryDirectory.path, 'codex-home');

  mkdirSync(codexHome, { recursive: true });

  return {
    directory: temporaryDirectory.path,
    bridgeDir: join(temporaryDirectory.path, 'bridge'),
    codexHome,
  };
}

// These tests run the installed Codex CLI, whose App Server API changes between
// releases: CI's Test Codex Bridge step runs them on the build CODEX_VERSION pins,
// and a machine without one skips them (Bun 1.4.2's skipIf takes only a boolean).
const codexMissing = Bun.which('codex') === null;

// The Codex version the CI job pins beside the Claude Code pin is unset on a
// local run, where no pin names the installed build.
const codexUnpinned = codexMissing || process.env['CODEX_VERSION'] === undefined;

test.skipIf(codexUnpinned)('it matches the installed Codex to the pinned version', async () => {
  const codexOnPath = Bun.which('codex');
  const pinnedCodexVersion = process.env['CODEX_VERSION'];

  invariant(typeof codexOnPath === 'string', 'no codex on PATH');
  invariant(typeof pinnedCodexVersion === 'string', 'no pinned Codex version');

  const printed = await new Response(
    Bun.spawn([codexOnPath, '--version'], { stderr: 'ignore' }).stdout,
  ).text();

  expect(printed.trim()).toBe(`codex-cli ${pinnedCodexVersion}`);
});

test.skipIf(codexMissing)('it starts a thread on the installed Codex App Server', async () => {
  const ctx = setupTest();
  const codexOnPath = Bun.which('codex');

  invariant(typeof codexOnPath === 'string', 'no codex on PATH');

  const bridge = await startCodexAppServerBridge(
    {
      session: toSessionID('s-real'),
      cwd: ctx.directory,
      env: { CODEX_HOME: ctx.codexHome },
      withheldEnv: [],
      options: { prompt: '', resume: false },
      directory: ctx.bridgeDir,
      host: buildStubMessageBridgeHost().host,
    },
    {
      bin: codexOnPath,
      planTerminal: (remote, thread) => ({ bin: codexOnPath, args: [remote, thread] }),
    },
  );

  registerTestCleanup(() => bridge.stop());

  expect(bridge.plan.args[1]).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
  );
});

test.skipIf(codexMissing)(
  'it resumes on the installed Codex App Server the thread an earlier bridge started',
  async () => {
    const ctx = setupTest();
    const codexOnPath = Bun.which('codex');

    invariant(typeof codexOnPath === 'string', 'no codex on PATH');

    const first = await startCodexAppServerBridge(
      {
        session: toSessionID('s-real'),
        cwd: ctx.directory,
        env: { CODEX_HOME: ctx.codexHome },
        withheldEnv: [],
        options: { prompt: '', resume: false },
        directory: ctx.bridgeDir,
        host: buildStubMessageBridgeHost().host,
      },
      {
        bin: codexOnPath,
        planTerminal: (remote, thread) => ({ bin: codexOnPath, args: [remote, thread] }),
      },
    );

    registerTestCleanup(() => first.stop());

    const [, thread] = first.plan.args;

    invariant(typeof thread === 'string');

    await first.stop();

    const second = await startCodexAppServerBridge(
      {
        session: toSessionID('s-real'),
        cwd: ctx.directory,
        env: { CODEX_HOME: ctx.codexHome },
        withheldEnv: [],
        options: { prompt: '', resume: toAgentSessionID(thread) },
        directory: ctx.bridgeDir,
        host: buildStubMessageBridgeHost().host,
      },
      {
        bin: codexOnPath,
        planTerminal: (remote, resuming) => ({ bin: codexOnPath, args: [remote, resuming] }),
      },
    );

    registerTestCleanup(() => second.stop());

    expect(second.plan.args[1]).toBe(thread);
  },
);
