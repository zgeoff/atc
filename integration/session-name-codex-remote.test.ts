import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from '@atc/config';
import { buildStubGuestFilesProvider } from '@atc/daemon/testing';
import { createCodexAdapter } from '@atc/harness-codex';
import { getAgentEntry, getRecord, setupTempDir, updateEnv, waitFor } from '@atc/test-utils';
import { SHIPPED_HARNESS_PLUGINS } from '../packages/app/src/plugins/shipped-harness-plugins';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

test("it names an unbrokered remote Codex session from the session index in its host user's Codex home", async () => {
  const temporaryDirectory = setupTempDir('atc-codex-remote-name-');
  const guestFiles = join(temporaryDirectory.path, 'guest');

  const config = parseConfig(SHIPPED_HARNESS_PLUGINS, {
    agents: { codex: { bin: '/usr/local/bin/codex' } },
  });

  updateEnv('CODEX_HOME', join(temporaryDirectory.path, 'daemon-codex-home'));

  const daemon = await startTestDaemon({
    prefix: 'atc-codex-remote-name-daemon-',
    options: () => ({
      adapters: [createCodexAdapter(getAgentEntry(config, 'codex'), config)],
      targets: [
        {
          id: 'box',
          kind: 'remote',
          options: {},
          identity: 'remote:test',
          provider: buildStubGuestFilesProvider({
            guestDirectory: '/tmp/atc',
            hostDirectory: guestFiles,
          }),
        },
      ],
      defaultTarget: 'box',
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: '/root/work',
    agent: 'codex',
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];
  const codexHome = join(guestFiles, 'home', '.codex');

  mkdirSync(codexHome, { recursive: true });

  writeFileSync(
    join(codexHome, 'session_index.jsonl'),
    '{"id":"c-1","thread_name":"sort the inbox","updated_at":"2026-10-29T00:00:00Z"}\n',
  );

  await daemon.sendHookLines({ atcId: id, event: 'Stop', payload: { session_id: 'c-1' } });

  await waitFor(async () => {
    const got = await daemon.client.sendRequest('session.get', { session: id });

    expect(getRecord(got, 'session')['name']).toBe('sort the inbox');
  });
});
