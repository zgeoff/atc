/**
 * The principal a request acts as: the OAuth client id it goes out as `as`,
 * and the client's name it goes out as `asName` beside it.
 */
export interface Principal {
  readonly id: string;
  readonly name: string;
}
