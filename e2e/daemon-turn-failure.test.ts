import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStubComposer } from '@atc/app/test-utils/create-stub-composer';
import { resolveATCCommand } from '@atc/core/test-utils/resolve-atc-command';
import { createStubClaude } from '@atc/harness-claude/test-utils/create-stub-claude';
import { startDaemonProcess } from '@atc/lifecycle/test-utils/start-daemon-process';
import { waitForEvent } from '@atc/protocol/test-utils/wait-for-event';
import type { DaemonEvent } from '@atcx/contract';
import { createTempDir } from '@zgeoff/testing/fs';

function setupTest() {
  const temporaryDirectory = createTempDir('atc-e2e-turn-failure-');
  const atc = resolveATCCommand();
  const composer = createStubComposer(temporaryDirectory.path);
  const configDir = join(temporaryDirectory.path, '.config', 'atc');

  mkdirSync(configDir, { recursive: true });

  return {
    home: temporaryDirectory.path,
    atc,
    configPath: join(configDir, 'config.json'),
    claude: createStubClaude(temporaryDirectory.path, { atc, composer }),
  };
}

test('it flags a turn that ends in an API error as needing the user, with the error text', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.configPath, JSON.stringify({ agents: { claude: { bin: ctx.claude } } }));

  writeFileSync(
    join(ctx.home, 'fake-claude-events.jsonl'),
    [
      { hook_event_name: 'UserPromptSubmit', session_id: 'fake-1', prompt: 'fix the bug' },
      {
        hook_event_name: 'StopFailure',
        session_id: 'fake-1',
        error: 'rate_limit',
        last_assistant_message: "API Error: You've hit your weekly limit",
      },
    ]
      .map((event) => `${JSON.stringify(event)}\n`)
      .join(''),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: DaemonEvent[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');
  await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const failed = await waitForEvent(
    events,
    {
      ev: 'SessionState',
      session: { state: 'needs_you', lastMsg: "API Error: You've hit your weekly limit" },
    },
    { timeoutMs: 12_000 },
  );

  expect(failed).toMatchObject({ session: { state: 'needs_you' } });
}, 15_000);
