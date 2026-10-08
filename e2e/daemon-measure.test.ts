import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir } from '../src/test-utils/setup-temp-dir';

// Throwaway measurement for GEO-198: never merged.
test.skipIf(process.env['ATC_BIN'] === undefined)(
  'it measures startup CPU on this runner',
  async () => {
    const tmp = setupTempDir('atc-e2e-measure-');
    const noBytecode = join(tmp.dir, 'atc-nobytecode');

    const build = Bun.spawn(
      [
        process.execPath,
        'build',
        '--compile',
        '--format=esm',
        '--no-compile-autoload-dotenv',
        'src/cli.ts',
        '--outfile',
        noBytecode,
      ],
      { stdout: 'ignore', stderr: 'inherit' },
    );

    const buildCode = await build.exited;

    expect(buildCode).toBe(0);

    const multiples: Partial<Record<string, number>> = { linux: 16, darwin: 8 };
    const multiple = multiples[process.platform] ?? 0;

    for (let trial = 0; trial < 5; trial += 1) {
      for (const [label, binary] of [
        ['healthy', process.env['ATC_BIN'] ?? ''],
        ['nobytecode', noBytecode],
      ]) {
        const reporter: number[] = [];
        const bare: number[] = [];
        const codes: number[] = [];

        for (let run = 0; run < 9; run += 1) {
          for (const [cmd, xs] of [
            [[binary ?? '', 'hook-report', '--agent', 'claude'], reporter],
            [[process.execPath, '-e', '0'], bare],
          ] as [string[], number[]][]) {
            const proc = Bun.spawn(cmd, {
              cwd: tmp.dir,
              env: { PATH: process.env['PATH'], HOME: tmp.dir },
              stdin: 'ignore',
              stdout: 'ignore',
              stderr: 'ignore',
            });

            const code = await proc.exited;

            codes.push(code);
            xs.push(Number(proc.resourceUsage()?.cpuTime.total) / 1000);
          }
        }

        const r = reporter.toSorted((a, b) => a - b)[4] ?? 0;
        const b = bare.toSorted((a, b2) => a - b2)[4] ?? 1;
        const verdict = codes.every((c) => c === 0) && r < multiple * b ? 'PASS' : 'FAIL';

        console.log(
          `VERDICT ${process.platform}-${process.arch} trial=${trial} ${label} reporter=${r.toFixed(2)} bare=${b.toFixed(2)} budget=${(multiple * b).toFixed(2)} ratio=${(r / b).toFixed(2)} ${verdict}`,
        );
      }
    }
  },
  300_000,
);
