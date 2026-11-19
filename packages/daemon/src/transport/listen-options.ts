export interface ListenOptions {
  readonly host: string;
  readonly port: number;
  readonly tokenFile: string;

  readonly failureDelayMs?: number;

  readonly maxDelayedHandshakes?: number;

  readonly refusalLogIntervalMs?: number;

  readonly maxRefusalWindows?: number;
}
