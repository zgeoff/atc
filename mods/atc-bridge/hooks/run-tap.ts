import { ATC_CLI } from './atc-cli.ts';
import { ATC_CWD, type BridgeHost, type BridgeState } from './bridge-state.ts';
import { scheduleDelivery, scheduleNoticeDelivery } from './deliver-messages.ts';
import { parseTapLine } from './parse-tap-line.ts';

const FIRST_TAP_RETRY_MS = 1000;
const LONGEST_TAP_RETRY_MS = 30_000;

// atc refuses every message to a session whose tap never attached, and atc tap exits 0 only
// once atc closed the inbox for good, so any other end starts the tap again.
export async function runTap(
  host: BridgeHost,
  state: BridgeState,
  sessionID: string,
): Promise<void> {
  let wait = FIRST_TAP_RETRY_MS;

  for (;;) {
    const failure = await runTapOnce(host, state, sessionID);

    if (failure === null) {
      host.ui.log('atc-bridge: atc tap ended; this session takes no more atc messages', {
        to: 'debug',
      });

      return;
    }

    host.ui.log(`atc-bridge: atc tap failed (${failure}); starting it again in ${wait}ms`, {
      to: 'debug',
    });

    // An unload of the mod rejects the wait, and the next load starts its own tap.
    try {
      await host.clock.sleep(wait);
    } catch {
      return;
    }

    wait = Math.min(wait * 2, LONGEST_TAP_RETRY_MS);
  }
}

async function runTapOnce(
  host: BridgeHost,
  state: BridgeState,
  sessionID: string,
): Promise<string | null> {
  const tap = host.process.spawn({
    argv: [...ATC_CLI, 'tap', '--session', sessionID, '--notices'],
    cwd: ATC_CWD,
  });

  let pending = '';
  let stderr = '';

  try {
    for await (const chunk of tap) {
      if (chunk.stream !== 'stdout') {
        stderr = `${stderr}${chunk.text}`.slice(-1000);
        continue;
      }

      const lines = `${pending}${chunk.text}`.split('\n');

      pending = lines.pop() ?? '';

      for (const line of lines) {
        const item = parseTapLine(line);

        if (item?.kind === 'message') {
          scheduleDelivery(host, state, item.msg);
        } else if (item?.kind === 'answer') {
          scheduleNoticeDelivery(host, state, item.notice);
        }
      }
    }

    const exit = await tap.result;

    if (exit.code === 0) {
      return null;
    }

    const reason = exit.signal ?? `exit ${String(exit.code)}`;
    const said = stderr.trim();

    return said === '' ? reason : `${reason}: ${said}`;
  } catch (error) {
    return String(error);
  }
}
