import { isCompiledBinary } from '@atc/config/host';

// The binary the provider copies into an imp: the running daemon itself
// when it is a compiled Linux binary, since an imp runs Linux.
export function findOwnLinuxBinary(): string | null {
  return isCompiledBinary() && process.platform === 'linux' ? process.execPath : null;
}
