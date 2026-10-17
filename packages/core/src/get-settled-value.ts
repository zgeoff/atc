// calls that go out at once settle together; taking their results one at a
// time keeps the order their failures are reported in.
export function getSettledValue<T>(result: Readonly<PromiseSettledResult<T>>): T {
  if (result.status === 'rejected') {
    throw result.reason;
  }

  return result.value;
}
