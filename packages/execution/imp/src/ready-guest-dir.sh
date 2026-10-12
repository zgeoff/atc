# Readies the guest folder and exits 0 only when the configured guest atc
# is an executable, or when no guest atc is configured.
# $1: the guest folder.
# $2: the configured guest atc, or empty for none.
mkdir -p "$1/run" && { [ -z "$2" ] || [ -x "$2" ]; }
