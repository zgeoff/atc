import { isSubscriptionOverrideVariable } from '@atc/core';
import type { ProjectSettingsCheck } from '@atc/plugin-api';
import { AtcError } from '@atcx/contract/light';
import { z } from 'zod';

const LOCAL_SETTINGS_FILE = '.claude/settings.local.json';
const UNPARSEABLE = '(unparseable)';

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
          ? `agent '${agent}' signs in through the target's broker, but ${file} is not a JSON object, so atc cannot check it for settings that would override that sign-in`
          : `agent '${agent}' signs in through the target's broker, but ${file} sets ${setting}, which would override or route around that sign-in`;

      return new AtcError('auth_target_unsupported', message, {
        agent,
        problem: 'project_settings_conflict',
        file,
        setting,
      });
    },
  };
}

const ProjectSettingsSchema = z.looseObject({
  apiKeyHelper: z.unknown().optional(),
  env: z.unknown().optional(),
});

const EnvSchema = z.record(z.string(), z.unknown());

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
