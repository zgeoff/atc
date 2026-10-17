// only a service below the user manager counts, since a user manager cannot
// restart a process in a login session, a scope, or a system service.
export function parseSystemdUnit(cgroupText: string, uid: number): string | null {
  for (const line of cgroupText.split('\n')) {
    const path = line.slice(line.indexOf(':', line.indexOf(':') + 1) + 1);
    const segments = path.split('/').filter((segment) => segment !== '');
    const manager = segments.indexOf(`user@${uid}.service`);

    if (manager === -1) {
      continue;
    }

    const unit = segments.slice(manager + 1).find((segment) => segment.endsWith('.service'));

    if (unit !== undefined) {
      return unit;
    }
  }

  return null;
}
