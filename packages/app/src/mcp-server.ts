import type { DaemonBoot } from '@atc/protocol';
import { openDaemonClient } from '@atc/protocol/client';
import { readSessionEnv } from '@atc/protocol/session';
import { LineDecoder } from '@atc/protocol/wire';
import { answerRPCRequest } from './mcp/answer-rpc-request';
import { TransportCaller } from './mcp/transport-caller';
import type { FleetCaller, ToolContext } from './mcp/types';

export async function runMCPServer(
  build: string,
  bootDaemon: () => Promise<DaemonBoot>,
): Promise<void> {
  const boot = await bootDaemon();

  boot.client.stop();

  // a spawn from inside a session nests under it by default, and each
  // connection's handshake claims that session for the answers to the
  // messages it sends
  const callerSessionID = readSessionEnv(process.env).sessionID ?? null;

  const caller = new TransportCaller(
    boot.socketPath,
    build,
    (path) => openDaemonClient(path),
    callerSessionID,
  );

  const toolContext: ToolContext = { callerSessionID };

  const decoder = new LineDecoder();

  // Each request runs on its own, so a long poll never holds up the others;
  // responses carry their request's id.
  const inFlight = new Set<Promise<void>>();

  for await (const chunk of Bun.stdin.stream()) {
    for (const line of decoder.splitChunk(chunk)) {
      const finished = Promise.withResolvers<void>();

      inFlight.add(finished.promise);

      void (async () => {
        try {
          await answerRPCLine(caller, build, toolContext, line);
        } catch {
          // A failed line gets no response, the way a malformed one gets none.
        } finally {
          inFlight.delete(finished.promise);
          finished.resolve();
        }
      })();
    }
  }

  await Promise.all(inFlight);
  await caller.stop();
}

async function answerRPCLine(
  caller: FleetCaller,
  build: string,
  toolContext: ToolContext,
  line: string,
): Promise<void> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }

  const outcome = await answerRPCRequest(parsed, { caller, build, toolContext });

  if (outcome.kind === 'reply') {
    // stdout carries only JSON-RPC lines
    process.stdout.write(`${JSON.stringify(outcome.body)}\n`);
  }
}
