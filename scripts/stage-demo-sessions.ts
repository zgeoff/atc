// Spawns or kills sessions on the daemon the environment points at, for the
// demo recording. `spawn <cwd> <name> <prompt>` starts one session and prints
// its id; `kill-all` kills every session the daemon hosts.
import { DaemonClient } from '../src/client/daemon-client';
import { daemonSocketPath } from '../src/shared/config';
import { getBuild } from '../src/shared/get-build';
import { isRecord } from '../src/shared/report';

const [mode, cwd, name = '', prompt = ''] = process.argv.slice(2);

const client = await DaemonClient.open(daemonSocketPath);

await client.sendHello(getBuild());

if (mode === 'spawn' && cwd !== undefined) {
  const ok = await client.sendRequest('session.spawn', { cwd, name, prompt, cols: 98, rows: 28 });

  const session = ok['session'];
  const line = isRecord(session) ? session['id'] : JSON.stringify(ok);

  console.log(line);
} else if (mode === 'kill-all') {
  const ok = await client.sendRequest('session.list');

  const sessions = Array.isArray(ok['sessions']) ? ok['sessions'] : [];

  for (const session of sessions) {
    if (isRecord(session) && typeof session['id'] === 'string') {
      await client.sendRequest('session.kill', { session: session['id'] });
    }
  }
} else {
  console.error('usage: stage-demo-sessions.ts spawn <cwd> <name> <prompt> | kill-all');

  process.exitCode = 1;
}

client.stop();
