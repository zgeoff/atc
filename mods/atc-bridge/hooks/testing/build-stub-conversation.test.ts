import { expect, test } from 'claude-code/testing';
import { buildStubConversation } from './build-stub-conversation';

test('it keeps appended and submitted rows in the order they arrive', async (engine, on) => {
  const conversation = buildStubConversation(on);

  await engine.session.append({
    message: { type: 'user', content: [{ type: 'text', text: 'an appended row' }] },
  });

  await engine.prompt.submit({ text: 'a submitted prompt' });

  expect(conversation.rows).toStrictEqual(['an appended row', 'a submitted prompt']);
});

test('it holds an append until its gate opens', async (engine, on) => {
  const gate = Promise.withResolvers<void>();
  const conversation = buildStubConversation(on, gate.promise);

  const appended = engine.session.append({
    message: { type: 'user', content: [{ type: 'text', text: 'a held row' }] },
  });

  await engine.prompt.submit({ text: 'a submitted prompt' });

  const beforeGate = [...conversation.rows];

  gate.resolve();

  await appended;

  expect([beforeGate, conversation.rows]).toStrictEqual([
    ['a submitted prompt'],
    ['a submitted prompt', 'a held row'],
  ]);
});
