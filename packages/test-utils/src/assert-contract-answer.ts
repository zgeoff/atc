import { findAnswerSchema } from '@atc/protocol/find-answer-schema';

/**
 * Throws unless a daemon answer parses under its method's contract output
 * schema to the same value, so the schema neither refuses the answer nor
 * drops a field of it. A method the contract does not define passes.
 */
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
