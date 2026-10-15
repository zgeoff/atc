// Checks which execution providers the atc bundle carries. The daemon reaches
// a provider's code only through the shipped execution plugins list, so a
// provider the list leaves out stays out of the bundle, with every external
// package that only it depends on. Two builds of the atc entry hold that:
// the atc build as it ships, which may carry only the providers the list
// imports, and a local-only build, whose list keeps the local provider
// alone and which may carry no other provider. Each build must also carry
// every provider it keeps, so the check cannot pass on a bundle that lost
// them. Prints every finding and exits 1 when there is one.
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { BunPlugin } from 'bun';
import { z } from 'zod';
import { collectImports } from './collect-imports';

async function main(): Promise<void> {
  const root = resolve(process.argv[2] ?? join(import.meta.dir, '..'));
  const providers = loadProviders(root);
  const registry = readFileSync(join(root, REGISTRY), 'utf8');

  const shipped = providers.filter((provider) =>
    collectImports(registry).specifiers.some((specifier) =>
      specifier.startsWith(`${provider.name}/`),
    ),
  );

  const local = providers.filter((provider) => provider.name === LOCAL_PROVIDER);

  const builds = [
    { label: 'atc', kept: shipped },
    { label: 'local-only atc', kept: local },
  ];

  const findings: string[] = [];

  for (const build of builds) {
    const bundled = await collectBundled(root, providers, build.kept);

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
  readonly dir: string;

  // The external packages this provider depends on and no other workspace
  // package declares.
  readonly ownDependencies: readonly string[];
}

const MANIFEST_SCHEMA = z.object({
  name: z.string(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
});

/**
 * Every execution provider package under the root, with the external
 * packages that only it depends on.
 */
function loadProviders(root: string): Provider[] {
  const manifests = [...new Bun.Glob('packages/**/package.json').scanSync({ cwd: root })]
    .filter((path) => !path.split('/').includes('node_modules'))
    .toSorted()
    .map((path) => {
      const text = readFileSync(join(root, path), 'utf8');

      return { dir: dirname(path), manifest: MANIFEST_SCHEMA.parse(JSON.parse(text)) };
    });

  return manifests
    .filter((entry) => entry.dir.startsWith('packages/execution/'))
    .map((entry) => {
      const others = new Set<string>();

      for (const other of manifests.filter((candidate) => candidate.dir !== entry.dir)) {
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

      return { name: entry.manifest.name, dir: entry.dir, ownDependencies };
    });
}

const STAND_IN_NAMESPACE = 'dropped-provider';

/**
 * Every input `bun build` bundles from the atc entry, as a path relative to
 * the root, when the shipped execution plugins list imports only the kept
 * providers. Each module of another provider that the list imports turns
 * into a stand-in that holds the same export names and no code.
 */
async function collectBundled(
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

  // a linked package's inputs can arrive under its link in node_modules,
  // so each input counts at the path its link leads to; a stand-in holds no
  // provider code and counts as nothing
  const realRoot = realpathSync(root);

  return Object.keys(build.metafile.inputs)
    .filter((input) => !input.startsWith(`${STAND_IN_NAMESPACE}:`))
    .map((input) => relative(realRoot, realpathSync(resolve(root, input))));
}

function makeDropPlugin(registryPath: string, dropped: readonly Provider[]): BunPlugin {
  return {
    name: 'drop-providers',
    setup(builder) {
      builder.onResolve({ filter: /^@atc\/execution-/ }, (args) => {
        const isDropped = dropped.some((provider) => args.path.startsWith(`${provider.name}/`));

        if (args.importer !== registryPath || !isDropped) {
          return null;
        }

        return {
          path: Bun.resolveSync(args.path, dirname(args.importer)),
          namespace: STAND_IN_NAMESPACE,
        };
      });

      builder.onLoad({ filter: /.*/, namespace: STAND_IN_NAMESPACE }, (args) => {
        const source = readFileSync(args.path, 'utf8');

        const exports = new Bun.Transpiler({ loader: 'ts' }).scan(source).exports;

        return {
          contents: exports.map((name) => `export const ${name} = undefined;`).join('\n'),
          loader: 'ts',
        };
      });
    },
  };
}

/**
 * The findings for one build: a bundled file of a provider the build does
 * not keep, a bundled external package that only such a provider depends
 * on, and a kept provider with no file in the bundle.
 */
function checkBundle(
  label: string,
  providers: readonly Provider[],
  kept: readonly Provider[],
  bundled: readonly string[],
): string[] {
  const packages = new Set(bundled.flatMap((input) => findExternalPackage(input) ?? []));

  const findings: string[] = [];

  for (const provider of providers.filter((candidate) => !kept.includes(candidate))) {
    for (const input of bundled.filter((path) => path.startsWith(`${provider.dir}/`)).toSorted()) {
      findings.push(`unshipped provider: ${label} bundles ${input} (${provider.name})`);
    }

    for (const dependency of provider.ownDependencies.filter((name) => packages.has(name))) {
      findings.push(
        `unshipped provider: ${label} bundles ${dependency}, which only ${provider.name} depends on`,
      );
    }
  }

  for (const provider of kept) {
    if (!bundled.some((input) => input.startsWith(`${provider.dir}/`))) {
      findings.push(`missing provider: ${label} keeps ${provider.name} but bundles none of it`);
    }
  }

  return findings;
}

/**
 * The external package an input under node_modules belongs to, such as
 * `@zgeoff/imp-client`, or null for a workspace input.
 */
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
  return providers.length === 0 ? 'no providers' : providers.map((p) => p.name).join(', ');
}

await main();
