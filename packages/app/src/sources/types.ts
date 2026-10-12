/**
 * What a candidate or a typed input resolves to: a directory on the
 * daemon's host, or a git repository URL that a probe pins to a commit
 * before any spawn uses it.
 */
type SourcePick =
  | { readonly kind: 'path'; readonly dir: string }
  | { readonly kind: 'git'; readonly url: string };

// The kind of pick every candidate of one source resolves to.
export type SourceKind = SourcePick['kind'];

// One entry a source lists for the spawn picker.
interface SourceCandidate {
  readonly label: string;
  readonly detail?: string;
  readonly pick: SourcePick;
}

// One listing: the candidates, and the scope they were listed under, or
// null when the source lists without one.
interface SourceListing {
  readonly candidates: readonly SourceCandidate[];
  readonly scope: string | null;
}

// What a listing asks for: a scope the source defines, such as one account,
// and filter text for a source that filters on the daemon.
interface SourceQuery {
  readonly scope?: string;
  readonly text?: string;
}

/**
 * What a source reads typed input as: a scope to list, a pick, or nothing
 * it recognizes.
 */
export type SourceInterpretation =
  | { readonly kind: 'browse'; readonly scope: string }
  | SourcePick
  | { readonly kind: 'none' };

/**
 * The request a source serves: the execution target the spawn will use,
 * and the daemon's spawn history as the requesting principal may read it.
 */
export interface SourceRequest {
  readonly target: string;
  readonly collectSpawnDirs: () => Promise<string[]>;
}

/**
 * A discovery source for the spawn picker. It lists candidates and reads
 * typed input, and every candidate resolves to a pick of its kind. A source
 * runs on the daemon, the host that materializes the workspace, and gets
 * the services it uses when it is built. A failure throws the error the
 * source defines for it.
 */
export interface SourceProvider {
  readonly id: string;
  readonly label: string;
  readonly kind: SourceKind;
  readonly list: (query: SourceQuery, request: SourceRequest) => Promise<SourceListing>;
  readonly interpret: (input: string, request: SourceRequest) => Promise<SourceInterpretation>;

  // The other URLs of the repository at a git URL the daemon's host could
  // not read, for a source that knows its host's URL forms; none when it
  // does not recognize the URL.
  readonly findAlternateURLs?: (url: string) => readonly string[];
}
