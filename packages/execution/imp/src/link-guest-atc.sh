# shellcheck shell=sh
# Readies the guest folder and links bin/atc to the image's atc again, as a
# cold boot of an imp leaves it without the link.
# $1: the guest folder.
# $2: the image's atc.
mkdir -p "$1/run" "$1/bin" && { [ "$2" = "$1/bin/atc" ] || ln -sfn "$2" "$1/bin/atc"; }
