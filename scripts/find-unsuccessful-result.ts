// GitHub joins the result of each job a gate needs into one line, one word per job, such as
// `success skipped`; a gate passes only when every one of them is `success`.
export function findUnsuccessfulResult(results: string): string | null {
  return results.split(/\s+/u).find((result) => result !== '' && result !== 'success') ?? null;
}

if (import.meta.main) {
  const unsuccessful = findUnsuccessfulResult(process.env['RESULTS'] ?? '');

  if (unsuccessful !== null) {
    process.stderr.write(`a required job ended as ${unsuccessful}\n`);
    process.exit(1);
  }
}
