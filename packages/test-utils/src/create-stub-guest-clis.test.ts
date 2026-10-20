import { expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubRecordingATC } from './build-stub-recording-atc';
import { createStubBin } from './create-stub-bin';
import { createStubGuestCLIs } from './create-stub-guest-clis';
import { runCommand } from './run-command';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-stub-guest-clis-');

  return { directory: temporaryDirectory.path };
}

test('it creates both tools under the directory', () => {
  const ctx = setupTest();

  expect(createStubGuestCLIs(ctx.directory)).toStrictEqual({
    atc: join(ctx.directory, 'atc'),
    claude: join(ctx.directory, 'claude'),
  });
});

test('it creates an atc that runs the CLI of this source tree', async () => {
  const ctx = setupTest();

  const result = await runCommand([createStubGuestCLIs(ctx.directory).atc, 'help']);

  expect(result.stdout).toInclude('Terminal control tower for coding-agent sessions');
});

test('it creates a claude that prints its pid, then echoes each line it reads', async () => {
  const ctx = setupTest();

  const result = await runCommand([createStubGuestCLIs(ctx.directory).claude], {
    stdin: Buffer.from('hello\n'),
  });

  expect(result.stdout).toMatch(/^UP:\d+\nGOT:hello\n$/u);
});

test('it makes both tools executable', () => {
  const ctx = setupTest();
  const clis = createStubGuestCLIs(ctx.directory);

  expect(statSync(clis.atc).mode & 0o111).toBe(0o111);
  expect(statSync(clis.claude).mode & 0o111).toBe(0o111);
});

test('it reports a SessionStart with a transcript only the host holds for start', async () => {
  const ctx = setupTest();
  const clis = createStubGuestCLIs(ctx.directory);
  const log = join(ctx.directory, 'atc.log');

  createStubBin(ctx.directory, 'atc', buildStubRecordingATC(log));

  await runCommand([clis.claude], {
    stdin: Buffer.from('start c-1\n'),
    env: { ...process.env, ATC_SESSION_ID: 's-own' },
  });

  expect(readFileSync(log, 'utf8')).toBe(
    'args:hook-report --agent claude\nsession:s-own\nstdin:{"hook_event_name":"SessionStart","session_id":"c-1","transcript_path":"/guest/only/transcript.jsonl"}\n',
  );
});

test('it reports a Notification carrying the text for notify', async () => {
  const ctx = setupTest();
  const clis = createStubGuestCLIs(ctx.directory);
  const log = join(ctx.directory, 'atc.log');

  createStubBin(ctx.directory, 'atc', buildStubRecordingATC(log));

  await runCommand([clis.claude], {
    stdin: Buffer.from('notify needs you\n'),
    env: { ...process.env, ATC_SESSION_ID: 's-own' },
  });

  expect(readFileSync(log, 'utf8')).toBe(
    'args:hook-report --agent claude\nsession:s-own\nstdin:{"hook_event_name":"Notification","message":"needs you"}\n',
  );
});

test('it reports a Stop for stop', async () => {
  const ctx = setupTest();
  const clis = createStubGuestCLIs(ctx.directory);
  const log = join(ctx.directory, 'atc.log');

  createStubBin(ctx.directory, 'atc', buildStubRecordingATC(log));

  await runCommand([clis.claude], {
    stdin: Buffer.from('stop\n'),
    env: { ...process.env, ATC_SESSION_ID: 's-own' },
  });

  expect(readFileSync(log, 'utf8')).toBe(
    'args:hook-report --agent claude\nsession:s-own\nstdin:{"hook_event_name":"Stop"}\n\n',
  );
});

test('it reports a SessionStart from a nested Codex harness for nested', async () => {
  const ctx = setupTest();
  const clis = createStubGuestCLIs(ctx.directory);
  const log = join(ctx.directory, 'atc.log');

  createStubBin(ctx.directory, 'atc', buildStubRecordingATC(log));

  await runCommand([clis.claude], {
    stdin: Buffer.from('nested x-1\n'),
    env: { ...process.env, ATC_SESSION_ID: 's-own' },
  });

  expect(readFileSync(log, 'utf8')).toBe(
    'args:hook-report --agent codex\nsession:s-own\nstdin:{"hook_event_name":"SessionStart","session_id":"x-1","source":"startup"}\n',
  );
});

test('it reports a Notification as another atc session for forge', async () => {
  const ctx = setupTest();
  const clis = createStubGuestCLIs(ctx.directory);
  const log = join(ctx.directory, 'atc.log');

  createStubBin(ctx.directory, 'atc', buildStubRecordingATC(log));

  await runCommand([clis.claude], {
    stdin: Buffer.from('forge s-other\n'),
    env: { ...process.env, ATC_SESSION_ID: 's-own' },
  });

  expect(readFileSync(log, 'utf8')).toBe(
    'args:hook-report --agent claude\nsession:s-other\nstdin:{"hook_event_name":"Notification","message":"forged"}\n\n',
  );
});

test('it answers the message with the text for answer', async () => {
  const ctx = setupTest();
  const clis = createStubGuestCLIs(ctx.directory);
  const log = join(ctx.directory, 'atc.log');

  createStubBin(ctx.directory, 'atc', buildStubRecordingATC(log));

  await runCommand([clis.claude], {
    stdin: Buffer.from('answer m-1 the answer\n'),
    env: { ...process.env, ATC_SESSION_ID: 's-own' },
  });

  expect(readFileSync(log, 'utf8')).toBe(
    'args:answer --messages m-1\nsession:s-own\nstdin:the answer\n',
  );
});

test('it reports a note labelled progress for note', async () => {
  const ctx = setupTest();
  const clis = createStubGuestCLIs(ctx.directory);
  const log = join(ctx.directory, 'atc.log');

  createStubBin(ctx.directory, 'atc', buildStubRecordingATC(log));

  await runCommand([clis.claude], {
    stdin: Buffer.from('note half way\n'),
    env: { ...process.env, ATC_SESSION_ID: 's-own' },
  });

  expect(readFileSync(log, 'utf8')).toBe(
    'args:note --label progress\nsession:s-own\nstdin:half way\n',
  );
});

test('it runs the tap in the background, printing into the file, for tap', async () => {
  const ctx = setupTest();
  const clis = createStubGuestCLIs(ctx.directory);
  const tapFile = join(ctx.directory, 'tap.log');

  createStubBin(ctx.directory, 'atc', buildStubRecordingATC('/dev/stdout'));

  await runCommand([clis.claude], {
    stdin: Buffer.from(`tap ${tapFile}\n`),
    env: { ...process.env, ATC_SESSION_ID: 's-own' },
  });

  await waitFor(() => {
    expect(readFileSync(tapFile, 'utf8')).toBe('args:tap --session s-own\nsession:s-own\nstdin:\n');
  });
});
