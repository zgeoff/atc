export function buildStubRequestClient(
  answers: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  failure: Error | null = null,
) {
  const asked: string[] = [];

  return {
    asked,
    sendRequest: (method: string): Promise<Readonly<Record<string, unknown>>> => {
      asked.push(method);

      return failure === null ? Promise.resolve(answers[method] ?? {}) : Promise.reject(failure);
    },
  };
}
