import { isCompiledBinary } from '@atc/config/host';
import { truncateSummary } from '@atc/core';
import type { HeadlessRunEvents, HeadlessRunHandle } from '@atc/plugin-api';
import { buildClaudeQueryOptions } from './build-claude-query-options';
import type { ClaudeHeadlessRunRequest } from './build-claude-query-options';
import { renderSDKMessage } from './render-sdk-message';

/**
 * Runs one headless Agent SDK turn over a session, rendering its structured
 * messages as plain lines into the session's output pipe. The run ends in
 * done (with the turn's whole result) or needs_you (errors, turn limits,
 * anything a human must look at).
 */
export function startClaudeHeadlessRun(
  opts: ClaudeHeadlessRunRequest,
  events: HeadlessRunEvents,
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
          events.onOutput(`${rendered}\r\n`);
        }

        if (message.type !== 'result') {
          continue;
        }

        if (message.subtype === 'success') {
          events.onDone(message.result);
          continue;
        }

        if (stderrTail.trim() !== '') {
          events.onOutput(`headless stderr: ${stderrTail.trim()}\r\n`);
        }

        events.onNeedsYou(`headless run stopped: ${message.subtype}`);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const msg = error instanceof Error ? error.message : String(error);

        events.onOutput(`headless run failed: ${msg}\r\n`);
        events.onNeedsYou(`headless run failed: ${truncateSummary(msg)}`);
      }
    }
  })();

  return {
    stop() {
      controller.abort();
    },
  };
}
