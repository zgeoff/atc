import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import { canResumeFromTranscript } from './can-resume-from-transcript';

// A folder for the transcript a test writes or leaves out.
function setupTest() {
  const tmp = setupTempDir('atc-resume-');

  return { dir: tmp.dir };
}

test('it resumes when no transcript was reported', () => {
  expect(canResumeFromTranscript({})).toBeTrue();
});

test('it resumes when the reported transcript exists', () => {
  const ctx = setupTest();
  const transcript = join(ctx.dir, 'transcript.jsonl');

  writeFileSync(transcript, '');

  expect(canResumeFromTranscript({ transcriptSource: transcript })).toBeTrue();
});

test('it does not resume when the reported transcript is gone', () => {
  const ctx = setupTest();

  expect(canResumeFromTranscript({ transcriptSource: join(ctx.dir, 'missing.jsonl') })).toBeFalse();
});
