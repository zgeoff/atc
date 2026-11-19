import { FFIType, dlopen, ptr } from 'bun:ffi';

const SOL_SOCKET = 1;
const SO_PEERCRED = 17;

// `struct ucred` holds the peer's pid, uid and gid, each 32 bits wide.
const UCRED_FIELDS = 3;

export function readPeerPID(socket: object): number | null {
  const fd: unknown = Reflect.get(socket, 'fd');

  if (process.platform !== 'linux' || typeof fd !== 'number' || fd < 0) {
    return null;
  }

  const cred = new Int32Array(UCRED_FIELDS);
  const length = new Uint32Array([cred.byteLength]);

  libc ??= tryOpenLibc();

  if (libc === 'missing') {
    return null;
  }

  const result = libc.symbols.getsockopt(fd, SOL_SOCKET, SO_PEERCRED, ptr(cred), ptr(length));
  const pid = cred[0] ?? 0;

  return result === 0 && pid > 0 ? pid : null;
}

// A Linux system without glibc, such as one built on musl, has no libc.so.6 to open.
// Peer reads on such a system return null.
let libc: ReturnType<typeof openLibc> | 'missing' | null = null;

function tryOpenLibc(): ReturnType<typeof openLibc> | 'missing' {
  try {
    return openLibc();
  } catch {
    return 'missing';
  }
}

function openLibc() {
  return dlopen('libc.so.6', {
    getsockopt: {
      args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
  });
}
