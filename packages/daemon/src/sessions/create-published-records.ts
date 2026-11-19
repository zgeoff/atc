import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeKeyedLock } from '@atc/core';
import type { ExecutionProvider } from '@atc/plugin-api';
import type { DeclaredScope } from '@atc/protocol';
import { toScopeFilePath } from '@atc/protocol/session';
import type { PublishedRecord, RecordedScope, SessionID, SessionWorkspace } from '@atcx/contract';
import { checkSessionScope } from '../auth/check-session-scope';
import type { CheckedScope } from '../auth/check-session-scope';
import { mergeRecordedScope } from '../auth/merge-recorded-scope';
import { buildScopeFile } from './build-scope-file';
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

  readonly branch?: string | null;
}

type RecordOrigin = Pick<PublishedRecord, 'spawner' | 'scratch'>;

interface PlacedFile {
  readonly name: string;
  readonly content: string;
}

interface PublishedRecordsOptions {
  readonly store: PublishedRecordStore;
  readonly daemonID: string;

  readonly localDir: string;

  readonly ghBin: string;
  readonly now: () => number;
}

const EMPTY_SCOPE: CheckedScope = { worktrees: [], branches: [], pullRequests: [] };
const NO_ORIGIN: RecordOrigin = { spawner: null, scratch: null };

export interface PublishedRecords {
  readonly createRecord: (
    subject: RecordSubject,
    declared: DeclaredScope | null,
    origin: RecordOrigin,
  ) => Promise<string>;

  readonly restoreCopy: (subject: RecordSubject) => Promise<string>;

  readonly updateIdentity: (subject: RecordSubject, placeCopy: boolean) => Promise<void>;

  readonly updateScope: (
    subject: RecordSubject,
    declared: DeclaredScope,
  ) => Promise<PublishedRecord>;

  readonly readRecord: (sessionID: SessionID) => Promise<PublishedRecord | null>;

  readonly getLocalPath: (sessionID: SessionID) => string;

  readonly remove: (sessionID: SessionID) => Promise<void>;
}

export function createPublishedRecords(options: PublishedRecordsOptions): PublishedRecords {
  const withSessionTurn = makeKeyedLock();

  const withoutGuestCopy = new Set<SessionID>();

  const getLocalPath = (sessionID: SessionID): string =>
    join(options.localDir, `${sessionID}.json`);

  const buildRecord = (
    subject: RecordSubject,
    origin: RecordOrigin,
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
    spawner: origin.spawner,
    scratch: origin.scratch,
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

  // A harness started before its host kept read-only files reads the guest-folder copy and keeps
  // that environment on reattach, so the copy must stay current. A cold boot clears the folder
  // and ends that process.
  const refreshGuestCopy = async (
    subject: RecordSubject,
    record: PlacedFile,
    scope: PlacedFile,
  ): Promise<void> => {
    if (withoutGuestCopy.has(subject.session)) {
      return;
    }

    const directory = await readGuestDir(subject);

    if (!(await refreshGuestFile(subject, directory, record))) {
      withoutGuestCopy.add(subject.session);

      return;
    }

    await refreshGuestFile(subject, directory, scope);
  };

  const writeCopy = async (subject: RecordSubject, record: PublishedRecord): Promise<string> => {
    const name = `${subject.session}.json`;
    const content = formatFile(record);
    const scopeName = toScopeFilePath(name);
    const scopeContent = formatFile(buildScopeFile(record));

    if (!subject.provider.remote) {
      const path = await writeLocalFile(name, content);

      await writeLocalFile(scopeName, scopeContent);

      return path;
    }

    const protectedPath = await subject.provider.writeReadOnlyFile?.(
      subject.host,
      `atc/records/${name}`,
      content,
    );

    if (protectedPath !== undefined && protectedPath !== null) {
      const protectedScope = await subject.provider.writeReadOnlyFile?.(
        subject.host,
        `atc/records/${scopeName}`,
        scopeContent,
      );

      if (protectedScope === undefined || protectedScope === null) {
        throw new Error(`the host of session ${subject.session} refused its read-only scope file`);
      }

      await refreshGuestCopy(
        subject,
        { name, content },
        { name: scopeName, content: scopeContent },
      );

      return protectedPath;
    }

    // A remote host runs the command as the user its provider runs commands as, root on an imp,
    // so the files and their directory belong to that user.
    const directory = await readGuestDir(subject);

    withoutGuestCopy.delete(subject.session);

    await placeGuestFile(subject, directory, { name, content });
    await placeGuestFile(subject, directory, { name: scopeName, content: scopeContent });

    return `${directory}/${name}`;
  };

  const writeLocalFile = async (name: string, content: string): Promise<string> => {
    const directory = options.localDir;
    const path = join(directory, name);
    const staged = join(directory, `.${name}.${randomUUID()}`);

    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await writeFile(staged, content, { mode: 0o444, flag: 'wx' });
    await chmod(staged, 0o444);
    await rename(staged, path);

    return path;
  };

  const writeIdentity = async (
    subject: RecordSubject,
    stored: PublishedRecord,
  ): Promise<PublishedRecord> => {
    if (stored.name === subject.name && stored.transcriptPath === subject.transcriptPath) {
      return stored;
    }

    const record = buildRecord(subject, stored, stored.scope, stored.revision + 1);

    await options.store.writePublishedRecord(record);

    return record;
  };

  const readFirstRecord = async (subject: RecordSubject): Promise<PublishedRecord> => {
    const workspace = await readWorkspace(subject);

    return buildRecord(subject, NO_ORIGIN, { workspace, ...EMPTY_SCOPE }, 0);
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

    if (stored !== null && merged === current.scope) {
      await writeCopy(subject, stored);

      return stored;
    }

    const record = buildRecord(subject, current, merged, current.revision + 1);

    await options.store.writePublishedRecord(record);

    await writeCopy(subject, record);

    return record;
  };

  const createRecord = async (
    subject: RecordSubject,
    declared: DeclaredScope | null,
    origin: RecordOrigin,
  ): Promise<string> => {
    const checked = declared === null ? EMPTY_SCOPE : await checkScope(subject, declared);

    const workspace = await readWorkspace(subject);

    const record = buildRecord(subject, origin, { workspace, ...checked }, 1);

    await options.store.writePublishedRecord(record);

    return writeCopy(subject, record);
  };

  return {
    createRecord,

    restoreCopy: (subject) =>
      withSessionTurn(subject.session, async () => {
        const stored = await options.store.readPublishedRecord(subject.session);

        if (stored === null) {
          return createRecord(subject, null, NO_ORIGIN);
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
      await rm(toScopeFilePath(getLocalPath(sessionID)), { force: true });
    },
  };
}

async function readGuestDir(subject: RecordSubject): Promise<string> {
  const guest = await readGuestLayout(subject.provider, subject.host);

  return `${guest.directory}/records`;
}

export const PLACE_COPY_SCRIPT =
  'umask 022 && mkdir -p "$1" && printf "%s" "$4" > "$1/$3" && chmod 0444 "$1/$3" && mv -f "$1/$3" "$1/$2"';

const NO_COPY_CODE = 3;

export const REFRESH_COPY_SCRIPT = `[ -e "$1/$2" ] || exit ${NO_COPY_CODE}; ${PLACE_COPY_SCRIPT}`;

async function refreshGuestFile(
  subject: RecordSubject,
  directory: string,
  file: PlacedFile,
): Promise<boolean> {
  const refreshed = await subject.provider.runCommand({
    argv: [
      'sh',
      '-c',
      REFRESH_COPY_SCRIPT,
      'sh',
      directory,
      file.name,
      `.${file.name}.${randomUUID()}`,
      file.content,
    ],
    cwd: '/',
    host: subject.host,
  });

  if (refreshed.exitCode === NO_COPY_CODE) {
    return false;
  }

  if (refreshed.exitCode !== 0) {
    throw new Error(`refreshing ${file.name} in ${directory} failed: ${refreshed.stderr.trim()}`);
  }

  return true;
}

function formatFile(content: object): string {
  return `${JSON.stringify(content, null, 2)}\n`;
}

async function placeGuestFile(
  subject: RecordSubject,
  directory: string,
  file: PlacedFile,
): Promise<void> {
  const placed = await subject.provider.runCommand({
    argv: [
      'sh',
      '-c',
      PLACE_COPY_SCRIPT,
      'sh',
      directory,
      file.name,
      `.${file.name}.${randomUUID()}`,
      file.content,
    ],
    cwd: '/',
    host: subject.host,
  });

  if (placed.exitCode !== 0) {
    throw new Error(`placing ${file.name} in ${directory} failed: ${placed.stderr.trim()}`);
  }
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

function readBranch(subject: RecordSubject): Promise<string | null> {
  if (subject.branch !== undefined) {
    return Promise.resolve(subject.branch);
  }

  return subject.provider.remote
    ? Promise.resolve(null)
    : readHostBranch(subject.provider, subject.host, subject.directory);
}
