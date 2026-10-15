import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  STUB_CODEX_APP_SERVER_SCENARIO_SCHEMA,
  startStubCodexAppServer,
} from './start-stub-codex-app-server';

/**
 * A stand-in `codex app-server --listen unix://<path>` process. It takes the
 * directory a test owns, then Codex's own arguments, reads its scenario from
 * `app-server-scenario.json` in the directory when the file exists, and
 * appends each request it takes to `app-server-requests.jsonl` there. It
 * serves until it is told to stop.
 */
function main(argv: readonly string[]): void {
  const [dir, command, flag, listen] = argv;

  if (
    dir === undefined ||
    command !== 'app-server' ||
    flag !== '--listen' ||
    listen === undefined ||
    !listen.startsWith('unix://')
  ) {
    console.error(`run-stub-codex-app-server: unexpected arguments ${argv.join(' ')}`);
    process.exit(2);
  }

  const scenarioPath = join(dir, 'app-server-scenario.json');

  const scenario = existsSync(scenarioPath)
    ? STUB_CODEX_APP_SERVER_SCENARIO_SCHEMA.parse(JSON.parse(readFileSync(scenarioPath, 'utf8')))
    : {};

  const server = startStubCodexAppServer(listen.slice('unix://'.length), scenario, (request) => {
    appendFileSync(join(dir, 'app-server-requests.jsonl'), `${JSON.stringify(request)}\n`);
  });

  process.on('SIGTERM', () => {
    void (async () => {
      await server.stop();

      process.exit(0);
    })();
  });
}

main(process.argv.slice(2));
