import type { Dialect } from 'kysely';

export interface MCPAuthDatabase {
  readonly dialect: Dialect;

  // releases the file, once Kysely is done with it.
  readonly close: () => void;
}
