/**
 * The client end of a daemon connection, for a connection under test with
 * no socket behind it. While accepting, a write takes every byte and
 * returns the count; while not, it takes none and returns 0, as a socket
 * whose kernel buffer is full does, so backpressure is a switch instead of
 * a buffer race. It starts accepting. `collectWrittenLines` returns every
 * complete line taken so far, in order, and `end` does nothing.
 */
export function buildStubPeerSocket() {
  const decoder = new TextDecoder();

  let accepting = true;
  let written = '';

  return {
    // oxlint-disable-next-line prefer-readonly-parameter-types -- a readonly view cannot satisfy the writer contract; the stand-in never mutates chunks
    write: (data: Uint8Array): number => {
      const taken = accepting ? data : data.subarray(0, 0);

      written += decoder.decode(taken);

      return taken.length;
    },
    end: () => {},
    setAccepting: (value: boolean) => {
      accepting = value;
    },
    collectWrittenLines: () => written.split('\n').filter((line) => line !== ''),
  };
}
