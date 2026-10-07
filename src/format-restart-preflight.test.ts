import { expect, test } from 'bun:test';
import { formatRestartPreflight } from './format-restart-preflight';

const POLICY =
  'Stopping the daemon ends every agent process it hosts. A session that is mid-turn loses that turn; the restore resumes each session from its transcript, and the interrupted turn does not continue.';

test('it lists the mid-turn sessions and marks the one that asked for the restart', () => {
  const lines = formatRestartPreflight({
    pid: 77,
    socketPath: '/run/atc-daemon.sock',
    answer: { kind: 'ok', build: 'atc/3.1.1+abc', protocol: 7 },
    sessions: [
      { id: 's-1', name: 'api', state: 'running' },
      { id: 's-2', name: 'docs', state: 'done' },
      { id: 's-3', name: 'web', state: 'running' },
    ],
    callerSession: 's-3',
    replacement: { kind: 'plain', build: 'atc/3.1.1+abc', command: 'atc daemon' },
  });

  expect(lines).toStrictEqual([
    'daemon: pid 77, build atc/3.1.1+abc, protocol v7',
    '2 sessions are mid-turn:',
    '  api (s-1)',
    '  web (s-3) (this session)',
    'replacement: build atc/3.1.1+abc, started with atc daemon',
    POLICY,
  ]);
});

test('it prints the refusal and parses the daemon build from a protocol mismatch', () => {
  const message =
    'atc/x speaks protocol v7, daemon atc/legacy-build speaks v6; restart the daemon so both run the same build';

  const lines = formatRestartPreflight({
    pid: 77,
    socketPath: '/run/atc-daemon.sock',
    answer: { kind: 'refused', message },
    sessions: null,
    callerSession: null,
    replacement: { kind: 'plain', build: 'atc/x', command: 'atc daemon' },
  });

  expect(lines).toStrictEqual([
    `daemon: pid 77 refused this build's handshake: ${message}`,
    'daemon build atc/legacy-build speaks protocol v6',
    'The session states cannot be read across the protocol mismatch, so the sessions that are mid-turn are unknown.',
    'replacement: build atc/x, started with atc daemon',
    POLICY,
  ]);
});

test('it says that the restart only starts a daemon when none answers and no pid is recorded', () => {
  const lines = formatRestartPreflight({
    pid: null,
    socketPath: null,
    answer: null,
    sessions: null,
    callerSession: null,
    replacement: { kind: 'plain', build: 'atc/x', command: 'atc daemon' },
  });

  expect(lines[0]).toBe(
    'no daemon answers and no live pid is recorded; the restart only starts one and restores the fleet',
  );
});

test('it names the unit and its ExecStart path and says that the unit decides the build', () => {
  const lines = formatRestartPreflight({
    pid: 77,
    socketPath: '/run/atc-daemon.sock',
    answer: { kind: 'ok', build: 'atc/3.1.1+abc', protocol: 7 },
    sessions: [],
    callerSession: null,
    replacement: { kind: 'unit', unit: 'atc-daemon.service', execStart: '/home/u/.local/bin/atc' },
  });

  expect(lines).toIncludeAllMembers([
    'no session is mid-turn',
    'replacement: systemd unit atc-daemon.service, ExecStart /home/u/.local/bin/atc',
    'The unit decides the build the replacement runs.',
  ]);
});
