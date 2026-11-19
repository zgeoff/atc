export interface HandshakeRefusal {
  readonly peer: string;
  readonly reason: string;
}

const refusalPattern = /^atc tcp event=handshake_refused peer=(?<peer>\S+) reason=(?<reason>\S+)/u;

export function collectHandshakeRefusals(lines: readonly string[]): HandshakeRefusal[] {
  return lines.flatMap((line) => {
    const groups = refusalPattern.exec(line)?.groups;
    const peer = groups?.['peer'];
    const reason = groups?.['reason'];

    return peer === undefined || reason === undefined ? [] : [{ peer, reason }];
  });
}
