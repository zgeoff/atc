import { CONTRACT_VERSION } from './contract-version';
import { DAEMON_FEATURES } from './daemon-features';
import type { DaemonFeature } from './daemon-features';
import type { HelloResult } from './hello-result';

export type DaemonCheck =
  | {
      readonly verdict: 'match';
      readonly missing: readonly DaemonFeature[];
      readonly added: readonly string[];
    }
  | {
      readonly verdict: 'older' | 'newer';
      readonly daemonMajor: number;
      readonly contractMajor: number;
    }
  | { readonly verdict: 'unreadable'; readonly daemon: string };

export function checkDaemon(
  hello: Pick<HelloResult, 'daemon' | 'features'>,
  contractVersion: string = CONTRACT_VERSION,
): DaemonCheck {
  const daemonMajor = parseMajor(hello.daemon.replace(/^atc\//u, ''));
  const contractMajor = parseMajor(contractVersion);

  if (contractMajor === null) {
    throw new Error(`the contract's version ${contractVersion} names no major version`);
  }

  if (daemonMajor === null) {
    return { verdict: 'unreadable', daemon: hello.daemon };
  }

  if (daemonMajor !== contractMajor) {
    return {
      verdict: daemonMajor < contractMajor ? 'older' : 'newer',
      daemonMajor,
      contractMajor,
    };
  }

  const known: readonly string[] = DAEMON_FEATURES;

  return {
    verdict: 'match',
    missing: DAEMON_FEATURES.filter((feature) => !hello.features.includes(feature)),
    added: hello.features.filter((feature) => !known.includes(feature)),
  };
}

function parseMajor(version: string): number | null {
  const major = /^(?<major>\d+)\.\d+\.\d+/u.exec(version)?.groups?.['major'];

  return major === undefined ? null : Number(major);
}
