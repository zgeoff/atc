// $1: the absolute path, $2: the mode in octal. Writes stdin beside the path, then moves it into
// place in one step.
export const WRITE_FILE_SCRIPT =
  'mkdir -p "$(dirname -- "$1")" && cat > "$1.part" && chmod "$2" "$1.part" && mv -f "$1.part" "$1"';
