interface WorkspaceManifest {
  readonly exports: Readonly<Record<string, string>>;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly [field: string]: unknown;
}

// The workspace manifest points each entry at its TypeScript source and each
// dependency at the root catalog, neither of which an npm consumer can read.
export function buildPublishedManifest(
  manifest: WorkspaceManifest,
  catalog: Readonly<Record<string, string>>,
): Record<string, unknown> {
  return {
    ...manifest,
    exports: Object.fromEntries(
      Object.entries(manifest.exports).map(([subpath, entry]) => {
        const built = entry.replace(/^\.\/src\//u, './dist/').replace(/\.ts$/u, '');

        return [subpath, { types: `${built}.d.ts`, default: `${built}.js` }];
      }),
    ),
    files: ['dist'],
    dependencies: Object.fromEntries(
      Object.entries(manifest.dependencies).map(([name, version]) => {
        const pinned = version === 'catalog:' ? catalog[name] : version;

        if (pinned === undefined) {
          throw new Error(`the catalog has no version of ${name}`);
        }

        return [name, pinned];
      }),
    ),
  };
}
