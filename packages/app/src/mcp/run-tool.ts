import { createHash } from 'node:crypto';
import { isRecord } from '@atc/core';
import { DaemonError } from '@atc/protocol/wire';
import { match } from 'ts-pattern';
import { parseIdempotencyKey } from './parse-idempotency-key';
import { readEventTexts } from './read-event-texts';
import type { FleetCaller, ToolContext } from './types';

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
    .with('atc_sessions_list', async () => {
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
        ...(args['pluginDirs'] === undefined ? {} : { pluginDirs: args['pluginDirs'] }),
        ...(key === undefined ? {} : { idempotencyKey: key }),
        ...(args['target'] === undefined ? {} : { target: args['target'] }),
        ...(args['workspace'] === undefined ? {} : { workspace: args['workspace'] }),
        ...(args['trustClonedWorkspace'] === undefined
          ? {}
          : { trustClonedWorkspace: args['trustClonedWorkspace'] }),
        ...(args['scope'] === undefined ? {} : { scope: args['scope'] }),
        cols: 100,
        rows: 30,
      };

      const ok =
        nested && ctx.callerSessionID !== null
          ? await sendNestedSpawn(caller, params, ctx.callerSessionID)
          : await caller.sendRequest('session.spawn', params);

      // A spawn whose workspace left changes behind returns its warnings
      // beside the session's own fields.
      const warnings = ok['warnings'];

      const session =
        warnings === undefined || !isRecord(ok['session'])
          ? ok['session']
          : { ...ok['session'], warnings };

      return buildObjectResult(session);
    })
    .with('atc_terminal_type', async () => {
      await caller.sendRequest('session.submit', {
        session: args['session'],
        text: typeof args['text'] === 'string' ? args['text'] : '',
      });

      return buildObjectResult({ written: true });
    })
    .with('atc_terminal_choose', async () => {
      // A choice without a token could only be checked against a menu the
      // caller never read, so it presses nothing.
      if (
        args['menuToken'] === undefined &&
        (args['option'] !== undefined || args['label'] !== undefined || args['key'] !== undefined)
      ) {
        throw new DaemonError(
          'bad_args',
          'a choice takes the menuToken of the menu it answers; call with session alone to read it',
        );
      }

      if (args['menuToken'] === undefined) {
        const ok = await caller.sendRequest('session.menu', { session: args['session'] });

        return buildObjectResult({ menu: ok['menu'] });
      }

      const ok = await caller.sendRequest('session.choose', {
        session: args['session'],
        menuToken: args['menuToken'],
        ...(args['option'] === undefined ? {} : { option: args['option'] }),
        ...(args['label'] === undefined ? {} : { label: args['label'] }),
        ...(args['key'] === undefined ? {} : { key: args['key'] }),
      });

      return buildObjectResult({
        pressed: ok['pressed'],
        menu: ok['menu'],
        ...(ok['partial'] === true ? { partial: true } : {}),
      });
    })
    .with('atc_terminal_read', async () => {
      const ok = await caller.sendRequest('session.screen', { session: args['session'] });

      return {
        text: typeof ok['text'] === 'string' ? ok['text'] : JSON.stringify(ok),
        structured: null,
      };
    })
    .with('atc_session_update', async () => {
      const ok = await caller.sendRequest('session.update', {
        session: args['session'],
        ...(typeof args['name'] === 'string' ? { name: args['name'] } : {}),
        ...(typeof args['pinned'] === 'boolean' ? { pinned: args['pinned'] } : {}),
        ...(args['parent'] === null ? { parent: null } : {}),
      });

      if (ok['renameSkipped'] === 'agent_named') {
        return {
          text: 'updated, not renamed: the agent named this session itself with /rename, and a name the agent sets wins over one set here. Any pin or detach in the call applied.',
          structured: null,
        };
      }

      return { text: 'updated', structured: null };
    })
    .with('atc_session_scope_add', async () => {
      const ok = await caller.sendRequest('session.scope.add', {
        session: args['session'],
        scope: args['scope'],
      });

      return { text: JSON.stringify(ok), structured: ok };
    })
    .with('atc_session_stop', async () => {
      // A stop never removes a session, so an exited one stays listed until
      // a forget removes it.
      const ok = await caller.sendRequest('session.kill', {
        session: args['session'],
        stopOnly: true,
      });

      return buildObjectResult({ stopped: ok['stopped'] === true });
    })
    .with('atc_session_adopt', async () => {
      await caller.sendRequest('session.adopt', { session: args['session'], cols: 100, rows: 30 });

      return buildObjectResult({ adopted: true });
    })
    .with('atc_session_auth_rebind', async () => {
      const ok = await caller.sendRequest('session.auth.rebind', { session: args['session'] });

      return buildObjectResult({
        revision: ok['revision'],
        restartPending: Array.isArray(ok['restartPending']) ? ok['restartPending'] : [],
      });
    })
    .with('atc_session_forget', async () => {
      const params = {
        session: args['session'],
        ...(typeof args['confirmToken'] === 'string' ? { confirmToken: args['confirmToken'] } : {}),
      };

      const ok = await sendGuardedForget(caller, params, args['stop'] === true);

      return buildObjectResult(ok);
    })
    .with('atc_session_mark_read', async () => {
      await caller.sendRequest('session.ack', { session: args['session'] });

      return { text: 'marked read', structured: null };
    })
    .with('atc_recent_dirs_list', async () => {
      const params = typeof args['daemon'] === 'string' ? { daemon: args['daemon'] } : {};

      const ok = await caller.sendRequest('dirs.list', params);

      return { text: JSON.stringify(ok['dirs'], null, 2), structured: { dirs: ok['dirs'] } };
    })
    .with('atc_daemons_list', async () => {
      const ok = await caller.sendRequest('daemons.list');

      return buildObjectResult(ok);
    })
    .with('atc_spawn_options_get', async () => {
      const ok = await caller.sendRequest('agents.list');

      return buildObjectResult(ok);
    })
    .with('atc_session_get', async () => {
      const ok = await caller.sendRequest('session.get', { session: args['session'] });

      return buildObjectResult(ok);
    })
    .with('atc_transcript_read', async () => {
      const ok = await caller.sendRequest('session.read', {
        session: args['session'],
        ...(typeof args['cursor'] === 'string' ? { cursor: args['cursor'] } : {}),
        ...(typeof args['limit'] === 'number' ? { limit: args['limit'] } : {}),
      });

      return buildObjectResult(ok);
    })
    .with('atc_events_read', async () => {
      const previewOnly = args['previewOnly'] === true;

      const ok = await caller.sendRequest('events.read', {
        ...(typeof args['cursor'] === 'string' ? { cursor: args['cursor'] } : {}),
        ...(typeof args['limit'] === 'number' ? { limit: args['limit'] } : {}),
        ...(typeof args['waitMs'] === 'number' ? { waitMs: args['waitMs'] } : {}),
        ...(typeof args['session'] === 'string' ? { session: args['session'] } : {}),
      });

      // Each note's whole text and each message's whole answer ride the
      // same call, so a reader catches up without one read per event.
      const page = previewOnly ? ok : await readEventTexts(caller, ok);

      return buildObjectResult(buildPageWithoutTextHandles(page));
    })
    .with('atc_message_send', async () => {
      const key = parseIdempotencyKey(args['idempotencyKey']);
      const legacyFrom = args['from'];

      const ok = await caller.sendRequest('session.message', {
        session: args['session'],
        text: args['text'],
        ...(key === undefined ? {} : { idempotencyKey: key }),
        ...(key !== undefined &&
        ctx.passesLegacyFrom === true &&
        typeof legacyFrom === 'string' &&
        legacyFrom !== ''
          ? { from: legacyFrom }
          : {}),
      });

      return buildObjectResult(ok);
    })
    .with('atc_message_get', async () => {
      const ok = await caller.sendRequest('message.get', {
        message: args['message'],
        ...(typeof args['waitMs'] === 'number' ? { waitMs: args['waitMs'] } : {}),
      });

      return buildObjectResult(ok);
    })
    .otherwise(() => Promise.reject(new Error(`unknown tool '${name}'`)));
}

// A page without the per-event note and answer handles, which only a text
// read takes and no tool offers to a caller.
function buildPageWithoutTextHandles(
  page: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const events: unknown = page['events'];

  if (!Array.isArray(events)) {
    return page;
  }

  return {
    ...page,
    events: events.map((event: unknown) => {
      if (!isRecord(event)) {
        return event;
      }

      const { note: _note, answer: _answer, ...rest } = event;

      return rest;
    }),
  };
}

function buildObjectResult(value: unknown): ToolResult {
  return {
    text: JSON.stringify(value, null, 2),
    structured: isRecord(value) ? value : null,
  };
}

// The refusals of a forget, worded for an MCP client.
const SESSION_PINNED_REFUSAL =
  'session_pinned: the session is pinned, or is a sub-session of a pinned session and the call does not come from inside its parent. Unpin it, or detach the sub-session with parent null, through atc_session_update before forgetting it.';

const SESSION_LIVE_REFUSAL =
  'session_live: the session is live. Pass stop: true to stop and forget it.';

// the daemon checks pinned and live in the same step that forgets, so a pin or
// revive that lands just before the forget still refuses it.
async function sendGuardedForget(
  caller: FleetCaller,
  params: Readonly<Record<string, unknown>>,
  stops: boolean,
): Promise<Readonly<Record<string, unknown>>> {
  try {
    return await caller.sendRequest('session.forget', {
      ...params,
      refusePinned: true,
      refuseLive: !stops,
    });
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error)) {
      throw error;
    }

    if (error.code === 'session_pinned') {
      throw new Error(SESSION_PINNED_REFUSAL, { cause: error });
    }

    if (error.code === 'session_live') {
      throw new Error(SESSION_LIVE_REFUSAL, { cause: error });
    }

    throw error;
  }
}

// the inherited id can point at a session another daemon hosts, or one this
// daemon no longer lists; the spawn then lands top-level instead of failing.
async function sendNestedSpawn(
  caller: FleetCaller,
  params: Readonly<Record<string, unknown>>,
  parent: string,
): Promise<Readonly<Record<string, unknown>>> {
  try {
    return await caller.sendRequest('session.spawn', { ...params, parent });
  } catch (error) {
    // an answer that holds an effect id is a keyed spawn that already ran, which a
    // top-level spawn would only duplicate.
    if (
      error instanceof DaemonError &&
      error.code === 'no_such_session' &&
      error.data?.['effectRef'] === undefined
    ) {
      return caller.sendRequest('session.spawn', buildTopLevelParams(params));
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

  // the top-level spawn has a different payload, so it runs under its own key. A retry
  // derives the same key and replays it instead of conflicting with the nested key,
  // and the fixed-length hash fits the daemon's cap whatever the caller's length.
  const digest = createHash('sha256').update(key).digest('hex');

  return { ...params, idempotencyKey: `top-level:${digest}` };
}
