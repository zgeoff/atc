// bun-pty embeds one librust_pty per libc a target can run, and Bun gives each
// a hashed name such as `librust_pty_musl-j5hf8p7d.so`.
const PTY_LIBRARY_NAME = /^librust_pty(?:_arm64)?(?<musl>_musl)?-[^.]+\.(?:so|dylib)$/u;

export function pickPTYLibrary(files: readonly Blob[], musl: boolean): string | null {
  for (const file of files) {
    const name = 'name' in file && typeof file.name === 'string' ? file.name : '';
    const groups = PTY_LIBRARY_NAME.exec(name)?.groups;

    if (groups !== undefined && (groups['musl'] !== undefined) === musl) {
      return name;
    }
  }

  return null;
}
