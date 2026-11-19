import type { AuthProfile } from './auth-profile';

// A service outside the host that adds a credential to each request the host's agents send to a
// route's URL, so no credential value enters the host.
export interface CredentialRouter {
  // the start of every host name; a route's access policy must admit every name that starts with it
  readonly hostPrefix: string;

  // rejects unless every profile has a route whose access policy admits every name that starts with
  // hostPrefix; runs before anything touches the host
  readonly verifyRoutes: (profiles: readonly AuthProfile[]) => Promise<void>;

  // the URL that each profile's requests go to, keyed by profile name; the router adds the credential there
  readonly readRoutes: (
    profiles: readonly AuthProfile[],
  ) => Promise<Readonly<Record<string, string>>>;
}
