import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { runServiceSecret } from './run-service-secret';

function setupTest() {
  const printed: string[] = [];
  const errors: string[] = [];

  return {
    printed,
    errors,
    io: {
      print: (line: string) => {
        printed.push(line);
      },
      printError: (line: string) => {
        errors.push(line);
      },
    },
  };
}

test('it prints a secret and the sha256 digest of that secret to stdout', () => {
  const ctx = setupTest();

  runServiceSecret(ctx.io);

  const secret = /^secret: (?<value>svcs_\S+)$/u.exec(ctx.printed[0] ?? '')?.groups?.['value'];

  expect(secret).toBeString();

  expect(ctx.printed).toStrictEqual([
    expect.stringMatching(/^secret: svcs_/u),
    `digest: ${createHash('sha256')
      .update(secret ?? '')
      .digest('hex')}`,
  ]);
});

test('it keeps the secret off stderr', () => {
  const ctx = setupTest();

  runServiceSecret(ctx.io);

  expect(ctx.errors.join('\n')).not.toInclude('svcs_');
});

test('it prints a different secret on each run', () => {
  const ctx = setupTest();

  runServiceSecret(ctx.io);
  runServiceSecret(ctx.io);

  expect(ctx.printed[0]).not.toBe(ctx.printed[2]);
});
