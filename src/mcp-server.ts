import { bootDaemonClient } from './client/boot-daemon';
import { answerRPCRequest } from './mcp/answer-rpc-request';
import type { FleetCaller, ToolContext } from './mcp/types';

/**
 * An MCP server over stdio bridging to the atc daemon: any MCP client —
 * including a wrangled session — can list, spawn, and drive the fleet.
 * stdout carries only JSON-RPC lines; the daemon is booted on demand.
 */
export async function runMCPServer(build: string): Promise<void> {
  const boot = await bootDaemonClient();

  const client = boot.client;

  // The server inherits the calling session's id from its environment, so a
  // spawn from inside a session nests under it by default.
  const inherited = process.env['ATC_SESSION_ID'];
  const callerSessionID = inherited === undefined || inherited === '' ? null : inherited;
  const toolContext: ToolContext = { callerSessionID, defaultFrom: callerSessionID ?? 'mcp' };

  const decoder = new TextDecoder('utf-8');

  let buffer = '';

  // Each request runs on its own, so a long poll never holds up the others;
  // responses carry their request's id.
  const inFlight = new Set<Promise<void>>();

  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });

    const lines = buffer.split('\n');

    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.trim() === '') {
        continue;
      }

      const finished = Promise.withResolvers<void>();

      inFlight.add(finished.promise);

      void (async () => {
        try {
          await answerRPCLine(client, build, toolContext, line);
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

  client.stop();
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
