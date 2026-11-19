export interface TokenFileAccess {
  readonly openFile: (path: string) => number;
  readonly statFile: (descriptor: number) => { readonly uid: number; readonly mode: number };
  readonly readFile: (descriptor: number) => string;
  readonly closeFile: (descriptor: number) => void;
  readonly readUserID: () => number;
}

type OwnerOnlyRead =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string };

// Any user who can open a token file can read its tokens, so this refuses a file unless
// the process's own user owns it and it has no group or other permission bits.
export function readOwnerOnlyText(path: string, access: TokenFileAccess): OwnerOnlyRead {
  try {
    return readCheckedFile(path, access);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    return { ok: false, reason: `cannot read ${path}: ${detail}` };
  }
}

// POSIX mode bits 0o077 grant read, write or execute to the file's group or to other users.
const SHARED_MODE_BITS = 0o077;

// The file is checked through the descriptor it is read from, so a swap of
// the path between the check and the read changes nothing.
function readCheckedFile(path: string, access: TokenFileAccess): OwnerOnlyRead {
  const descriptor = access.openFile(path);

  try {
    const stats = access.statFile(descriptor);

    if (stats.uid !== access.readUserID()) {
      return {
        ok: false,
        reason: `${path} belongs to another user; give it to this user, then run chmod 600 ${path}`,
      };
    }

    if ((stats.mode & SHARED_MODE_BITS) !== 0) {
      return {
        ok: false,
        reason: `other users can open ${path} (mode ${(stats.mode & 0o777).toString(8)}); run chmod 600 ${path}`,
      };
    }

    return { ok: true, text: access.readFile(descriptor) };
  } finally {
    access.closeFile(descriptor);
  }
}
