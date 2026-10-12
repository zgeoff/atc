import { isCompiledBinary } from '../shared/is-compiled-binary';
import { truncateSummary } from '../shared/truncate-summary';
import { buildClaudeQueryOptions } from './build-claude-query-options';
import type { ClaudeHeadlessRunRequest } from './build-claude-query-options';
import { renderSDKMessage } from './render-sdk-message';

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
export function startClaudeHeadlessRun(
  opts: ClaudeHeadlessRunRequest,
  hooks: HeadlessRunHooks,
): HeadlessRunHandle {
  const controller = new AbortController();

  void (async () => {
    try {
      let stderrTail = '';

      // The SDK is the heaviest module in the daemon's graph, and only a
      // headless turn needs it, so loading it here keeps it off the daemon's
      // cold start.
      const sdk = await import('@anthropic-ai/claude-agent-sdk');

      const stream = sdk.query({
        prompt: opts.prompt,
        options: {
          ...buildClaudeQueryOptions(opts, isCompiledBinary()),
          abortController: controller,
          stderr: (data: string) => {
            stderrTail = `${stderrTail}${data}`.slice(-2000);
          },
        },
      });

      for await (const message of stream) {
        const rendered = renderSDKMessage(message);

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
