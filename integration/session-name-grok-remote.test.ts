import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from '@atc/config';
import { buildStubGuestFilesProvider } from '@atc/daemon/testing';
import { createGrokAdapter } from '@atc/harness-grok';
import { getAgentEntry, getRecord, setupTempDir, waitFor } from '@atc/test-utils';
import { SHIPPED_HARNESS_PLUGINS } from '../packages/app/src/plugins/shipped-harness-plugins';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

test('it names a remote Grok session after the summary in the Grok home of its host user', async () => {
  const temporaryDirectory = setupTempDir('atc-grok-remote-name-');
  const guestFiles = join(temporaryDirectory.path, 'guest');

  const config = parseConfig(SHIPPED_HARNESS_PLUGINS, {
    agents: { grok: { bin: '/usr/local/bin/grok' } },
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-grok-remote-name-daemon-',
    options: () => ({
      adapters: [createGrokAdapter(getAgentEntry(config, 'grok'))],
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
    agent: 'grok',
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];
  const session = join(guestFiles, 'home', '.grok', 'sessions', '%2Froot%2Fwork', 'g-1');

  mkdirSync(session, { recursive: true });

  writeFileSync(
    join(session, 'summary.json'),
    JSON.stringify({ generated_title: 'sort the inbox' }),
  );

  await daemon.sendHookLines({
    atcId: id,
    event: 'Stop',
    payload: { sessionId: 'g-1', cwd: '/root/work', reason: 'end_turn' },
  });

  await waitFor(async () => {
    const got = await daemon.client.sendRequest('session.get', { session: id });

    expect(getRecord(got, 'session')['name']).toBe('sort the inbox');
  });
});
