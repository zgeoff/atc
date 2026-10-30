import type { AgentID, StepTimer } from '@atc/core';
import type { AgentAdapter, ExecutionProvider, SpawnOverrides } from '@atc/plugin-api';
import type { DeclaredScope } from '@atc/protocol';
import type { AgentSessionID, GrantScope, SessionID } from '@atcx/contract';
import type { AuthSetup } from '../auth/create-auth-setup';
import type { SessionRegistry } from './create-session-registry';
import type { Session } from './session';
import type { SpawnMaterializer } from './spawn-materializer';

// What a spawn settled on before its first step: the agent, the target and
// its host, the auth the harness takes, and the caller's request.
export interface SpawnRequest {
  readonly adapter: AgentAdapter;
  readonly provider: ExecutionProvider;
  readonly execution: ReturnType<SessionRegistry['requireExecution']>;
  readonly auth: ReturnType<AuthSetup['resolveHarnessAuth']>;
  readonly id: SessionID;
  readonly hostKey: SessionID;
  readonly target: string;
  readonly cwd: string;
  readonly name: string;
  readonly prompt: string;
  readonly cols: number;
  readonly rows: number;
  readonly resume: boolean | AgentSessionID;
  readonly namedBy: 'user' | 'auto';
  readonly agent: AgentID;
  readonly parent: SessionID | null;
  readonly spawner: SessionID | null;
  readonly atcAccess: readonly GrantScope[] | null;
  readonly overrides: SpawnOverrides;
  readonly materialize: SpawnMaterializer | null;
  readonly requireInReach: () => void;
  readonly autoDir: boolean;
  readonly scope: DeclaredScope | null;
  readonly trustClonedWorkspace: boolean;
  readonly parentTrustedRoot: string | null;
  readonly timer: StepTimer;

  // Builds the caller's answer once the harness started, as the spawn's
  // last step, so a failure there unwinds the spawn too.
  readonly answer: ((session: Session) => void) | null;
}
