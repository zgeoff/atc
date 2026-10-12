import { expect, test } from 'bun:test';
import { formatProtocolMismatch } from './format-protocol-mismatch';

test('it holds both builds, both versions, the pid, and the deliberate restart', () => {
  const message = formatProtocolMismatch({
    socketPath: '/run/user/1000/atc-daemon.sock',
    daemonPID: 4242,
    clientBuild: 'atc/2.13.0+abc',
    clientProtocol: 4,
    daemonMessage:
      'atc/2.13.0+abc speaks protocol v4, daemon atc/2.12.0+xyz speaks v3; restart the daemon so both run the same build',
  });

  expect(message).toMatchInlineSnapshot(`
    "the atc daemon (pid 4242, socket /run/user/1000/atc-daemon.sock) speaks another protocol than this client, atc/2.13.0+abc on protocol v4.
    The daemon answered: atc/2.13.0+abc speaks protocol v4, daemon atc/2.12.0+xyz speaks v3; restart the daemon so both run the same build
    It was left running, so the sessions it hosts keep running.
    To restart it, run \`atc\` from the build you want and confirm its restart prompt: every hosted session ends, and the fleet is restored on the new daemon."
  `);
});

test('it tells the user to find and stop the daemon when its pid is unknown', () => {
  const message = formatProtocolMismatch({
    socketPath: '/run/user/1000/atc-daemon.sock',
    daemonPID: null,
    clientBuild: 'atc/2.13.0+abc',
    clientProtocol: 4,
    daemonMessage: 'refused',
  });

  expect(message).toMatchInlineSnapshot(`
    "the atc daemon (pid unknown, socket /run/user/1000/atc-daemon.sock) speaks another protocol than this client, atc/2.13.0+abc on protocol v4.
    The daemon answered: refused
    It was left running, so the sessions it hosts keep running.
    To restart it, find its pid with \`ss -xlp | grep /run/user/1000/atc-daemon.sock\` on Linux or \`lsof -U | grep /run/user/1000/atc-daemon.sock\` on macOS, stop that process, and run \`atc\` again: every hosted session ends, and \`R\` respawns them from their transcripts."
  `);
});
