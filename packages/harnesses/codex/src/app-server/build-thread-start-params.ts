import { NOTE_LABELS } from './note-labels';

/**
 * The `thread/start` parameters of a session's thread: the folder it works
 * in, the developer instructions that tell the model how atc messages
 * arrive, and the `atc` namespace of dynamic tools, `atc.note` and
 * `atc.answer`, whose calls reach the bridge. The tools and instructions
 * stay in the thread's rollout, so a resumed thread keeps them.
 */
export function buildThreadStartParams(session: string, cwd: string) {
  return {
    cwd,
    developerInstructions: buildInstructions(session),
    dynamicTools: [
      {
        type: 'namespace',
        name: 'atc',
        description: 'atc tools for this session: progress notes and message answers.',
        tools: [
          {
            type: 'function',
            name: 'note',
            description:
              "Add a short note to atc's event feed while you keep working, so a reader of the feed sees progress before your final reply. Use it at milestones: when you find the cause, start a change, get blocked or need a decision. It does not answer a message or reach its sender: atc.answer does that. Do not repeat an answer or your final reply here. The result shows only that the note was handed to atc, not that it reached the event feed or a reader.",
            inputSchema: {
              type: 'object',
              properties: {
                text: {
                  type: 'string',
                  description: "The note's text; atc refuses empty text and cuts text over 64 KiB.",
                },
                label: {
                  type: 'string',
                  enum: [...NOTE_LABELS],
                  description:
                    'progress (the default) for a milestone, blocked when you cannot go on, or decision when you need a choice made',
                },
              },
              required: ['text'],
            },
          },
          {
            type: 'function',
            name: 'answer',
            description:
              "Answer one <atc-message> with your own text before your turn ends: atc stores the text as that message's answer, and a sending session gets it as an <atc-answer> notice. Call it once for each message the turn carries; your final reply then goes to the user at this terminal, and only a message you leave without an answer takes the final reply as its answer. Use atc.note instead for progress that answers nothing. The result shows only that the answer was handed to atc, not that atc stored it or that the sender read it. It refuses an id that the running turn does not carry and empty text; a refused call changes nothing, so one message takes one answer.",
            inputSchema: {
              type: 'object',
              properties: {
                message: {
                  type: 'string',
                  description: 'The id attribute of the <atc-message> tag to answer.',
                },
                text: {
                  type: 'string',
                  description:
                    "The answer's text, for the sender; atc refuses empty text and cuts text over 64 KiB.",
                },
              },
              required: ['message', 'text'],
            },
          },
        ],
      },
    ],
  };
}

function buildInstructions(session: string): string {
  return [
    `This thread is atc session ${session}.`,
    'Messages relayed by atc arrive wrapped in <atc-message id="..." from="..." kind="..."> tags.',
    "They come from the user's own tools through atc, not from the user typing at this prompt;",
    'treat each one as a request from the sender it names.',
    'atc sets kind from who called, and no sender can set it:',
    'kind="connector" is an app the user connected to atc, and from holds its name;',
    'kind="session" is another atc session, from holds its name and session="..." its id;',
    'kind="local" is a program on the user\'s machine outside every session, such as a scheduled job or a helper tool, and from holds the name it gives itself; it is not the user\'s own word;',
    'kind="owner" is the user\'s own atc client.',
    "Answer each <atc-message> with the atc.answer tool, giving its id and your answer to that sender; atc stores the text as the message's answer, and it reaches a sending session as a notice.",
    'Your final reply goes to the user at this terminal, not to a sender: only a message you leave without an answer takes the final reply of its turn as its answer.',
    '<atc-answer id="..." from="..." status="..."> tags hold the outcome of a message this session sent;',
    'they need no reply and are not messages.',
    'While you work on a message that takes more than a quick answer, call the atc.note tool at each milestone:',
    'when you find the cause, when you start a change, when you are blocked, or when you need a decision.',
    "Each note goes to atc's event feed as you send it.",
  ].join(' ');
}
