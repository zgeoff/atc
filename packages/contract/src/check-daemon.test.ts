import { expect, test } from 'bun:test';
import { checkDaemon } from './check-daemon';
import type { DaemonCheck } from './check-daemon';
import { CONTRACT_VERSION } from './contract-version';

test.each<[string, string, string[], DaemonCheck]>([
  [
    'a matching daemon',
    'atc/7.4.2+lq2x9a',
    ['events.read.from-start'],
    { verdict: 'match', missing: [], added: [] },
  ],
  [
    'an older daemon',
    'atc/6.9.0+lq2x9a',
    ['events.read.from-start'],
    { verdict: 'older', daemonMajor: 6, contractMajor: 7 },
  ],
  [
    'a newer daemon',
    'atc/8.0.0+lq2x9a',
    ['events.read.from-start'],
    { verdict: 'newer', daemonMajor: 8, contractMajor: 7 },
  ],
  [
    'a daemon of the same major that lacks a feature',
    'atc/7.0.3+lq2x9a',
    [],
    { verdict: 'match', missing: ['events.read.from-start'], added: [] },
  ],
  [
    'a daemon of the same major that adds a feature',
    'atc/7.9.0+lq2x9a',
    ['events.read.from-start', 'session.watch'],
    { verdict: 'match', missing: [], added: ['session.watch'] },
  ],
  ['a daemon string with no version', 'atc/dev', [], { verdict: 'unreadable', daemon: 'atc/dev' }],
])('it checks %s against a 7.1.0 contract', (_label, daemon, features, expected) => {
  expect(checkDaemon({ daemon, features }, '7.1.0')).toStrictEqual(expected);
});

test('it matches a daemon of its own version that lists every feature', () => {
  expect(
    checkDaemon({ daemon: `atc/${CONTRACT_VERSION}+lq2x9a`, features: ['events.read.from-start'] }),
  ).toStrictEqual({ verdict: 'match', missing: [], added: [] });
});

test('it throws on a contract version that names no major version', () => {
  expect(() => checkDaemon({ daemon: 'atc/7.1.0', features: [] }, 'invalid')).toThrowWithMessage(
    Error,
    "the contract's version invalid names no major version",
  );
});
