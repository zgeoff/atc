import { isRecord } from '@atc/core';
import { readSourceEntry } from '@atc/core/test-utils/read-source-entry';
import { registerTestCleanup } from '@atc/core/test-utils/register-test-cleanup';
import { buildMCPToolCalls } from '@atc/mcp/test-utils/build-mcp-tool-calls';

interface MCPStdioOptions {
  readonly home: string;

  readonly callerSessionID?: string;

  readonly command?: readonly string[];
}

export async function startMCPStdio(options: MCPStdioOptions) {
  const subprocess = Bun.spawn(
    [...(options.command ?? [process.execPath, readSourceEntry('atc'), 'mcp'])],
    {
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
    },
  );

  // Killing the server leaves the daemon it booted or joined running; the test home's cleanup
  // stops that daemon.
  const stop = registerTestCleanup(async (): Promise<void> => {
    void subprocess.stdin.end();
    subprocess.kill();

    await subprocess.exited;
  });

  const pending = new Map<number, PromiseWithResolvers<Readonly<Record<string, unknown>>>>();

  void readResponses(subprocess.stdout, pending);
  let nextID = 0;

  const sendRequest = (
    method: string,
    params?: object,
  ): Promise<Readonly<Record<string, unknown>>> => {
    nextID += 1;

    const id = nextID;
    const response = Promise.withResolvers<Readonly<Record<string, unknown>>>();

    pending.set(id, response);

    void subprocess.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`,
    );

    void subprocess.stdin.flush();

    return response.promise;
  };

  const server = { sendRequest, ...buildMCPToolCalls(sendRequest), stop };

  const initialized = await sendRequest('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'atc-test', version: '1.0.0' },
  }).catch(async (error: unknown) => {
    await stop();

    throw error;
  });

  if (!isRecord(initialized['result'])) {
    await stop();

    throw new Error(`atc mcp refused the initialize: ${JSON.stringify(initialized)}`);
  }

  return server;
}

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
