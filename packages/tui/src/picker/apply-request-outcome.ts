import { match } from 'ts-pattern';
import { applyAccessProbe, applyReadOutcome } from './apply-list-submit';
import { applySpawnOutcome } from './apply-prompt-submit';
import { applyRefreshProbe, applyResolveProbe } from './apply-ref-submit';
import type { RequestOutcome } from './create-picker-actors';
import { applyAgentList } from './open-agent-menu';
import type { PickerFlow } from './picker-flow';

export function applyRequestOutcome(flow: PickerFlow, outcome: RequestOutcome) {
  if (outcome.kind !== 'agents') {
    flow.ctx.pending = null;
  }

  match(outcome)
    .with({ kind: 'agents' }, (agents) => {
      applyAgentList(flow, agents.list, agents.failure);
    })
    .with({ kind: 'read' }, (read) => {
      applyReadOutcome(flow, read);
    })
    .with({ kind: 'probe' }, (probe) => {
      match(probe.request.followUp)
        .with({ kind: 'access' }, (access) => {
          applyAccessProbe(flow, probe, access.label);
        })
        .with({ kind: 'refresh' }, (refresh) => {
          applyRefreshProbe(flow, probe, refresh.reason, refresh.repo);
        })
        .with({ kind: 'resolve' }, (resolve) => {
          applyResolveProbe(flow, probe, resolve.typed);
        })
        .exhaustive();
    })
    .with({ kind: 'spawn' }, (spawn) => {
      applySpawnOutcome(flow, spawn);
    })
    .exhaustive();
}
