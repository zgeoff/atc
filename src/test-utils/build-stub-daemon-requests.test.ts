import { expect, test } from 'bun:test';
import { buildStubDaemonRequests } from './build-stub-daemon-requests';

test('it collects the params of every request sent under a method in the order they were sent', () => {
  const daemon = buildStubDaemonRequests({ countReactions: () => 0 });

  void daemon.sendRequest('sources.list', { source: 'dirs' });
  void daemon.sendRequest('agents.list');
  void daemon.sendRequest('sources.list', { source: 'git' });
  expect(daemon.collectSent('sources.list')).toStrictEqual([{ source: 'dirs' }, { source: 'git' }]);
});

test('it answers the latest request waiting under the method', async () => {
  const seen: string[] = [];
  const daemon = buildStubDaemonRequests({ countReactions: () => seen.length });

  void (async () => {
    await daemon.sendRequest('sources.list', { source: 'git' });

    seen.push('git');
  })();

  void (async () => {
    await daemon.sendRequest('sources.list', { source: 'dirs' });

    seen.push('dirs');
  })();

  await daemon.answer('sources.list', {});

  expect(seen).toStrictEqual(['dirs']);
});

test('it answers the oldest request waiting under the method', async () => {
  const seen: string[] = [];
  const daemon = buildStubDaemonRequests({ countReactions: () => seen.length });

  void (async () => {
    await daemon.sendRequest('sources.list', { source: 'git' });

    seen.push('git');
  })();

  void (async () => {
    await daemon.sendRequest('sources.list', { source: 'dirs' });

    seen.push('dirs');
  })();

  await daemon.answerOldest('sources.list', {});

  expect(seen).toStrictEqual(['git']);
});

test('it skips a request it already answered', async () => {
  const seen: string[] = [];
  const daemon = buildStubDaemonRequests({ countReactions: () => seen.length });

  void (async () => {
    await daemon.sendRequest('sources.list', { source: 'git' });

    seen.push('git');
  })();

  void (async () => {
    await daemon.sendRequest('sources.list', { source: 'dirs' });

    seen.push('dirs');
  })();

  await daemon.answer('sources.list', {});
  await daemon.answer('sources.list', {});

  expect(seen).toStrictEqual(['dirs', 'git']);
});

test('it waits for a request under the method to be sent before it answers', async () => {
  const seen: unknown[] = [];
  const daemon = buildStubDaemonRequests({ countReactions: () => seen.length });
  const answering = daemon.answer('agents.list', { targets: [] });

  void (async () => {
    const answer = await daemon.sendRequest('agents.list');

    seen.push(answer);
  })();

  await answering;

  expect(seen).toStrictEqual([{ targets: [] }]);
});

test('it counts another request the client sends as its reaction to an answer', async () => {
  const daemon = buildStubDaemonRequests({ countReactions: () => 0 });

  void (async () => {
    await daemon.sendRequest('agents.list');
    await daemon.sendRequest('sources.list');
  })();

  await daemon.answer('agents.list', {});

  expect(daemon.collectSent('sources.list')).toStrictEqual([{}]);
});

test('it resolves an answer only once the client has reacted to it', async () => {
  let reactions = 0;
  const daemon = buildStubDaemonRequests({ countReactions: () => reactions });

  void (async () => {
    await daemon.sendRequest('agents.list');

    setImmediate(() => {
      reactions += 1;
    });
  })();

  await daemon.answer('agents.list', {});

  expect(reactions).toBe(1);
});
