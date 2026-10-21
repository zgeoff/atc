import type { AgentList } from './create-picker-actors';
import { openFirstSource, quitFlow, renderFlow } from './navigate-picker';
import type { AgentPick, PickerFlow } from './picker-flow';

export function openAgentMenu(flow: PickerFlow) {
  flow.ctx.agentStepWait = 'reading agents…';

  flow.effects.push({ kind: 'request', request: { kind: 'agents' } });

  renderFlow(flow, true);
}

export function applyAgentList(flow: PickerFlow, list: AgentList | null, failure: string | null) {
  const ctx = flow.ctx;
  const deps = flow.deps;

  ctx.agentStepWait = null;
  ctx.listedAgents = list?.agents ?? [];
  ctx.listedTargets = list?.targets ?? [];
  ctx.sources = list?.sources ?? [];
  ctx.picks = collectAgentPicks(ctx.listedAgents);

  ctx.selected = Math.max(
    0,
    ctx.picks.findIndex((pick) => pick.agent === deps.getLastUsedAgent()),
  );

  ctx.agent = ctx.picks[ctx.selected]?.agent ?? deps.getLastUsedAgent();

  if (failure !== null) {
    flow.effects.push({ kind: 'log', line: `agent list failed: ${failure}` });

    ctx.refusal = `cannot read the agents: ${failure} · esc cancel`;
  } else if (ctx.picks.length === 1) {
    openFirstSource(flow);

    return;
  }

  renderFlow(flow);
}

export function applyAgentSubmit(flow: PickerFlow) {
  const pick = flow.ctx.picks[flow.ctx.selected];

  if (pick === undefined) {
    return;
  }

  flow.ctx.agent = pick.agent;

  openFirstSource(flow);
}

export function applyAgentCancel(flow: PickerFlow) {
  quitFlow(flow);
}

function collectAgentPicks(agents: AgentList['agents']): AgentPick[] {
  return agents.flatMap((agent) =>
    agent.installed && agent.capabilities.spawn ? [{ agent: agent.id, label: agent.label }] : [],
  );
}
