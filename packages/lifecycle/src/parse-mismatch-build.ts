interface MismatchBuild {
  readonly build: string;
  readonly protocol: number;
}

export function parseMismatchBuild(text: string): MismatchBuild | null {
  const match = /\bdaemon (?<build>\S+) speaks v(?<protocol>\d+)/u.exec(text);

  if (match === null) {
    return null;
  }

  return { build: match.groups?.['build'] ?? '', protocol: Number(match.groups?.['protocol']) };
}
