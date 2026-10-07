import { expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createStubBin } from './create-stub-bin';
import { createStubGuestCLIs } from './create-stub-guest-clis';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

function setupTest() {
  return setupTempDir('atc-stub-guest-clis-');
}

test('it creates both tools under the directory', () => {
  using ctx = setupTest();

  expect(createStubGuestCLIs(ctx.dir)).toStrictEqual({
    atc: join(ctx.dir, 'atc'),
    claude: join(ctx.dir, 'claude'),
  });
});

test('it creates an atc that runs the CLI of this source tree', () => {
  using ctx = setupTest();

  const clis = createStubGuestCLIs(ctx.dir);
  const result = Bun.spawnSync([clis.atc, 'help']);

  expect(result.stdout.toString()).toInclude('Terminal control tower for coding-agent sessions');
});

test('it creates a claude that prints its pid, then echoes each line it reads', () => {
  using ctx = setupTest();

  const clis = createStubGuestCLIs(ctx.dir);
  const result = Bun.spawnSync([clis.claude], { stdin: Buffer.from('hello\n') });

  expect(result.stdout.toString()).toMatch(/^UP:\d+\nGOT:hello\n$/);
});

test('it makes both tools executable', () => {
  using ctx = setupTest();

  const clis = createStubGuestCLIs(ctx.dir);

  expect([statSync(clis.atc).mode & 0o111, statSync(clis.claude).mode & 0o111]).toStrictEqual([
    0o111, 0o111,
  ]);
});

test('it reports a SessionStart with a transcript only the host holds for start', () => {
  using ctx = setupTest();

  const clis = createStubGuestCLIs(ctx.dir);
  const log = join(ctx.dir, 'atc.log');

  createStubBin(ctx.dir, 'atc', buildRecorderScript(log));

  Bun.spawnSync([clis.claude], {
    stdin: Buffer.from('start c-1\n'),
    env: { ...process.env, ATC_SESSION_ID: 's-own' },
  });

  expect(readFileSync(log, 'utf8')).toBe(
    'args:hook-report --agent claude\nsession:s-own\nstdin:{"hook_event_name":"SessionStart","session_id":"c-1","transcript_path":"/guest/only/transcript.jsonl"}\n',
  );
});

test('it reports a Notification carrying the text for notify', () => {
  using ctx = setupTest();

  const clis = createStubGuestCLIs(ctx.dir);
  const log = join(ctx.dir, 'atc.log');

  createStubBin(ctx.dir, 'atc', buildRecorderScript(log));

  Bun.spawnSync([clis.claude], {
    stdin: Buffer.from('notify needs you\n'),
    env: { ...process.env, ATC_SESSION_ID: 's-own' },
  });

  expect(readFileSync(log, 'utf8')).toBe(
    'args:hook-report --agent claude\nsession:s-own\nstdin:{"hook_event_name":"Notification","message":"needs you"}\n',
  );
});

test('it reports a SessionStart from a nested Codex harness for nested', () => {
  using ctx = setupTest();

  const clis = createStubGuestCLIs(ctx.dir);
  const log = join(ctx.dir, 'atc.log');

  createStubBin(ctx.dir, 'atc', buildRecorderScript(log));

  Bun.spawnSync([clis.claude], {
    stdin: Buffer.from('nested x-1\n'),
    env: { ...process.env, ATC_SESSION_ID: 's-own' },
  });

  expect(readFileSync(log, 'utf8')).toBe(
    'args:hook-report --agent codex\nsession:s-own\nstdin:{"hook_event_name":"SessionStart","session_id":"x-1","source":"startup"}\n',
  );
});

test('it reports a Notification as another atc session for forge', () => {
  using ctx = setupTest();

  const clis = createStubGuestCLIs(ctx.dir);
  const log = join(ctx.dir, 'atc.log');

  createStubBin(ctx.dir, 'atc', buildRecorderScript(log));

  Bun.spawnSync([clis.claude], {
    stdin: Buffer.from('forge s-other\n'),
    env: { ...process.env, ATC_SESSION_ID: 's-own' },
  });

  expect(readFileSync(log, 'utf8')).toBe(
    'args:hook-report --agent claude\nsession:s-other\nstdin:{"hook_event_name":"Notification","message":"forged"}\n\n',
  );
});

test('it answers the message with the text for answer', () => {
  using ctx = setupTest();

  const clis = createStubGuestCLIs(ctx.dir);
  const log = join(ctx.dir, 'atc.log');

  createStubBin(ctx.dir, 'atc', buildRecorderScript(log));

  Bun.spawnSync([clis.claude], {
    stdin: Buffer.from('answer m-1 the answer\n'),
    env: { ...process.env, ATC_SESSION_ID: 's-own' },
  });

  expect(readFileSync(log, 'utf8')).toBe(
    'args:report answered --messages m-1\nsession:s-own\nstdin:the answer\n',
  );
});

test('it reports a note labelled progress for note', () => {
  using ctx = setupTest();

  const clis = createStubGuestCLIs(ctx.dir);
  const log = join(ctx.dir, 'atc.log');

  createStubBin(ctx.dir, 'atc', buildRecorderScript(log));

  Bun.spawnSync([clis.claude], {
    stdin: Buffer.from('note half way\n'),
    env: { ...process.env, ATC_SESSION_ID: 's-own' },
  });

  expect(readFileSync(log, 'utf8')).toBe(
    'args:report note --label progress\nsession:s-own\nstdin:half way\n',
  );
});

test('it runs the tap in the background, printing into the file, for tap', async () => {
  using ctx = setupTest();

  const clis = createStubGuestCLIs(ctx.dir);
  const tapFile = join(ctx.dir, 'tap.log');

  createStubBin(ctx.dir, 'atc', buildRecorderScript('/dev/stdout'));

  Bun.spawnSync([clis.claude], {
    stdin: Buffer.from(`tap ${tapFile}\n`),
    env: { ...process.env, ATC_SESSION_ID: 's-own' },
  });

  await waitFor(() => {
    expect(readFileSync(tapFile, 'utf8')).toBe('args:tap --session s-own\nsession:s-own\nstdin:\n');
  });
});

// An atc that appends its arguments, the atc session it runs as, and what it
// read from stdin to the log.
function buildRecorderScript(log: string): string {
  return `#!/bin/sh
{ printf 'args:%s\\n' "$*"; printf 'session:%s\\n' "$ATC_SESSION_ID"; printf 'stdin:'; cat; printf '\\n'; } >> '${log}'
`;
}
