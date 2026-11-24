import { z } from 'zod';
import { DAEMON_CONTRACT } from '../daemon-contract/daemon-contract';
import { REQUEST_PARAM_SCHEMAS } from '../daemon-contract/request-param-schemas';
import { TRANSCRIPT_ROW_SCHEMA } from '../daemon-events/transcript-row';
import { ANSWER_VIEW_SCHEMA } from '../messages/answer-view-schema';
import { MENU_VIEW_SCHEMA } from '../messages/menu-view';
import { MESSAGE_ANSWER_SCHEMA } from '../messages/message-answer-schema';
import { MESSAGE_VIEW_SCHEMA } from '../messages/message-view-schema';
import { NOTE_VIEW_SCHEMA } from '../messages/note-view-schema';
import { PUBLISHED_RECORD_SCHEMA } from '../sessions/published-record-schema';
import { WORKSPACE_CLEANUP_SCHEMA } from '../workspaces/workspace-cleanup';
import { FLEET_BASE, buildFleetMeta } from './fleet-base';
import type { FleetShapes } from './fleet-shapes';

const PARAMS = REQUEST_PARAM_SCHEMAS;
const DAEMON = DAEMON_CONTRACT;
const EMPTY = z.object({});
const STRINGS = z.array(z.string()).readonly();
const SPAWN = PARAMS['session.spawn'].shape;
const MESSAGE = PARAMS['session.message'].shape;
const FORGET = PARAMS['session.forget'].shape;
const CHOOSE = PARAMS['session.choose'].shape;
const READ = PARAMS['session.read'].shape;
const EVENTS = PARAMS['events.read'].shape;
const SESSION = PARAMS['session.get'].shape;

const FORGET_CONFIRM = z.object({
  confirmToken: z.string(),
  expiresAt: z.number(),
});

const FORGET_DONE = z.object({
  forgotten: z.literal(true),
  destroyed: z.boolean(),
  workspace: WORKSPACE_CLEANUP_SCHEMA,
});

const IDEMPOTENCY_KEY = z
  .string({ error: 'idempotencyKey must be a string' })
  .min(1, 'idempotencyKey must not be empty')
  .max(180, 'idempotencyKey must be at most 180 characters');

// One list of procedures, built for the answers of the gateway or of one daemon. Each input is an
// allowlist of the daemon input's fields, so a field a later daemon adds never reaches a caller.
export function buildFleetContract<TShapes extends FleetShapes>(shapes: TShapes) {
  const daemon = shapes.daemonInput;

  return {
    ...shapes.extraProcedures,
    agents: {
      list: FLEET_BASE.meta(buildFleetMeta(DAEMON.agents.list, 'agents.list'))
        .input(EMPTY)
        .output(shapes.agentsList),
    },
    dirs: {
      list: FLEET_BASE.meta(buildFleetMeta(DAEMON.dirs.list, 'dirs.list'))
        .input(z.object({ ...daemon }))
        .output(z.object({ dirs: STRINGS })),
    },
    session: {
      list: FLEET_BASE.meta(buildFleetMeta(DAEMON.session.list, 'session.list'))
        .input(EMPTY)
        .output(shapes.sessionList),
      get: FLEET_BASE.meta(buildFleetMeta(DAEMON.session.get, 'session.get'))
        .input(z.object({ ...daemon, session: SESSION.session }))
        .output(shapes.sessionGet),
      spawn: FLEET_BASE.meta(buildFleetMeta(DAEMON.session.spawn, 'session.spawn'))
        .input(
          z.object({
            ...daemon,
            cwd: SPAWN.cwd,
            name: SPAWN.name,
            prompt: SPAWN.prompt,
            agent: SPAWN.agent,
            model: SPAWN.model,
            effort: SPAWN.effort,
            pluginDirs: SPAWN.pluginDirs,
            idempotencyKey: IDEMPOTENCY_KEY,
            target: SPAWN.target,
            workspace: SPAWN.workspace,
            trustClonedWorkspace: SPAWN.trustClonedWorkspace,
            scope: SPAWN.scope,
            atcAccess: SPAWN.atcAccess,
            ...shapes.spawnInput,
          }),
        )
        .output(shapes.spawn),
      update: FLEET_BASE.meta(buildFleetMeta(DAEMON.session.update, 'session.update'))
        .input(
          z.object({
            ...daemon,
            session: PARAMS['session.update'].shape.session,
            name: PARAMS['session.update'].shape.name,
            pinned: PARAMS['session.update'].shape.pinned,
            parent: PARAMS['session.update'].shape.parent,
          }),
        )
        .output(z.object({ renameSkipped: z.string().optional() })),
      ack: FLEET_BASE.meta(buildFleetMeta(DAEMON.session.ack, 'session.ack'))
        .input(z.object({ ...daemon, session: SESSION.session }))
        .output(EMPTY),
      kill: FLEET_BASE.meta(buildFleetMeta(DAEMON.session.kill, 'session.kill'))
        .input(
          z.object({
            ...daemon,
            session: PARAMS['session.kill'].shape.session,
          }),
        )
        .output(z.object({ stopped: z.boolean().optional() })),
      forget: FLEET_BASE.meta(buildFleetMeta(DAEMON.session.forget, 'session.forget'))
        .input(
          z.object({
            ...daemon,
            session: FORGET.session,
            confirmToken: FORGET.confirmToken,
            stop: z.boolean({ error: 'session.forget stop must be a boolean' }).optional(),
          }),
        )
        .output(z.union([FORGET_CONFIRM, FORGET_DONE])),
      adopt: FLEET_BASE.meta(buildFleetMeta(DAEMON.session.adopt, 'session.adopt'))
        .input(z.object({ ...daemon, session: SESSION.session }))
        .output(EMPTY),
      submit: FLEET_BASE.meta(buildFleetMeta(DAEMON.session.submit, 'session.submit'))
        .input(
          z.object({
            ...daemon,
            session: PARAMS['session.submit'].shape.session,
            text: PARAMS['session.submit'].shape.text,
          }),
        )
        .output(EMPTY),
      screen: FLEET_BASE.meta(buildFleetMeta(DAEMON.session.screen, 'session.screen'))
        .input(z.object({ ...daemon, session: SESSION.session }))
        .output(z.object({ text: z.string(), cols: z.number(), rows: z.number() })),
      menu: FLEET_BASE.meta(buildFleetMeta(DAEMON.session.menu, 'session.menu'))
        .input(z.object({ ...daemon, session: SESSION.session }))
        .output(z.object({ menu: MENU_VIEW_SCHEMA.nullable() })),
      choose: FLEET_BASE.meta(buildFleetMeta(DAEMON.session.choose, 'session.choose'))
        .input(
          z
            .object({
              ...daemon,
              session: CHOOSE.session,
              menuToken: CHOOSE.menuToken,
              option: CHOOSE.option,
              label: CHOOSE.label,
              key: CHOOSE.key,
            })
            .refine(
              (params) =>
                params.key === undefined
                  ? params.option !== undefined && params.label !== undefined
                  : params.option === undefined,
              {
                message: "session.choose takes an option with its label, or key 'escape', not both",
              },
            ),
        )
        .output(
          z.object({
            pressed: z.string(),
            menu: MENU_VIEW_SCHEMA.nullable(),
            partial: z.literal(true).optional(),
          }),
        ),
      read: FLEET_BASE.meta(buildFleetMeta(DAEMON.session.read, 'session.read'))
        .input(
          z.object({
            ...daemon,
            session: READ.session,
            cursor: READ.cursor,
            limit: READ.limit,
          }),
        )
        .output(
          z.object({
            rows: z.array(TRANSCRIPT_ROW_SCHEMA).readonly(),
            cursor: z.string(),
            more: z.boolean(),
          }),
        ),
      message: FLEET_BASE.meta(buildFleetMeta(DAEMON.session.message, 'session.message'))
        .input(
          z
            .object({
              ...daemon,
              session: MESSAGE.session,
              text: MESSAGE.text,
              idempotencyKey: IDEMPOTENCY_KEY,
            })
            .refine((params) => params.text !== '', {
              message: 'session.message requires text',
            }),
        )
        .output(MESSAGE_ANSWER_SCHEMA),
      scope: {
        add: FLEET_BASE.meta(buildFleetMeta(DAEMON.session.scope.add, 'session.scope.add'))
          .input(
            z.object({
              ...daemon,
              session: PARAMS['session.scope.add'].shape.session,
              scope: PARAMS['session.scope.add'].shape.scope,
            }),
          )
          .output(z.object({ record: PUBLISHED_RECORD_SCHEMA })),
      },
      auth: {
        rebind: FLEET_BASE.meta(buildFleetMeta(DAEMON.session.auth.rebind, 'session.auth.rebind'))
          .input(z.object({ ...daemon, session: SESSION.session }))
          .output(z.object({ revision: z.number(), restartPending: STRINGS })),
      },
    },
    events: {
      read: FLEET_BASE.meta(buildFleetMeta(DAEMON.events.read, 'events.read'))
        .input(
          z.object({
            cursor: EVENTS.cursor,
            limit: EVENTS.limit,
            waitMs: EVENTS.waitMs,
            session: EVENTS.session,
          }),
        )
        .output(shapes.eventsPage),
    },
    message: {
      get: FLEET_BASE.meta(buildFleetMeta(DAEMON.message.get, 'message.get'))
        .input(
          z
            .object({
              ...daemon,
              message: PARAMS['message.get'].shape.message,
              waitMs: PARAMS['message.get'].shape.waitMs,
            })
            .refine((params) => params.message !== '', {
              message: 'message.get requires a message',
            }),
        )
        .output(MESSAGE_VIEW_SCHEMA),
    },
    note: {
      get: FLEET_BASE.meta(buildFleetMeta(DAEMON.note.get, 'note.get'))
        .input(
          z
            .object({ ...daemon, note: PARAMS['note.get'].shape.note })
            .refine((params) => params.note !== '', {
              message: 'note.get requires a note',
            }),
        )
        .output(NOTE_VIEW_SCHEMA),
    },
    answer: {
      get: FLEET_BASE.meta(buildFleetMeta(DAEMON.answer.get, 'answer.get'))
        .input(
          z
            .object({ ...daemon, answer: PARAMS['answer.get'].shape.answer })
            .refine((params) => params.answer !== '', {
              message: 'answer.get requires an answer',
            }),
        )
        .output(ANSWER_VIEW_SCHEMA),
    },
  };
}
