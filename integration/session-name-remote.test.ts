import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from '@atc/config';
import { buildStubGuestFilesProvider } from '@atc/daemon/testing';
import { createClaudeAdapter } from '@atc/harness-claude';
import {
  buildMockHostServices,
  getAgentEntry,
  getRecord,
  setupTempDir,
  waitFor,
} from '@atc/test-utils';
import { SHIPPED_HARNESS_PLUGINS } from '../packages/app/src/plugins/shipped-harness-plugins';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

test('it names a remote Claude session after the /rename title in the transcript inside its host', async () => {
  const temporaryDirectory = setupTempDir('atc-remote-name-');
  const guestFiles = join(temporaryDirectory.path, 'guest');

  const config = parseConfig(SHIPPED_HARNESS_PLUGINS, {
    agents: { claude: { bin: '/usr/local/bin/claude' } },
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-remote-name-daemon-',
    options: () => ({
      adapter: createClaudeAdapter(
        getAgentEntry(config, 'claude'),
        config,
        buildMockHostServices(),
      ),
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
    name: 'typed',
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];
  const projects = `sessions/${String(id)}/claude-config/projects/-root-work`;

  mkdirSync(join(guestFiles, projects), { recursive: true });

  writeFileSync(
    join(guestFiles, projects, 'a-1.jsonl'),
    `${JSON.stringify({ type: 'custom-title', customTitle: 'tidy the docs', sessionId: 'a-1' })}\n`,
  );

  await daemon.sendHookLines({
    atcId: id,
    event: 'Stop',
    payload: { session_id: 'a-1', transcript_path: `/tmp/atc/${projects}/a-1.jsonl` },
  });

  await waitFor(async () => {
    const got = await daemon.client.sendRequest('session.get', { session: id });

    expect(getRecord(got, 'session')['name']).toBe('tidy the docs');
  });
});
