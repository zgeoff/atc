// OAuth client IDs are random alphanumeric strings, which never hold a colon,
// so a service client's ID can never equal an OAuth client's.
export function buildServiceClientID(name: string): string {
  return `service:${name}`;
}
