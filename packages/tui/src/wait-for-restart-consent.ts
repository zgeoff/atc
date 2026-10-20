import { ansi } from '@atc/core';
import type { ProtocolMismatch } from '@atc/protocol';
import type { ClientActor } from './build-client-machine';

// What the prompt borrows from the client that owns the screen.
export interface RestartConsentDeps {
  readonly service: ClientActor;
  readonly drawMode: () => void;
}

export async function waitForRestartConsent(
  mismatch: ProtocolMismatch,
  phase: 'boot' | 'tui',
  deps: RestartConsentDeps,
): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return false;
  }

  const lines = [
    `atc: the daemon (pid ${mismatch.daemonPID}) speaks another protocol than this client, ${mismatch.clientBuild} on protocol v${mismatch.clientProtocol}.`,
    `The daemon answered: ${mismatch.daemonMessage}`,
    'Restart it now? Every session it hosts ends, then the fleet is restored on the new daemon. [y/N] ',
  ];

  if (phase === 'tui') {
    const prompt = lines.join('\r\n');

    process.stdout.write(ansi.clear + prompt);

    const key = await new Promise<string>((resolve) => {
      deps.service.send({ type: 'CONSENT_ASKED', consent: { prompt, answer: resolve } });
    });

    // The mode under the prompt may have changed while the reconnect
    // waited, so the screen it owns is drawn again rather than left blank.
    process.stdout.write(ansi.clear);
    deps.drawMode();

    return key === 'y' || key === 'Y';
  }

  process.stderr.write(lines.join('\n'));
  process.stdin.setRawMode(true);
  process.stdin.resume();

  const key = await new Promise<string>((resolve) => {
    process.stdin.once('data', (buf: Buffer) => {
      resolve(buf.toString());
    });
  });

  process.stdin.setRawMode(false);
  process.stdin.pause();

  const confirmed = key === 'y' || key === 'Y';
  const echo = confirmed ? 'y\n' : 'n\n';

  process.stderr.write(echo);

  return confirmed;
}
