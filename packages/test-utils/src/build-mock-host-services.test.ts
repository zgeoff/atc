import { expect, test } from 'bun:test';
import { systemClock } from '@atc/core/system-clock';
import { buildMockHostServices } from './build-mock-host-services';

test('it builds default host services', () => {
  const host = buildMockHostServices();

  expect(host).toStrictEqual({
    atcArgv: [expect.toStartWith('/')],
    version: expect.toSatisfy((value: string) => /^\d+\.\d+\.\d+$/u.test(value)),
    build: expect.toStartWith(`${host.version}+bin.`),
    runCommand: expect.toBeFunction(),
    clock: systemClock,
    log: expect.toBeFunction(),
  });
});

test('it applies overrides on top of the defaults', () => {
  const host = buildMockHostServices({ atcArgv: ['/usr/local/bin/atc'], version: '4.2.0' });

  expect(host).toStrictEqual({
    atcArgv: ['/usr/local/bin/atc'],
    version: '4.2.0',
    build: expect.toSatisfy((value: string) => /^\d+\.\d+\.\d+\+bin\./u.test(value)),
    runCommand: expect.toBeFunction(),
    clock: systemClock,
    log: expect.toBeFunction(),
  });
});

test('it finds no command to run by default', async () => {
  const host = buildMockHostServices();

  const ran = await host.runCommand(['impd', '--version']);

  expect(ran).toStrictEqual({
    code: 127,
    stdout: '',
    stderr: 'impd: command not found',
  });
});
