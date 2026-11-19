import type { GuestPaths } from '@atc/plugin-api';
import { loadOAuthStates } from './load-oauth-states';
import type { BrokerHarnessAuth, RoutedHarnessAuth } from './types';

export async function planGuestAuth(
  auth: BrokerHarnessAuth | RoutedHarnessAuth,
  revision: number,
): Promise<NonNullable<GuestPaths['auth']>> {
  if (auth.kind === 'routed') {
    return {
      revision: 1,
      env: auth.binding.placeholderEnv,
      profileEnv: auth.binding.profileEnv,
      routes: await auth.router.readRoutes(auth.profiles),
    };
  }

  const oauth = await loadOAuthStates(auth.host, auth.binding);

  return {
    revision,
    env: auth.binding.placeholderEnv,
    profileEnv: auth.binding.profileEnv,
    ...(auth.binding.telemetryHost === null ? {} : { telemetryHost: auth.binding.telemetryHost }),
    ...(oauth === undefined ? {} : { oauth }),
  };
}
