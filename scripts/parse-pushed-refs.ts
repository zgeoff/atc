export interface PushedRef {
  readonly localSha: string;

  // Null when the push creates the remote ref.
  readonly remoteSha: string | null;
}

const zeroSha = /^0+$/u;

// git writes one `<local ref> <local sha> <remote ref> <remote sha>` line per ref it pushes.
export function parsePushedRefs(text: string): PushedRef[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => {
      const [, localSha, , remoteSha] = line.trim().split(' ');

      if (localSha === undefined || remoteSha === undefined) {
        throw new Error(`cannot read the pushed ref line: ${line}`);
      }

      // A push that deletes the remote ref sends no commit.
      if (zeroSha.test(localSha)) {
        return [];
      }

      return [{ localSha, remoteSha: zeroSha.test(remoteSha) ? null : remoteSha }];
    });
}
