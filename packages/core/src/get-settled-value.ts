/**
 * The value of a settled promise, or its rejection thrown again. Calls that
 * go out at once settle together, and taking their results one at a time
 * keeps the order in which their failures are reported.
 */
export function getSettledValue<T>(result: Readonly<PromiseSettledResult<T>>): T {
  if (result.status === 'rejected') {
    throw result.reason;
  }

  return result.value;
}
