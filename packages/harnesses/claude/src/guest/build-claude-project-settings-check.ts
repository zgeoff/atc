import { isSubscriptionOverrideVariable } from '@atc/core';
import type { ProjectSettingsCheck } from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import { z } from 'zod';

// a file that is not a JSON object refuses too, since what the CLI would take from it is
// unknown; a refusal names the setting, never its value
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

// The two keys of a project settings file that can carry a sign-in
// override. An `env` that is not an object sets no variable.
const ProjectSettingsSchema = z.looseObject({
  apiKeyHelper: z.unknown().optional(),
  env: z.unknown().optional(),
});

const EnvSchema = z.record(z.string(), z.unknown());

// The first setting a project settings file holds that would override the
// sign-in, as `env.<variable>` or `apiKeyHelper`, the unparseable marker
// for content that is not a JSON object, or null when it holds none.
function findOverrideSetting(content: string): string | null {
  let raw: unknown;

  try {
    raw = JSON.parse(content);
  } catch {
    return UNPARSEABLE;
  }

  const parsed = ProjectSettingsSchema.safeParse(raw);

  if (!parsed.success) {
    return UNPARSEABLE;
  }

  if (parsed.data.apiKeyHelper !== undefined) {
    return 'apiKeyHelper';
  }

  const env = EnvSchema.safeParse(parsed.data.env).data ?? {};
  const variable = Object.keys(env).find((key) => isSubscriptionOverrideVariable(key));

  return variable === undefined ? null : `env.${variable}`;
}
