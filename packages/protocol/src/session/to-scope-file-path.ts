export function toScopeFilePath(recordPath: string): string {
  return `${recordPath.replace(/\.json$/u, '')}.scope.json`;
}
