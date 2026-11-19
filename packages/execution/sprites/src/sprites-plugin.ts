import { readFileSync } from 'node:fs';
import { isCompiledBinary } from '@atc/config/host';
import {
  EXECUTION_TARGET_CONFIG_SCHEMA,
  TargetUnavailableError,
  definePlugin,
} from '@atc/plugin-api';
import { parseSpritesTarget } from './config/parse-sprites-target';
import type { SpritesTokenSource } from './config/parse-sprites-target';
import { createSpritesProvider } from './create-sprites-provider';
import { createSpritesApiPort } from './port/create-sprites-api-port';

export const SPRITES_PLUGIN = definePlugin({
  kind: 'execution',
  id: 'sprites',
  configFields: ['tokenEnv', 'tokenFile', 'spritePrefix', 'apiURL', 'guestDir'],

  configSchema: () =>
    EXECUTION_TARGET_CONFIG_SCHEMA.superRefine((config, ctx) => {
      const parsed = parseSpritesTarget(config.id, config.options);

      if (parsed.kind === 'refused') {
        ctx.addIssue({ code: 'custom', message: parsed.problem });
      }
    }),

  create: (config, host) => {
    const parsed = parseSpritesTarget(config.id, config.options);

    if (parsed.kind === 'refused') {
      throw new TargetUnavailableError(config.id, parsed.problem);
    }

    const target = parsed.target;
    const problem = readTokenProblem(target.token, config.env);

    if (problem !== null) {
      throw new TargetUnavailableError(config.id, `target ${JSON.stringify(config.id)} ${problem}`);
    }

    // each sprite runs the daemon's own binary, which a daemon run from source lacks
    if (!isCompiledBinary()) {
      throw new TargetUnavailableError(
        config.id,
        "compiled_binary_required: the sprites provider runs the daemon's compiled binary in each sprite, and this daemon runs from source",
      );
    }

    return createSpritesProvider(
      createSpritesApiPort({
        apiURL: target.apiURL,
        readToken: () => readToken(target.token, config.env),
      }),
      target,
      {
        targetID: config.id,
        atcBinary: process.execPath,
        getBuild: () => host.build,
        log: host.log,
      },
    );
  },
});

// why the token cannot be used, naming the variable or the file and never the value
function readTokenProblem(
  source: SpritesTokenSource,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  try {
    readToken(source, env);

    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'has a token that cannot be read';
  }
}

function readToken(
  source: SpritesTokenSource,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (source.kind === 'env') {
    const value = env[source.name];

    if (value === undefined || value === '') {
      throw new Error(`reads its Sprites token from ${source.name}, which is unset or empty`);
    }

    return value;
  }

  let text: string;

  try {
    text = readFileSync(source.path, 'utf8');
  } catch (error) {
    const code =
      error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'unknown error';

    throw new Error(`cannot read its Sprites token file ${source.path}: ${code}`, { cause: error });
  }

  const token = text.trim();

  if (token === '') {
    throw new Error(`reads its Sprites token from ${source.path}, which is empty`);
  }

  return token;
}
