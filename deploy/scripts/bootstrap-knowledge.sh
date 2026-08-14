#!/bin/sh
set -eu

data_dir=${KNOWLEDGE_DATA_DIR_IN_CONTAINER:-/data}
notes_dir="$data_dir/notes"
state_dir="$data_dir/state"
bootstrap_dir=${KNOWLEDGE_BOOTSTRAP_DIR:-/bootstrap-notes}
runtime_uid=${KNOWLEDGE_UID:-10001}
runtime_gid=${KNOWLEDGE_GID:-10001}

case "$runtime_uid:$runtime_gid" in
  *[!0-9:]*|:*|*:) echo "KNOWLEDGE_UID/GID must be numeric" >&2; exit 64 ;;
esac

mkdir -p "$notes_dir" "$state_dir"

# Seed examples only into an entirely empty note tree. Existing Obsidian vaults
# and user-created notes are never merged over or replaced.
if [ -d "$bootstrap_dir" ] && [ -z "$(find "$notes_dir" -mindepth 1 -print -quit)" ]; then
  cp -R "$bootstrap_dir"/. "$notes_dir"/
fi

chown -R "$runtime_uid:$runtime_gid" "$data_dir"
