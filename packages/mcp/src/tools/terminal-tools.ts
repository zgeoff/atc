import { SESSION_INPUT } from './session-input';
import { TOOL_ANNOTATIONS } from './tool-annotations';
import type { MCPToolDefinition } from './types';

const TERMINAL_TYPE_OUTPUT: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    written: {
      type: 'boolean',
      description:
        'true once the line reached the terminal, or started a headless turn; it does not show the agent took it',
    },
  },
  required: ['written'],
};

// A menu as atc_terminal_choose returns it, and the result of a read or a
// choice on one.
const MENU_OUTPUT: Readonly<Record<string, unknown>> = {
  type: ['object', 'null'],
  description:
    'The menu the screen shows, or null when it shows none: after a choice, the menu once the screen settles',
  properties: {
    text: { type: 'string', description: "The menu's lines above its options" },
    options: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          option: { type: 'number', description: 'The number a choice gives, counted from 1' },
          label: { type: 'string', description: 'The text a choice gives as label' },
          checked: {
            type: ['boolean', 'null'],
            description: "Whether the option's box is ticked; null for an option with no box",
          },
          highlighted: { type: 'boolean', description: 'Whether the cursor is on the option' },
        },
        required: ['option', 'label', 'checked', 'highlighted'],
      },
    },
    menuToken: {
      type: 'string',
      description:
        'The token a choice on this menu gives; it changes with the text, a label or a box, and not with the cursor',
    },
  },
  required: ['text', 'options', 'menuToken'],
};

const TERMINAL_CHOOSE_OUTPUT: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    pressed: {
      type: 'string',
      description:
        'After a choice, the key atc pressed last: enter or escape. Absent when the call only read the menu',
    },
    menu: MENU_OUTPUT,
    partial: {
      type: 'boolean',
      description:
        'true when atc could not read the whole of a long list after the key: menu holds only the options the screen shows, numbered from the top of the screen, so read the menu again before a choice on it. Absent otherwise',
    },
  },
  required: ['menu'],
};

export const TERMINAL_TOOLS: readonly MCPToolDefinition[] = [
  {
    name: 'atc_terminal_type',
    annotations: TOOL_ANNOTATIONS.agentFacingDestructive,
    scope: 'spawn',
    description:
      "Type a line into a session's terminal and press Enter, as a person at the keyboard would. This tool cannot answer a menu: on a permission prompt, the folder-trust dialog or any other choice list, the text is dropped and Enter picks the highlighted option. atc_terminal_choose answers a Claude Code menu, and a person answers any other in the TUI. Only a Claude or Claude-compatible session refuses the line with permission_pending while a permission prompt is open; atc sees no permission prompt of any other agent, and never sees the folder-trust dialog. Use it for a plain-text prompt, or for an agent that takes no messages. When the agent takes messages (capabilities.message true in atc_spawn_options_get), use atc_message_send instead: atc tracks the message, stores the answer, and puts the outcome into a sending session's conversation as an <atc-answer> notice. Returns { written: true } once the line reaches the terminal; that does not show the agent took it, so check with atc_terminal_read or atc_events_read. On a headless session the line starts a headless turn as its prompt and returns the same result; a headless session whose turn still runs refuses it with too_slow. A session with no terminal refuses it with session_dead. The text goes in as one paste, newlines included, whenever the agent's terminal takes pastes, so the agent's input box and atc_terminal_read can show a placeholder such as [Pasted text #1] instead of the text. Empty text presses Enter alone, which submits what the input box already holds. A retry types the line again.",
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'The atc session id, from atc_sessions_list' },
        text: {
          type: 'string',
          description:
            'The line to type; atc presses Enter after it. Empty text presses Enter alone',
        },
      },
      required: ['session', 'text'],
      additionalProperties: false,
    },
    outputSchema: TERMINAL_TYPE_OUTPUT,
  },
  {
    name: 'atc_terminal_choose',
    annotations: TOOL_ANNOTATIONS.agentFacingDestructive,
    scope: 'spawn',
    description:
      "Read or answer the menu a session's agent waits on in its terminal, such as a permission prompt, the folder-trust dialog or the new MCP servers list. For a plain-text prompt, use atc_terminal_type. Called with session alone, it returns { menu }: the menu's text, its options with their numbers, labels, ticked boxes and cursor, and menuToken; menu is null when the screen shows no menu. A list longer than the screen, such as a long new MCP servers list, reads whole: atc waits until the agent has printed nothing, moves the cursor through the list with arrow keys, puts it back on the option it was on, and numbers every option by its place in the whole list, so a choice can pick an option the screen does not show. A menu that fits on the screen, or a list atc has read whole before, takes no key, except a list that fills Claude Code's list window with the cursor on its last row, where the screen cannot show whether more options follow; a read never presses Enter or Escape. To pick an option, call again with its option number, its label as read, and menuToken: atc checks all three against the screen before it presses a key, waits until the agent has printed nothing for 4 seconds, or 10 seconds at most, since Claude Code refuses Enter on a menu that has just opened and then moves its cursor back, moves the cursor one arrow key at a time, and presses Enter only once the cursor is on that option. Enter on an option with a box ticks or clears that box and keeps the menu open; pick the menu's own item, such as Enable selected, to confirm it. key escape with menuToken presses Escape on that menu instead: it dismisses the menu, rejects every server on the new MCP servers list, and exits the agent on the folder-trust dialog. A choice returns { pressed, menu }: the key atc pressed last and the menu the screen shows once it settles, or null. A choice whose menu atc could not read whole afterwards says so with partial true, as the output schema describes. The same menu with the cursor on the option means the agent ignored the key, or opened a new menu that reads the same; check atc_events_read before you call again with its menuToken. A refusal presses nothing that picks an option, though menu_changed and menu_busy can come after arrow keys moved the cursor: menu_changed when the screen shows another menu or none, menu_label_mismatch when the menu has no such option or its label differs, and menu_busy when the cursor did not reach the option. A read of a long list can be refused with menu_changed or menu_busy the same way, after arrow keys moved its cursor, and with menu_busy on a terminal too short to show two rows of the list. After any refusal, read the menu again for its state and menuToken. session_dead refuses a session with no screen. menuToken matches any menu with the same text, labels and boxes, so a retry after a choice that went through answers the next menu when it reads the same. It reads only Claude Code's menus, and refuses other agents with unsupported. In a menu without numbers, an option whose label wraps onto a second line reads as two options.",
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'The atc session id, from atc_sessions_list' },
        menuToken: {
          type: 'string',
          description:
            'The menuToken of the menu this call answers, from a call with session alone; omit to only read the menu',
        },
        option: {
          type: 'number',
          description:
            'The number of the option to pick, a whole number counted from 1; give label with it',
        },
        label: {
          type: 'string',
          description: 'The label of that option as the menu showed it',
        },
        key: {
          type: 'string',
          enum: ['escape'],
          description: 'escape presses Escape on the menu instead of picking an option',
        },
      },
      required: ['session'],
      additionalProperties: false,
    },
    outputSchema: TERMINAL_CHOOSE_OUTPUT,
  },
  {
    name: 'atc_terminal_read',
    annotations: TOOL_ANNOTATIONS.readOnly,
    scope: 'read',
    description:
      "Read a session's terminal screen as plain text, as it is now. Use it to see a prompt, a menu or an error the agent printed; atc_terminal_choose reads a Claude Code menu as numbered options and answers it. atc holds screens in memory only: a stopped session keeps its last screen until it is forgotten or the daemon restarts, and a session restored after a restart starts from an empty screen. A session with no screen, such as one spawned headless or one still exited after a restart, refuses the read with session_dead. A session moved from its terminal to a headless run returns its last terminal screen, which no longer changes.",
    inputSchema: SESSION_INPUT,
  },
];
