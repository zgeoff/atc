import type { Dialect } from 'kysely';

/**
 * An open authorization database as the entry hands it to the server: the
 * Kysely dialect over it, and the close that releases the file once Kysely
 * is done with it.
 */
export interface MCPAuthDatabase {
  readonly dialect: Dialect;
  readonly close: () => void;
}
