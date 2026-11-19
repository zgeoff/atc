// What the provider needs of the Sprites API. One adapter answers it over the REST and WebSocket
// API, and an in-memory fake answers it in tests.
export interface SpritesPort {
  readonly readSprite: (name: string) => Promise<SpriteView | null>;
  readonly createSprite: (name: string) => Promise<SpriteView>;

  // a sprite already gone counts as deleted
  readonly removeSprite: (name: string) => Promise<void>;
  readonly listExecs: (name: string) => Promise<readonly ExecView[]>;

  // starts an exec, or attaches to request.execID
  readonly openExec: (name: string, request: ExecRequest) => ExecConnection;
  readonly readConnectors: () => Promise<readonly ConnectorView[]>;
  readonly readFile: (name: string, path: string) => Promise<Uint8Array | null>;
  readonly writeFile: (
    name: string,
    path: string,
    content: Uint8Array,
    mode: number,
  ) => Promise<void>;
}

export interface SpriteView {
  // a sprite made again under the same name gets a new id
  readonly id: string;
  readonly name: string;

  // running while a client is attached; warm and cold are asleep, and the two flap
  readonly status: 'cold' | 'warm' | 'running';
}

export interface ConnectorView {
  readonly id: string;

  // the connector's kind: `custom_api` for an Anthropic route
  readonly provider: string;

  // access_policy.name_prefix: Sprites admits a sprite whose name starts with it, and null admits none
  readonly namePrefix: string | null;
}

export interface ExecView {
  readonly id: string;
  readonly command: string;
  readonly tty: boolean;
}

export interface ExecRequest {
  // attaches to this exec, which replays its stdout from its first byte; the other fields then
  // stay unused
  readonly execID?: string;
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly tty: boolean;
  readonly cols?: number;
  readonly rows?: number;

  // the exec keeps running after every client has gone, for as long as the sprite is awake
  readonly outlivesClients?: boolean;
}

export type ExecEnd =
  | { readonly kind: 'exit'; readonly exitCode: number }
  | { readonly kind: 'dropped' };

export interface ExecConnection {
  // resolves with the exec's id once the exec has started or attached, and rejects when the
  // connection fails first
  readonly execID: Promise<string>;
  readonly onData: (listener: (data: Uint8Array, stream: 'stdout' | 'stderr') => void) => void;
  readonly onEnd: (listener: (end: ExecEnd) => void) => void;
  readonly write: (data: Uint8Array) => Promise<void>;

  // closes the exec's stdin
  readonly endInput: () => void;
  readonly resize: (cols: number, rows: number) => void;
  readonly signal: (signal: 'SIGTERM' | 'SIGKILL') => void;

  // lets go of the connection and leaves the exec running; no listener fires after it
  readonly detach: () => void;
}
