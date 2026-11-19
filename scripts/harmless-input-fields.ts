// An input field that a release added inside a major version and that changes no behaviour, so a
// daemon that lacks it behaves the same: its method, its dotted path, and why it is harmless. A
// field that does change behaviour goes in FEATURE_INPUT_FIELDS in @atcx/contract instead.
export const HARMLESS_INPUT_FIELDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {};
