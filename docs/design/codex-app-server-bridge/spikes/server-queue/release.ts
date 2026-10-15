import { buildText, openClient } from './open-client';

// Starts one normal turn and logs whether a queued item follows it: bun release.ts <url> <log> <thread>
const [url, log, thread] = process.argv.slice(2);

const c = await openClient(url!, log!, 'release');

await c.sendRequest('thread/resume', { threadId: thread, excludeTurns: true });

const t = await c.sendRequest('turn/start', {
  threadId: thread,
  input: buildText('Reply with the word OK.'),
});

await c.waitFor((n) => n.method === 'turn/completed' && n.params.turn.id === t.turn.id, 90_000);

try {
  const next = await c.waitFor(
    (n) => n.method === 'turn/started' && n.params.turn.id !== t.turn.id,
    30_000,
  );

  await c.waitFor(
    (n) => n.method === 'turn/completed' && n.params.turn.id === next.params.turn.id,
    90_000,
  );
} catch (e) {
  console.log('no queued turn followed', String(e));
}

await c.sendRequest('thread/queue/list', { threadId: thread });

c.close();
process.exit(0);
