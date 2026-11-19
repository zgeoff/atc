// Enters the directory given first from the home, then runs the rest in its place. `./` keeps a
// directory named `-` from meaning the previous one, and keeps any CDPATH entry from standing in
// for it.
export const ENTER_FROM_HOME_SCRIPT = 'cd && cd -P -- "./$0" && exec "$@"';
