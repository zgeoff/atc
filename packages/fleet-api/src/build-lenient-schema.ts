import { z } from 'zod';

// The check of an answer from a daemon on another minor version: an object keeps the keys it does
// not declare, and an enum or a string literal takes any string. Each field keeps its type, and an
// optional field may be absent.
export function buildLenientSchema(schema: z.core.$ZodType): z.ZodType {
  if (schema instanceof z.ZodObject) {
    return z.looseObject(
      Object.fromEntries(
        Object.entries(schema.shape).map(([key, field]) => [key, buildLenientSchema(field)]),
      ),
    );
  }

  if (schema instanceof z.ZodArray) {
    return z.array(buildLenientSchema(schema.element));
  }

  if (schema instanceof z.ZodRecord) {
    return z.record(z.string(), buildLenientSchema(schema.valueType));
  }

  if (schema instanceof z.ZodOptional) {
    return buildLenientSchema(schema.unwrap()).optional();
  }

  if (schema instanceof z.ZodNullable) {
    return buildLenientSchema(schema.unwrap()).nullable();
  }

  if (schema instanceof z.ZodReadonly) {
    return buildLenientSchema(schema.unwrap());
  }

  if (schema instanceof z.ZodUnion) {
    return z.union(schema.options.map((option) => buildLenientSchema(option)));
  }

  if (schema instanceof z.ZodPipe) {
    const checked = schema.in instanceof z.ZodTransform ? schema.out : schema.in;

    return buildLenientSchema(checked);
  }

  if (schema instanceof z.ZodEnum) {
    return z.string();
  }

  if (
    schema instanceof z.ZodLiteral &&
    [...schema.values].every((value) => typeof value === 'string')
  ) {
    return z.string();
  }

  return schema instanceof z.ZodType ? schema : z.unknown();
}
