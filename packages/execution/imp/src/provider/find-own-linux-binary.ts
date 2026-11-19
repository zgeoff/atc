import { isCompiledBinary } from '@atc/config/host';

// An imp runs Linux, so the running daemon can be copied into one only when it is a
// compiled Linux binary.
export function findOwnLinuxBinary(): string | null {
  return isCompiledBinary() && process.platform === 'linux' ? process.execPath : null;
}
