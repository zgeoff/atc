# Readies the guest folder and exits 0 only when bin/atc is an executable
# it can run.
# $1: the guest folder.
mkdir -p "$1/run" && [ -x "$1/bin/atc" ]
