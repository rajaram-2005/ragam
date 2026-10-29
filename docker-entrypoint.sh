#!/bin/sh
set -eu

DISK_MOUNT=/var/data

# Fail closed if the Render volume is missing. Otherwise the service could appear
# healthy while writing SQLite state to the disposable container filesystem.
if ! awk -v mount="$DISK_MOUNT" '$2 == mount { found = 1 } END { exit !found }' /proc/mounts; then
  echo "Render persistent disk is not mounted at $DISK_MOUNT; refusing to start." >&2
  exit 1
fi

# Render mounts the disk root as root-owned. Give the app user ownership once;
# this is recursive only while the mount root is not already owned by node.
NODE_UID="$(id -u node)"
DISK_UID="$(stat -c '%u' "$DISK_MOUNT")"
if [ "$DISK_UID" != "$NODE_UID" ]; then
  echo "Assigning $DISK_MOUNT to the unprivileged node user."
  chown -R node:node "$DISK_MOUNT"
fi

# The application process never runs as root.
exec gosu node:node "$@"
