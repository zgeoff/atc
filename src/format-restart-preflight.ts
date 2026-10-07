import { parseMismatchBuild } from './parse-mismatch-build';
import type { RestartPlan } from './restart-plan';

const INTERRUPTION_POLICY =
  'Stopping the daemon ends every agent process it hosts. A session that is mid-turn loses that turn; the restore resumes each session from its transcript, and the interrupted turn does not continue.';

/**
 * Renders what a restart is about to do: the daemon it stops, the sessions
 * that are mid-turn, the replacement it starts, and the interruption
 * policy.
 */
export function formatRestartPreflight(plan: RestartPlan): string[] {
  return [...formatTarget(plan), ...formatReplacement(plan), INTERRUPTION_POLICY];
}

function formatTarget(plan: RestartPlan): string[] {
  const pid = plan.pid === null ? 'pid unknown' : `pid ${plan.pid}`;

  if (plan.answer === null) {
    return [
      plan.pid === null
        ? 'no daemon answers and no live pid is recorded; the restart only starts one and restores the fleet'
        : `the daemon (${pid}) does not answer; the restart stops it, starts one, and restores the fleet`,
    ];
  }

  if (plan.answer.kind === 'refused') {
    const parsed = parseMismatchBuild(plan.answer.message);

    return [
      `daemon: ${pid} refused this build's handshake: ${plan.answer.message}`,
      ...(parsed === null
        ? []
        : [`daemon build ${parsed.build} speaks protocol v${parsed.protocol}`]),
      'The session states cannot be read across the protocol mismatch, so the sessions that are mid-turn are unknown.',
    ];
  }

  return [
    `daemon: ${pid}, build ${plan.answer.build}, protocol v${plan.answer.protocol}`,
    ...formatSessions(plan),
  ];
}

function formatSessions(plan: RestartPlan): string[] {
  if (plan.sessions === null) {
    return ['The session list could not be read, so the sessions that are mid-turn are unknown.'];
  }

  const running = plan.sessions.filter((session) => session.state === 'running');

  if (running.length === 0) {
    return ['no session is mid-turn'];
  }

  return [
    `${running.length} session${running.length === 1 ? ' is' : 's are'} mid-turn:`,
    ...running.map(
      (session) =>
        `  ${session.name} (${session.id})${session.id === plan.callerSession ? ' (this session)' : ''}`,
    ),
  ];
}

function formatReplacement(plan: RestartPlan): string[] {
  if (plan.replacement.kind === 'unit') {
    return [
      `replacement: systemd unit ${plan.replacement.unit}${plan.replacement.execStart === null ? '' : `, ExecStart ${plan.replacement.execStart}`}`,
      'The unit decides the build the replacement runs.',
    ];
  }

  return [`replacement: build ${plan.replacement.build}, started with ${plan.replacement.command}`];
}
