import { posix } from 'node:path';
import type { SessionID } from '@atc/core';
import type { AgentAdapter, ExecutionProvider } from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import type { HostDirClaims } from '../sessions/create-host-dir-claims';
import { REPOSITORY_ENV_UNSET_ARGV } from '../workspace/repository-env-unset-argv';
import { READ_PROJECT_SETTINGS_SCRIPT } from './read-project-settings-script';

// The launch whose project settings a host holds: the agent and provider,
// the host and target, and the directory the harness starts in.
export interface ProjectSettingsLaunch {
  readonly adapter: AgentAdapter;
  readonly provider: ExecutionProvider;
  readonly hostKey: SessionID;
  readonly target: string;
  readonly cwd: string;
}

const ABSENT_DIR_EXIT = 3;

// The largest settings file atc reads.
const MAX_SETTINGS_BYTES = 1_048_576;

export async function requireProjectSettings(
  claims: Pick<HostDirClaims, 'resolveHostHome'>,
  launch: ProjectSettingsLaunch,
): Promise<void> {
  const adapter = launch.adapter;
  const provider = launch.provider;
  const hostKey = launch.hostKey;
  const target = launch.target;
  const cwd = launch.cwd;
  const check = adapter.planProjectSettingsCheck?.();

  if (check === undefined) {
    return;
  }

  // The host resolves the directory as given, since a lexical join would
  // drop a parent step after a symlink that the host follows.
  const home = posix.isAbsolute(cwd) ? null : await claims.resolveHostHome(provider, hostKey);
  const directory = home === null ? cwd : `${home}/${cwd}`;

  const found = await provider.runCommand({
    argv: [
      ...REPOSITORY_ENV_UNSET_ARGV,
      'sh',
      '-c',
      READ_PROJECT_SETTINGS_SCRIPT,
      'sh',
      directory,
      ...check.files,
      '--',
      ...check.rootFiles,
    ],
    cwd: '/',
    host: hostKey,
  });

  if (found.exitCode === ABSENT_DIR_EXIT) {
    return;
  }

  if (found.exitCode !== 0) {
    throw buildUnreadableSettingsRefusal(adapter.id, target, directory);
  }

  for (const [path, read] of collectSettingsReads(found.stdout)) {
    const content = read === null ? null : Buffer.from(read, 'base64');

    // a file the host holds but cannot read as a settings file refuses, since what the agent
    // would take from it is unknown
    if (content === null || content.byteLength > MAX_SETTINGS_BYTES) {
      throw buildUnreadableSettingsRefusal(adapter.id, target, path);
    }

    const refusal = check.findRefusal(path, new TextDecoder().decode(content));

    if (refusal !== null) {
      throw new DaemonError(refusal.code, refusal.message, { ...refusal.data, target });
    }
  }
}

function buildUnreadableSettingsRefusal(agent: string, target: string, path: string): DaemonError {
  return new DaemonError(
    'auth_target_unsupported',
    `agent '${agent}' signs in through the broker of target '${target}', but atc cannot read ${path} there as a settings file to check it for settings that would override that sign-in`,
    { agent, target, problem: 'project_settings_unreadable', file: path },
  );
}

// Each path the settings read printed, once and in the order it first
// printed it, with the file's content in base64, or null for a path it
// could not read as a settings file.
function collectSettingsReads(stdout: string): Map<string, string | null> {
  const fields = stdout.split('\0');

  const reads = new Map<string, string | null>();

  for (let index = 0; index + 1 < fields.length; index += 2) {
    const path = fields[index] ?? '';
    const read = fields[index + 1] ?? '';
    const content = read.startsWith('F') ? read.slice(1) : null;

    if (path !== '' && !reads.has(path)) {
      reads.set(path, content);
    }
  }

  return reads;
}
