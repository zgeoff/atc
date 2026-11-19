// Promise.all rejects with whichever call fails first in time; unwrapping allSettled results
// one at a time reports failures in the order the calls were made.
export function getSettledValue<T>(result: Readonly<PromiseSettledResult<T>>): T {
  if (result.status === 'rejected') {
    throw result.reason;
  }

  return result.value;
}
