import type { AgentSessionID, GrantScope, SessionID } from '@atcx/contract';

export interface GrantedSpawn {
  readonly atcAccess: readonly GrantScope[];
  readonly resume: boolean | AgentSessionID;
  readonly hasWorkspace: boolean;
}

export interface GrantedSpawnHolder {
  readonly id: SessionID;
  readonly scopes: readonly GrantScope[];
  readonly isResumable: (agentSessionID: AgentSessionID) => boolean;
}

// The daemon reads a workspace source with its own host's files and
// credentials, and the fleet keeps one row per agent session on a target, so
// neither may reach past the holder's access.
export function findGrantedSpawnRefusal(
  holder: GrantedSpawnHolder,
  spawn: GrantedSpawn,
): string | null {
  const missing = spawn.atcAccess.filter((scope) => !holder.scopes.includes(scope));

  if (missing.length > 0) {
    return `session '${holder.id}' holds atc access ${holder.scopes.join(', ')}, so its spawn cannot grant ${missing.join(', ')}`;
  }

  if (spawn.hasWorkspace) {
    return `session '${holder.id}' holds atc access, so its spawn takes no workspace source; check the work out inside the new session`;
  }

  if (spawn.resume === true) {
    return `session '${holder.id}' holds atc access, so its spawn names the agent session to resume`;
  }

  if (spawn.resume !== false && !holder.isResumable(spawn.resume)) {
    return `session '${holder.id}' holds atc access, so its spawn resumes only an agent session that a session in its reach holds`;
  }

  return null;
}
