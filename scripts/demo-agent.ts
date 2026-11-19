// The stand-in agent of the demo recording: it reports through the real hook
// reporter, reads its inbox through `atc tap`, and spends no model usage.
// The header of docs/assets/demo.tape lists the messages it acts on.
import { homedir } from 'node:os';
import { z } from 'zod';

const TAP_LINE_SCHEMA = z.object({ text: z.string() });
const JSON_RPC_REPLY_SCHEMA = z.object({ id: z.number(), result: z.unknown().optional() });
const TOOL_RESULT_SCHEMA = z.object({ isError: z.boolean().optional() });
const prompt = process.argv.at(-1) ?? '';
const sessionID = process.env['ATC_SESSION_ID'] ?? '';
const log: string[] = [];

process.on('SIGWINCH', writeScreen);

writeScreen();

await writeHookEvent({
  hook_event_name: 'SessionStart',
  session_id: `demo-${sessionID}`,
  transcript_path: '/dev/null',
});

await readInbox();

// Each message gets a line on screen before the stand-in acts on it, so an
// attached viewer sees why the session moved.
async function readInbox(): Promise<void> {
  const tap = Bun.spawn(['atc', 'tap', '--session', sessionID], { stdout: 'pipe' });

  for await (const line of readLines(tap.stdout)) {
    const parsed = TAP_LINE_SCHEMA.safeParse(parseJSON(line));

    if (!parsed.success) {
      continue;
    }

    const text = parsed.data.text;

    log.push(`\u001B[2m← ${text}\u001B[0m`);

    writeScreen();

    if (text.startsWith('start builders:')) {
      await runBuilders(text.slice('start builders:'.length).split(','));
    } else if (text.startsWith('ask:')) {
      await runQuestion(text.slice('ask:'.length).trim());
    }
  }
}

async function runBuilders(parts: readonly string[]): Promise<void> {
  const mcp = createMCPClient();

  await mcp.sendRequest('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'atc-demo-agent', version: '1.0.0' },
  });

  for (const part of parts.map((x) => x.trim()).filter((x) => x !== '')) {
    const name = `builder-${part}`;

    const result = await mcp.sendRequest('tools/call', {
      name: 'atc_session_spawn',
      arguments: { cwd: process.cwd(), name, prompt: `build the ${part} for 2.0` },
    });

    const failed = TOOL_RESULT_SCHEMA.safeParse(result).data?.isError === true;

    const line = failed
      ? `✗ ${name}: ${JSON.stringify(result)}`
      : `\u001B[32m✓\u001B[0m started ${name}`;

    log.push(line);

    writeScreen();
  }

  mcp.stop();
}

async function runQuestion(question: string): Promise<void> {
  log.push('', `\u001B[1m${question}\u001B[0m`, '  1. Yes', '  2. No');

  writeScreen();

  await writeHookEvent({
    hook_event_name: 'Notification',
    session_id: `demo-${sessionID}`,
    message: question,
  });
}

// `atc mcp` over stdio, one JSON-RPC message per line, as an agent CLI runs
// it. It reads ATC_SESSION_ID, so each spawn is a sub-session of this one.
function createMCPClient() {
  const server = Bun.spawn(['atc', 'mcp'], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });

  const pending = new Map<number, PromiseWithResolvers<unknown>>();

  let nextID = 0;

  void (async () => {
    for await (const line of readLines(server.stdout)) {
      const reply = JSON_RPC_REPLY_SCHEMA.safeParse(parseJSON(line));

      if (reply.success) {
        pending.get(reply.data.id)?.resolve(reply.data.result);
      }
    }
  })();

  const sendRequest = (method: string, params: object): Promise<unknown> => {
    nextID += 1;

    const response = Promise.withResolvers<unknown>();

    pending.set(nextID, response);
    void server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: nextID, method, params })}\n`);
    void server.stdin.flush();

    return response.promise;
  };

  const stop = () => {
    void server.stdin.end();
    server.kill();
  };

  return { sendRequest, stop };
}

async function writeHookEvent(event: object): Promise<void> {
  const reporter = Bun.spawn(['atc', 'hook-report', '--agent', 'claude'], { stdin: 'pipe' });

  void reporter.stdin.write(JSON.stringify(event));
  void reporter.stdin.end();

  await reporter.exited;
}

function writeScreen(): void {
  // The recording sets DEMO_HOME on both daemons, so a cloud session shows
  // its path from the same home the list does.
  const where = process.cwd().replace(process.env['DEMO_HOME'] ?? homedir(), '~');

  process.stdout.write(
    [
      '\u001B[2J\u001B[H',
      `\u001B[38;5;173m✻\u001B[0m \u001B[1mdemo agent\u001B[0m  \u001B[2m${where}\u001B[0m`,
      '',
      `\u001B[2m>\u001B[0m ${prompt}`,
      '',
      ...log,
    ].join('\r\n'),
  );
}

async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();

  let buffered = '';

  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });

    const lines = buffered.split('\n');

    buffered = lines.pop() ?? '';
    yield* lines;
  }
}

function parseJSON(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
