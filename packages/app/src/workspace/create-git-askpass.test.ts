import { expect, test } from 'bun:test';
import { runShellcheck } from '@atc/test-utils/run-shellcheck';
import { ASKPASS_SCRIPT } from './create-git-askpass';

test('it answers git prompts through a helper script that passes shellcheck', async () => {
  const result = await runShellcheck(ASKPASS_SCRIPT);

  expect(result).toStrictEqual({ exitCode: 0, findings: [] });
});
