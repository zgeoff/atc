import type { CredentialRouter } from '@atc/plugin-api';

// A router that admits every profile and routes each one to a URL named for it, and records the
// profile names of each verification.
export function buildStubCredentialRouter() {
  const verified: string[][] = [];

  const router: CredentialRouter = {
    hostPrefix: 'atc-',
    verifyRoutes: (profiles) => {
      verified.push(profiles.map((profile) => profile.name));

      return Promise.resolve();
    },
    readRoutes: (profiles) =>
      Promise.resolve(
        Object.fromEntries(
          profiles.map((profile) => [profile.name, `https://route.example/${profile.name}`]),
        ),
      ),
  };

  return { router, verified };
}
