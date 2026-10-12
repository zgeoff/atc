import { expect, test } from 'bun:test';
import { buildStubGHCommand } from './build-stub-gh-command';

test('it answers a gh run with the reply for its first argument, trimmed', async () => {
  const gh = buildStubGHCommand({
    replies: { repo: { stdout: 'out\n', stderr: ' err\n', exitCode: 3 } },
  });

  const ran = await gh.runCommand(['gh', 'repo', 'list']);

  expect(ran).toStrictEqual({ code: 3, stdout: 'out', stderr: 'err', aborted: false });
});

test('it answers a gh run without a reply with no output and exit code 0', async () => {
  const gh = buildStubGHCommand({ replies: {} });

  const ran = await gh.runCommand(['gh', 'config', 'get', 'git_protocol']);

  expect(ran).toStrictEqual({ code: 0, stdout: '', stderr: '', aborted: false });
});

test('it records the argv of every run in order', async () => {
  const gh = buildStubGHCommand({ replies: {} });

  await gh.runCommand(['gh', 'repo', 'list']);
  await gh.runCommand(['/opt/gh', 'config', 'get', 'git_protocol']);

  expect(gh.calls).toStrictEqual([
    ['gh', 'repo', 'list'],
    ['/opt/gh', 'config', 'get', 'git_protocol'],
  ]);
});

test('it ends a hanging run as aborted once its signal aborts', async () => {
  const gh = buildStubGHCommand({ replies: { repo: 'hang' } });

  const controller = new AbortController();

  const running = gh.runCommand(['gh', 'repo', 'list'], { signal: controller.signal });

  controller.abort();

  const ran = await running;

  expect(ran).toStrictEqual({ code: -1, stdout: '', stderr: '', aborted: true });
});

test('it ends a hanging run at once when its signal aborted before the call', async () => {
  const gh = buildStubGHCommand({ replies: { repo: 'hang' } });

  const ran = await gh.runCommand(['gh', 'repo', 'list'], { signal: AbortSignal.abort() });

  expect(ran).toStrictEqual({ code: -1, stdout: '', stderr: '', aborted: true });
});
