import { z } from 'zod';

export const NO_INPUT: Readonly<Record<string, unknown>> = z.toJSONSchema(z.strictObject({}));
