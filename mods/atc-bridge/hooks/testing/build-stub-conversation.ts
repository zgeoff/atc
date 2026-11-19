import type { On } from 'claude-code';

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
