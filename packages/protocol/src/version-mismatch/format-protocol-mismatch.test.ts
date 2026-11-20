import { expect, test } from 'bun:test';
import { formatProtocolMismatch } from './format-protocol-mismatch';

test('it holds both builds, both major versions, the pid, and the deliberate restart', () => {
  const message = formatProtocolMismatch({
    socketPath: '/run/user/1000/atc-daemon.sock',
    daemonPID: 4242,
    clientBuild: 'atc/8.0.0+abc',
    clientProtocol: 15,
    daemonProtocol: 15,
    clientMajor: 8,
    daemonMajor: 7,
    daemonMessage:
      'atc/8.0.0+abc is on major version 8 and protocol v15, daemon atc/7.2.0+xyz speaks v15 on major version 7; restart the daemon so both run the same major version',
  });

  expect(message).toMatchInlineSnapshot(`
    "the atc daemon (pid 4242, socket /run/user/1000/atc-daemon.sock) speaks another major version than this client, atc/8.0.0+abc on major version 8.
    The daemon answered: atc/8.0.0+abc is on major version 8 and protocol v15, daemon atc/7.2.0+xyz speaks v15 on major version 7; restart the daemon so both run the same major version
    It was left running, so the sessions it hosts keep running.
    To restart it, run \`atc\` from the build you want and confirm its restart prompt: every hosted session ends, and the fleet is restored on the new daemon."
  `);
});

test('it tells the user to find and stop an older daemon when its pid is unknown', () => {
  const message = formatProtocolMismatch({
    socketPath: '/run/user/1000/atc-daemon.sock',
    daemonPID: null,
    clientBuild: 'atc/8.0.0+abc',
    clientProtocol: 15,
    daemonProtocol: 14,
    clientMajor: 8,
    daemonMajor: null,
    daemonMessage: 'refused',
  });

  expect(message).toMatchInlineSnapshot(`
    "the atc daemon (pid unknown, socket /run/user/1000/atc-daemon.sock) speaks another major version than this client, atc/8.0.0+abc on major version 8.
    The daemon answered: refused
    It was left running, so the sessions it hosts keep running.
    To restart it, find its pid with \`ss -xlp | grep /run/user/1000/atc-daemon.sock\` on Linux or \`lsof -U | grep /run/user/1000/atc-daemon.sock\` on macOS, stop that process, and run \`atc\` again: every hosted session ends, and \`R\` respawns them from their transcripts."
  `);
});

test('it tells a client older than the daemon to reopen itself, and offers no restart', () => {
  const message = formatProtocolMismatch({
    socketPath: '/run/user/1000/atc-daemon.sock',
    daemonPID: 4242,
    clientBuild: 'atc/7.2.0+xyz',
    clientProtocol: 15,
    daemonProtocol: 15,
    clientMajor: 7,
    daemonMajor: 8,
    daemonMessage: 'update or reopen the client',
  });

  expect(message).toMatchInlineSnapshot(`
    "this client, atc/7.2.0+xyz on major version 7, is older than the atc daemon (pid 4242, socket /run/user/1000/atc-daemon.sock), which runs major version 8.
    The daemon answered: update or reopen the client
    It was left running, so the sessions it hosts keep running.
    To reconnect, update atc if this build is out of date, then quit this client and run \`atc\` again. A daemon restart cannot help, because the daemon comes back on its own build."
  `);
});
