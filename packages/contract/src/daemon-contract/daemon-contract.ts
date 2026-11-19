import { eventIterator, oc } from '@orpc/contract';
import { z } from 'zod';
import { AGENT_LIST_SCHEMA } from '../config/agent-list';
import { DAEMON_EVENT_SCHEMA } from '../daemon-events/daemon-event';
import { EVENTS_PAGE_SCHEMA } from '../daemon-events/events-page-schema';
import { TRANSCRIPT_ROW_SCHEMA } from '../daemon-events/transcript-row';
import { HELLO_RESULT_SCHEMA } from '../hello/hello-result';
import { ANSWER_VIEW_SCHEMA } from '../messages/answer-view-schema';
import { MENU_VIEW_SCHEMA } from '../messages/menu-view';
import { MESSAGE_ANSWER_SCHEMA } from '../messages/message-answer-schema';
import { MESSAGE_VIEW_SCHEMA } from '../messages/message-view-schema';
import { NOTE_VIEW_SCHEMA } from '../messages/note-view-schema';
import { SPAWN_ANSWER_SCHEMA } from '../messages/spawn-answer-schema';
import { FLEET_ENTRY_VIEW_SCHEMA } from '../sessions/fleet-entry-view-schema';
import { PUBLISHED_RECORD_SCHEMA } from '../sessions/published-record-schema';
import { SESSION_DESCRIPTOR_SCHEMA } from '../sessions/session-descriptor';
import { SOURCE_CANDIDATE_SCHEMA } from '../sources/source-candidate';
import { SOURCE_INTERPRETATION_SCHEMA } from '../sources/source-interpretation';
import { GIT_PROBE_RESULT_SCHEMA } from '../workspaces/git-probe-result';
import { WORKSPACE_CLEANUP_SCHEMA } from '../workspaces/workspace-cleanup';
import { WORKSPACE_PRUNE_SCHEMA } from '../workspaces/workspace-prune';
import { DAEMON_ERROR_MAP } from './daemon-error-map';
import type { ProcedureMeta } from './procedure-meta';
import { REQUEST_PARAM_SCHEMAS } from './request-param-schemas';

const EMPTY = z.object({});
const STRINGS = z.array(z.string()).readonly();
const FORGET_CONFIRM = z.object({ confirmToken: z.string(), expiresAt: z.number() });

const FORGET_DONE = z.object({
  forgotten: z.literal(true),
  destroyed: z.boolean(),
  workspace: WORKSPACE_CLEANUP_SCHEMA,
});

const PENDING_PROMPT = z.object({ message: z.string() });
const ACT: ProcedureMeta = { access: 'principal', readOnly: false, keyed: false };
const READ: ProcedureMeta = { access: 'principal', readOnly: true, keyed: false };
const KEYED: ProcedureMeta = { access: 'principal', readOnly: false, keyed: true };
const OWNER: ProcedureMeta = { access: 'owner', readOnly: false, keyed: false };
const base = oc.$meta<ProcedureMeta>(ACT).errors(DAEMON_ERROR_MAP);
const PARAMS = REQUEST_PARAM_SCHEMAS;

export const DAEMON_CONTRACT = {
  daemon: {
    hello: base.meta(READ).input(PARAMS['daemon.hello']).output(HELLO_RESULT_SCHEMA),
    ping: base.meta(READ).input(PARAMS['daemon.ping']).output(EMPTY),
    quit: base.meta(OWNER).input(PARAMS['daemon.quit']).output(EMPTY),
    restarted: base.meta(OWNER).input(PARAMS['daemon.restarted']).output(EMPTY),
    backup: base
      .meta(OWNER)
      .input(PARAMS['daemon.backup'])
      .output(z.object({ path: z.string(), bytes: z.number() })),
  },
  workspaces: {
    prune: base.meta(OWNER).input(PARAMS['workspaces.prune']).output(WORKSPACE_PRUNE_SCHEMA),
  },
  dirs: {
    list: base
      .meta(READ)
      .input(PARAMS['dirs.list'])
      .output(z.object({ dirs: STRINGS })),
  },
  agents: {
    list: base.meta(READ).input(PARAMS['agents.list']).output(AGENT_LIST_SCHEMA),
  },
  sources: {
    list: base
      .meta(READ)
      .input(PARAMS['sources.list'])
      .output(
        z.object({
          source: z.string(),
          scope: z.string().nullable(),
          candidates: z.array(SOURCE_CANDIDATE_SCHEMA).readonly(),
        }),
      ),
    interpret: base
      .meta(READ)
      .input(PARAMS['sources.interpret'])
      .output(SOURCE_INTERPRETATION_SCHEMA),

    // Completion runs on the daemon host, not the client: a path completes against the daemon's
    // filesystem, and a relative path resolves under the daemon user's home.
    complete: base
      .meta(READ)
      .input(PARAMS['sources.complete'])
      .output(z.object({ completions: z.array(SOURCE_CANDIDATE_SCHEMA).readonly() })),
  },
  git: {
    probe: base.meta(READ).input(PARAMS['git.probe']).output(GIT_PROBE_RESULT_SCHEMA),
  },
  fleet: {
    list: base
      .meta(READ)
      .input(PARAMS['fleet.list'])
      .output(z.object({ fleet: z.array(FLEET_ENTRY_VIEW_SCHEMA).readonly() })),
    restore: base
      .meta(OWNER)
      .input(PARAMS['fleet.restore'])
      .output(z.object({ restored: z.number() })),
  },
  session: {
    list: base
      .meta(READ)
      .input(PARAMS['session.list'])
      .output(z.object({ sessions: z.array(SESSION_DESCRIPTOR_SCHEMA).readonly() })),
    spawn: base.meta(KEYED).input(PARAMS['session.spawn']).output(SPAWN_ANSWER_SCHEMA),
    kill: base.input(PARAMS['session.kill']).output(z.object({ stopped: z.boolean().optional() })),
    ack: base.input(PARAMS['session.ack']).output(EMPTY),
    forget: base.input(PARAMS['session.forget']).output(z.union([FORGET_CONFIRM, FORGET_DONE])),
    resumeCommand: base
      .meta(READ)
      .input(PARAMS['session.resumeCommand'])
      .output(z.object({ command: z.string() })),
    auth: {
      revoke: base
        .meta(OWNER)
        .input(PARAMS['session.auth.revoke'])
        .output(z.object({ revoked: z.literal(true) })),
      rebind: base
        .meta(OWNER)
        .input(PARAMS['session.auth.rebind'])
        .output(z.object({ revision: z.number(), restartPending: STRINGS })),
    },

    update: base
      .input(PARAMS['session.update'])
      .output(z.object({ renameSkipped: z.string().optional() })),
    scope: {
      add: base
        .input(PARAMS['session.scope.add'])
        .output(z.object({ record: PUBLISHED_RECORD_SCHEMA })),
    },
    attach: base
      .input(PARAMS['session.attach'])
      .output(z.object({ cols: z.number(), rows: z.number() })),
    detach: base.input(PARAMS['session.detach']).output(EMPTY),

    // A watcher receives the session's output without counting toward its
    // size. seq is the last output the replay holds, so the live output that
    // follows starts at seq + 1.
    watch: base
      .meta(READ)
      .input(PARAMS['session.watch'])
      .output(
        z.object({ cols: z.number(), rows: z.number(), seq: z.number(), replay: z.string() }),
      ),
    input: base.input(PARAMS['session.input']).output(EMPTY),
    submit: base.input(PARAMS['session.submit']).output(EMPTY),
    resize: base.input(PARAMS['session.resize']).output(EMPTY),
    screen: base
      .meta(READ)
      .input(PARAMS['session.screen'])
      .output(z.object({ text: z.string(), cols: z.number(), rows: z.number() })),

    // A list longer than the screen is read with arrow keys that move the
    // cursor and put it back, so the read picks nothing and stays safe to
    // send again.
    menu: base
      .meta(READ)
      .input(PARAMS['session.menu'])
      .output(z.object({ menu: MENU_VIEW_SCHEMA.nullable() })),

    choose: base.input(PARAMS['session.choose']).output(
      z.object({
        pressed: z.string(),
        menu: MENU_VIEW_SCHEMA.nullable(),
        partial: z.literal(true).optional(),
      }),
    ),
    eject: base.input(PARAMS['session.eject']).output(EMPTY),
    adopt: base.input(PARAMS['session.adopt']).output(EMPTY),
    get: base
      .meta(READ)
      .input(PARAMS['session.get'])
      .output(
        z.object({
          session: SESSION_DESCRIPTOR_SCHEMA,
          prompt: z.string().nullable(),
          lastActivityAt: z.number(),
          pending: PENDING_PROMPT.nullable(),
          result: z.string().nullable(),
          sessionRecord: PUBLISHED_RECORD_SCHEMA.nullable(),
        }),
      ),
    read: base
      .meta(READ)
      .input(PARAMS['session.read'])
      .output(
        z.object({
          rows: z.array(TRANSCRIPT_ROW_SCHEMA).readonly(),
          cursor: z.string(),
          more: z.boolean(),
        }),
      ),
    message: base.meta(KEYED).input(PARAMS['session.message']).output(MESSAGE_ANSWER_SCHEMA),
    tap: base.input(PARAMS['session.tap']).output(EMPTY),
  },
  permission: {
    respond: base.input(PARAMS['permission.respond']).output(EMPTY),
  },
  events: {
    read: base.meta(READ).input(PARAMS['events.read']).output(EVENTS_PAGE_SCHEMA),

    subscribe: base.meta(READ).input(EMPTY).output(eventIterator(DAEMON_EVENT_SCHEMA)),
  },
  message: {
    get: base.meta(READ).input(PARAMS['message.get']).output(MESSAGE_VIEW_SCHEMA),
    ack: base.input(PARAMS['message.ack']).output(MESSAGE_ANSWER_SCHEMA),
  },
  notice: {
    ack: base.input(PARAMS['notice.ack']).output(MESSAGE_ANSWER_SCHEMA),
  },
  note: {
    get: base.meta(READ).input(PARAMS['note.get']).output(NOTE_VIEW_SCHEMA),
  },
  answer: {
    get: base.meta(READ).input(PARAMS['answer.get']).output(ANSWER_VIEW_SCHEMA),
  },
};
