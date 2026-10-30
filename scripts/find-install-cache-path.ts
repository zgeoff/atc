// A path segment, so `node_modules_backup` and `.bun/install/cache-old` are other folders.
const installCachePattern = /(?:^|\/)(?:node_modules|\.bun\/install\/cache)(?:\/|$)/u;

// actions/cache reads one path per line, and a line that starts with `!` leaves that path out. A
// line that holds an expression is left alone, because GitHub resolves it only when the job runs.
export function findInstallCachePath(paths: unknown): string | undefined {
  return typeof paths === 'string'
    ? paths
        .split('\n')
        .map((path) => path.trim())
        .find(
          (path) =>
            !path.startsWith('!') && !path.includes('${{') && installCachePattern.test(path),
        )
    : undefined;
}
