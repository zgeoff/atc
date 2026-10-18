import type { On } from 'claude-code';

// Stands in for the session's conversation: it keeps the text of each row a
// plugin appends or submits, in order. An append lands once its gate opens,
// so a test can hold it past the end of a turn.
export function buildStubConversation(
  on: On,
  appendGate: Promise<void> = Promise.resolve(),
): { readonly rows: readonly string[] } {
  const rows: string[] = [];

  on('session.append', async ($, e, next) => {
    await appendGate;

    const [block] = e.message.content;

    rows.push(block?.type === 'text' ? block.text : '');

    return next(e);
  });

  on('prompt.submit', ($, e) => {
    rows.push(e.text);

    return { text: e.text };
  });

  return { rows };
}
