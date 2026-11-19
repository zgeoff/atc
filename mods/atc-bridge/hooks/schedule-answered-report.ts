import { ATC_CLI } from './atc-cli.ts';
import { ATC_CWD, type BridgeHost, type BridgeState } from './bridge-state.ts';

export function scheduleAnsweredReport(
  host: BridgeHost,
  state: BridgeState,
  messageIDs: readonly string[],
  turnID: string,
  answer: string,
): void {
  state.reporting = state.reporting
    .then(async () => {
      await host.process.run(
        [...ATC_CLI, 'answer', '--messages', messageIDs.join(','), '--turn', turnID],
        {
          cwd: ATC_CWD,
          stdin: answer,
          timeoutMs: 5000,
        },
      );
    })
    .catch((error: unknown) => {
      host.ui.log(`atc-bridge: reporting ${messageIDs.join(', ')} failed (${String(error)})`, {
        to: 'debug',
      });
    });
}
