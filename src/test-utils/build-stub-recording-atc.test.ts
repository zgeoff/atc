import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubRecordingATC } from './build-stub-recording-atc';
import { createStubBin } from './create-stub-bin';
import { setupTempDir } from './setup-temp-dir';

function setupTest() {
  return setupTempDir('atc-stub-recording-atc-');
}

test('it records its arguments, its atc session, and its input in the log', () => {
  using ctx = setupTest();

  const atc = createStubBin(ctx.dir, 'atc', buildStubRecordingATC(join(ctx.dir, 'atc.log')));

  const result = Bun.spawnSync([atc, 'report', 'note'], {
    stdin: Buffer.from('half way'),
    env: { ...process.env, ATC_SESSION_ID: 's-1' },
  });

  expect({
    exitCode: result.exitCode,
    log: readFileSync(join(ctx.dir, 'atc.log'), 'utf8'),
  }).toStrictEqual({
    exitCode: 0,
    log: 'args:report note\nsession:s-1\nstdin:half way\n',
  });
});

test('it appends each run after the runs before it', () => {
  using ctx = setupTest();

  const atc = createStubBin(ctx.dir, 'atc', buildStubRecordingATC(join(ctx.dir, 'atc.log')));

  Bun.spawnSync([atc, 'first'], {
    stdin: Buffer.from(''),
    env: { ...process.env, ATC_SESSION_ID: 's-1' },
  });

  Bun.spawnSync([atc, 'second'], {
    stdin: Buffer.from(''),
    env: { ...process.env, ATC_SESSION_ID: 's-2' },
  });

  expect(readFileSync(join(ctx.dir, 'atc.log'), 'utf8')).toBe(
    'args:first\nsession:s-1\nstdin:\nargs:second\nsession:s-2\nstdin:\n',
  );
});
