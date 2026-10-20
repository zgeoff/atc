import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { buildStubMCPStdioServer } from './build-stub-mcp-stdio-server';
import { createStubBin } from './create-stub-bin';
import { registerTestCleanup } from './register-test-cleanup';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-stub-mcp-stdio-server-');

  return { directory: temporaryDirectory.path };
}

test('it answers each line it reads with the next reply, as given', async () => {
  const ctx = setupTest();

  const bin = createStubBin(
    ctx.directory,
    'server',
    buildStubMCPStdioServer(['{"jsonrpc":"2.0","id":1,"result":{}}', "not json, it's text"]),
  );

  const subprocess = Bun.spawn([bin], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });

  registerTestCleanup(() => {
    subprocess.kill('SIGKILL');
  });

  void subprocess.stdin.write('one\ntwo\nthree\n');

  await subprocess.stdin.end();

  const stdout = await new Response(subprocess.stdout).text();

  expect({ stdout, code: await subprocess.exited }).toStrictEqual({
    stdout: `{"jsonrpc":"2.0","id":1,"result":{}}\nnot json, it's text\n`,
    code: 0,
  });
});

test('it prints nothing for the replies left when stdin ends', async () => {
  const ctx = setupTest();

  const bin = createStubBin(
    ctx.directory,
    'server',
    buildStubMCPStdioServer(['first', 'second', 'third']),
  );

  const subprocess = Bun.spawn([bin], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });

  registerTestCleanup(() => {
    subprocess.kill('SIGKILL');
  });

  void subprocess.stdin.write('one\n');

  await subprocess.stdin.end();

  const stdout = await new Response(subprocess.stdout).text();

  expect({ stdout, code: await subprocess.exited }).toStrictEqual({ stdout: 'first\n', code: 0 });
});

test('it records its pid beside its script', async () => {
  const ctx = setupTest();
  const bin = createStubBin(ctx.directory, 'server', buildStubMCPStdioServer([]));
  const subprocess = Bun.spawn([bin], { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });

  registerTestCleanup(() => {
    subprocess.kill('SIGKILL');
  });

  const recorded = await waitFor(() => readFile(`${bin}.pid`, 'utf8'));

  expect(recorded).toBe(`${subprocess.pid}\n`);
});
