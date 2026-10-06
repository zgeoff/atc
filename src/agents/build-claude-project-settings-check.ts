import { DaemonError } from '../protocol/daemon-error';
import { isSubscriptionOverrideVariable } from '../shared/is-subscription-override-variable';
import { isRecord } from '../shared/report';
import type { ProjectSettingsCheck } from './agent-adapter';

/**
 * The check of a Claude CLI session's project settings before a launch
 * behind impd's broker. The CLI applies a repository's
 * `.claude/settings.json` from the directory it starts in, and its
 * `.claude/settings.local.json` from there and from the repository's root
 * or a worktree's main checkout, once the folder is trusted; a person can
 * accept that trust inside the session. Each file refuses the launch when
 * its `env` block sets a variable that would override the sign-in or route
 * around the broker, or when it sets `apiKeyHelper`. A file that is not a
 * JSON object refuses it too, since what the CLI would take from it is
 * unknown. A refusal holds the setting's name, never its value.
 */
export function buildClaudeProjectSettingsCheck(agent: string): ProjectSettingsCheck {
  return {
    files: ['.claude/settings.json', LOCAL_SETTINGS_FILE],
    rootFiles: [LOCAL_SETTINGS_FILE],
    findRefusal: (file, content) => {
      const setting = findOverrideSetting(content);

      if (setting === null) {
        return null;
      }

      const message =
        setting === UNPARSEABLE
          ? `agent '${agent}' signs in through impd's broker, but ${file} is not a JSON object, so atc cannot check it for settings that would override that sign-in`
          : `agent '${agent}' signs in through impd's broker, but ${file} sets ${setting}, which would override or route around that sign-in`;

      return new DaemonError('auth_target_unsupported', message, {
        agent,
        problem: 'project_settings_conflict',
        file,
        setting,
      });
    },
  };
}

const LOCAL_SETTINGS_FILE = '.claude/settings.local.json';
const UNPARSEABLE = '(unparseable)';

// The first setting a project settings file holds that would override the
// sign-in, as `env.<variable>` or `apiKeyHelper`, the unparseable marker
// for content that is not a JSON object, or null when it holds none.
function findOverrideSetting(content: string): string | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch {
    return UNPARSEABLE;
  }

  if (!isRecord(parsed)) {
    return UNPARSEABLE;
  }

  if (parsed['apiKeyHelper'] !== undefined) {
    return 'apiKeyHelper';
  }

  const env = parsed['env'];

  const variable = isRecord(env)
    ? Object.keys(env).find((key) => isSubscriptionOverrideVariable(key))
    : undefined;

  return variable === undefined ? null : `env.${variable}`;
}
