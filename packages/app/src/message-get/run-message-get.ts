import invariant from 'tiny-invariant';
import { formatCommandOutcome } from '../cli/format-command-outcome';
import { pickSendFailure } from '../send/pick-send-failure';
import type { SendDependencies } from '../send/run-send';
import type { CommandOutcome, ConnectTarget, MessageGetRequest } from '../send/types';
import { waitForMessage } from '../send/wait-for-message';
import { buildFailureOutcome, buildReadOutcome } from './build-read-outcome';
import type { OutcomeBase } from './build-read-outcome';

// Resolves to the exit status.
export async function runMessageGet(
  request: Readonly<MessageGetRequest>,
  dependencies: Readonly<Pick<SendDependencies, 'connect' | 'clock' | 'io'>>,
): Promise<number> {
  const base: OutcomeBase = { key: null, session: null, message: request.message };
  const target = buildConnectTarget(request);

  const connected = await dependencies.connect(target);

  let outcome: CommandOutcome;

  if (connected.ok) {
    const connection = connected.connection;

    try {
      const read = await waitForMessage({
        connection,
        clock: dependencies.clock,
        message: request.message,
        timeoutSeconds: request.wait ? request.timeoutSeconds : null,
      });

      outcome = buildReadOutcome(base, read.view, read.timedOut);
    } catch (error) {
      const picked = pickSendFailure(error, {
        stage: 'wait',
        closed: connection.isClosed(),
        remote: request.daemon !== null,
      });

      invariant(picked.kind === 'ended');

      outcome = buildFailureOutcome(base, picked.exitCode, picked.error);
    } finally {
      connection.stop();
    }
  } else {
    const exitCode = connected.error.code === 'unreachable' ? 4 : 1;

    outcome = buildFailureOutcome(base, exitCode, connected.error);
  }

  const output = formatCommandOutcome(outcome, { command: 'message get', json: request.json });

  if (output.stdout !== null) {
    dependencies.io.print(output.stdout);
  }

  if (output.stderr !== null) {
    dependencies.io.printError(output.stderr);
  }

  return outcome.exitCode;
}

function buildConnectTarget(request: Readonly<MessageGetRequest>): ConnectTarget {
  if (request.daemon !== null) {
    return { kind: 'remote', name: request.daemon };
  }

  return { kind: 'local', owner: false };
}
