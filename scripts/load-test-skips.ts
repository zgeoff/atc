// Loads the list of tests that the pre-push test step skips: each entry holds
// a test file, the full name of one test in it, and the Linear issue that
// tracks the test's failure on a developer host.
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const testSkipSchema = z
  .object({
    file: z.string().regex(/\.test\.ts$/u, 'must be a .test.ts path'),
    test: z.string().min(1),
    issue: z.string().regex(/^GEO-\d+$/u, 'must be a Linear issue ID such as GEO-123'),
  })
  .strict();

const testSkipsSchema = z.array(testSkipSchema);

export type TestSkip = z.infer<typeof testSkipSchema>;

/**
 * Reads and parses the skip list at the given path. Throws when the file is
 * missing, is not JSON, holds an entry without a test file, a test name or a
 * Linear issue ID, or holds the same test twice.
 */
export function loadTestSkips(path: string): TestSkip[] {
  const parsed = testSkipsSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));

  if (!parsed.success) {
    throw new Error(`${path}: ${z.prettifyError(parsed.error)}`);
  }

  const seen = new Set<string>();

  for (const skip of parsed.data) {
    const key = `${skip.file}\u0000${skip.test}`;

    if (seen.has(key)) {
      throw new Error(`${path}: "${skip.test}" in ${skip.file} is listed twice`);
    }

    seen.add(key);
  }

  return parsed.data;
}
