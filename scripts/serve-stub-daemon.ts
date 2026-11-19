import { startStubDaemon } from '@atcx/client/test-utils/start-stub-daemon';

// A stub daemon for the checks that run @atcx/client outside the repository: it prints its socket
// path, answers every call with an empty answer, and sends an event to each subscriber until it is
// stopped.
async function main(): Promise<void> {
  const daemon = await startStubDaemon();

  console.log(daemon.path);

  setInterval(() => {
    if (daemon.subscriptions > 0) {
      daemon.emit({ ev: 'SessionRemoved', sessionID: 's_smoke' });
    }
  }, 50);

  process.on('SIGTERM', () => {
    void stopDaemon(daemon.stop);
  });
}

await main();

async function stopDaemon(stop: () => Promise<void>): Promise<void> {
  await stop();

  process.exit(0);
}
