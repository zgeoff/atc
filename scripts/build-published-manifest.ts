interface WorkspaceManifest {
  readonly version: string;
  readonly exports: Readonly<Record<string, string>>;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly [field: string]: unknown;
}

// The entries a consumer imports: a package's test helpers stay in the repository.
export function buildPublishedExports(
  exports: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(exports).filter(([subpath]) => !subpath.startsWith('./test-utils/')),
  );
}

// The workspace manifest points each entry at its TypeScript source and each
// dependency at the root catalog or a workspace package, none of which an npm
// consumer can read. A workspace package publishes at a caret range of its own version.
export function buildPublishedManifest(
  manifest: WorkspaceManifest,
  catalog: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const { devDependencies: _devDependencies, ...published } = manifest;

  return {
    ...published,
    exports: Object.fromEntries(
      Object.entries(buildPublishedExports(manifest.exports)).map(([subpath, entry]) => {
        const built = entry.replace(/^\.\/src\//u, './dist/').replace(/\.ts$/u, '');

        return [subpath, { types: `${built}.d.ts`, default: `${built}.js` }];
      }),
    ),
    files: ['dist'],
    dependencies: Object.fromEntries(
      Object.entries(manifest.dependencies).map(([name, version]) => {
        const pinned = pinVersion(version, name, manifest.version, catalog);

        if (pinned === undefined) {
          throw new Error(`the catalog has no version of ${name}`);
        }

        return [name, pinned];
      }),
    ),
  };
}

function pinVersion(
  version: string,
  name: string,
  own: string,
  catalog: Readonly<Record<string, string>>,
): string | undefined {
  if (version === 'catalog:') {
    return catalog[name];
  }

  return version.startsWith('workspace:') ? `^${own}` : version;
}
