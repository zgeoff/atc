type SourcePick =
  | { readonly kind: 'path'; readonly directory: string }
  | { readonly kind: 'git'; readonly url: string };

export type SourceKind = SourcePick['kind'];

interface SourceCandidate {
  readonly label: string;
  readonly detail?: string;
  readonly pick: SourcePick;
}

interface SourceListing {
  readonly candidates: readonly SourceCandidate[];
  readonly scope: string | null;
}

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

  readonly readSpawnDirs: () => Promise<string[]>;
}

export interface SourceInputRequest extends SourceRequest {
  readonly clientCwd?: string;
}

export interface SourceProvider {
  readonly id: string;
  readonly label: string;
  readonly kind: SourceKind;
  readonly list: (query: SourceQuery, request: SourceRequest) => Promise<SourceListing>;
  readonly interpret: (input: string, request: SourceInputRequest) => Promise<SourceInterpretation>;

  readonly findAlternateURLs?: (url: string) => readonly string[];

  readonly complete?: (input: string, request: SourceInputRequest) => Promise<SourceCandidate[]>;
}
