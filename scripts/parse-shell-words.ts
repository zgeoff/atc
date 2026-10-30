import type { ShellEscapeParser } from './shell-escape-parsers.ts';
import { shellEscapeParsers } from './shell-escape-parsers.ts';

export interface ShellWord {
  readonly text: string;
  readonly isQuoted: boolean;
  readonly isOperator: boolean;

  // An unquoted NAME= prefix makes the word a variable assignment, whatever quotes its value holds.
  readonly isAssignment: boolean;
}

type ShellContext =
  | 'plain'
  | 'substitution'
  | 'group'
  | 'backtick'
  | 'quoted-backtick'
  | 'single-quote'
  | 'ansi-c-quote'
  | 'double-quote'
  | 'parameter'
  | 'quoted-parameter'
  | 'arithmetic'
  | 'arithmetic-group';

interface ParserState {
  readonly command: string;
  readonly words: ShellWord[];
  readonly contexts: ShellContext[];
  index: number;
  text: string;
  isQuoted: boolean;
  redirect: string;

  // The word's text before its first quote, escape or expansion.
  plainText: string;
  isPlain: boolean;
}

interface ShellCursor {
  readonly character: string;
  readonly ahead: string;
  readonly isWordStart: boolean;

  // The unescaped `>` or `<` just before the character, or empty.
  readonly redirect: string;
}

interface ShellActionFields {
  readonly text: { readonly text: string };
  readonly redirect: { readonly text: string };
  readonly escape: object;
  readonly open: { readonly context: ShellContext; readonly text: string; readonly length: number };
  readonly close: { readonly text: string };
  readonly break: object;
  readonly operator: { readonly text: string };
  readonly comment: object;
}

type ShellActionOf<Kind extends keyof ShellActionFields> = {
  readonly kind: Kind;
} & ShellActionFields[Kind];

type ShellAction = {
  [Kind in keyof ShellActionFields]: ShellActionOf<Kind>;
}[keyof ShellActionFields];

interface ShellContextRules {
  readonly pickAction: (cursor: ShellCursor) => ShellAction;
  readonly parseEscape: ShellEscapeParser;

  // A quote or an escape here marks the word quoted, since the shell strips it from the command's
  // own words.
  readonly isTopLevel: boolean;
  readonly isQuote: boolean;
}

// Every decision that depends on the context lives in this table, which is typed over every
// context, so a context without its rules fails the type check.
type ShellContextTable = Readonly<Record<ShellContext, ShellContextRules>>;

const contextTable: ShellContextTable = {
  plain: {
    pickAction: makeCodeReader({ closer: '', isGrouping: false, isCommenting: true }),
    parseEscape: shellEscapeParsers.code,
    isTopLevel: true,
    isQuote: false,
  },
  substitution: {
    pickAction: makeCodeReader({ closer: ')', isGrouping: true, isCommenting: false }),
    parseEscape: shellEscapeParsers.code,
    isTopLevel: false,
    isQuote: false,
  },
  group: {
    pickAction: makeCodeReader({ closer: ')', isGrouping: true, isCommenting: false }),
    parseEscape: shellEscapeParsers.code,
    isTopLevel: false,
    isQuote: false,
  },
  backtick: {
    pickAction: makeCodeReader({ closer: '`', isGrouping: false, isCommenting: false }),
    parseEscape: shellEscapeParsers.backtick,
    isTopLevel: false,
    isQuote: false,
  },
  'quoted-backtick': {
    pickAction: makeCodeReader({ closer: '`', isGrouping: false, isCommenting: false }),
    parseEscape: shellEscapeParsers['quoted-backtick'],
    isTopLevel: false,
    isQuote: false,
  },
  'single-quote': {
    pickAction: pickSingleQuotedAction,
    parseEscape: shellEscapeParsers.literal,
    isTopLevel: false,
    isQuote: true,
  },
  'ansi-c-quote': {
    pickAction: pickANSICQuotedAction,
    parseEscape: shellEscapeParsers['ansi-c'],
    isTopLevel: false,
    isQuote: true,
  },
  'double-quote': {
    pickAction: pickDoubleQuotedAction,
    parseEscape: shellEscapeParsers['double-quote'],
    isTopLevel: false,
    isQuote: true,
  },
  parameter: {
    pickAction: pickParameterAction,
    parseEscape: shellEscapeParsers.code,
    isTopLevel: false,
    isQuote: false,
  },
  'quoted-parameter': {
    pickAction: pickQuotedParameterAction,
    parseEscape: shellEscapeParsers['double-quote'],
    isTopLevel: false,
    isQuote: false,
  },
  arithmetic: {
    pickAction: makeArithmeticReader('))'),
    parseEscape: shellEscapeParsers['double-quote'],
    isTopLevel: false,
    isQuote: false,
  },
  'arithmetic-group': {
    pickAction: makeArithmeticReader(')'),
    parseEscape: shellEscapeParsers['double-quote'],
    isTopLevel: false,
    isQuote: false,
  },
};

// The parser keeps a stack of the quotes, substitutions and expansions it is inside, and each
// context reads the next character by the shell's rules for that context.
export function parseShellWords(command: string): ShellWord[] {
  const state: ParserState = {
    command,
    words: [],
    contexts: ['plain'],
    index: 0,
    text: '',
    isQuoted: false,
    redirect: '',
    plainText: '',
    isPlain: true,
  };

  while (state.index < command.length) {
    const rules = contextTable[getContext(state)];

    const action = rules.pickAction({
      character: command.charAt(state.index),
      ahead: command.slice(state.index + 1, state.index + 3),
      isWordStart: state.text === '' && !state.isQuoted,
      redirect: state.redirect,
    });

    advanceParser(state, action, rules.isTopLevel);
  }

  endWord(state);

  return state.words;
}

interface ShellCodeRules {
  // The text that closes the context, or empty when nothing closes it.
  readonly closer: string;
  readonly isGrouping: boolean;
  readonly isCommenting: boolean;
}

function makeCodeReader(rules: ShellCodeRules): (cursor: ShellCursor) => ShellAction {
  return (cursor) => {
    const character = cursor.character;

    // A closing backtick would read as an opening one, so the closer comes first.
    if (character === rules.closer) {
      return { kind: 'close', text: character };
    }

    const opening = pickOpening(cursor, false);

    if (opening !== undefined) {
      return opening;
    }

    if (character === "'") {
      return { kind: 'open', context: 'single-quote', text: '', length: 1 };
    }

    if (character === '"') {
      return { kind: 'open', context: 'double-quote', text: '', length: 1 };
    }

    if (character === '(' && rules.isGrouping) {
      return { kind: 'open', context: 'group', text: '(', length: 1 };
    }

    if (character === '#' && cursor.isWordStart && rules.isCommenting) {
      return { kind: 'comment' };
    }

    if (character === '\n') {
      return { kind: 'operator', text: '\n' };
    }

    if (/\s/u.test(character)) {
      return { kind: 'break' };
    }

    return pickOperator(cursor) ?? pickPlainAction(character);
  };
}

// `${` opens a parameter expansion, `$((` an arithmetic expansion, and `$(` or a backtick a
// command substitution, in every context but a single quote. Outside double quotes, `$'` opens an
// ANSI-C quote, and `$"` opens a locale quote, which reads as a double quote.
function pickOpening(cursor: ShellCursor, isInsideQuotes: boolean): ShellAction | undefined {
  const character = cursor.character;

  if (character === '\\') {
    return { kind: 'escape' };
  }

  if (character === '`') {
    return isInsideQuotes
      ? { kind: 'open', context: 'quoted-backtick', text: '`', length: 1 }
      : { kind: 'open', context: 'backtick', text: '`', length: 1 };
  }

  if (character !== '$') {
    return undefined;
  }

  if (cursor.ahead.startsWith("'") && !isInsideQuotes) {
    return { kind: 'open', context: 'ansi-c-quote', text: '', length: 2 };
  }

  if (cursor.ahead.startsWith('"') && !isInsideQuotes) {
    return { kind: 'open', context: 'double-quote', text: '', length: 2 };
  }

  if (cursor.ahead.startsWith('{')) {
    return isInsideQuotes
      ? { kind: 'open', context: 'quoted-parameter', text: '${', length: 2 }
      : { kind: 'open', context: 'parameter', text: '${', length: 2 };
  }

  if (cursor.ahead === '((') {
    return { kind: 'open', context: 'arithmetic', text: '$((', length: 3 };
  }

  if (cursor.ahead.startsWith('(')) {
    return { kind: 'open', context: 'substitution', text: '$(', length: 2 };
  }

  return undefined;
}

// A redirection keeps its `|` and `&` in the word: `>|`, `>&`, `<&`, `&>` and `&>>`. `>>` and `<>`
// hold no operator character.
function pickOperator(cursor: ShellCursor): ShellAction | undefined {
  const character = cursor.character;
  const ahead = cursor.ahead;

  if (character === ';') {
    return { kind: 'operator', text: ';' };
  }

  if (character === '|' && cursor.redirect !== '>') {
    return { kind: 'operator', text: ahead.startsWith('|') ? '||' : '|' };
  }

  if (character === '&' && ahead.startsWith('&')) {
    return { kind: 'operator', text: '&&' };
  }

  if (character === '&' && cursor.redirect === '' && !ahead.startsWith('>')) {
    return { kind: 'operator', text: '&' };
  }

  return undefined;
}

function pickPlainAction(character: string): ShellAction {
  return character === '>' || character === '<'
    ? { kind: 'redirect', text: character }
    : { kind: 'text', text: character };
}

function pickSingleQuotedAction(cursor: ShellCursor): ShellAction {
  if (cursor.character === '\\') {
    return { kind: 'escape' };
  }

  return cursor.character === "'"
    ? { kind: 'close', text: '' }
    : { kind: 'text', text: cursor.character };
}

function pickANSICQuotedAction(cursor: ShellCursor): ShellAction {
  if (cursor.character === '\\') {
    return { kind: 'escape' };
  }

  return cursor.character === "'"
    ? { kind: 'close', text: '' }
    : { kind: 'text', text: cursor.character };
}

function pickDoubleQuotedAction(cursor: ShellCursor): ShellAction {
  const opening = pickOpening(cursor, true);

  if (opening !== undefined) {
    return opening;
  }

  return cursor.character === '"'
    ? { kind: 'close', text: '' }
    : { kind: 'text', text: cursor.character };
}

// A parameter expansion reads its default or pattern as text, so `${VALUE:-a;b}` holds no operator,
// while quotes and expansions inside it keep their meaning.
function pickParameterAction(cursor: ShellCursor): ShellAction {
  const opening = pickOpening(cursor, false);

  if (opening !== undefined) {
    return opening;
  }

  if (cursor.character === "'") {
    return { kind: 'open', context: 'single-quote', text: '', length: 1 };
  }

  if (cursor.character === '"') {
    return { kind: 'open', context: 'double-quote', text: '', length: 1 };
  }

  return cursor.character === '}'
    ? { kind: 'close', text: '}' }
    : { kind: 'text', text: cursor.character };
}

// Inside double quotes, a single quote in a parameter expansion is literal text.
function pickQuotedParameterAction(cursor: ShellCursor): ShellAction {
  const opening = pickOpening(cursor, true);

  if (opening !== undefined) {
    return opening;
  }

  if (cursor.character === '"') {
    return { kind: 'open', context: 'double-quote', text: '', length: 1 };
  }

  return cursor.character === '}'
    ? { kind: 'close', text: '}' }
    : { kind: 'text', text: cursor.character };
}

function makeArithmeticReader(closer: ')' | '))'): (cursor: ShellCursor) => ShellAction {
  return (cursor) => {
    const character = cursor.character;
    const opening = pickOpening(cursor, true);

    if (opening !== undefined) {
      return opening;
    }

    if (character === '(') {
      return { kind: 'open', context: 'arithmetic-group', text: '(', length: 1 };
    }

    if (`${character}${cursor.ahead}`.startsWith(closer)) {
      return { kind: 'close', text: closer };
    }

    return { kind: 'text', text: character };
  };
}

function getContext(state: ParserState): ShellContext {
  const context = state.contexts.at(-1);

  // Only a reader inside a nested context closes it, so the plain context never leaves the stack.
  if (context === undefined) {
    throw new Error('the shell parser closed its plain context');
  }

  return context;
}

// Each handler returns how many characters its action consumed. The table is typed over every
// action kind, so an action without a handler fails the type check.
type ShellActionHandlers = {
  readonly [Kind in keyof ShellActionFields]: (
    state: ParserState,
    action: ShellActionOf<Kind>,
    isTopLevel: boolean,
  ) => number;
};

const actionHandlers: ShellActionHandlers = {
  text: appendText,
  redirect: (state, action) => {
    state.redirect = action.text;

    return appendText(state, action);
  },
  escape: (state, _action, isTopLevel) => {
    const escape = contextTable[getContext(state)].parseEscape(state.command, state.index);

    state.text += escape.text;

    if (escape.isQuoting) {
      state.isPlain = false;
      state.isQuoted ||= isTopLevel;
    }

    return escape.length;
  },
  open: (state, action, isTopLevel) => {
    state.isPlain = false;

    state.contexts.push(action.context);

    state.text += action.text;
    state.isQuoted ||= isTopLevel && contextTable[action.context].isQuote;

    return action.length;
  },
  close: (state, action) => {
    state.contexts.pop();

    state.text += action.text;

    return Math.max(action.text.length, 1);
  },
  break: (state) => {
    endWord(state);

    return 1;
  },
  operator: (state, action) => {
    endWord(state);

    state.words.push({ text: action.text, isQuoted: false, isOperator: true, isAssignment: false });

    return action.text.length;
  },
  comment: (state) => {
    const end = state.command.indexOf('\n', state.index);

    return (end === -1 ? state.command.length : end) - state.index;
  },
};

// The handler table is generic over the action kind, so a call with the whole union still checks.
function advanceParser<Kind extends keyof ShellActionFields>(
  state: ParserState,
  action: ShellActionOf<Kind>,
  isTopLevel: boolean,
): void {
  const handler: ShellActionHandlers[Kind] = actionHandlers[action.kind];

  state.redirect = '';
  state.index += handler(state, action, isTopLevel);
}

function appendText(state: ParserState, action: ShellActionFields['text']): number {
  state.text += action.text;
  state.plainText += state.isPlain ? action.text : '';

  return 1;
}

const assignmentPattern = /^[A-Za-z_]\w*=/u;

function endWord(state: ParserState): void {
  if (state.text !== '' || state.isQuoted) {
    state.words.push({
      text: state.text,
      isQuoted: state.isQuoted,
      isOperator: false,
      isAssignment: assignmentPattern.test(state.plainText),
    });
  }

  state.text = '';
  state.isQuoted = false;
  state.plainText = '';
  state.isPlain = true;
}
