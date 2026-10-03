/**
 * Which agent a session runs under: the key the adapter registry is looked
 * up by. Every agent CLI supplies one, and so does every configured backend
 * that drives a CLI it does not own, so two ids can share one kind.
 */
export type AgentID = string;
