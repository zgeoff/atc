import { mock } from 'bun:test';
import type { Mock } from 'bun:test';
import type { ClaudeHeadlessRun } from '../agents/make-claude-headless-runner';

/**
 * A stand-in for the Claude headless runner an adapter takes: it records
 * each request and its event hooks, starts no turn, fires no hook, and
 * hands back a handle whose stop does nothing. A test reads what the
 * adapter asked for through the mock matchers.
 */
export function buildStubClaudeHeadlessRun(): Mock<ClaudeHeadlessRun> {
  return mock<ClaudeHeadlessRun>(() => ({ stop: () => {} }));
}
