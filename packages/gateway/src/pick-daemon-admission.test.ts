import { expect, test } from 'bun:test';
import type { DaemonCheck } from '@atcx/contract';
import { pickDaemonAdmission } from './pick-daemon-admission';
import type { DaemonAdmission } from './pick-daemon-admission';

test.each<[string, string, DaemonCheck, DaemonAdmission]>([
  [
    'admits a matching daemon with every feature',
    'atc/7.4.2+lq2x9a',
    { verdict: 'match', missing: [], added: ['session.watch'] },
    { kind: 'admit' },
  ],
  [
    'warns on a matching daemon that lacks features',
    'atc/7.0.3+lq2x9a',
    { verdict: 'match', missing: ['daemon.hello.viewer', 'session.forget.workspace'], added: [] },
    {
      kind: 'warn',
      message:
        "daemon 'harbor' runs atc/7.0.3+lq2x9a, which lacks daemon.hello.viewer, session.forget.workspace; a call that needs one fails",
    },
  ],
  [
    'refuses an older daemon',
    'atc/6.9.0+lq2x9a',
    { verdict: 'older', daemonMajor: 6, contractMajor: 7 },
    {
      kind: 'refuse',
      message:
        "daemon 'harbor' runs atc 6, older than the atc 7 protocol this gateway speaks; upgrade the daemon",
    },
  ],
  [
    'refuses a newer daemon',
    'atc/8.0.0+lq2x9a',
    { verdict: 'newer', daemonMajor: 8, contractMajor: 7 },
    {
      kind: 'refuse',
      message:
        "daemon 'harbor' runs atc 8, newer than the atc 7 protocol this gateway speaks; upgrade the gateway",
    },
  ],
  [
    'warns on a daemon whose build names no version',
    'atc/dev',
    { verdict: 'unreadable', daemon: 'atc/dev' },
    {
      kind: 'warn',
      message:
        "daemon 'harbor' runs atc/dev, which names no version, so the gateway cannot check its protocol",
    },
  ],
])('it %s', (_label, build, check, expected) => {
  expect(pickDaemonAdmission('harbor', build, check)).toStrictEqual(expected);
});
