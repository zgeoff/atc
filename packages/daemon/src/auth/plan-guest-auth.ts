import type { GuestPaths } from '@atc/plugin-api';
import { loadOAuthStates } from './load-oauth-states';
import type { BrokerHarnessAuth, RoutedHarnessAuth } from './types';

// The revision and placeholders a guest plan launches under: the broker's, with the sign-in
// state it lists for each oauth secret, or on a routed host revision 1 with each profile's route.
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
