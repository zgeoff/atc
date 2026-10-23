// Builds @atcx/contract as npm publishes it and packs it into a folder, then
// prints the tarball's path. Usage: bun scripts/pack-contract.ts --out <dir> [root]
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { buildPublishedManifest } from './build-published-manifest';
import { writeContractDeclarations } from './write-contract-declarations';

async function main(): Promise<void> {
  const args = parseArgs({
    args: process.argv.slice(2),
    options: { out: { type: 'string' } },
    allowPositionals: true,
  });

  if (args.values.out === undefined || args.positionals.length > 1) {
    throw new Error('usage: bun scripts/pack-contract.ts --out <dir> [root]');
  }

  const out = resolve(args.values.out);
  const root = resolve(args.positionals[0] ?? join(import.meta.dir, '..'));
  const staged = join(out, 'package');

  const manifest = WORKSPACE_MANIFEST_SCHEMA.parse(
    readJSON(join(root, CONTRACT_DIR, 'package.json')),
  );

  const catalog = ROOT_MANIFEST_SCHEMA.parse(readJSON(join(root, 'package.json'))).workspaces
    .catalog;

  mkdirSync(staged, { recursive: true });

  await Bun.build({
    entrypoints: Object.values(manifest.exports).map((entry) => join(root, CONTRACT_DIR, entry)),
    root: join(root, CONTRACT_DIR, 'src'),
    outdir: join(staged, 'dist'),
    target: 'node',
    format: 'esm',
    packages: 'external',
    throw: true,
  });

  await writeContractDeclarations(root, join(staged, 'dist'));

  writeFileSync(
    join(staged, 'package.json'),
    `${JSON.stringify(buildPublishedManifest(manifest, catalog), null, 2)}\n`,
  );

  copyFileSync(join(root, CONTRACT_DIR, 'README.md'), join(staged, 'README.md'));
  copyFileSync(join(root, 'LICENSE'), join(staged, 'LICENSE'));

  // npm packs a plain folder as it publishes it, and the staged manifest names
  // no catalog: or workspace: version for npm to ship verbatim
  const pack = Bun.spawn(['npm', 'pack', '--pack-destination', out, '--silent'], {
    cwd: staged,
    stdout: 'pipe',
    stderr: 'inherit',
  });

  if ((await pack.exited) !== 0) {
    throw new Error('npm pack failed');
  }

  const tarball = await new Response(pack.stdout).text();

  console.log(join(out, tarball.trim()));
}

const CONTRACT_DIR = 'packages/contract';
const NAMES_SCHEMA = z.record(z.string(), z.string());

const WORKSPACE_MANIFEST_SCHEMA = z.looseObject({
  exports: NAMES_SCHEMA,
  dependencies: NAMES_SCHEMA,
});

const ROOT_MANIFEST_SCHEMA = z.object({ workspaces: z.object({ catalog: NAMES_SCHEMA }) });

function readJSON(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

await main();
