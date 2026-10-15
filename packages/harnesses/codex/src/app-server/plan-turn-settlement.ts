/**
 * How one ended turn settles the messages it carried: answered with its
 * final reply, or unanswered with the reason the turn gave none.
 */
export type TurnSettlement =
  | {
      readonly kind: 'answered';
      readonly turn: string;
      readonly messages: readonly string[];
      readonly answer: string;
    }
  | {
      readonly kind: 'unanswered';
      readonly turn: string;
      readonly messages: readonly string[];
      readonly reason: string;
    };

/**
 * Plans how an ended turn settles the messages it carried: a completed turn
 * with a final reply answers them with it, and any other end leaves them
 * unanswered, `interrupted` for an interrupted turn and `error` for a
 * failed one or one that gave no reply. A turn still in progress, or one
 * that carried no message, settles nothing.
 */
export function planTurnSettlement(
  turn: string,
  status: string,
  messages: readonly string[],
  reply: string | undefined,
): TurnSettlement | null {
  if (status === 'inProgress' || messages.length === 0) {
    return null;
  }

  if (status === 'completed' && reply !== undefined) {
    return { kind: 'answered', turn, messages, answer: reply };
  }

  return {
    kind: 'unanswered',
    turn,
    messages,
    reason: status === 'interrupted' ? 'interrupted' : 'error',
  };
}
