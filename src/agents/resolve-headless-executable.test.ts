import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createStubBin } from '../test-utils/create-stub-bin';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { updateEnv } from '../test-utils/update-env';
import { resolveHeadlessExecutable } from './resolve-headless-executable';

// The folder the PATH entry with a stand-in claude binary sits in.
function setupTest() {
  return setupTempDir('atc-headless-exec-');
}

test('it leaves the SDK on its own CLI copy under a source run', () => {
  expect(resolveHeadlessExecutable('claude', false)).toBeNull();
});

test('it hands a compiled binary the configured claude path as written when it holds a slash', () => {
  expect(resolveHeadlessExecutable('/opt/claude/bin/claude', true)).toStrictEqual({
    pathToClaudeCodeExecutable: '/opt/claude/bin/claude',
  });
});

test('it runs a JavaScript claude entry under node', () => {
  expect(resolveHeadlessExecutable('/usr/lib/node_modules/claude/cli.js', true)).toStrictEqual({
    pathToClaudeCodeExecutable: '/usr/lib/node_modules/claude/cli.js',
    executable: 'node',
  });
});

test('it resolves a bare binary name on PATH for a compiled binary', () => {
  using ctx = setupTest();

  createStubBin(join(ctx.dir, 'bin'), 'fake-claude', '#!/bin/sh\n');
  updateEnv('PATH', join(ctx.dir, 'bin'));

  expect(resolveHeadlessExecutable('fake-claude', true)).toStrictEqual({
    pathToClaudeCodeExecutable: join(ctx.dir, 'bin', 'fake-claude'),
  });
});
