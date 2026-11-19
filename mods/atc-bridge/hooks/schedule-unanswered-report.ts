import { ATC_CLI } from './atc-cli.ts';
import { ATC_CWD, type BridgeHost, type BridgeState } from './bridge-state.ts';

export function scheduleUnansweredReport(
  host: BridgeHost,
  state: BridgeState,
  messageIDs: readonly string[],
  reason: string,
  turnID: string | null,
): void {
  state.reporting = state.reporting
    .then(async () => {
      await host.process.run(
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
      host.ui.log(`atc-bridge: reporting ${messageIDs.join(', ')} failed (${String(error)})`, {
        to: 'debug',
      });
    });
}
