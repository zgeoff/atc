import type { ColourDepth } from './types';

export interface ColourEnv {
  readonly colorterm: string | undefined;
  readonly term: string | undefined;
}

export function pickColourDepth(env: ColourEnv): ColourDepth {
  if (env.colorterm === 'truecolor' || env.colorterm === '24bit') {
    return 'truecolor';
  }

  return env.term?.endsWith('-256color') === true ? '256' : '16';
}
