import type { AgentSessionID } from '../shared/agent-session-id';
import { socketPath } from '../shared/config';
import { isCompiledBinary } from '../shared/is-compiled-binary';
import { isRecord } from '../shared/report';
import type { SessionID } from '../shared/session-id';
import { buildHeadlessEnv } from './build-headless-env';
import { resolveHeadlessExecutable } from './resolve-headless-executable';
import { truncateSummary } from './truncate-summary';

const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'auto',
  'dontAsk',
] as const;

interface HeadlessRunOptions {
  readonly claudeBin: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly resume?: AgentSessionID;
  readonly permissionMode?: string;
  readonly settings?: string;
  readonly sessionID?: SessionID;
  readonly pluginDir?: string;
}

interface HeadlessRunHooks {
  readonly onOutput: (text: string) => void;
  readonly onDone: (summary: string) => void;
  readonly onNeedsYou: (msg: string) => void;
}

interface HeadlessRunHandle {
  readonly stop: () => void;
}

/**
 * Runs one headless Agent SDK turn over a session, rendering its structured
 * messages as plain lines into the session's output pipe. The run ends in
 * done (with the turn's whole result) or needs_you (errors, turn limits,
 * anything a human must look at).
 */
export function startHeadlessRun(
  opts: HeadlessRunOptions,
  hooks: HeadlessRunHooks,
): HeadlessRunHandle {
  const controller = new AbortController();

  void (async () => {
    try {
      const mode = PERMISSION_MODES.find((m) => m === opts.permissionMode);
      let stderrTail = '';

      // The SDK is the heaviest module in the daemon's graph, and only a
      // headless turn needs it, so loading it here keeps it off the daemon's
      // cold start.
      const sdk = await import('@anthropic-ai/claude-agent-sdk');

      const stream = sdk.query({
        prompt: opts.prompt,
        options: {
          cwd: opts.cwd,
          env: buildHeadlessEnv({
            socketPath,
            ...(opts.pluginDir === undefined ? {} : { pluginDir: opts.pluginDir }),
            ...(opts.sessionID === undefined ? {} : { sessionID: opts.sessionID }),
          }),
          abortController: controller,
          stderr: (data: string) => {
            stderrTail = `${stderrTail}${data}`.slice(-2000);
          },
          ...(opts.resume === undefined ? {} : { resume: opts.resume }),
          ...(mode === undefined ? {} : { permissionMode: mode }),

          // The same generated file the terminal spawn passes, so the turn
          // runs against the session's own backend and instrumentation.
          ...(opts.settings === undefined ? {} : { extraArgs: { settings: opts.settings } }),
          ...resolveHeadlessExecutable(opts.claudeBin, isCompiledBinary()),
        },
      });

      for await (const message of stream) {
        const rendered = renderSdkMessage(message);

        if (rendered !== null) {
          hooks.onOutput(`${rendered}\r\n`);
        }

        if (message.type !== 'result') {
          continue;
        }

        if (message.subtype === 'success') {
          hooks.onDone(message.result);
          continue;
        }

        if (stderrTail.trim() !== '') {
          hooks.onOutput(`headless stderr: ${stderrTail.trim()}\r\n`);
        }

        hooks.onNeedsYou(`headless run stopped: ${message.subtype}`);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const msg = error instanceof Error ? error.message : String(error);

        hooks.onOutput(`headless run failed: ${msg}\r\n`);
        hooks.onNeedsYou(`headless run failed: ${truncateSummary(msg)}`);
      }
    }
  })();

  return {
    stop() {
      controller.abort();
    },
  };
}

interface RenderableMessage {
  readonly type: string;
  readonly subtype?: string;
  readonly result?: string;
  readonly message?: unknown;
}

/**
 * One structured SDK message → zero or one plain-text line for the session's
 * output pipe: assistant text verbatim, tool calls as compact one-liners,
 * results as a closing line.
 */
export function renderSdkMessage(message: RenderableMessage): string | null {
  if (message.type === 'assistant') {
    const inner = message.message;

    if (!isRecord(inner) || !Array.isArray(inner['content'])) {
      return null;
    }

    const content = inner['content'];
    const lines: string[] = [];

    for (const raw of content) {
      const block: unknown = raw;

      if (!isRecord(block)) {
        continue;
      }

      if (
        block['type'] === 'text' &&
        typeof block['text'] === 'string' &&
        block['text'].trim() !== ''
      ) {
        lines.push(block['text'].replaceAll('\n', '\r\n'));
      }

      if (block['type'] === 'tool_use' && typeof block['name'] === 'string') {
        lines.push(`⚙ ${block['name']} ${truncateSummary(JSON.stringify(block['input'] ?? {}))}`);
      }
    }

    return lines.length === 0 ? null : lines.join('\r\n');
  }

  if (message.type === 'result') {
    return message.subtype === 'success'
      ? `— headless turn done: ${truncateSummary(message.result ?? '')}`
      : `— headless turn stopped: ${message.subtype ?? 'unknown'}`;
  }

  return null;
}
