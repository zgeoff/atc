export interface ImpTargetOptions {
  readonly impPrefix?: string;
  readonly rebindChangedAuth?: boolean;
  readonly dropSysAdmin?: boolean;
  readonly image?: string;
  readonly memoryMib?: number;
  readonly maxMemoryMib?: number;
  readonly guestDir?: string;
  readonly guestATC?: string;
  readonly sessionEnv?: Readonly<Record<string, string>>;
}

export interface ImpProviderOptions {
  // How long each lease the daemon takes lasts before a renewal, in seconds.
  readonly leaseSeconds?: number;

  // The wait before each reconnect to a harness whose connection ended
  // without an exit, in milliseconds.
  readonly reconnectDelaysMs?: readonly number[];

  // The Linux atc binary on the daemon's machine that the provider copies
  // into an imp without one, or null for none. A compiled daemon on Linux
  // copies itself; one run from source has no binary to copy.
  readonly atcBinary?: string | null;

  // The atc version the daemon runs, which the image's atc must print for
  // hooks to run it.
  readonly version: string;
}
