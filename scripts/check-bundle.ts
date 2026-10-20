// Checks which execution providers the atc bundle carries. The daemon reaches
// a provider's code only through the shipped execution plugins list, so a
// provider the list leaves out stays out of the bundle, with its own packages.
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { BunPlugin } from 'bun';
import { z } from 'zod';
import { collectImports } from './collect-imports';

async function main(): Promise<void> {
  // bun reports each importer at the path its links lead to, so the root
  // takes that path too, or a root reached through a link matches no importer
  const root = realpathSync(resolve(process.argv[2] ?? join(import.meta.dir, '..')));
  const providers = loadProviders(root);
  const registry = readFileSync(join(root, REGISTRY), 'utf8');

  const shipped = providers.filter((provider) =>
    collectImports(registry).specifiers.some((specifier) => isEntryOf(provider, specifier)),
  );

  const local = providers.filter((provider) => provider.name === LOCAL_PROVIDER);

  // Each build must also carry every provider it keeps, so the check cannot
  // pass on a bundle that lost them
  const builds = [
    { label: 'atc', kept: shipped },
    { label: 'local-only atc', kept: local },
  ];

  const findings: string[] = [];

  for (const build of builds) {
    const bundled = await readBundled(root, providers, build.kept);

    findings.push(...checkBundle(build.label, providers, build.kept, bundled));

    console.log(
      `check-bundle: ${build.label} keeps ${formatNames(build.kept)} and bundles ${bundled.length} inputs`,
    );
  }

  for (const finding of findings) {
    console.error(finding);
  }

  console.log(`check-bundle: ${findings.length} findings`);

  if (findings.length > 0) {
    process.exit(1);
  }
}

const ENTRY = 'packages/app/src/cli.ts';
const REGISTRY = 'packages/app/src/plugins/shipped-execution-plugins.ts';
const LOCAL_PROVIDER = '@atc/execution-local';

interface Provider {
  readonly name: string;
  readonly directory: string;

  // The external packages this provider depends on and no other workspace
  // package declares.
  readonly ownDependencies: readonly string[];
}

const MANIFEST_SCHEMA = z.object({
  name: z.string(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
});

function loadProviders(root: string): Provider[] {
  const manifests = [...new Bun.Glob('packages/**/package.json').scanSync({ cwd: root })]
    .filter((path) => !path.split('/').includes('node_modules'))
    .toSorted()
    .map((path) => {
      const text = readFileSync(join(root, path), 'utf8');

      return { directory: dirname(path), manifest: MANIFEST_SCHEMA.parse(JSON.parse(text)) };
    });

  return manifests
    .filter((entry) => entry.directory.startsWith('packages/execution/'))
    .map((entry) => {
      const others = new Set<string>();

      for (const other of manifests.filter(
        (candidate) => candidate.directory !== entry.directory,
      )) {
        for (const dependency of Object.keys(other.manifest.dependencies ?? {})) {
          others.add(dependency);
        }

        for (const dependency of Object.keys(other.manifest.devDependencies ?? {})) {
          others.add(dependency);
        }
      }

      const ownDependencies = Object.keys(entry.manifest.dependencies ?? {}).filter(
        (dependency) => !dependency.startsWith('@atc/') && !others.has(dependency),
      );

      return { name: entry.manifest.name, directory: entry.directory, ownDependencies };
    });
}

const STAND_IN_NAMESPACE = 'dropped-provider';

// Each module of a dropped provider that the list imports turns into a
// stand-in that holds the same export names and no code
async function readBundled(
  root: string,
  providers: readonly Provider[],
  kept: readonly Provider[],
): Promise<string[]> {
  const dropped = providers.filter((provider) => !kept.includes(provider));

  const build = await Bun.build({
    entrypoints: [join(root, ENTRY)],
    root,
    target: 'bun',
    metafile: true,
    throw: false,
    plugins: [makeDropPlugin(join(root, REGISTRY), dropped)],
  });

  if (!build.success || build.metafile === undefined) {
    const logs = build.logs.map((log) => log.message).join('\n');

    throw new Error(`bun build ${ENTRY} failed: ${logs}`);
  }

  return Object.keys(build.metafile.inputs)
    .filter((input) => !input.startsWith(`${STAND_IN_NAMESPACE}:`))
    .map((input) => {
      // bun writes an input inside the working directory relative to it and
      // one outside as absolute, and a linked package's input can arrive under
      // its link, so each counts at the path its link leads to
      const path = realpathSync(resolve(process.cwd(), input));

      return relative(root, path);
    });
}

function makeDropPlugin(registryPath: string, dropped: readonly Provider[]): BunPlugin {
  return {
    name: 'drop-providers',
    setup(builder) {
      builder.onResolve({ filter: /^@atc\/execution-/u }, (args) => {
        const isDropped = dropped.some((provider) => isEntryOf(provider, args.path));

        if (args.importer !== registryPath || !isDropped) {
          return null;
        }

        return {
          path: Bun.resolveSync(args.path, dirname(args.importer)),
          namespace: STAND_IN_NAMESPACE,
        };
      });

      builder.onLoad({ filter: /.*/u, namespace: STAND_IN_NAMESPACE }, (args) => {
        const exports = readExportNames(args.path);

        return {
          contents: exports.map((name) => `export const ${name} = undefined;`).join('\n'),
          loader: 'ts',
        };
      });
    },
  };
}

function isEntryOf(provider: Provider, specifier: string): boolean {
  return specifier === provider.name || specifier.startsWith(`${provider.name}/`);
}

function readExportNames(path: string): string[] {
  const source = readFileSync(path, 'utf8');

  const names = new Bun.Transpiler({ loader: 'ts' }).scan(source).exports;

  for (const match of source.matchAll(/^export \* from '(?<specifier>[^']+)';$/gmu)) {
    const specifier = match.groups?.['specifier'];

    if (specifier !== undefined) {
      const target = Bun.resolveSync(specifier, dirname(path));

      names.push(...readExportNames(target));
    }
  }

  return [...new Set(names)];
}

function checkBundle(
  label: string,
  providers: readonly Provider[],
  kept: readonly Provider[],
  bundled: readonly string[],
): string[] {
  const packages = new Set(bundled.flatMap((input) => findExternalPackage(input) ?? []));

  const findings: string[] = [];

  for (const provider of providers.filter((candidate) => !kept.includes(candidate))) {
    for (const input of bundled
      .filter((path) => path.startsWith(`${provider.directory}/`))
      .toSorted()) {
      findings.push(`unshipped provider: ${label} bundles ${input} (${provider.name})`);
    }

    for (const dependency of provider.ownDependencies.filter((name) => packages.has(name))) {
      findings.push(
        `unshipped provider: ${label} bundles ${dependency}, which only ${provider.name} depends on`,
      );
    }
  }

  for (const provider of kept) {
    if (!bundled.some((input) => input.startsWith(`${provider.directory}/`))) {
      findings.push(`missing provider: ${label} keeps ${provider.name} but bundles none of it`);
    }
  }

  return findings;
}

function findExternalPackage(input: string): string | null {
  const parts = input.split('/');
  const index = parts.lastIndexOf('node_modules');

  if (index === -1) {
    return null;
  }

  const [first = '', second = ''] = parts.slice(index + 1);

  return first.startsWith('@') ? `${first}/${second}` : first;
}

function formatNames(providers: readonly Provider[]): string {
  return providers.length === 0
    ? 'no providers'
    : providers.map((provider) => provider.name).join(', ');
}

await main();
