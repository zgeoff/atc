import type { Tagged } from 'type-fest';

/**
 * An atc-minted message id; keys the messages table and every message
 * request and event.
 */
export type MessageID = Tagged<string, 'MessageID'>;
