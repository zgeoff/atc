import { bootDaemonClient } from './boot-daemon';
import { DaemonError } from './daemon-error';
import { isRecord } from './report';

// The slice of the daemon client the tool handlers need.
interface FleetCaller {
  readonly sendRequest: (
    m: string,
    p?: Readonly<Record<string, unknown>>,
  ) => Promise<Readonly<Record<string, unknown>>>;
}

const PROTOCOL_FALLBACK = '2025-06-18';

interface MCPTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

const NO_INPUT: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

const SESSION_INPUT: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    session: { type: 'string', description: 'The atc session id, from atc_session_list' },
  },
  required: ['session'],
  additionalProperties: false,
};

const TOOLS: readonly MCPTool[] = [
  {
    name: 'atc_session_list',
    description:
      'List every session the atc daemon hosts: id, name, working directory, state (running, needs_you, done, exited), unread flag, and last activity.',
    inputSchema: NO_INPUT,
  },
  {
    name: 'atc_session_spawn',
    description:
      'Spawn a new Claude Code session in a directory. Returns the new session descriptor. Give it a prompt to start it working immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Absolute path of the working directory' },
        name: { type: 'string', description: 'Session name; defaults to the directory basename' },
        prompt: { type: 'string', description: 'First message for the session' },
      },
      required: ['cwd'],
      additionalProperties: false,
    },
  },
  {
    name: 'atc_session_input',
    description:
      'Type a line of text into a running session, as if the operator typed it and pressed enter. Use it to answer a session that is waiting on input.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'The atc session id' },
        text: { type: 'string', description: 'The line to type; a newline is appended' },
      },
      required: ['session', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'atc_session_update',
    description:
      'Rename and/or pin a session. Renames stick against auto-summaries; pinned sessions lead every list. Use this to organise the fleet: name sessions after their task.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'The atc session id' },
        name: { type: 'string', description: 'New display name; omit to keep' },
        pinned: { type: 'boolean', description: 'Pin or unpin; omit to keep' },
      },
      required: ['session'],
      additionalProperties: false,
    },
  },
  {
    name: 'atc_session_kill',
    description: 'Kill a session. A second kill on a dead session removes it from the list.',
    inputSchema: SESSION_INPUT,
  },
  {
    name: 'atc_session_ack',
    description: 'Clear a session unread flag without attaching to it.',
    inputSchema: SESSION_INPUT,
  },
  {
    name: 'atc_resume_command',
    description:
      'Build the shell command that reopens a session outside atc (cd into its directory and claude --resume its id).',
    inputSchema: SESSION_INPUT,
  },
  {
    name: 'atc_dirs_list',
    description: 'List directories sessions were previously spawned from, most recent first.',
    inputSchema: NO_INPUT,
  },
];

/**
 * An MCP server over stdio bridging to the atc daemon: any MCP client —
 * including a wrangled session — can list, spawn, and drive the fleet.
 * stdout carries only JSON-RPC lines; the daemon is booted on demand.
 */
export async function runMCPServer(build: string): Promise<void> {
  const boot = await bootDaemonClient();

  const client = boot.client;

  const decoder = new TextDecoder('utf-8');

  let buffer = '';

  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });

    const lines = buffer.split('\n');

    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.trim() === '') {
        continue;
      }

      await applyRPCLine(client, build, line);
    }
  }

  client.stop();
}

async function applyRPCLine(client: FleetCaller, build: string, line: string): Promise<void> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }

  if (!isRecord(parsed) || typeof parsed['method'] !== 'string') {
    return;
  }

  const method = parsed['method'];
  const id = parsed['id'];
  const params = isRecord(parsed['params']) ? parsed['params'] : {};

  // Notifications carry no id and get no response.
  if (id === undefined || id === null) {
    return;
  }

  if (typeof id !== 'string' && typeof id !== 'number') {
    return;
  }

  switch (method) {
    case 'initialize': {
      const requested = params['protocolVersion'];

      sendResult(id, {
        protocolVersion: typeof requested === 'string' ? requested : PROTOCOL_FALLBACK,
        capabilities: { tools: {} },
        serverInfo: { name: 'atc', version: build },
      });

      return;
    }
    case 'ping': {
      sendResult(id, {});

      return;
    }
    case 'tools/list': {
      sendResult(id, { tools: TOOLS });

      return;
    }
    case 'tools/call': {
      await applyToolCall(client, id, params);

      return;
    }
    default: {
      sendError(id, -32_601, `unknown method '${method}'`);
    }
  }
}

async function applyToolCall(
  client: FleetCaller,
  id: string | number,
  params: Readonly<Record<string, unknown>>,
): Promise<void> {
  const name = typeof params['name'] === 'string' ? params['name'] : '';
  const args = isRecord(params['arguments']) ? params['arguments'] : {};

  try {
    const text = await runTool(client, name, args);

    sendResult(id, { content: [{ type: 'text', text }] });
  } catch (error) {
    let msg = String(error);

    if (error instanceof DaemonError) {
      msg = `${error.code}: ${error.message}`;
    } else if (error instanceof Error) {
      msg = error.message;
    }

    sendResult(id, { content: [{ type: 'text', text: msg }], isError: true });
  }
}

async function runTool(
  client: FleetCaller,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<string> {
  switch (name) {
    case 'atc_session_list': {
      const ok = await client.sendRequest('session.list');

      return JSON.stringify(ok['sessions'], null, 2);
    }
    case 'atc_session_spawn': {
      const ok = await client.sendRequest('session.spawn', {
        cwd: args['cwd'],
        ...(typeof args['name'] === 'string' ? { name: args['name'] } : {}),
        ...(typeof args['prompt'] === 'string' ? { prompt: args['prompt'] } : {}),
        cols: 100,
        rows: 30,
      });

      return JSON.stringify(ok['session'], null, 2);
    }
    case 'atc_session_input': {
      await client.sendRequest('session.input', {
        session: args['session'],
        d: `${typeof args['text'] === 'string' ? args['text'] : ''}\n`,
      });

      return 'sent';
    }
    case 'atc_session_update': {
      await client.sendRequest('session.update', {
        session: args['session'],
        ...(typeof args['name'] === 'string' ? { name: args['name'] } : {}),
        ...(typeof args['pinned'] === 'boolean' ? { pinned: args['pinned'] } : {}),
      });

      return 'updated';
    }
    case 'atc_session_kill': {
      await client.sendRequest('session.kill', { session: args['session'] });

      return 'killed';
    }
    case 'atc_session_ack': {
      await client.sendRequest('session.ack', { session: args['session'] });

      return 'acked';
    }
    case 'atc_resume_command': {
      const ok = await client.sendRequest('session.resumeCommand', { session: args['session'] });

      return typeof ok['command'] === 'string' ? ok['command'] : JSON.stringify(ok);
    }
    case 'atc_dirs_list': {
      const ok = await client.sendRequest('dirs.list');

      return JSON.stringify(ok['dirs'], null, 2);
    }
    default: {
      throw new Error(`unknown tool '${name}'`);
    }
  }
}

function sendResult(id: string | number, result: Readonly<Record<string, unknown>>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function sendError(id: string | number, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}
