import { z } from 'zod';
import { SESSION_WORKSPACE_SCHEMA } from './session-workspace';

/**
 * One stored fleet row as `fleet.list` answers it: what a restart restores
 * a session from. An absent field has no stored value.
 */
export const FLEET_ENTRY_VIEW_SCHEMA = z.object({
  sessionID: z.string(),
  name: z.string(),
  cwd: z.string(),
  agentSessionID: z.string().optional(),
  agent: z.string(),
  pinned: z.boolean().optional(),
  lastAttachedAt: z.number().optional(),
  exited: z.boolean().optional(),
  parent: z.string().optional(),
  prompt: z.string().optional(),
  result: z.string().optional(),
  transcriptPath: z.string().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  target: z.string().optional(),
  targetIdentity: z.string().optional(),
  workspace: SESSION_WORKSPACE_SCHEMA.optional(),
  withheldEnv: z.array(z.string()).readonly().optional(),
  desired: z.enum(['sleep', 'stop']).optional(),
  hostKey: z.string().optional(),
});
