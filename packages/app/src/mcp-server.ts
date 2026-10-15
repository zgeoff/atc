import type { DaemonBoot } from '@atc/protocol';
import { readSessionEnv } from '@atc/protocol/session';
import { DaemonClient, LineDecoder } from '@atc/protocol/wire';
import { answerRPCRequest } from './mcp/answer-rpc-request';
import { ReconnectingCaller } from './mcp/reconnecting-caller';
import type { FleetCaller, ToolContext } from './mcp/types';

/**
 * An MCP server over stdio bridging to the atc daemon: any MCP client —
 * including a wrangled session — can list, spawn, and drive the fleet.
 * stdout carries only JSON-RPC lines; the daemon is booted on demand,
 * through the boot the entry wires in. Once the daemon restarts, the next
 * request reconnects to the socket the boot reached, so the server outlives
 * the daemon it started against.
 */
export async function runMCPServer(
  build: string,
  bootDaemon: () => Promise<DaemonBoot>,
): Promise<void> {
  const boot = await bootDaemon();

  boot.client.stop();

  // The server inherits the calling session's id from its environment, so a
  // spawn from inside a session nests under it by default, and each
  // connection's handshake claims that session for the answers to the
  // messages it sends.
  const callerSessionID = readSessionEnv(process.env).sessionID ?? null;

  const caller = new ReconnectingCaller(
    boot.socketPath,
    build,
    (path) => DaemonClient.open(path),
    callerSessionID,
  );

  const toolContext: ToolContext = { callerSessionID, passesLegacyFrom: true };

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
    process.stdout.write(`${JSON.stringify(outcome.body)}\n`);
  }
}
