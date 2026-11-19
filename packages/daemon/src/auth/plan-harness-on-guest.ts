import type { AgentAdapter, GuestPaths, GuestSpawnPlan, SpawnOptions } from '@atc/plugin-api';
import { toSignInRefusal } from './to-sign-in-refusal';
import type { HarnessAuthSetup } from './types';

export function planHarnessOnGuest(
  adapter: AgentAdapter,
  options: SpawnOptions,
  paths: GuestPaths,
  auth: HarnessAuthSetup | null,
): GuestSpawnPlan | null {
  try {
    if (adapter.planGuestSpawn !== undefined) {
      return adapter.planGuestSpawn(options, paths);
    }

    const local = adapter.planSpawn(options);

    return { ...local, env: { ...local.env, ...paths.sessionEnv }, files: {} };
  } catch (error) {
    throw auth?.kind === 'broker' ? toSignInRefusal(error, auth.host, auth.binding.secrets) : error;
  }
}
