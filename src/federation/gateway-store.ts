import { Database } from 'bun:sqlite';
import { DaemonError } from '../protocol/daemon-error';

/**
 * The last outcome the gateway saw for a keyed request: `pending` until an
 * answer arrives, `completed` for any answer the daemon gave other than
 * `outcome_unknown`, and `uncertain` for `outcome_unknown` or a response
 * that never arrived.
 */
export type BindingOutcome = 'pending' | 'completed' | 'uncertain';

/**
 * The daemon a keyed spawn or message went to: bound per principal,
 * operation, and key before the request leaves the gateway, so every retry
 * reaches the same daemon whatever the default daemon is by then. The
 * daemon's announced completed-key retention, null when it announced none,
 * decides when the binding may go. The payload hash binds the key to the
 * request it was first used with, as the daemon's own ledger does.
 */
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

  // When the binding was claimed, before its first send, and the daemon's
  // id of the effect an uncertain answer returned, null without one.
  readonly claimedAt: number;
  readonly effectRef: string | null;

  // The id of the claim that wrote the binding, so a call can tell its own
  // binding from one another call wrote first.
  readonly claimID: string;
}

interface BindingRow {
  readonly principal: string;
  readonly operation: string;
  readonly key: string;
  readonly daemon: string;
  readonly daemon_id: string;
  readonly retention_ms: number | null;
  readonly payload_hash: string;
  readonly outcome: string;
  readonly outcome_at: number;
  readonly claimed_at: number;
  readonly effect_ref: string | null;
  readonly claim_id: string;
}

/**
 * `gateway.db`: the keyed-request bindings, and nothing else the gateway
 * could rebuild. A binding outlives the daemon's promise to deduplicate its
 * key: a completed binding goes only once twice the daemon's announced
 * retention has passed since its answer, and a pending or uncertain one,
 * or one bound to a daemon that announced no retention, stays for good, as
 * the daemon keeps such a key.
 */
export class GatewayStore {
  private readonly db: Database;

  private constructor(db: Database) {
    this.db = db;
  }

  static open(path: string): GatewayStore {
    const db = new Database(path, { create: true, strict: true });

    db.run('PRAGMA journal_mode = WAL');

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
      claimed_at INTEGER NOT NULL,
      effect_ref TEXT,
      claim_id TEXT NOT NULL,
      PRIMARY KEY (principal, operation, key)
    )`);

    return new GatewayStore(db);
  }

  /**
   * Binds the key to the daemon under the given claim id unless a binding
   * for it already exists, and
   * returns the binding that holds after the call: the new one, or the one
   * an earlier request made, whose daemon the request must go to. Throws
   * `idempotency_conflict` when the key's binding holds another payload, so
   * a reused key never reaches a daemon that may have dropped it already.
   */
  claimBinding(
    binding: Omit<KeyBinding, 'outcome' | 'outcomeAt' | 'claimedAt' | 'effectRef'>,
    now: number,
  ): KeyBinding {
    this.db
      .query(
        `INSERT INTO key_binding
           (principal, operation, key, daemon, daemon_id, retention_ms, payload_hash, outcome, outcome_at, claimed_at, claim_id)
         VALUES ($principal, $operation, $key, $daemon, $daemonID, $retentionMs, $payloadHash, 'pending', $now, $now, $claimID)
         ON CONFLICT (principal, operation, key) DO NOTHING`,
      )
      .run({
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

    const held = this.findBinding(binding.principal, binding.operation, binding.key);

    if (held === null) {
      throw new Error('a claimed key binding is missing');
    }

    if (held.payloadHash !== binding.payloadHash) {
      throw new DaemonError(
        'idempotency_conflict',
        `idempotency key '${binding.key}' was first used with a different ${binding.operation} payload`,
      );
    }

    return held;
  }

  findBinding(principal: string, operation: string, key: string): KeyBinding | null {
    const row = this.db
      .query<BindingRow, { principal: string; operation: string; key: string }>(
        `SELECT * FROM key_binding
         WHERE principal = $principal AND operation = $operation AND key = $key`,
      )
      .get({ principal, operation, key });

    return row === null ? null : toKeyBinding(row);
  }

  /**
   * Records the last outcome of the key's request, and the effect id an
   * uncertain answer returned, keeping one recorded earlier when this
   * answer holds none.
   */
  updateOutcome(
    principal: string,
    operation: string,
    key: string,
    outcome: BindingOutcome,
    now: number,
    effectRef: string | null = null,
  ): void {
    this.db
      .query(
        `UPDATE key_binding
         SET outcome = $outcome, outcome_at = $now, effect_ref = COALESCE($effectRef, effect_ref)
         WHERE principal = $principal AND operation = $operation AND key = $key`,
      )
      .run({ principal, operation, key, outcome, now, effectRef });
  }

  /**
   * Removes the key's binding when the given claim wrote it and its request
   * has no outcome yet, for a request the gateway refused before it sent
   * anything. A binding another claim wrote, or one with an outcome, stays.
   */
  removeBinding(principal: string, operation: string, key: string, claimID: string): void {
    this.db
      .query(
        `DELETE FROM key_binding
         WHERE principal = $principal AND operation = $operation AND key = $key
           AND claim_id = $claimID AND outcome = 'pending'`,
      )
      .run({ principal, operation, key, claimID });
  }

  /**
   * Removes every completed binding whose daemon announced a retention and
   * whose answer is older than twice that retention. Returns how many went.
   */
  removeExpiredBindings(now: number): number {
    return this.db
      .query(
        `DELETE FROM key_binding
         WHERE outcome = 'completed' AND retention_ms IS NOT NULL
           AND outcome_at + 2 * retention_ms < $now`,
      )
      .run({ now }).changes;
  }

  stop(): void {
    this.db.close();
  }
}

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
    claimedAt: row.claimed_at,
    effectRef: row.effect_ref,
    claimID: row.claim_id,
  };
}

// A stored outcome; anything unreadable counts as uncertain, which keeps
// the binding.
function pickOutcome(value: string): BindingOutcome {
  return value === 'pending' || value === 'completed' ? value : 'uncertain';
}
