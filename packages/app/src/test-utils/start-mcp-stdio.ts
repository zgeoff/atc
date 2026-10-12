import { join } from 'node:path';
import { isRecord } from '../shared/report';
import { registerTestCleanup } from './register-test-cleanup';

const CLI_PATH = join(import.meta.dir, '..', 'cli.ts');

interface MCPStdioOptions {
  // The home the server runs with, as its `HOME` and `XDG_RUNTIME_DIR`.
  readonly home: string;

  // The session id the server sees itself running inside; absent means a
  // server started outside any session.
  readonly callerSessionID?: string;

  // A command that stands in for `atc mcp`; absent means this checkout's
  // `atc mcp`.
  readonly command?: readonly string[];
}

/**
 * One tool call's result as the server returned it: `isError` as sent,
 * `structured` as its `structuredContent`, and the text of its only content
 * item.
 */
interface MCPToolResult {
  readonly isError: unknown;
  readonly text: string;
  readonly structured: Readonly<Record<string, unknown>> | undefined;
}

/**
 * `atc mcp` from this checkout, run as a subprocess over stdio, with an
 * `initialize` already answered, so the daemon the server boots or joins is
 * up. `sendRequest` sends one JSON-RPC request under the next id and
 * resolves with its whole response. `sendToolCall` sends `tools/call` and
 * resolves with the result, rejecting when the response holds no result, the
 * result holds anything but one text item, or its structured content is not
 * an object. `spawnSession` spawns through `atc_session_spawn` and resolves
 * with the new session's id. A request still unanswered when the server's
 * stdout ends rejects. When `initialize` fails, the server is stopped
 * before the start rejects. The server stops once the current test
 * finishes, so it must run inside a test; `stop` stops it sooner and waits
 * for it to exit, and a second stop waits for the same exit. The daemon
 * stays up for the home to stop.
 */
export async function startMCPStdio(options: MCPStdioOptions) {
  const proc = Bun.spawn([...(options.command ?? [process.execPath, CLI_PATH, 'mcp'])], {
    env: {
      ...process.env,
      HOME: options.home,
      XDG_RUNTIME_DIR: options.home,
      PATH: '/usr/sbin:/usr/bin:/bin',
      ATC_SESSION_ID: options.callerSessionID ?? '',
      ATC_TAP_GRACE_MS: '0',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
  });

  const stop = registerTestCleanup(async (): Promise<void> => {
    void proc.stdin.end();
    proc.kill();

    await proc.exited;
  });

  const pending = new Map<number, PromiseWithResolvers<Readonly<Record<string, unknown>>>>();

  void readResponses(proc.stdout, pending);
  let nextID = 0;

  const sendRequest = (
    method: string,
    params?: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>> => {
    nextID += 1;

    const id = nextID;
    const response = Promise.withResolvers<Readonly<Record<string, unknown>>>();

    pending.set(id, response);

    void proc.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`,
    );

    void proc.stdin.flush();

    return response.promise;
  };

  const sendToolCall = async (
    name: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<MCPToolResult> => {
    const response = await sendRequest('tools/call', { name, arguments: args });

    return toToolResult(response);
  };

  const server = {
    sendRequest,
    sendToolCall,
    async spawnSession(args: Readonly<Record<string, unknown>>): Promise<string> {
      const spawned = await sendToolCall('atc_session_spawn', args);

      const id = spawned.structured?.['id'];

      if (typeof id !== 'string') {
        throw new TypeError(`spawn returned no session id: ${spawned.text}`);
      }

      return id;
    },
    stop,
  };

  // A failed initialize stops the server here, before the start rejects.
  await sendRequest('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'atc-test' },
  }).catch(async (error: unknown) => {
    await stop();

    throw error;
  });

  return server;
}

/**
 * Reads the server's stdout as JSON-RPC lines and resolves the pending
 * request each response's id matches. Once stdout ends, or holds a line that
 * is not JSON, every request not yet resolved rejects.
 */
async function readResponses(
  stdout: Readonly<ReadableStream<Uint8Array>>,
  pending: ReadonlyMap<number, PromiseWithResolvers<Readonly<Record<string, unknown>>>>,
): Promise<void> {
  const decoder = new TextDecoder('utf-8');

  let buffer = '';

  try {
    for await (const chunk of stdout) {
      buffer += decoder.decode(chunk, { stream: true });

      const lines = buffer.split('\n');

      buffer = lines.pop() ?? '';

      for (const line of lines.filter((candidate) => candidate.trim() !== '')) {
        const parsed: unknown = JSON.parse(line);
        const id = isRecord(parsed) ? parsed['id'] : undefined;
        const waiting = typeof id === 'number' ? pending.get(id) : undefined;

        if (isRecord(parsed) && waiting !== undefined) {
          waiting.resolve(parsed);
        }
      }
    }
  } catch {
    // A line that is not JSON ends the reading; the requests still pending
    // reject below.
  } finally {
    for (const [id, waiting] of pending) {
      waiting.reject(new Error(`atc mcp stopped answering before request ${id}`));
    }
  }
}

function toToolResult(response: Readonly<Record<string, unknown>>): MCPToolResult {
  const result = response['result'];
  const content = isRecord(result) ? result['content'] : undefined;
  const item: unknown = Array.isArray(content) && content.length === 1 ? content[0] : undefined;
  const structured = isRecord(result) ? result['structuredContent'] : undefined;

  if (
    !isRecord(result) ||
    !isRecord(item) ||
    typeof item['text'] !== 'string' ||
    (structured !== undefined && !isRecord(structured))
  ) {
    throw new TypeError(`tool call returned an unexpected result: ${JSON.stringify(response)}`);
  }

  return { isError: result['isError'], text: item['text'], structured };
}
