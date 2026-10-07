import { expect, onTestFinished, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { buildStubMCPStdioServer } from './build-stub-mcp-stdio-server';
import { createStubBin } from './create-stub-bin';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

function setupTest() {
  return setupTempDir('atc-stub-mcp-stdio-server-');
}

test('it answers each line it reads with the next reply, as given', async () => {
  using ctx = setupTest();

  const bin = createStubBin(
    ctx.dir,
    'server',
    buildStubMCPStdioServer(['{"jsonrpc":"2.0","id":1,"result":{}}', "not json, it's text"]),
  );

  const proc = Bun.spawn([bin], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });

  onTestFinished(() => {
    proc.kill('SIGKILL');
  });

  void proc.stdin.write('one\ntwo\nthree\n');

  await proc.stdin.end();

  const stdout = await new Response(proc.stdout).text();

  expect({ stdout, code: await proc.exited }).toStrictEqual({
    stdout: `{"jsonrpc":"2.0","id":1,"result":{}}\nnot json, it's text\n`,
    code: 0,
  });
});

test('it records its pid beside its script', async () => {
  using ctx = setupTest();

  const bin = createStubBin(ctx.dir, 'server', buildStubMCPStdioServer([]));
  const proc = Bun.spawn([bin], { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });

  onTestFinished(() => {
    proc.kill('SIGKILL');
  });

  const recorded = await waitFor(() => readFile(`${bin}.pid`, 'utf8'));

  expect(recorded).toBe(`${proc.pid}\n`);
});
