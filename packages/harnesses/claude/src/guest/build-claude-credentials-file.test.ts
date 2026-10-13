import { expect, test } from 'bun:test';
import invariant from 'tiny-invariant';
import { buildClaudeCredentialsFile } from './build-claude-credentials-file';

test('it signs in with the broker placeholder and no refresh token or expiry', () => {
  const file = buildClaudeCredentialsFile();

  invariant(typeof file === 'object' && 'mode' in file, 'expected a file with a mode');

  expect(JSON.parse(new TextDecoder().decode(file.content))).toStrictEqual({
    claudeAiOauth: {
      accessToken: 'imp-broker-placeholder',
      refreshToken: null,
      expiresAt: null,
      scopes: ['user:inference'],
    },
  });
});

test('it keeps the file readable by its owner alone', () => {
  const file = buildClaudeCredentialsFile();

  invariant(typeof file === 'object' && 'mode' in file, 'expected a file with a mode');

  expect(file.mode).toBe(0o600);
});
