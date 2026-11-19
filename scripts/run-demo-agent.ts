// The demo recording's stand-in agent: real hook reports, `atc tap` and
// `atc mcp`, and no model usage. Its spawn prompt picks the part it plays,
// and the header of docs/assets/demo.tape gives the script.
import { existsSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

type MCPClient = ReturnType<typeof createMCPClient>;

const TAP_SENDER_SCHEMA = z.object({
  kind: z.string(),
  session: z.string().optional(),
});

const TAP_MESSAGE_SCHEMA = z.object({
  id: z.string(),
  from: z.string(),
  sender: TAP_SENDER_SCHEMA.optional(),
  text: z.string(),
});

type TapMessage = z.output<typeof TAP_MESSAGE_SCHEMA>;

const JSON_RPC_REPLY_SCHEMA = z.object({ id: z.number(), result: z.unknown().optional() });

const TOOL_RESULT_SCHEMA = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.unknown().optional(),
});

const SESSION_ROW_SCHEMA = z.object({ id: z.string(), name: z.string() });
const SESSIONS_SCHEMA = z.object({ sessions: z.array(SESSION_ROW_SCHEMA) });

// The line the viewer types into the orchestrator: which part to build, on
// which daemon, and which builder coordinates with it.
const ORCHESTRATOR_ASK =
  /builder for the (?<part>\w+) on the (?<daemon>\w+) box and tell (?<peer>[\w-]+) to coordinate/iu;

const BUILDER_UI_PROMPT = /^Build the orders UI, and ask (?<peer>[\w-]+) /u;

// Narrower than any pane the tape opens, and than the spawn width.
const RULE_COLUMNS = 88;
const BUILDER_UI_QUESTION = 'What does the orders endpoint return?';
const prompt = process.argv.slice(2).at(-1) ?? '';
const sessionID = process.env['ATC_SESSION_ID'] ?? '';
const log: string[] = [];

// The orchestrator's input box, or null while the stand-in draws none.
let input: string | null = null;

// A resize redraws from a cleared screen, since the old size may have
// wrapped a full-width line.
process.on('SIGWINCH', () => {
  process.stdout.write('\u001B[2J');

  writeScreen();
});

writeScreen();

await writeHookEvent({ hook_event_name: 'SessionStart' });

writeUserLine(prompt);

await writeHookEvent({ hook_event_name: 'UserPromptSubmit', prompt });

// The inbox stays open for as long as the session runs, beside the part.
await Promise.all([readInbox(), runPart()]);

async function runPart(): Promise<void> {
  if (prompt.startsWith('Plan the orders release')) {
    await runOrchestrator();
  } else if (prompt.startsWith('Build the orders API')) {
    writeReply('Added the orders table and its migration.');
    writeReply('Added GET /orders and POST /orders.');
    writeLine('\u001B[38;5;173m✻\u001B[0m Writing the order status endpoint…');
  } else if (prompt.startsWith('Write the upgrade notes')) {
    await finishTurn('Wrote docs/upgrade-2.0.md.');
  } else {
    const peer = BUILDER_UI_PROMPT.exec(prompt)?.groups?.['peer'];

    if (peer !== undefined) {
      await runBuilderUI(peer);
    }
  }
}

// The orchestrator finished its planning turn before the recording starts,
// and then waits at its input box for the line the viewer types.
async function runOrchestrator(): Promise<void> {
  await finishTurn('The release needs the orders API and its UI. builder-api has the API.');

  input = '';

  writeScreen();

  process.stdin.setRawMode(true);

  for await (const chunk of process.stdin) {
    for (const key of String(chunk)) {
      if (key === '\r') {
        const line = input;

        input = '';

        writeUserLine(line);

        await runOrchestratorLine(line);
      } else if (key === '\u007F') {
        input = input.slice(0, -1);
      } else if (key >= ' ') {
        input += key;
      }

      writeScreen();
    }
  }
}

async function runOrchestratorLine(line: string): Promise<void> {
  await writeHookEvent({ hook_event_name: 'UserPromptSubmit', prompt: line });

  const ask = ORCHESTRATOR_ASK.exec(line);

  if (ask === null) {
    await finishTurn('The demo orchestrator only starts builders.');

    return;
  }

  const part = ask.groups?.['part'] ?? '';
  const daemon = ask.groups?.['daemon'] ?? '';
  const peer = ask.groups?.['peer'] ?? '';
  const name = `builder-${part.toLowerCase()}`;

  const mcp = await openMCPClient(daemon);

  const spawned = await mcp.callTool('atc_session_spawn', {
    cwd: process.cwd(),
    name,
    prompt: `Build the orders UI, and ask ${peer} what the API returns.`,
  });

  const spawnReply =
    spawned === null ? `✗ The spawn of ${name} failed.` : `Spawned ${daemon} ${name}`;

  writeReply(spawnReply);

  const peerID = await readSessionID(mcp, peer);

  const sent =
    peerID === null
      ? null
      : await mcp.callTool('atc_message_send', {
          session: peerID,
          text: `${name} is building the orders UI on this box. Agree the orders endpoint with it.`,
        });

  const sendReply = sent === null ? `✗ The message to ${peer} failed.` : `Messaged ${peer}`;

  writeReply(sendReply);

  mcp.stop();

  await finishTurn(`Started ${name} and messaged ${peer}.`);
}

// builder-ui asks builder-api its question once the recording has left
// builder-api's pane, so the orchestrator's message stays the newest thing
// there. The recording drops a cue file to say so.
async function runBuilderUI(peer: string): Promise<void> {
  writeReply('Read the orders page mockup.');

  await waitForCue();

  const mcp = await openMCPClient(null);
  const peerID = await readSessionID(mcp, peer);

  const sent =
    peerID === null
      ? null
      : await mcp.callTool('atc_message_send', { session: peerID, text: BUILDER_UI_QUESTION });

  mcp.stop();

  const reply =
    sent === null ? `✗ The message to ${peer} failed.` : `Messaged ${peer}: ${BUILDER_UI_QUESTION}`;

  writeReply(reply);
}

// The bridge hands each message to Claude Code as a prompt in this
// envelope, and Claude Code shows it as the user's turn.
async function readInbox(): Promise<void> {
  const tap = Bun.spawn(['atc', 'tap', '--session', sessionID], { stdout: 'pipe' });

  for await (const line of readLines(tap.stdout)) {
    const parsed = TAP_MESSAGE_SCHEMA.safeParse(parseJSON(line));

    if (parsed.success) {
      writeUserLine(renderEnvelope(parsed.data));
    }
  }
}

// A copy of renderEnvelope in mods/atc-bridge/hooks/register.ts.
function renderEnvelope(message: TapMessage): string {
  const body = message.text.replaceAll('</atc-message>', '&lt;/atc-message&gt;');

  const session =
    message.sender?.session === undefined
      ? ''
      : ` session="${encodeAttribute(message.sender.session)}"`;

  const sender = message.sender === undefined ? '' : ` kind="${message.sender.kind}"${session}`;

  return `<atc-message id="${encodeAttribute(message.id)}" from="${encodeAttribute(message.from)}"${sender}>\n${body}\n</atc-message>`;
}

function encodeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

async function waitForCue(): Promise<void> {
  const folder = process.env['DEMO_CUES'] ?? '';
  const cue = join(folder, sessionID);
  const cued = Promise.withResolvers<void>();

  const watcher = watch(folder, () => {
    if (existsSync(cue)) {
      cued.resolve();
    }
  });

  if (existsSync(cue)) {
    cued.resolve();
  }

  await cued.promise;

  watcher.close();
}

async function readSessionID(mcp: MCPClient, name: string): Promise<string | null> {
  const result = await mcp.callTool('atc_sessions_list', {});

  const listed = SESSIONS_SCHEMA.safeParse(result);

  return listed.data?.sessions.find((x) => x.name === name)?.id ?? null;
}

async function finishTurn(reply: string): Promise<void> {
  writeReply(reply);

  await writeHookEvent({ hook_event_name: 'Stop', last_assistant_message: reply });
}

function writeUserLine(text: string): void {
  const [first = '', ...rest] = text.split('\n');

  log.push('', `\u001B[2m>\u001B[0m ${first}`, ...rest.map((x) => `  ${x}`));

  writeScreen();
}

function writeReply(text: string): void {
  writeLine(`⏺ ${text}`);
}

function writeLine(text: string): void {
  log.push('', text);

  writeScreen();
}

// `atc mcp` over stdio, one JSON-RPC message per line, as an agent CLI runs
// it, on this session's daemon or on a named one. It reads ATC_SESSION_ID,
// so a spawn on this session's own daemon is a sub-session of this one.
async function openMCPClient(daemon: string | null): Promise<MCPClient> {
  const client = createMCPClient(daemon);

  await client.sendRequest('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'atc-demo-agent', version: '1.0.0' },
  });

  return client;
}

function createMCPClient(daemon: string | null) {
  const command = daemon === null ? ['atc', 'mcp'] : ['atc', 'mcp', '--daemon', daemon];
  const server = Bun.spawn(command, { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });

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

  // A failed call returns null, and the stand-in shows the failure on screen.
  const callTool = async (name: string, args: object): Promise<unknown> => {
    const reply = await sendRequest('tools/call', { name, arguments: args });

    const result = TOOL_RESULT_SCHEMA.safeParse(reply);

    return result.success && result.data.isError !== true
      ? (result.data.structuredContent ?? null)
      : null;
  };

  const stop = () => {
    void server.stdin.end();
    server.kill();
  };

  return { sendRequest, callTool, stop };
}

async function writeHookEvent(event: object): Promise<void> {
  const reporter = Bun.spawn(['atc', 'hook-report', '--agent', 'claude'], { stdin: 'pipe' });

  void reporter.stdin.write(
    JSON.stringify({ session_id: `demo-${sessionID}`, transcript_path: '/dev/null', ...event }),
  );

  void reporter.stdin.end();

  await reporter.exited;
}

// Each redraw writes over the last one line by line, so no frame catches a
// cleared screen. The input box's rules stop short of the spawn width, so
// the first frame after an attach, drawn before the resize, never wraps.
function writeScreen(): void {
  // The recording sets DEMO_HOME on both daemons, so a cloud session shows
  // its path from the same home the list does.
  const where = process.cwd().replace(process.env['DEMO_HOME'] ?? homedir(), '~');
  const width = Math.min(process.stdout.columns ?? RULE_COLUMNS, RULE_COLUMNS);
  const rule = `\u001B[2m${'─'.repeat(width)}\u001B[0m`;
  const box = input === null ? [] : ['', rule, `\u001B[2m>\u001B[0m ${input}`, rule];

  const lines = [
    `\u001B[38;5;173m✻\u001B[0m \u001B[1mdemo agent\u001B[0m  \u001B[2m${where}\u001B[0m`,
    ...log,
    ...box,
  ];

  // The cursor shows only in the input box, after what the viewer typed.
  const cursor =
    input === null ? '\u001B[?25l' : `\u001B[${lines.length - 1};${input.length + 3}H\u001B[?25h`;

  process.stdout.write(`\u001B[H${lines.map((x) => `${x}\u001B[K`).join('\r\n')}\u001B[J${cursor}`);
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
