import type { Database } from 'bun:sqlite';

// When a grant last reached /mcp, as atc's own OAuth server stamped it before
// atc moved to @zgeoff/mcp-auth, which no code here makes now.
export interface OwnerGrantUse {
  readonly grantID: string;
  readonly lastUsedAt: string;
}

export function seedOwnerGrantUse(sqlite: Database, input: OwnerGrantUse): void {
  sqlite.run('insert into atc_grant_use (grant_id, last_used_at) values (?, ?)', [
    input.grantID,
    input.lastUsedAt,
  ]);
}
