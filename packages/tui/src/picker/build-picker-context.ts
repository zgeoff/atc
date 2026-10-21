import type { WorkspacesConfig } from '@atc/config';
import { DEFAULT_GIT_TRANSPORTS } from '@atc/config';
import type { AgentID } from '@atc/core';
import type { PickerContext } from './picker-flow';

const NO_WORKSPACES: WorkspacesConfig = {
  githubOwner: null,
  sources: null,
  gitTransports: DEFAULT_GIT_TRANSPORTS,
  root: null,
  targetRoots: new Map(),
};

export function buildPickerContext(
  resume: boolean,
  agent: AgentID,
  workspaces: WorkspacesConfig = NO_WORKSPACES,
): PickerContext {
  return {
    step: 'agent',
    resume,
    sources: [],
    sourceIndex: -1,
    input: '',
    selected: 0,
    picks: [],
    listedAgents: [],
    listedTargets: [],
    agentStepWait: null,
    dirs: [],
    dirLabels: new Map(),
    completed: null,
    completion: null,
    workspaces,
    directory: '',
    targets: [],
    target: null,
    targetGap: null,
    candidates: [],
    listedScope: null,
    listNotice: null,
    listedKey: null,
    listing: null,
    listedFrom: null,
    refreshFailure: null,
    requestedScope: null,
    pathListing: false,
    sourceDraft: '',
    sourceAction: { kind: 'none' },
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
