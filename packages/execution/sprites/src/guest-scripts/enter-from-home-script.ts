// `./` stops a directory named `-` from meaning the previous one
// and stops CDPATH entries from standing in for it.
export const ENTER_FROM_HOME_SCRIPT = 'cd && cd -P -- "./$0" && exec "$@"';
