import { expect, test } from 'bun:test';
import { renderSdkMessage } from './start-headless-run';

test('it renders assistant text verbatim with pty line endings', () => {
  const rendered = renderSdkMessage({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'first line\nsecond line' }] },
  });

  expect(rendered).toBe('first line\r\nsecond line');
});

test('it renders a tool call as a compact one-liner', () => {
  const rendered = renderSdkMessage({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'bun test' } }] },
  });

  expect(rendered).toBe('⚙ Bash {"command":"bun test"}');
});

test('it renders a successful result as a closing line', () => {
  const rendered = renderSdkMessage({
    type: 'result',
    subtype: 'success',
    result: 'done and verified',
  });

  expect(rendered).toBe('— headless turn done: done and verified');
});

test('it renders a failed result with its subtype', () => {
  const rendered = renderSdkMessage({ type: 'result', subtype: 'error_max_turns' });

  expect(rendered).toBe('— headless turn stopped: error_max_turns');
});

test('it renders nothing for messages without displayable content', () => {
  expect(renderSdkMessage({ type: 'system', subtype: 'init' })).toBeNull();
  expect(renderSdkMessage({ type: 'assistant', message: { content: [] } })).toBeNull();
});

test('it truncates an oversized tool input summary', () => {
  const rendered = renderSdkMessage({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Write', input: { data: 'x'.repeat(400) } }] },
  });

  if (rendered === null) {
    throw new Error('nothing rendered');
  }

  expect(rendered.length).toBeLessThan(240);
  expect(rendered).toEndWith('…');
});
