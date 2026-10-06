import { createHash } from 'node:crypto';
import { match } from 'ts-pattern';
import { DaemonError } from '../protocol/daemon-error';
import type { DaemonFeature } from '../protocol/daemon-features';
import { isRecord } from '../shared/report';
import { parseIdempotencyKey } from './parse-idempotency-key';
import { readReportTexts } from './read-report-texts';
import type { FleetCaller, ToolContext } from './types';

/**
 * A tool's result: the text every client reads, and for a tool whose result
 * is data, that data as an object for clients that read structured content.
 */
interface ToolResult {
  readonly text: string;
  readonly structured: Readonly<Record<string, unknown>> | null;
}

export function runTool(
  caller: FleetCaller,
  name: string,
  args: Readonly<Record<string, unknown>>,
  ctx: ToolContext,
): Promise<ToolResult> {
  return match(name)
    .with('atc_session_list', async () => {
      const ok = await caller.sendRequest('session.list');

      // A caller that routes across named daemons adds each daemon's state,
      // so a daemon that is down never reads as one with no sessions.
      if (ok['daemons'] !== undefined) {
        return buildObjectResult({ sessions: ok['sessions'], daemons: ok['daemons'] });
      }

      // The text stays the bare list older clients read; structured content
      // has to be an object.
      return {
        text: JSON.stringify(ok['sessions'], null, 2),
        structured: { sessions: ok['sessions'] },
      };
    })
    .with('atc_session_spawn', async () => {
      const rawAgent = args['agent'];
      const nested = args['detached'] !== true && ctx.callerSessionID !== null;
      const key = parseIdempotencyKey(args['idempotencyKey']);

      const params = {
        ...(typeof args['daemon'] === 'string' ? { daemon: args['daemon'] } : {}),
        ...(args['cwd'] === undefined ? {} : { cwd: args['cwd'] }),
        ...(typeof args['name'] === 'string' ? { name: args['name'] } : {}),
        ...(typeof args['prompt'] === 'string' ? { prompt: args['prompt'] } : {}),
        ...(rawAgent === undefined ? {} : { agent: rawAgent }),
        ...(args['model'] === undefined ? {} : { model: args['model'] }),
        ...(args['effort'] === undefined ? {} : { effort: args['effort'] }),
        ...(key === undefined ? {} : { idempotencyKey: key }),
        ...(args['target'] === undefined ? {} : { target: args['target'] }),
        ...(args['workspace'] === undefined ? {} : { workspace: args['workspace'] }),
        ...(args['trustClonedWorkspace'] === undefined
          ? {}
          : { trustClonedWorkspace: args['trustClonedWorkspace'] }),
        cols: 100,
        rows: 30,
      };

      // A model, effort, key, target, or workspace needs a daemon that takes
      // them; the check runs on every connection the spawn rides.
      const optionFeatures: readonly DaemonFeature[] =
        args['model'] === undefined && args['effort'] === undefined ? [] : ['spawn.options'];

      const keyFeatures: readonly DaemonFeature[] = key === undefined ? [] : ['spawn.idempotency'];

      const targetFeatures: readonly DaemonFeature[] =
        args['target'] === undefined ? [] : ['spawn.target'];

      const workspaceFeatures: readonly DaemonFeature[] =
        args['workspace'] === undefined ? [] : ['spawn.workspace'];

      const trustFeatures: readonly DaemonFeature[] =
        args['trustClonedWorkspace'] === undefined ? [] : ['spawn.workspace.trust'];

      // Only a daemon that picks a git workspace's directory takes one
      // without a cwd.
      const autoDirFeatures: readonly DaemonFeature[] =
        args['cwd'] === undefined && args['workspace'] !== undefined
          ? ['spawn.workspace.autoDir']
          : [];

      const required = [
        ...optionFeatures,
        ...keyFeatures,
        ...targetFeatures,
        ...workspaceFeatures,
        ...trustFeatures,
        ...autoDirFeatures,
      ];

      const ok =
        nested && ctx.callerSessionID !== null
          ? await sendNestedSpawn(caller, params, ctx.callerSessionID, required)
          : await caller.sendRequest('session.spawn', params, required);

      // A spawn whose workspace left changes behind returns its warnings
      // beside the session's own fields.
      const warnings = ok['warnings'];

      const session =
        warnings === undefined || !isRecord(ok['session'])
          ? ok['session']
          : { ...ok['session'], warnings };

      return buildObjectResult(session);
    })
    .with('atc_session_input', async () => {
      // An older daemon would take the line as raw input, which some agents
      // never submit.
      await caller.sendRequest(
        'session.submit',
        {
          session: args['session'],
          text: typeof args['text'] === 'string' ? args['text'] : '',
        },
        ['session.submit'],
      );

      return { text: 'sent', structured: null };
    })
    .with('atc_session_screen', async () => {
      const ok = await caller.sendRequest('session.screen', { session: args['session'] });

      return {
        text: typeof ok['text'] === 'string' ? ok['text'] : JSON.stringify(ok),
        structured: null,
      };
    })
    .with('atc_session_update', async () => {
      await caller.sendRequest('session.update', {
        session: args['session'],
        ...(typeof args['name'] === 'string' ? { name: args['name'] } : {}),
        ...(typeof args['pinned'] === 'boolean' ? { pinned: args['pinned'] } : {}),
      });

      return { text: 'updated', structured: null };
    })
    .with('atc_session_kill', async () => {
      await caller.sendRequest('session.kill', { session: args['session'] });

      return { text: 'killed', structured: null };
    })
    .with('atc_session_ack', async () => {
      await caller.sendRequest('session.ack', { session: args['session'] });

      return { text: 'acked', structured: null };
    })
    .with('atc_resume_command', async () => {
      const ok = await caller.sendRequest('session.resumeCommand', { session: args['session'] });

      return {
        text: typeof ok['command'] === 'string' ? ok['command'] : JSON.stringify(ok),
        structured: null,
      };
    })
    .with('atc_dirs_list', async () => {
      const params = typeof args['daemon'] === 'string' ? { daemon: args['daemon'] } : {};

      const ok = await caller.sendRequest('dirs.list', params);

      return { text: JSON.stringify(ok['dirs'], null, 2), structured: { dirs: ok['dirs'] } };
    })
    .with('atc_daemons_list', async () => {
      const ok = await caller.sendRequest('daemons.list');

      return buildObjectResult(ok);
    })
    .with('atc_agents_list', async () => {
      const ok = await caller.sendRequest('agents.list', {}, ['agents.list']);

      return buildObjectResult(ok);
    })
    .with('atc_session_get', async () => {
      const ok = await caller.sendRequest('session.get', { session: args['session'] });

      return buildObjectResult(ok);
    })
    .with('atc_session_read', async () => {
      const ok = await caller.sendRequest('session.read', {
        session: args['session'],
        ...(typeof args['cursor'] === 'string' ? { cursor: args['cursor'] } : {}),
        ...(typeof args['limit'] === 'number' ? { limit: args['limit'] } : {}),
      });

      return buildObjectResult(ok);
    })
    .with('atc_events_read', async () => {
      const filtered = typeof args['session'] === 'string' && args['session'] !== '';
      const required: DaemonFeature[] = filtered ? ['events.session'] : [];

      const ok = await caller.sendRequest(
        'events.read',
        {
          ...(typeof args['cursor'] === 'string' ? { cursor: args['cursor'] } : {}),
          ...(typeof args['limit'] === 'number' ? { limit: args['limit'] } : {}),
          ...(typeof args['waitMs'] === 'number' ? { waitMs: args['waitMs'] } : {}),
          ...(typeof args['session'] === 'string' ? { session: args['session'] } : {}),
        },
        required,
      );

      // Each report's whole text rides the same call, so a reader catches
      // up without one report read per report.
      if (args['reportText'] === true) {
        const withTexts = await readReportTexts(caller, ok);

        return buildObjectResult(withTexts);
      }

      return buildObjectResult(ok);
    })
    .with('atc_report_get', async () => {
      const ok = await caller.sendRequest('report.get', { report: args['report'] }, ['report.get']);

      return buildObjectResult(ok);
    })
    .with('atc_session_message', async () => {
      const given = args['from'];

      const from =
        ctx.sender.kind === 'default' && typeof given === 'string' && given !== ''
          ? given
          : ctx.sender.name;

      const key = parseIdempotencyKey(args['idempotencyKey']);
      const required: DaemonFeature[] = key === undefined ? [] : ['message.idempotency'];

      const ok = await caller.sendRequest(
        'session.message',
        {
          session: args['session'],
          text: args['text'],
          from,
          ...(key === undefined ? {} : { idempotencyKey: key }),
        },
        required,
      );

      return buildObjectResult(ok);
    })
    .with('atc_message_get', async () => {
      const waits = typeof args['waitMs'] === 'number' && args['waitMs'] > 0;
      const required: DaemonFeature[] = waits ? ['message.wait'] : [];

      const ok = await caller.sendRequest(
        'message.get',
        {
          message: args['message'],
          ...(typeof args['waitMs'] === 'number' ? { waitMs: args['waitMs'] } : {}),
        },
        required,
      );

      return buildObjectResult(ok);
    })
    .otherwise(() => Promise.reject(new Error(`unknown tool '${name}'`)));
}

function buildObjectResult(value: unknown): ToolResult {
  return {
    text: JSON.stringify(value, null, 2),
    structured: isRecord(value) ? value : null,
  };
}

// The inherited id can point at a session another daemon hosts, or one
// this daemon no longer lists; the spawn then lands top-level instead of
// failing the tool call. The top-level spawn has a different payload, so it
// runs under its own key, a fixed-length hash of the caller's: a retry of the
// tool call derives the same key and replays it rather than conflicting with
// the nested attempt's key, and the derived key fits the daemon's cap
// whatever the caller's length. An answer
// that holds an effect id is a keyed spawn that already ran, which a
// top-level spawn would only duplicate.
async function sendNestedSpawn(
  caller: FleetCaller,
  params: Readonly<Record<string, unknown>>,
  parent: string,
  required: readonly DaemonFeature[],
): Promise<Readonly<Record<string, unknown>>> {
  try {
    return await caller.sendRequest('session.spawn', { ...params, parent }, required);
  } catch (error) {
    if (
      error instanceof DaemonError &&
      error.code === 'no_such_session' &&
      error.data?.['effectRef'] === undefined
    ) {
      return caller.sendRequest('session.spawn', buildTopLevelParams(params), required);
    }

    throw error;
  }
}

function buildTopLevelParams(
  params: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const key = params['idempotencyKey'];

  if (typeof key !== 'string') {
    return params;
  }

  const digest = createHash('sha256').update(key).digest('hex');

  return { ...params, idempotencyKey: `top-level:${digest}` };
}
