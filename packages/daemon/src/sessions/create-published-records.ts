import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeKeyedLock } from '@atc/core';
import type { SessionID } from '@atc/core';
import type { ExecutionProvider } from '@atc/plugin-api';
import type {
  DeclaredScope,
  PublishedRecord,
  RecordedScope,
  SessionWorkspace,
} from '@atc/protocol';
import { checkSessionScope } from '../auth/check-session-scope';
import type { CheckedScope } from '../auth/check-session-scope';
import { mergeRecordedScope } from '../auth/merge-recorded-scope';
import { readGuestLayout } from './read-guest-layout';
import { readHostBranch } from './read-host-branch';

interface PublishedRecordStore {
  readonly readPublishedRecord: (sessionID: SessionID) => Promise<PublishedRecord | null>;
  readonly writePublishedRecord: (record: PublishedRecord) => Promise<void>;
  readonly removePublishedRecord: (sessionID: SessionID) => Promise<void>;
}

export interface RecordSubject {
  readonly session: SessionID;
  readonly target: string;
  readonly name: string;
  readonly transcriptPath: string | null;
  readonly provider: ExecutionProvider;
  readonly host: SessionID;
  readonly directory: string;
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
export const PLACE_COPY =
  'umask 022 && mkdir -p "$1" && printf "%s" "$4" > "$1/$3" && chmod 0444 "$1/$3" && mv -f "$1/$3" "$1/$2"';

// The exit code of REFRESH_COPY when the directory holds no copy to refresh.
const NO_COPY_CODE = 3;

// Writes a record copy as PLACE_COPY does, but only over a copy already in
// place, and exits NO_COPY_CODE when there is none.
export const REFRESH_COPY = `[ -e "$1/$2" ] || exit ${NO_COPY_CODE}; ${PLACE_COPY}`;

export interface PublishedRecords {
  // Checks a spawn's declared scope on its readied host, records it with
  // the workspace the session runs in, and places the copy. Returns the
  // copy's path on the host.
  readonly createRecord: (
    subject: RecordSubject,
    declared: DeclaredScope | null,
  ) => Promise<string>;

  // Places the stored copy again before a harness starts on a revived or
  // restored session, recording a fresh one for a session without one, and
  // a name or transcript path changed since then as the next revision.
  readonly restoreCopy: (subject: RecordSubject) => Promise<string>;

  // Records a changed name or transcript path as the next revision. The
  // copy is placed only when placeCopy holds, since a host that sleeps
  // takes its copy at its next harness start.
  readonly updateIdentity: (subject: RecordSubject, placeCopy: boolean) => Promise<void>;

  // Checks an added scope on the session's host, adds each entry the record
  // lacks, and places the changed copy. A scope that adds nothing leaves
  // the record and its revision as they were.
  readonly updateScope: (
    subject: RecordSubject,
    declared: DeclaredScope,
  ) => Promise<PublishedRecord>;

  readonly readRecord: (sessionID: SessionID) => Promise<PublishedRecord | null>;

  // Where the copy of a session on the daemon's own machine lies, the only
  // machine a headless turn runs on.
  readonly getLocalPath: (sessionID: SessionID) => string;

  // Drops a session's record and its copy on the daemon's machine.
  readonly remove: (sessionID: SessionID) => Promise<void>;
}

// only the daemon writes the record or its read-only copy, from what it checked itself
export function createPublishedRecords(options: PublishedRecordsOptions): PublishedRecords {
  // The change under way for each session, which the next change to the
  // same record waits on, so two additions never write over each other.
  const withSessionTurn = makeKeyedLock();

  // The sessions whose host holds no guest-folder copy beside its read-only
  // copy, so a write to the read-only copy skips the refresh.
  const withoutGuestCopy = new Set<SessionID>();

  const getLocalPath = (sessionID: SessionID): string =>
    join(options.localDir, `${sessionID}.json`);

  const buildRecord = (
    subject: RecordSubject,
    scope: RecordedScope,
    revision: number,
  ): PublishedRecord => ({
    format: 'atc.session-record',
    version: 1,
    session: subject.session,
    daemonID: options.daemonID,
    target: subject.target,
    revision,
    updatedAt: new Date(options.now()).toISOString(),
    name: subject.name,
    transcriptPath: subject.transcriptPath,
    scope,
  });

  const checkScope = (subject: RecordSubject, declared: DeclaredScope): Promise<CheckedScope> =>
    checkSessionScope(
      {
        provider: subject.provider,
        host: subject.host,
        directory: subject.directory,
        repoURL: subject.workspace?.repoURL ?? null,
        declared,
      },
      options.ghBin,
    );

  // a harness started before its host kept read-only files reads the guest-folder copy, and a
  // later start reattaches to it with that environment, so the copy stays current while it
  // exists; a cold boot clears the folder and ends that process with it
  const refreshGuestCopy = async (
    subject: RecordSubject,
    name: string,
    content: string,
  ): Promise<void> => {
    if (withoutGuestCopy.has(subject.session)) {
      return;
    }

    const directory = await readGuestDir(subject);

    const refreshed = await subject.provider.runCommand({
      argv: ['sh', '-c', REFRESH_COPY, 'sh', directory, name, `.${name}.${randomUUID()}`, content],
      cwd: '/',
      host: subject.host,
    });

    if (refreshed.exitCode === NO_COPY_CODE) {
      withoutGuestCopy.add(subject.session);

      return;
    }

    if (refreshed.exitCode !== 0) {
      throw new Error(
        `refreshing the session record in ${directory} failed: ${refreshed.stderr.trim()}`,
      );
    }
  };

  // Replaces the copy through a rename, so a reader never sees half of it.
  const writeCopy = async (subject: RecordSubject, record: PublishedRecord): Promise<string> => {
    const content = `${JSON.stringify(record, null, 2)}\n`;
    const name = `${subject.session}.json`;

    if (!subject.provider.remote) {
      const directory = options.localDir;
      const path = getLocalPath(subject.session);
      const staged = join(directory, `.${name}.${randomUUID()}`);

      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      await writeFile(staged, content, { mode: 0o444, flag: 'wx' });
      await rename(staged, path);

      return path;
    }

    // A host that keeps read-only files holds the copy where no process
    // there can write it, root included.
    const protectedPath = await subject.provider.writeReadOnlyFile?.(
      subject.host,
      `atc/records/${name}`,
      content,
    );

    if (protectedPath !== undefined && protectedPath !== null) {
      await refreshGuestCopy(subject, name, content);

      return protectedPath;
    }

    // Elsewhere one command writes the copy beside its place and renames it
    // there. A remote host runs it as the user its provider runs commands
    // as, root on an imp, so the copy and its directory belong to that user.
    const directory = await readGuestDir(subject);

    withoutGuestCopy.delete(subject.session);

    const placed = await subject.provider.runCommand({
      argv: ['sh', '-c', PLACE_COPY, 'sh', directory, name, `.${name}.${randomUUID()}`, content],
      cwd: '/',
      host: subject.host,
    });

    if (placed.exitCode !== 0) {
      throw new Error(`placing the session record in ${directory} failed: ${placed.stderr.trim()}`);
    }

    return `${directory}/${name}`;
  };

  const writeIdentity = async (
    subject: RecordSubject,
    stored: PublishedRecord,
  ): Promise<PublishedRecord> => {
    if (stored.name === subject.name && stored.transcriptPath === subject.transcriptPath) {
      return stored;
    }

    const record = buildRecord(subject, stored.scope, stored.revision + 1);

    await options.store.writePublishedRecord(record);

    return record;
  };

  // The record a session without one starts from, at revision 0 so its
  // first change records revision 1.
  const readFirstRecord = async (subject: RecordSubject): Promise<PublishedRecord> => {
    const workspace = await readWorkspace(subject);

    return buildRecord(subject, { workspace, ...EMPTY_SCOPE }, 0);
  };

  const writeScope = async (
    subject: RecordSubject,
    declared: DeclaredScope,
  ): Promise<PublishedRecord> => {
    const stored = await options.store.readPublishedRecord(subject.session);

    let current = stored;

    current ??= await readFirstRecord(subject);

    const checked = await checkScope(subject, declared);

    const merged = mergeRecordedScope(current.scope, checked);

    // A change that adds nothing still places the copy, so a retry after a
    // failed copy write brings the copy level with the store.
    if (stored !== null && merged === current.scope) {
      await writeCopy(subject, stored);

      return stored;
    }

    const record = buildRecord(subject, merged, current.revision + 1);

    await options.store.writePublishedRecord(record);

    await writeCopy(subject, record);

    return record;
  };

  const createRecord = async (
    subject: RecordSubject,
    declared: DeclaredScope | null,
  ): Promise<string> => {
    const checked = declared === null ? EMPTY_SCOPE : await checkScope(subject, declared);

    const workspace = await readWorkspace(subject);

    const record = buildRecord(subject, { workspace, ...checked }, 1);

    await options.store.writePublishedRecord(record);

    return writeCopy(subject, record);
  };

  return {
    createRecord,

    restoreCopy: (subject) =>
      withSessionTurn(subject.session, async () => {
        const stored = await options.store.readPublishedRecord(subject.session);

        if (stored === null) {
          return createRecord(subject, null);
        }

        const record = await writeIdentity(subject, stored);

        return writeCopy(subject, record);
      }),

    updateIdentity: (subject, placeCopy) =>
      withSessionTurn(subject.session, async () => {
        const stored = await options.store.readPublishedRecord(subject.session);

        if (stored === null) {
          return;
        }

        const record = await writeIdentity(subject, stored);

        // An unchanged identity still places the copy, so a retry after a
        // failed copy write brings the copy level with the store.
        if (placeCopy) {
          await writeCopy(subject, record);
        }
      }),

    updateScope: (subject, declared) =>
      withSessionTurn(subject.session, () => writeScope(subject, declared)),

    readRecord: (sessionID) => options.store.readPublishedRecord(sessionID),

    getLocalPath,

    remove: async (sessionID) => {
      await options.store.removePublishedRecord(sessionID);

      withoutGuestCopy.delete(sessionID);

      await rm(getLocalPath(sessionID), { force: true });
    },
  };
}

async function readGuestDir(subject: RecordSubject): Promise<string> {
  const guest = await readGuestLayout(subject.provider, subject.host);

  return `${guest.directory}/records`;
}

async function readWorkspace(subject: RecordSubject): Promise<RecordedScope['workspace']> {
  const branch = await readBranch(subject);

  return {
    path: subject.directory,
    branch,
    repoURL: subject.workspace?.repoURL ?? null,
    sha: subject.workspace?.sha ?? null,
  };
}

// a remote directory atc did not materialize records no branch, so a spawn there runs no
// command on the host before its harness starts
function readBranch(subject: RecordSubject): Promise<string | null> {
  if (subject.branch !== undefined) {
    return Promise.resolve(subject.branch);
  }

  return subject.provider.remote
    ? Promise.resolve(null)
    : readHostBranch(subject.provider, subject.host, subject.directory);
}
