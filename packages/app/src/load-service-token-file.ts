import { readOwnerOnlyText } from '@atc/config/token-file';
import type { TokenFileAccess } from '@atc/config/token-file';
import { parseServiceTokenFile } from '@atc/mcp';
import type { ServiceTokenFile } from '@atc/mcp';

type LoadedServiceTokenFile =
  | { readonly ok: true; readonly file: ServiceTokenFile }
  | { readonly ok: false; readonly reason: string };

// The file has to pass the check the daemon's token file passes: the process's
// own user owns it, and no group or other bit is set.
export function loadServiceTokenFile(
  path: string,
  access: TokenFileAccess,
): LoadedServiceTokenFile {
  const read = readOwnerOnlyText(path, access);

  if (!read.ok) {
    return read;
  }

  const parsed = parseServiceTokenFile(read.text);

  return parsed.ok ? parsed : { ok: false, reason: `${path}: ${parsed.reason}` };
}
