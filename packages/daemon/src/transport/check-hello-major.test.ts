import { expect, test } from 'bun:test';
import { CONTRACT_MAJOR } from '@atcx/contract/light';
import { checkHelloMajor } from './check-hello-major';

test('it accepts a hello of the daemon major version', () => {
  expect(checkHelloMajor({ major: CONTRACT_MAJOR }, 'atc/9.9.9')).toBeNull();
});

test.each<[string, Record<string, unknown>, string]>([
  ['no major', { client: 'old-tui', protocol: 14 }, 'update or reopen the client'],
  [
    'an older major',
    { client: 'old-tui', major: CONTRACT_MAJOR - 1 },
    'update or reopen the client',
  ],
  ['a newer major', { client: 'new-tui', major: CONTRACT_MAJOR + 1 }, 'restart the daemon'],
  ['a major that is no number', { major: '7' }, 'update or reopen the client'],
])('it refuses a hello with %s with the daemon major and protocol', (_label, params, remedy) => {
  expect(checkHelloMajor(params, 'atc/9.9.9')).toStrictEqual({
    code: 'protocol_mismatch',
    message: expect.stringContaining(remedy),
    data: { daemonProtocol: 15, daemonMajor: CONTRACT_MAJOR },
  });
});

test('it names the daemon build and its protocol in the refusal', () => {
  expect(checkHelloMajor({}, 'atc/9.9.9')?.message).toContain('daemon atc/9.9.9 speaks v15');
});
