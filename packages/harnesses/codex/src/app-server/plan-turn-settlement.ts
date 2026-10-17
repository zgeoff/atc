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
