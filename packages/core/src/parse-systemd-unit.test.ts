import { expect, test } from 'bun:test';
import { parseSystemdUnit } from './parse-systemd-unit';

test('it reads the service a daemon runs in below the user manager', () => {
  const cgroup = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/atc-daemon.service\n';

  expect(parseSystemdUnit(cgroup, 1000)).toBe('atc-daemon.service');
});

test('it reads the service of a daemon that sits in a sub-cgroup of its unit', () => {
  const cgroup =
    '0::/user.slice/user-1000.slice/user@1000.service/app.slice/atc-daemon.service/pty\n';

  expect(parseSystemdUnit(cgroup, 1000)).toBe('atc-daemon.service');
});

test('it reads null for a process in a login session scope', () => {
  const cgroup = '0::/user.slice/user-1000.slice/session-3.scope\n';

  expect(parseSystemdUnit(cgroup, 1000)).toBeNull();
});

test('it reads null for a scope below the user manager', () => {
  const cgroup = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-term.scope\n';

  expect(parseSystemdUnit(cgroup, 1000)).toBeNull();
});

test('it reads null for a service of the system manager', () => {
  expect(parseSystemdUnit('0::/system.slice/atc.service\n', 1000)).toBeNull();
});

test('it reads null when the user manager belongs to another user', () => {
  const cgroup = '0::/user.slice/user-1001.slice/user@1001.service/app.slice/atc-daemon.service\n';

  expect(parseSystemdUnit(cgroup, 1000)).toBeNull();
});

test('it reads null for an empty cgroup file', () => {
  expect(parseSystemdUnit('', 1000)).toBeNull();
});
