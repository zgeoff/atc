import { DaemonError } from '@atc/protocol/wire';
import { z } from 'zod';

export type BindingOutcome = 'pending' | 'completed' | 'uncertain';

export interface KeyBinding {
  readonly principal: string;
  readonly operation: string;
  readonly key: string;
  readonly daemon: string;
  readonly daemonID: string;
  readonly retentionMs: number | null;
  readonly payloadHash: string;
  readonly outcome: BindingOutcome;
  readonly outcomeAt: number;

  // When a request under the key first left for its daemon, null while
  // none has, and the daemon's id of the effect an uncertain answer
  // returned, null without one.
  readonly sentAt: number | null;
  readonly effectRef: string | null;

  // The id of the claim that wrote the binding, so a call can tell its own
  // binding from one another call wrote first.
  readonly claimID: string;
}

const BINDING_ROW_SCHEMA = z.object({
  principal: z.string(),
  operation: z.string(),
  key: z.string(),
  daemon: z.string(),
  daemon_id: z.string(),
  retention_ms: z.number().nullable(),
  payload_hash: z.string(),
  outcome: z.string(),
  outcome_at: z.number(),
  sent_at: z.number().nullable(),
  effect_ref: z.string().nullable(),
  claim_id: z.string(),
});

// The part of a SQLite handle the store uses. The app opens the file, with
// named parameters bound without their prefix.
export interface BindingDatabase {
  readonly run: (sql: string) => unknown;
  readonly query: (sql: string) => {
    readonly run: (params: Readonly<Record<string, string | number | null>>) => {
      readonly changes: number;
    };
    readonly get: (params: Readonly<Record<string, string | number | null>>) => unknown;
  };
  readonly close: () => void;
}

export interface GatewayStore {
  readonly claimBinding: (
    binding: Omit<KeyBinding, 'outcome' | 'outcomeAt' | 'sentAt' | 'effectRef'>,
    now: number,
  ) => KeyBinding;
  readonly findBinding: (principal: string, operation: string, key: string) => KeyBinding | null;
  readonly claimFirstSend: (
    principal: string,
    operation: string,
    key: string,
    now: number,
  ) => boolean;
  readonly updateOutcome: (
    principal: string,
    operation: string,
    key: string,
    outcome: BindingOutcome,
    now: number,
    effectRef?: string | null,
  ) => void;
  readonly removeBinding: (
    principal: string,
    operation: string,
    key: string,
    claimID: string,
  ) => void;
  readonly removeExpiredBindings: (now: number) => number;
  readonly stop: () => void;
}

export function createGatewayStore(db: BindingDatabase): GatewayStore {
  db.run(`CREATE TABLE IF NOT EXISTS key_binding (
      principal TEXT NOT NULL,
      operation TEXT NOT NULL,
      key TEXT NOT NULL,
      daemon TEXT NOT NULL,
      daemon_id TEXT NOT NULL,
      retention_ms INTEGER,
      payload_hash TEXT NOT NULL,
      outcome TEXT NOT NULL,
      outcome_at INTEGER NOT NULL,
      sent_at INTEGER,
      effect_ref TEXT,
      claim_id TEXT NOT NULL,
      PRIMARY KEY (principal, operation, key)
    )`);

  const findBinding = (principal: string, operation: string, key: string): KeyBinding | null => {
    const row = db
      .query(
        `SELECT * FROM key_binding
         WHERE principal = $principal AND operation = $operation AND key = $key`,
      )
      .get({ principal, operation, key });

    return row === null ? null : toKeyBinding(BINDING_ROW_SCHEMA.parse(row));
  };

  return {
    claimBinding: (binding, now) => {
      db.query(
        `INSERT INTO key_binding
           (principal, operation, key, daemon, daemon_id, retention_ms, payload_hash, outcome, outcome_at, claim_id)
         VALUES ($principal, $operation, $key, $daemon, $daemonID, $retentionMs, $payloadHash, 'pending', $now, $claimID)
         ON CONFLICT (principal, operation, key) DO NOTHING`,
      ).run({
        principal: binding.principal,
        operation: binding.operation,
        key: binding.key,
        daemon: binding.daemon,
        daemonID: binding.daemonID,
        retentionMs: binding.retentionMs,
        payloadHash: binding.payloadHash,
        claimID: binding.claimID,
        now,
      });

      const held = findBinding(binding.principal, binding.operation, binding.key);

      if (held === null) {
        throw new Error('a claimed key binding is missing');
      }

      // a reused key never reaches a daemon that may have dropped it already
      if (held.payloadHash !== binding.payloadHash) {
        throw new DaemonError(
          'idempotency_conflict',
          `idempotency key '${binding.key}' was first used with a different ${binding.operation} payload`,
        );
      }

      return held;
    },

    findBinding,

    // one conditional statement, so of any number of calls, across gateway processes too,
    // exactly one takes the first send and every later one may only replay
    claimFirstSend: (principal, operation, key, now) =>
      db
        .query(
          `UPDATE key_binding SET sent_at = $now
           WHERE principal = $principal AND operation = $operation AND key = $key
             AND sent_at IS NULL`,
        )
        .run({ principal, operation, key, now }).changes === 1,

    updateOutcome: (principal, operation, key, outcome, now, effectRef = null) => {
      // a completed outcome stays completed, and an answer without an effect id keeps the one
      // recorded earlier
      db.query(
        `UPDATE key_binding
         SET outcome = $outcome, outcome_at = $now, effect_ref = COALESCE($effectRef, effect_ref)
         WHERE principal = $principal AND operation = $operation AND key = $key
           AND (outcome != 'completed' OR $outcome = 'completed')`,
      ).run({ principal, operation, key, outcome, now, effectRef });
    },

    removeBinding: (principal, operation, key, claimID) => {
      db.query(
        `DELETE FROM key_binding
         WHERE principal = $principal AND operation = $operation AND key = $key
           AND claim_id = $claimID AND sent_at IS NULL`,
      ).run({ principal, operation, key, claimID });
    },

    // a binding outlives the daemon's promise to deduplicate its key: only a completed one
    // goes, at twice the announced retention, as the daemon keeps every other key
    removeExpiredBindings: (now) =>
      db
        .query(
          `DELETE FROM key_binding
         WHERE outcome = 'completed' AND retention_ms IS NOT NULL
           AND outcome_at + 2 * retention_ms < $now`,
        )
        .run({ now }).changes,

    stop: () => {
      db.close();
    },
  };
}

type BindingRow = z.infer<typeof BINDING_ROW_SCHEMA>;

function toKeyBinding(row: BindingRow): KeyBinding {
  return {
    principal: row.principal,
    operation: row.operation,
    key: row.key,
    daemon: row.daemon,
    daemonID: row.daemon_id,
    retentionMs: row.retention_ms,
    payloadHash: row.payload_hash,
    outcome: pickOutcome(row.outcome),
    outcomeAt: row.outcome_at,
    sentAt: row.sent_at,
    effectRef: row.effect_ref,
    claimID: row.claim_id,
  };
}

// A stored outcome; anything unreadable counts as uncertain, which keeps
// the binding.
function pickOutcome(value: string): BindingOutcome {
  return value === 'pending' || value === 'completed' ? value : 'uncertain';
}
