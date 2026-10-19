import type { HooksConfig, InvalidGitTransports, TargetConfigError } from '@atc/config';
import type { AgentID, Clock, SessionID } from '@atc/core';
import type { AgentAdapter, SourceProvider } from '@atc/plugin-api';
import type { ExecutionTarget } from './fleet/build-execution-targets';
import type { RestoreSettled } from './fleet/restore-fleet';
import type { MenuTiming } from './sessions/menu-terminal';
import type { SettleScheduler } from './sessions/run-eject-handoff';
import type { ListenOptions } from './transport/listen-options';

export interface DaemonOptions {
  readonly socketPath: string;
  readonly reporterSocketPath: string;

  // Build string sent in the handshake and in mismatch errors, e.g. "atc/0.1.0".
  readonly build: string;
  readonly adapter?: AgentAdapter | null;

  // Adapters registered over and above the default one, each keyed by the id
  // it declares. Lookup never falls back across ids: a grok session with no
  // grok adapter is unsupported, not a Claude spawn.
  readonly adapters?: readonly AgentAdapter[];

  // The agent a spawn without one runs, reported in `agents.list`'s spawn
  // defaults; `claude` when unset.
  readonly defaultAgent?: AgentID;

  // Where sessions run, in config order. A spawn without a target runs on
  // the default one: `local` when unset and the targets hold it, and none
  // otherwise, which refuses such a spawn.
  readonly targets: readonly ExecutionTarget[];
  readonly defaultTarget?: string | null;

  // The target config problems the daemon started with. A target they cover
  // refuses every session, and `agents.list` returns them.
  readonly targetErrors?: readonly TargetConfigError[];

  // The targets each principal may use; unset or null when the config has
  // no principals, which leaves every principal the implicit local target.
  readonly principals?: ReadonlyMap<string, readonly string[]> | null;

  // SQLite path for daemon state; a fleet.json at legacyFleetPath seeds the
  // fleet table once so upgrading keeps the restorable fleet.
  readonly dbPath: string;
  readonly legacyFleetPath?: string;

  // When set, the daemon's pid is written here and removed on stop.
  readonly pidPath?: string;

  // When set, a read-only events socket listens here and streams every
  // broadcast event as NDJSON to any subscriber, no handshake required.
  readonly eventsSocketPath?: string;

  // User-configured hooks, keyed by wire-event name; each broadcast event
  // fires its matching commands, observational and fire-and-forget.
  readonly hooks?: HooksConfig;

  // Where the statusline contract file is written; defaults to the real one.
  readonly statusPath?: string;

  // Outbound queue capacity per client; small values force desync in tests.
  readonly queueBytes?: number;

  // How long an eject waits for the dying terminal to report SessionEnd
  // before starting the headless run anyway.
  readonly ejectSettleMs?: number;

  // Starts the eject settle timer; the daemon's clock when unset.
  readonly scheduleEjectSettle?: SettleScheduler;

  // How long a failed spawn's rollback waits for the killed process to
  // exit, once after its kill and once more after a forced kill; 2 s when
  // unset.
  readonly failedSpawnExitWaitMs?: number;

  // A fleet-wide restore revives one session at a time and waits for each to report it booted;
  // this caps that wait, so a session that never reports cannot stall the rest. Unset reads the
  // restart's wait for the restored fleet; zero waits forever, which only tests ask for.
  readonly restoreBootTimeoutMs?: number;

  // The waits before each further try at a restored session whose host
  // refused for now, such as an imp that cannot take a lease yet; the
  // restore's own delays when unset.
  readonly restoreRetryDelaysMs?: readonly number[];
  readonly tapGraceMs?: number;

  // The clock behind every time the daemon stamps, waits on or stores, from hook events and
  // timeouts to the restore's boot cap and the listener's refusal windows; the wall clock when
  // unset.
  readonly clock?: Clock;

  // How long a menu choice waits on a session's screen; tests shorten it.
  readonly menuTiming?: MenuTiming;

  // Whether the daemon restores the stored fleet by itself once it is
  // listening, when that fleet holds sessions; off when unset.
  readonly restoreFleetOnRestart?: boolean;

  // Called once each fleet restore has ended its staggered terminal
  // adoption, with how many sessions it registered and how it ended; a
  // restore that threw before registering any reports none and failed.
  readonly onRestoreSettled?: (settled: RestoreSettled) => void;

  // Called when a start declines to restore the stored fleet by itself:
  // the option is off, or the stored fleet holds no sessions.
  readonly onRestoreSkipped?: (reason: 'disabled' | 'empty') => void;

  // Called when a Note line changes nothing: a note from a session the
  // fleet does not list, or an answer or unanswered report that matches no
  // unsettled message the reporting session owns.
  readonly onNoteIgnored?: (sessionID: string, kind: 'note' | 'answered' | 'unanswered') => void;

  // How long a confirm token from `session.forget` stays usable.
  readonly forgetConfirmMs?: number;

  // The clock confirm tokens from `session.forget` are minted and checked
  // against, in epoch milliseconds; the daemon's clock when unset.
  readonly forgetClock?: () => number;

  // The clock the event trail's sweep is scheduled on; its cutoff still
  // comes from the daemon's clock. The wall clock when unset.
  readonly eventSweepClock?: Clock;

  // Called with a session's id when it reports its start and the daemon
  // leaves the last-used agent as it is, because no spawn is waiting on
  // that start.
  readonly onLastUsedUnchanged?: (sessionID: SessionID) => void;

  // When set, a TCP listener serves the client protocol on this address to
  // peers whose handshake presents a token from the token file.
  readonly listen?: ListenOptions;

  // Called after a client-requested quit has stopped the daemon; the real
  // entrypoint exits the process, tests leave it unset.
  readonly onQuit?: () => void;

  // Where background failures and the TCP listener's lines are reported,
  // one line at a time. When unset, failures go to stderr and the
  // listener's lines to LogTape's `atc tcp` logger.
  readonly log?: (line: string) => void;

  // Called each time the daemon leaves a session's new output unjudged
  // because no screen detector covers it: no agent in the fleet has one,
  // the session's own agent has none, or the session is no longer listed.
  readonly onDetectSkipped?: (sessionID: SessionID) => void;

  // The sources the spawn picker offers, in order, each built with the
  // services it uses; none when unset.
  readonly sources?: readonly SourceProvider[];

  // The gh executable that checks a pull request a session's scope
  // declares; `gh` on PATH when unset.
  readonly ghBin?: string;

  // The transports a git workspace source may use and git may fetch over,
  // or the invalid list the config holds, which refuses every git
  // operation; https and ssh when unset.
  readonly gitTransports?: readonly string[] | InvalidGitTransports;

  // The root a git workspace without a directory lands under on any target
  // without its own, and each target's own root, by target id; the default
  // root under the target user's home when unset.
  readonly workspaceRoots?: Readonly<{
    root: string | null;
    targetRoots: ReadonlyMap<string, string>;
  }>;

  // The home a git workspace without a directory lands under on a target
  // on the daemon's own machine when no root applies, and the one a spawn's
  // plugin folder starting with ~ is under; the daemon user's home when unset.
  readonly homeDir?: string;
}
