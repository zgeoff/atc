import { expect, mock, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { runLocalCommand } from '@atc/test-utils';
import { toSessionID } from '@atcx/contract';
import { resolveHomeDir } from '@atcx/contract/light';
import { readHostAgentHome } from './read-host-agent-home';

test('it takes the agent home the launch env names without asking the host', async () => {
  const runCommand = mock(runLocalCommand);

  const home = await readHostAgentHome(
    { runCommand },
    toSessionID('host-1'),
    { env: 'CODEX_HOME', folder: '.codex' },
    { CODEX_HOME: '/tmp/atc/sessions/s-1/codex-home' },
  );

  expect(home).toBe('/tmp/atc/sessions/s-1/codex-home');
  expect(runCommand).not.toHaveBeenCalled();
});

test('it reads the agent home the variable on the host names', async () => {
  const home = await readHostAgentHome(
    { runCommand: runLocalCommand },
    toSessionID('host-1'),
    { env: 'ATC_TEST_HOME', folder: '.grok' },
    {},
  );

  expect(home).toBe(String(process.env['ATC_TEST_HOME']));
});

test("it reads the agent home under the host user's home when the host sets no variable", async () => {
  const userHome = realpathSync(resolveHomeDir());

  const home = await readHostAgentHome(
    { runCommand: runLocalCommand },
    toSessionID('host-1'),
    { env: 'ATC_UNSET_AGENT_HOME', folder: '.grok' },
    {},
  );

  expect(home).toBe(join(userHome, '.grok'));
});

test('it runs the read on the session host', async () => {
  const runCommand = mock(runLocalCommand);

  await readHostAgentHome(
    { runCommand },
    toSessionID('host-1'),
    { env: 'ATC_UNSET_AGENT_HOME', folder: '.grok' },
    {},
  );

  expect(runCommand).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ host: 'host-1' }));
});

test('it refuses a host that cannot resolve the agent home', () => {
  expect(
    readHostAgentHome(
      { runCommand: () => Promise.resolve({ exitCode: 1, stdout: '', stderr: 'no home\n' }) },
      toSessionID('host-1'),
      { env: 'GROK_HOME', folder: '.grok' },
      {},
    ),
  ).rejects.toMatchObject({ code: 'host_unavailable' });
});
