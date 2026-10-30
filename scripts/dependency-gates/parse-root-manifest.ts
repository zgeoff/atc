import { isRecord } from './is-record.ts';

export interface RootManifest {
  readonly overrides: Readonly<Record<string, string>>;
  readonly catalog: Readonly<Record<string, string>>;
  readonly catalogs: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly auditScript: string;
}

export function parseRootManifest(text: string): RootManifest {
  const manifest: unknown = JSON.parse(text);

  if (!isRecord(manifest)) {
    throw new TypeError('package.json holds no object');
  }

  const workspaces = manifest['workspaces'];
  const catalog = isRecord(workspaces) ? workspaces['catalog'] : undefined;
  const catalogs = isRecord(workspaces) ? workspaces['catalogs'] : undefined;
  const scripts = manifest['scripts'];
  const audit = isRecord(scripts) ? scripts['audit'] : undefined;

  return {
    overrides: parseVersions(manifest['overrides'], 'overrides'),
    catalog: parseVersions(catalog, 'workspaces.catalog'),
    catalogs: parseNamedCatalogs(catalogs),
    auditScript: typeof audit === 'string' ? audit : '',
  };
}

function parseVersions(value: unknown, field: string): Record<string, string> {
  if (value === undefined) {
    return {};
  }

  if (!isRecord(value)) {
    throw new TypeError(`package.json sets ${field} to a value that is not an object`);
  }

  return Object.fromEntries(
    Object.entries(value).map(([name, version]) => {
      if (typeof version !== 'string') {
        throw new TypeError(
          `package.json sets the ${field} entry for ${name} to a value that is not a version`,
        );
      }

      return [name, version];
    }),
  );
}

function parseNamedCatalogs(value: unknown): Record<string, Record<string, string>> {
  if (value === undefined) {
    return {};
  }

  if (!isRecord(value)) {
    throw new TypeError('package.json sets workspaces.catalogs to a value that is not an object');
  }

  return Object.fromEntries(
    Object.entries(value).map(([catalogName, versions]) => [
      catalogName,
      parseVersions(versions, `workspaces.catalogs.${catalogName}`),
    ]),
  );
}
