import { readOwnerOnlyText } from '@atc/config/token-file';
import type { TokenFileAccess } from '@atc/config/token-file';
import { SERVICE_TOKEN_PREFIX, parseServiceTokenFile } from '@atc/mcp';
import type { ServiceTokenFile } from '@atc/mcp';
import { GRANT_SCOPES } from '@atcx/contract';
import type { GrantScope } from '@atcx/contract';

type LoadedServiceTokenFile =
  | { readonly ok: true; readonly file: ServiceTokenFile<GrantScope> }
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

  const parsed = parseServiceTokenFile(read.text, {
    prefix: SERVICE_TOKEN_PREFIX,
    scopes: GRANT_SCOPES,
  });

  return parsed.ok ? parsed : { ok: false, reason: `${path}: ${parsed.reason}` };
}
