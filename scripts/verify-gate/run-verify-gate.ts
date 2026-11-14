import { join } from 'node:path';
import { match } from 'ts-pattern';
import { pickGateStep } from './pick-gate-step.ts';

// The step of the `verify / gate` check. The body comes from the event, as GitHub wrote it when the
// run started, so an `edited` run reads the report that `bun verify publish` just wrote.
export async function runVerifyGate(env: Readonly<Record<string, string | undefined>>) {
  const eventPath = env['GITHUB_EVENT_PATH'];
  const tempDirectory = env['RUNNER_TEMP'];

  if (eventPath === undefined || tempDirectory === undefined) {
    process.stderr.write(
      '::error::set GITHUB_EVENT_PATH and RUNNER_TEMP; a pull_request run sets both\n',
    );

    return 1;
  }

  const eventText = await Bun.file(eventPath).text();

  const step = pickGateStep(JSON.parse(eventText));

  return match(step)
    .with({ kind: 'refused' }, (refused) => {
      process.stderr.write(`::error::${refused.message}\n`);

      return 1;
    })
    .with({ kind: 'skip' }, (skip) => {
      process.stdout.write(`verify gate skipped: ${skip.reason}\n`);

      return 0;
    })
    .with({ kind: 'gate' }, async (gate) => {
      const bodyFile = join(tempDirectory, 'pr-body.md');

      await Bun.write(bodyFile, gate.body);

      const child = Bun.spawn(
        ['bun', 'verify', 'gate', '--base', `origin/${gate.baseRef}`, '--body-file', bodyFile],
        { stdout: 'inherit', stderr: 'inherit' },
      );

      return child.exited;
    })
    .exhaustive();
}

if (import.meta.main) {
  process.exitCode = await runVerifyGate(process.env);
}
