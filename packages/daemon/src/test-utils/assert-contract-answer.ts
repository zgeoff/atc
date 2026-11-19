import { findAnswerSchema } from '@atc/protocol';

export function assertContractAnswer(method: string, ok: Readonly<Record<string, unknown>>): void {
  const schema = findAnswerSchema(method);

  if (schema === null) {
    return;
  }

  const parsed = schema.safeParse(ok);

  if (!parsed.success) {
    throw new Error(`${method} answered outside its contract: ${parsed.error.message}`);
  }

  if (!Bun.deepEquals(parsed.data, ok)) {
    throw new Error(
      `${method} answered fields its contract drops: ${JSON.stringify(ok)} parsed as ${JSON.stringify(parsed.data)}`,
    );
  }
}
