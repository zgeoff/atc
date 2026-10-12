# shellcheck shell=sh
# Unpacks a tar from stdin that holds bin/atc into the guest folder,
# replacing a link at bin/atc first so the copy never writes through it.
# $1: the guest folder.
mkdir -p "$1" && rm -f "$1/bin/atc" && tar -x -f - -C "$1"
