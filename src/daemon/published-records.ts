import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DeclaredScope } from '../protocol/parse-declared-scope';
import type { PublishedRecord, RecordedScope } from '../protocol/published-record';
import type { SessionID } from '../shared/session-id';
import type { SessionWorkspace } from '../store/workspace-materialization';
import { checkSessionScope } from './check-session-scope';
import type { CheckedScope } from './check-session-scope';
import type { ExecutionProvider } from './execution-provider';
import { findHostBranch } from './find-host-branch';
import { mergeRecordedScope } from './merge-recorded-scope';

/**
 * Where the state store keeps each session's published record.
 */
interface PublishedRecordStore {
  readonly findPublishedRecord: (sessionID: SessionID) => Promise<PublishedRecord | null>;
  readonly writePublishedRecord: (record: PublishedRecord) => Promise<void>;
  readonly removePublishedRecord: (sessionID: SessionID) => Promise<void>;
}

/**
 * One session as its record sees it: the host it runs on, the directory
 * it runs in, and what its workspace was materialized from.
 */
export interface RecordSubject {
  readonly session: SessionID;
  readonly target: string;
  readonly provider: ExecutionProvider;
  readonly host: SessionID;
  readonly dir: string;
  readonly workspace: SessionWorkspace | null;

  // The branch atc checked the workspace out on, when atc materialized it;
  // absent leaves the host to show the directory's branch.
  readonly branch?: string | null;
}

interface PublishedRecordsOptions {
  readonly store: PublishedRecordStore;
  readonly daemonID: string;

  // The directory on the daemon's machine each local copy lands in.
  readonly localDir: string;

  // The gh executable that checks a declared pull request.
  readonly ghBin: string;
  readonly now: () => number;
}

const EMPTY_SCOPE: CheckedScope = { worktrees: [], branches: [], pullRequests: [] };

// Writes a record copy into a directory on a remote host: the content to a
// staged file, made read-only, then renamed over the copy.
const PLACE_COPY =
  'umask 022 && mkdir -p "$1" && printf "%s" "$4" > "$1/$3" && chmod 0444 "$1/$3" && mv -f "$1/$3" "$1/$2"';

/**
 * Publishes each session's record: the state store holds it, and the
 * session's provider places a read-only copy where the session reads it.
 * Only the daemon writes either, from what it checked itself.
 */
export class PublishedRecords {
  private readonly options: PublishedRecordsOptions;

  // The change under way for each session, which the next change to the
  // same record waits on, so two additions never write over each other.
  private readonly changes = new Map<SessionID, Promise<void>>();

  constructor(options: PublishedRecordsOptions) {
    this.options = options;
  }

  // Checks a spawn's declared scope on its readied host, records it with
  // the workspace the session runs in, and places the copy. Returns the
  // copy's path on the host.
  async createRecord(subject: RecordSubject, declared: DeclaredScope | null): Promise<string> {
    const checked = declared === null ? EMPTY_SCOPE : await this.checkScope(subject, declared);

    const workspace = await this.buildWorkspace(subject);

    const record = this.buildRecord(subject, { workspace, ...checked }, 1);

    await this.options.store.writePublishedRecord(record);

    return this.writeCopy(subject, record);
  }

  // Places the stored copy again before a harness starts on a revived or
  // restored session, recording a fresh one for a session without one.
  async restoreCopy(subject: RecordSubject): Promise<string> {
    const stored = await this.options.store.findPublishedRecord(subject.session);

    if (stored === null) {
      return this.createRecord(subject, null);
    }

    return this.writeCopy(subject, stored);
  }

  // Checks an added scope on the session's host, adds each entry the record
  // lacks, and places the changed copy. A scope that adds nothing leaves
  // the record and its revision as they were.
  async updateScope(subject: RecordSubject, declared: DeclaredScope): Promise<PublishedRecord> {
    const before = this.changes.get(subject.session);
    const turn = Promise.withResolvers<void>();

    this.changes.set(subject.session, turn.promise);

    try {
      await before;

      return await this.writeScope(subject, declared);
    } finally {
      turn.resolve();

      if (this.changes.get(subject.session) === turn.promise) {
        this.changes.delete(subject.session);
      }
    }
  }

  findRecord(sessionID: SessionID): Promise<PublishedRecord | null> {
    return this.options.store.findPublishedRecord(sessionID);
  }

  // Where the copy of a session on the daemon's own machine lies, the only
  // machine a headless turn runs on.
  getLocalPath(sessionID: SessionID): string {
    return join(this.options.localDir, `${sessionID}.json`);
  }

  // Drops a session's record and its copy on the daemon's machine.
  async remove(sessionID: SessionID): Promise<void> {
    await this.options.store.removePublishedRecord(sessionID);

    await rm(this.getLocalPath(sessionID), { force: true });
  }

  private async writeScope(
    subject: RecordSubject,
    declared: DeclaredScope,
  ): Promise<PublishedRecord> {
    const stored = await this.options.store.findPublishedRecord(subject.session);

    let current = stored;

    current ??= await this.buildFirstRecord(subject);

    const checked = await this.checkScope(subject, declared);

    const merged = mergeRecordedScope(current.scope, checked);

    if (stored !== null && merged === current.scope) {
      return stored;
    }

    const record = this.buildRecord(subject, merged, current.revision + 1);

    await this.options.store.writePublishedRecord(record);
    await this.writeCopy(subject, record);

    return record;
  }

  // The record a session without one starts from, at revision 0 so its
  // first change records revision 1.
  private async buildFirstRecord(subject: RecordSubject): Promise<PublishedRecord> {
    const workspace = await this.buildWorkspace(subject);

    return this.buildRecord(subject, { workspace, ...EMPTY_SCOPE }, 0);
  }

  private checkScope(subject: RecordSubject, declared: DeclaredScope): Promise<CheckedScope> {
    return checkSessionScope(
      {
        provider: subject.provider,
        host: subject.host,
        dir: subject.dir,
        repoURL: subject.workspace?.repoURL ?? null,
        declared,
      },
      this.options.ghBin,
    );
  }

  private async buildWorkspace(subject: RecordSubject): Promise<RecordedScope['workspace']> {
    const branch = await this.findBranch(subject);

    return {
      path: subject.dir,
      branch,
      repoURL: subject.workspace?.repoURL ?? null,
      sha: subject.workspace?.sha ?? null,
    };
  }

  // The branch atc checked a workspace out on, else the branch of a
  // directory on the daemon's machine. A remote directory atc did not
  // materialize records none, so a spawn there runs no command on the host
  // before its harness starts.
  private findBranch(subject: RecordSubject): Promise<string | null> {
    if (subject.branch !== undefined) {
      return Promise.resolve(subject.branch);
    }

    return subject.provider.remote
      ? Promise.resolve(null)
      : findHostBranch(subject.provider, subject.host, subject.dir);
  }

  private buildRecord(
    subject: RecordSubject,
    scope: RecordedScope,
    revision: number,
  ): PublishedRecord {
    return {
      format: 'atc.session-record',
      version: 1,
      session: subject.session,
      daemonID: this.options.daemonID,
      target: subject.target,
      revision,
      updatedAt: new Date(this.options.now()).toISOString(),
      scope,
    };
  }

  // Replaces the copy through a rename, so a reader never sees half of it.
  private async writeCopy(subject: RecordSubject, record: PublishedRecord): Promise<string> {
    const content = `${JSON.stringify(record, null, 2)}\n`;
    const name = `${subject.session}.json`;

    if (!subject.provider.remote) {
      const dir = this.options.localDir;
      const path = this.getLocalPath(subject.session);
      const staged = join(dir, `.${name}.${randomUUID()}`);

      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
      await writeFile(staged, content, { mode: 0o444, flag: 'wx' });
      await rename(staged, path);

      return path;
    }

    // One command writes the copy beside its place and renames it there.
    // A remote host runs it as the user its provider runs commands as,
    // root on an imp, so the copy and its directory belong to that user.
    const dir = `${subject.provider.guest?.dir ?? '/tmp/atc'}/records`;

    const placed = await subject.provider.runCommand({
      argv: ['sh', '-c', PLACE_COPY, 'sh', dir, name, `.${name}.${randomUUID()}`, content],
      cwd: '/',
      host: subject.host,
    });

    if (placed.exitCode !== 0) {
      throw new Error(`placing the session record in ${dir} failed: ${placed.stderr.trim()}`);
    }

    return `${dir}/${name}`;
  }
}
