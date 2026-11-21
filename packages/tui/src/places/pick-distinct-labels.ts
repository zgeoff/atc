export interface LabelCandidate {
  readonly label: string;

  // what tells two candidates with one label apart, in the order the label takes them
  readonly qualifiers: readonly string[];
}

// One label for each candidate, in order. While two labels match, each adds its next qualifier, as
// `<label> · <qualifier> · …`, until they differ or run out. A qualified label can match another
// candidate's own label, so the check runs again on the labels it made.
export function pickDistinctLabels(candidates: readonly LabelCandidate[]): string[] {
  const depths = candidates.map(() => 0);
  let isRaised = true;

  while (isRaised) {
    isRaised = false;

    const labels = candidates.map((candidate, index) => formatLabel(candidate, depths[index] ?? 0));

    const counts = new Map<string, number>();

    for (const label of labels) {
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }

    for (const [index, candidate] of candidates.entries()) {
      const depth = depths[index] ?? 0;
      const isClash = (counts.get(labels[index] ?? '') ?? 0) > 1;

      if (isClash && depth < candidate.qualifiers.length) {
        depths[index] = depth + 1;
        isRaised = true;
      }
    }
  }

  return candidates.map((candidate, index) => formatLabel(candidate, depths[index] ?? 0));
}

function formatLabel(candidate: LabelCandidate, depth: number): string {
  return [candidate.label, ...candidate.qualifiers.slice(0, depth)].join(' · ');
}
