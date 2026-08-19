import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter } from './claude-adapter';
import type { Config } from './config';

function buildClaudeConfig(): Config {
  return {
    claudeBin: 'claude',
    claudeArgs: [],
    grokBin: 'grok',
    grokArgs: [],
    leader: { code: 0, label: '^Space' },
  };
}

test('it resumes when no transcript was reported or the reported file exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atc-claude-resume-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const transcript = join(dir, 'transcript.jsonl');

  writeFileSync(transcript, '');

  const adapter = new ClaudeAdapter(buildClaudeConfig());

  expect(adapter.canResume({})).toBe(true);
  expect(adapter.canResume({ transcriptSource: transcript })).toBe(true);
  expect(adapter.canResume({ transcriptSource: join(dir, 'missing.jsonl') })).toBe(false);
});
