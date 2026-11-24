import { isRecord } from '@atc/core';
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
    return buildLenientUnion(schema.options);
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

// A union whose options each tag themselves with a listed string, such as a state, keeps that tag
// exact where an option lists it: a value that carries a listed tag must pass that option's check,
// and only a tag no option lists falls to any option.
function buildLenientUnion(options: readonly z.core.$ZodType[]): z.ZodType {
  const lenientOptions = options.map((option) => buildLenientSchema(option));
  const union = z.union(lenientOptions);
  const key = findTagKey(options);

  if (key === undefined) {
    return union;
  }

  const tagLists = options.map((option) => listTags(option, key));

  return union.refine((value) => {
    const tag = isRecord(value) ? value[key] : undefined;
    const index = tagLists.findIndex((tags) => tags.some((listed) => listed === tag));

    return index === -1 || (lenientOptions[index]?.safeParse(value).success ?? false);
  });
}

function findTagKey(options: readonly z.core.$ZodType[]): string | undefined {
  const [first] = options;

  if (!(first instanceof z.ZodObject)) {
    return undefined;
  }

  return Object.keys(first.shape).find((key) =>
    options.every((option) => listTags(option, key).length > 0),
  );
}

function listTags(option: z.core.$ZodType, key: string): readonly string[] {
  const field = option instanceof z.ZodObject ? option.shape[key] : undefined;

  if (field instanceof z.ZodEnum) {
    return Object.values(field.enum).filter((value) => typeof value === 'string');
  }

  if (field instanceof z.ZodLiteral) {
    return [...field.values].filter((value) => typeof value === 'string');
  }

  return [];
}
