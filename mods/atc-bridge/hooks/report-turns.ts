import type { EngineInterface } from 'claude-code';
import { ATC_CLI } from './atc-cli.ts';
import { ATC_CWD, type BridgeState } from './bridge-state.ts';

export function scheduleAnsweredReport(
  $: EngineInterface,
  state: BridgeState,
  messageIDs: readonly string[],
  turnID: string,
  answer: string,
): void {
  state.reporting = state.reporting
    .then(async () => {
      await $.process.run(
        [...ATC_CLI, 'answer', '--messages', messageIDs.join(','), '--turn', turnID],
        {
          cwd: ATC_CWD,
          stdin: answer,
          timeoutMs: 5000,
        },
      );
    })
    .catch((error: unknown) => {
      $.ui.log(`atc-bridge: reporting ${messageIDs.join(', ')} failed (${String(error)})`, {
        to: 'debug',
      });
    });
}

export function scheduleUnansweredReport(
  $: EngineInterface,
  state: BridgeState,
  messageIDs: readonly string[],
  reason: string,
  turnID: string | null,
): void {
  state.reporting = state.reporting
    .then(async () => {
      await $.process.run(
        [
          ...ATC_CLI,
          'unanswered',
          '--messages',
          messageIDs.join(','),
          ...(turnID === null ? [] : ['--turn', turnID]),
          '--reason',
          reason,
        ],
        { cwd: ATC_CWD, timeoutMs: 5000 },
      );
    })
    .catch((error: unknown) => {
      $.ui.log(`atc-bridge: reporting ${messageIDs.join(', ')} failed (${String(error)})`, {
        to: 'debug',
      });
    });
}
