import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir } from '@zgeoff/testing/fs';
import { probeTranscriptResumable } from './probe-transcript-resumable';

function setupTest() {
  const temporaryDirectory = createTempDir('atc-resume-');

  return { directory: temporaryDirectory.path };
}

test('it resumes when no transcript was reported', () => {
  expect(probeTranscriptResumable({})).toBeTrue();
});

test('it resumes when the reported transcript exists', () => {
  const ctx = setupTest();
  const transcript = join(ctx.directory, 'transcript.jsonl');

  writeFileSync(transcript, '');

  expect(probeTranscriptResumable({ transcriptSource: transcript })).toBeTrue();
});

test('it does not resume when the reported transcript is gone', () => {
  const ctx = setupTest();

  expect(
    probeTranscriptResumable({ transcriptSource: join(ctx.directory, 'missing.jsonl') }),
  ).toBeFalse();
});
