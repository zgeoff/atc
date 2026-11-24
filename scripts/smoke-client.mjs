// Runs the installed @atcx/client against a stub daemon, on whichever runtime starts it:
//   node smoke-client.mjs <socket path>
// It connects, sends a message, reads one event, closes, and calls a stand-in gateway.
import { AtcError, connect } from '@atcx/client';
import { openDaemonConnection } from '@atcx/client/connection';
import { connectGateway } from '@atcx/client/gateway';

const socketPath = process.argv.at(2);

if (socketPath === undefined) {
  console.error('usage: node smoke-client.mjs <socket path>');
  process.exit(2);
}

const runtime = typeof process.versions.bun === 'string' ? 'bun' : 'node';

const atc = await connect({ socketPath, client: 'smoke-client' });

await atc.session.message({ session: 's_smoke', text: 'hello from the packed client' });

for await (const event of atc.events()) {
  if (event.ev !== 'SessionRemoved') {
    throw new Error(`the stub daemon sent ${event.ev}`);
  }

  break;
}

await atc.close();

const connection = await openDaemonConnection({ path: socketPath }, { client: 'smoke-client' });

await connection.request('session.list', {});
await connection.close();

const missing = await connect({ socketPath: `${socketPath}.missing` }).catch((error) => error);

if (!(missing instanceof AtcError) || missing.code !== 'no_daemon') {
  throw new Error('connect() with no daemon did not throw no_daemon');
}

console.log(
  `${runtime} ${process.versions[runtime]} connects to the daemon, sends, and reads an event`,
);

const sent = [];

const gateway = connectGateway({
  url: 'https://gateway.example/',
  token: () => 'atcs_smoke',
  // oxlint-disable-next-line zgeoff/function-verb -- connectGateway names its transport option fetch
  fetch: (request) => {
    sent.push({
      url: request.url,
      authorization: request.headers.get('authorization'),
      major: request.headers.get('x-atc-major'),
    });

    return Promise.resolve(
      Response.json({ json: { daemons: [], defaultDaemon: 'none', contract: '0.0.0' } }),
    );
  },
});

const listed = await gateway.daemons.list({});

if (listed.defaultDaemon !== 'none') {
  throw new Error('connectGateway did not return the gateway answer');
}

const [call] = sent;

if (
  call?.url !== 'https://gateway.example/rpc/daemons/list' ||
  call.authorization !== 'Bearer atcs_smoke' ||
  !/^\d+$/u.test(call.major ?? '')
) {
  throw new Error(`connectGateway sent ${JSON.stringify(call)}`);
}
