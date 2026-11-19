import type { AuthProfile } from './auth-profile';

export interface CredentialRouter {
  readonly hostPrefix: string;

  readonly verifyRoutes: (profiles: readonly AuthProfile[]) => Promise<void>;

  readonly readRoutes: (
    profiles: readonly AuthProfile[],
  ) => Promise<Readonly<Record<string, string>>>;
}
