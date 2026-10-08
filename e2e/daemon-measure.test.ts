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

    const commands: Record<string, string[]> = {
      hook: [process.env['ATC_BIN'] ?? '', 'hook-report', '--agent', 'claude'],
      hookNoBytecode: [noBytecode, 'hook-report', '--agent', 'claude'],
      bunE0: [process.execPath, '-e', '0'],
      bunLoop: [process.execPath, '-e', 'let s=0;for(let i=0;i<2e7;i++)s+=i'],
    };

    const samples: Record<string, number[]> = {};

    for (let run = 0; run < 25; run += 1) {
      for (const [name, cmd] of Object.entries(commands)) {
        const proc = Bun.spawn(cmd, {
          cwd: tmp.dir,
          env: { PATH: process.env['PATH'], HOME: tmp.dir },
          stdin: 'ignore',
          stdout: 'ignore',
          stderr: 'ignore',
        });

        await proc.exited;

        (samples[name] ??= []).push(Number(proc.resourceUsage()?.cpuTime.total) / 1000);
      }
    }

    const medians: Record<string, number> = {};

    for (const [name, xs] of Object.entries(samples)) {
      const sorted = xs.toSorted((a, b) => a - b);

      medians[name] = sorted[12] ?? 0;

      console.log(
        `GEO198 ${process.platform}-${process.arch} ${name} median=${medians[name].toFixed(2)} min=${sorted[0]?.toFixed(2)} max=${sorted.at(-1)?.toFixed(2)} all=${xs.map((x) => x.toFixed(1)).join(',')}`,
      );
    }

    console.log(
      `GEO198 ${process.platform}-${process.arch} ratios hook/bunE0=${((medians['hook'] ?? 0) / (medians['bunE0'] ?? 1)).toFixed(2)} noBC/bunE0=${((medians['hookNoBytecode'] ?? 0) / (medians['bunE0'] ?? 1)).toFixed(2)} hook/bunLoop=${((medians['hook'] ?? 0) / (medians['bunLoop'] ?? 1)).toFixed(2)} noBC/bunLoop=${((medians['hookNoBytecode'] ?? 0) / (medians['bunLoop'] ?? 1)).toFixed(2)}`,
    );
  },
  300_000,
);
