import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { buildPublishedExports, buildPublishedManifest } from './build-published-manifest';
import { buildPublishedReadme } from './build-published-readme';
import { DECLARATION_TOOLS } from './declaration-tools';
import { writeContractDeclarations } from './write-contract-declarations';

async function main(): Promise<void> {
  const args = parseArgs({
    args: process.argv.slice(2),
    options: { out: { type: 'string' }, package: { type: 'string', default: 'contract' } },
    allowPositionals: true,
  });

  if (args.values.out === undefined || args.positionals.length > 1) {
    throw new Error('usage: bun scripts/pack-contract.ts --out <dir> [root] [--package <name>]');
  }

  const out = resolve(args.values.out);
  const root = resolve(args.positionals[0] ?? join(import.meta.dir, '..'));
  const staged = join(out, 'package');
  const packageDir = `packages/${args.values.package}`;

  const manifest = WORKSPACE_MANIFEST_SCHEMA.parse(
    readJSON(join(root, packageDir, 'package.json')),
  );

  const rootManifest = ROOT_MANIFEST_SCHEMA.parse(readJSON(join(root, 'package.json')));
  const catalog = rootManifest.workspaces.catalog;

  // release-please tags each release as <root package name>@<version>
  const treeURL = `${rootManifest.repository.url.replace(/^git\+/u, '').replace(/\.git$/u, '')}/blob/${encodeURIComponent(`${rootManifest.name}@${rootManifest.version}`)}`;

  mkdirSync(staged, { recursive: true });

  await Bun.build({
    entrypoints: Object.values(buildPublishedExports(manifest.exports)).map((entry) =>
      join(root, packageDir, entry),
    ),
    root: join(root, packageDir, 'src'),
    outdir: join(staged, 'dist'),
    target: 'node',
    format: 'esm',
    packages: 'external',
    throw: true,
  });

  await writeContractDeclarations(root, join(staged, 'dist'), DECLARATION_TOOLS, packageDir);

  writeFileSync(
    join(staged, 'package.json'),
    `${JSON.stringify(buildPublishedManifest(manifest, catalog), null, 2)}\n`,
  );

  const readme = readFileSync(join(root, packageDir, 'README.md'), 'utf8');

  writeFileSync(join(staged, 'README.md'), buildPublishedReadme(readme, treeURL, packageDir));
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

const NAMES_SCHEMA = z.record(z.string(), z.string());

const WORKSPACE_MANIFEST_SCHEMA = z.looseObject({
  version: z.string(),
  exports: NAMES_SCHEMA,
  dependencies: NAMES_SCHEMA,
});

const ROOT_MANIFEST_SCHEMA = z.object({
  name: z.string(),
  version: z.string(),
  repository: z.object({ url: z.string() }),
  workspaces: z.object({ catalog: NAMES_SCHEMA }),
});

function readJSON(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

await main();
