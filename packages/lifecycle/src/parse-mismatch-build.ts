interface MismatchBuild {
  readonly build: string;
  readonly protocol: number;
}

/**
 * The daemon's build and protocol version in its `protocol_mismatch`
 * refusal text (`daemon <build> speaks v<N>`), or null when the text does
 * not match that wording.
 */
export function parseMismatchBuild(text: string): MismatchBuild | null {
  const match = /\bdaemon (?<build>\S+) speaks v(?<protocol>\d+)/.exec(text);

  if (match === null) {
    return null;
  }

  return { build: match.groups?.['build'] ?? '', protocol: Number(match.groups?.['protocol']) };
}
