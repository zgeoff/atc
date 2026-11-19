import type { BridgeHost } from './bridge-state.ts';

export async function tryUpdateConversation(
  host: BridgeHost,
  id: string,
  text: string,
): Promise<boolean> {
  try {
    const appended = await host.session.append({
      message: { type: 'user', content: [{ type: 'text', text }] },
    });

    return appended.deny === undefined;
  } catch (error) {
    host.ui.log(`atc-bridge: appending ${id} failed (${String(error)}); submitting it instead`, {
      to: 'debug',
    });

    return false;
  }
}
