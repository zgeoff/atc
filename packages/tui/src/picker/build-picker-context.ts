import type { WorkspacesConfig } from '@atc/config';
import { DEFAULT_GIT_TRANSPORTS } from '@atc/config';
import type { AgentID } from '@atc/core';
import type { DaemonName } from '../session-key';
import type { PickerContext } from './picker-flow';

const NO_WORKSPACES: WorkspacesConfig = {
  gitTransports: DEFAULT_GIT_TRANSPORTS,
  root: null,
  targetRoots: new Map(),
  cleanup: { enabled: true, check: 'unpushed' },
};

export function buildPickerContext(
  resume: boolean,
  agent: AgentID,
  daemon: DaemonName,
  workspaces: WorkspacesConfig = NO_WORKSPACES,
): PickerContext {
  return {
    step: 'agent',
    resume,
    daemon,
    daemons: [],
    sources: [],
    sourceIndex: -1,
    input: '',
    selected: 0,
    picks: [],
    listedAgents: [],
    listedTargets: [],
    agentStepWait: null,
    listings: new Map(),
    listingTarget: null,
    listMark: null,
    completed: null,
    completion: null,
    workspaces,
    directory: '',
    targets: [],
    target: null,
    targetGap: null,
    gitPick: null,
    alternateURL: null,
    repo: null,
    ref: null,
    destination: '',
    destinationAttempt: 1,
    destinationEdited: false,
    destinationRepoURL: null,
    autoDestination: null,
    name: '',
    agent,
    refusal: null,
    pending: null,
    spawnedID: null,
    spawnedWarnings: [],
  };
}
