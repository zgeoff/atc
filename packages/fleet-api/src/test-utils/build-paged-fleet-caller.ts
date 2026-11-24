import { buildStubFleetCaller } from './build-stub-fleet-caller';

// A caller that answers each request with the next page in the list, and rejects once the list
// runs out.
export function buildPagedFleetCaller(pages: readonly Readonly<Record<string, unknown>>[]) {
  const queue = [...pages];

  return buildStubFleetCaller({
    answer: () => {
      const next = queue.shift();

      if (next === undefined) {
        throw new Error('the test queued no page for this request');
      }

      return next;
    },
  });
}
