import { expect, mock, test } from 'bun:test';
import { buildStubGHCommand } from '@atc/test-utils';
import { runGH } from './run-gh';

test('it returns what gh printed and its exit code', async () => {
  const gh = buildStubGHCommand({
    replies: { repo: { stdout: 'out\n', stderr: 'err\n', exitCode: 3 } },
  });

  const run = await runGH(gh.runCommand, 'gh', new AbortController().signal, ['repo', 'list']);

  expect(run).toStrictEqual({ exitCode: 3, stdout: 'out', stderr: 'err', timedOut: false });
});

test('it runs gh with its arguments, kept from prompting, colouring, and update checks, under the signal', async () => {
  const runCommand = mock(() =>
    Promise.resolve({ code: 0, stdout: '', stderr: '', aborted: false }),
  );

  const signal = new AbortController().signal;

  await runGH(runCommand, '/opt/gh', signal, ['repo', 'list']);

  expect(runCommand).toHaveBeenCalledExactlyOnceWith(['/opt/gh', 'repo', 'list'], {
    env: {
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
      GH_SPINNER_DISABLED: '1',
      NO_COLOR: '1',
      LC_ALL: 'C',
    },
    signal,
  });
});

test('it reads a gh the signal stopped as timed out', async () => {
  const gh = buildStubGHCommand({ replies: { repo: 'hang' } });

  const run = await runGH(gh.runCommand, 'gh', AbortSignal.abort(), ['repo', 'list']);

  expect(run).toStrictEqual({ exitCode: -1, stdout: '', stderr: '', timedOut: true });
});
