import { expect, onTestFinished, test } from 'bun:test';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { resolveHeadlessExecutable } from './resolve-headless-executable';

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
  using temp = setupTempDir('atc-headless-exec-');

  mkdirSync(join(temp.dir, 'bin'));
  writeFileSync(join(temp.dir, 'bin', 'fake-claude'), '#!/bin/sh\n');
  chmodSync(join(temp.dir, 'bin', 'fake-claude'), 0o755);

  const previous = process.env['PATH'];

  onTestFinished(() => {
    process.env['PATH'] = previous;
  });

  process.env['PATH'] = join(temp.dir, 'bin');

  expect(resolveHeadlessExecutable('fake-claude', true)).toStrictEqual({
    pathToClaudeCodeExecutable: join(temp.dir, 'bin', 'fake-claude'),
  });
});
