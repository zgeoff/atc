import { expect, test } from 'bun:test';
import { renderMessageLine } from './render-message-line';

test('it renders a message with its sender nested under sender', () => {
  const line = renderMessageLine({
    message: 'm-1',
    from: 'Lantern Notes',
    sender: { kind: 'connector', client: 'client-7', name: 'Lantern Notes' },
    text: 'check the tide tables',
    sentAt: 1000,
  });

  expect(line).toBe(
    '{"id":"m-1","from":"Lantern Notes","sender":{"kind":"connector","client":"client-7","name":"Lantern Notes"},"text":"check the tide tables","sentAt":1000}\n',
  );
});

test('it renders a message without a typed sender with its sender name alone', () => {
  const line = renderMessageLine({
    message: 'm-1',
    from: 'mcp',
    text: 'check the tide tables',
    sentAt: 1000,
  });

  expect(line).toBe('{"id":"m-1","from":"mcp","text":"check the tide tables","sentAt":1000}\n');
});
