import type { BridgeHost, BridgeState } from './bridge-state.ts';

// A prompt that wakes the model for notices already in its conversation,
// which names them without repeating them.
export function scheduleNoticeReminder(
  host: BridgeHost,
  state: BridgeState,
  messageIDs: readonly string[],
): void {
  const text = renderNoticeReminder(messageIDs);

  state.delivering = state.delivering
    .then(async () => {
      const submitted = await host.prompt.submit({ text });

      if ('drop' in submitted && submitted.drop !== undefined) {
        host.ui.log(`atc-bridge: a hook dropped the reminder for ${messageIDs.join(', ')}`, {
          to: 'debug',
        });
      }
    })
    .catch((error: unknown) => {
      host.ui.log(
        `atc-bridge: reminding of the answer notices for ${messageIDs.join(', ')} failed (${String(error)})`,
        { to: 'debug' },
      );
    });
}

function renderNoticeReminder(messageIDs: readonly string[]): string {
  const subject =
    messageIDs.length === 1
      ? `the answer notice for ${messageIDs.join('')}`
      : `the answer notices for ${messageIDs.join(', ')}`;

  return `atc added ${subject} to this conversation after your last reply. Read ${messageIDs.length === 1 ? 'it' : 'them'} above; atc does not send ${messageIDs.length === 1 ? 'it' : 'them'} again.`;
}
