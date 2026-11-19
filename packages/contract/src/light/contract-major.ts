import { CONTRACT_VERSION } from './contract-version';

// The major version of atc, which is the first number of CONTRACT_VERSION. A client sends it in its
// hello, and a daemon accepts a hello whose major equals its own.
export const CONTRACT_MAJOR: number = parseContractMajor(CONTRACT_VERSION);

function parseContractMajor(version: string): number {
  const major = /^(?<major>\d+)\./u.exec(version)?.groups?.['major'];

  if (major === undefined) {
    throw new Error(`the contract's version ${version} names no major version`);
  }

  return Number(major);
}
