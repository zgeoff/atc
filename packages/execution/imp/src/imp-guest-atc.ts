import type { GuestLayout } from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import CHECK_GUEST_ATC_SCRIPT from './check-guest-atc.sh' with { type: 'text' };
import type { ImpPort } from './imp-port';
import INSTALL_GUEST_ATC_SCRIPT from './install-guest-atc.sh' with { type: 'text' };
import LINK_GUEST_ATC_SCRIPT from './link-guest-atc.sh' with { type: 'text' };
import { NO_GZIP_CODE } from './no-gzip-code';
import { readGuestATCArchive } from './read-guest-atc-archive';
import READ_GUEST_ATC_SCRIPT from './read-guest-atc.sh' with { type: 'text' };
import READY_GUEST_DIR_SCRIPT from './ready-guest-dir.sh' with { type: 'text' };

interface ImpGuestATCOptions {
  readonly port: ImpPort;
  readonly guest: GuestLayout;
  readonly guestATC: string | undefined;
  readonly atcBinary: string | null;
  readonly version: string;
}

// The atc that hooks inside each imp run, and what the provider knows of the
// atc each imp's image ships.
export class ImpGuestATC {
  private readonly port: ImpPort;

  private readonly guest: GuestLayout;

  private readonly guestATC: string | undefined;

  private readonly atcBinary: string | null;

  private readonly version: string;

  // The version the image's atc printed on each imp, or null for an imp
  // without one, kept once a readying of the imp succeeds: an imp's image
  // never changes, and `bin/atc` there then runs the daemon's version.
  private readonly imageATCVersions = new Map<string, string | null>();

  // The signature an image's atc showed when it printed its version last, its
  // resolved path, inode, size and mtime, so a new imp of the same image takes
  // that version without running it.
  private imageATC: Readonly<{ signature: string; version: string }> | null = null;

  constructor(options: ImpGuestATCOptions) {
    this.port = options.port;
    this.guest = options.guest;
    this.guestATC = options.guestATC;
    this.atcBinary = options.atcBinary;
    this.version = options.version;
  }

  // An imp made anew, or destroyed, has no known image atc.
  removeImageVersion(name: string): void {
    this.imageATCVersions.delete(name);
  }

  // A cold boot clears the guest folder, so each readying links the image's atc
  // or copies the provider's binary in again.
  async setupGuest(name: string, installATC: boolean, log: (line: string) => void): Promise<void> {
    if (installATC && this.guestATC !== undefined) {
      await this.setupGuestATC(name, this.guestATC, log);

      return;
    }

    const ready = await this.port.runCommand(name, {
      argv: ['sh', '-c', READY_GUEST_DIR_SCRIPT, 'sh', this.guest.directory, this.guest.atc ?? ''],
    });

    if (ready.code === 0 || !installATC) {
      return;
    }

    if (this.atcBinary === null) {
      throw new DaemonError(
        'unsupported_operation',
        `imp ${name} has no executable atc at ${this.guest.atc ?? '(none)'}`,
        { provider: 'imp', problem: 'no_guest_atc' },
      );
    }

    await this.copyATCBinary(name, this.atcBinary);
  }

  // The first readying reads the image's version in the same command that links
  // it; a later one links again or checks the copy.
  private async setupGuestATC(
    name: string,
    image: string,
    log: (line: string) => void,
  ): Promise<void> {
    const directory = this.guest.directory;
    const known = this.imageATCVersions.has(name);
    let imageVersion = this.imageATCVersions.get(name) ?? null;
    let copiedVersion: string | null = null;

    if (known && imageVersion === this.version) {
      const linked = await this.port.runCommand(name, {
        argv: ['sh', '-c', LINK_GUEST_ATC_SCRIPT, 'sh', directory, image],
      });

      if (linked.code !== 0) {
        throw new Error(
          `linking ${directory}/bin/atc to ${image} in ${name} exited ${linked.code ?? 'by a signal'}`,
        );
      }
    } else if (known) {
      const ready = await this.port.runCommand(name, {
        argv: ['sh', '-c', CHECK_GUEST_ATC_SCRIPT, 'sh', directory],
      });

      copiedVersion = ready.code === 0 ? this.version : null;
    } else {
      const read = await this.port.runCommand(name, {
        argv: [
          'sh',
          '-c',
          READ_GUEST_ATC_SCRIPT,
          'sh',
          directory,
          image,
          this.version,
          this.imageATC?.signature ?? '',
          this.imageATC?.version ?? '',
        ],
      });

      if (read.code !== 0) {
        throw new Error(`reading the atc versions in ${name} exited ${read.code ?? 'by a signal'}`);
      }

      const [readImage, readCopied, readSignature] = new TextDecoder()
        .decode(read.stdout)
        .split('\n');

      imageVersion = readImage === undefined || readImage === '' ? null : readImage;
      copiedVersion = readCopied === undefined || readCopied === '' ? null : readCopied;

      if (imageVersion !== null && readSignature !== undefined && readSignature !== '') {
        this.imageATC = { signature: readSignature, version: imageVersion };
      }
    }

    const found =
      imageVersion === null
        ? `the image has no executable atc at ${image}`
        : `the image's atc at ${image} is ${imageVersion}`;

    if (imageVersion === this.version) {
      this.imageATCVersions.set(name, imageVersion);

      log(`imp ${name} runs hooks through the image's atc ${this.version} at ${image}`);

      return;
    }

    if (copiedVersion === this.version) {
      this.imageATCVersions.set(name, imageVersion);

      log(
        `imp ${name} runs hooks through the daemon's atc ${this.version}, already at ${directory}/bin/atc: ${found}`,
      );

      return;
    }

    if (this.atcBinary === null) {
      throw new DaemonError(
        'unsupported_operation',
        `imp ${name} cannot run hooks through atc ${this.version}: ${found}, and a daemon run from source has no binary to copy in; install atc ${this.version} there, or run a compiled atc daemon on Linux`,
        { provider: 'imp', problem: 'no_guest_atc' },
      );
    }

    await this.copyATCBinary(name, this.atcBinary);

    this.imageATCVersions.set(name, imageVersion);

    log(
      `imp ${name} runs hooks through the daemon's atc ${this.version}, copied to ${directory}/bin/atc: ${found}`,
    );
  }

  // Copies the binary to `bin/atc`, replacing a link to the image's atc.
  // The binary crosses the network to impd, so it goes over gzipped, and an
  // imp without gzip refuses the copy before it reads any input.
  private async copyATCBinary(name: string, atcBinary: string): Promise<void> {
    const unpacked = await this.port.runCommand(name, {
      argv: [
        'sh',
        '-c',
        INSTALL_GUEST_ATC_SCRIPT,
        'sh',
        this.guest.directory,
        String(NO_GZIP_CODE),
      ],
      stdin: await readGuestATCArchive(atcBinary),
    });

    if (unpacked.code === NO_GZIP_CODE) {
      throw new Error(
        `imp ${name} has no gzip, which installing atc in ${this.guest.directory} needs; install gzip in its image`,
      );
    }

    if (unpacked.code !== 0) {
      throw new Error(`tar exited ${unpacked.code ?? 'by a signal'} installing atc in ${name}`);
    }
  }
}
