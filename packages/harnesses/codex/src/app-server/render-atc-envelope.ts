import type { BridgedMessage } from '@atc/plugin-api';
import { encodeAttribute } from './encode-attribute';

/**
 * Renders a message as the `<atc-message>` envelope the model reads, with
 * the sender's kind and session when the daemon knows them, the same
 * envelope the Claude bridge delivers.
 */
export function renderAtcEnvelope(message: BridgedMessage): string {
  const body = message.text.replaceAll('</atc-message>', '&lt;/atc-message&gt;');
  const sender = message.sender;
  const session = sender?.kind === 'session' ? ` session="${encodeAttribute(sender.session)}"` : '';
  const kind = sender === undefined ? '' : ` kind="${sender.kind}"${session}`;

  return `<atc-message id="${encodeAttribute(message.id)}" from="${encodeAttribute(message.from)}"${kind}>\n${body}\n</atc-message>`;
}
