// a probe pins a git pick to a commit before any spawn uses it.
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

export type SourceInterpretation =
  | { readonly kind: 'browse'; readonly scope: string }
  | SourcePick
  | { readonly kind: 'none' };

export interface SourceRequest {
  readonly target: string;

  // the daemon's spawn history as the requesting principal may read it.
  readonly collectSpawnDirs: () => Promise<string[]>;
}

export interface SourceCompletionRequest extends SourceRequest {
  // a hint a source reads only when the daemon runs on the client's machine.
  readonly clientCwd?: string;
}

// a source runs on the daemon, the host that materializes the workspace, and
// a failure throws the error the source defines for it.
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

  // Completions of partly typed input, best first, such as the directories
  // a typed path could continue to, each with the label the picker shows.
  // Absent: the source completes nothing.
  readonly complete?: (
    input: string,
    request: SourceCompletionRequest,
  ) => Promise<SourceCandidate[]>;
}
