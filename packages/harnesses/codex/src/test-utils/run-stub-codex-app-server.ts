import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  STUB_CODEX_APP_SERVER_SCENARIO_SCHEMA,
  startStubCodexAppServer,
} from './start-stub-codex-app-server';

function main(argv: readonly string[]): void {
  const [directory, command, flag, listen] = argv;

  if (
    directory === undefined ||
    command !== 'app-server' ||
    flag !== '--listen' ||
    listen === undefined ||
    !listen.startsWith('unix://')
  ) {
    console.error(`run-stub-codex-app-server: unexpected arguments ${argv.join(' ')}`);
    process.exit(2);
  }

  const scenarioPath = join(directory, 'app-server-scenario.json');

  const scenario = existsSync(scenarioPath)
    ? STUB_CODEX_APP_SERVER_SCENARIO_SCHEMA.parse(JSON.parse(readFileSync(scenarioPath, 'utf8')))
    : {};

  const server = startStubCodexAppServer(listen.slice('unix://'.length), scenario, (request) => {
    appendFileSync(join(directory, 'app-server-requests.jsonl'), `${JSON.stringify(request)}\n`);
  });

  process.on('SIGTERM', () => {
    void (async () => {
      await server.stop();

      process.exit(0);
    })();
  });
}

main(process.argv.slice(2));
