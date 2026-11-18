import { mock } from 'bun:test';
import type { Mock } from 'bun:test';
import type { ClaudeHeadlessRun } from '../headless/make-claude-headless-runner';

export function buildStubClaudeHeadlessRun(): Mock<ClaudeHeadlessRun> {
  return mock<ClaudeHeadlessRun>(() => ({ stop: () => {} }));
}
