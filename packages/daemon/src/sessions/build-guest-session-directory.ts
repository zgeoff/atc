export function buildGuestSessionDirectory(guestDirectory: string, sessionID: string): string {
  return `${guestDirectory}/sessions/${sessionID}`;
}
