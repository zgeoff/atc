import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { updateEnv } from '@zgeoff/testing';
import { createStubBin } from '@zgeoff/testing/bin';
import { createTempDir } from '@zgeoff/testing/fs';
import { resolveHeadlessExecutable } from './resolve-headless-executable';

function setupTest() {
  const temporaryDirectory = createTempDir('atc-headless-exec-');

  return { directory: temporaryDirectory.path };
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
  const ctx = setupTest();

  createStubBin(join(ctx.directory, 'bin'), 'fake-claude', { script: '#!/bin/sh\n' });
  updateEnv('PATH', join(ctx.directory, 'bin'));

  expect(resolveHeadlessExecutable('fake-claude', true)).toStrictEqual({
    pathToClaudeCodeExecutable: join(ctx.directory, 'bin', 'fake-claude'),
  });
});
