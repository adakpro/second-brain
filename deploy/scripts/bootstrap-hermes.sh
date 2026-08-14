#!/bin/sh
set -eu

data_dir=${HERMES_DATA_DIR_IN_CONTAINER:-/opt/data}
template_dir=${HERMES_TEMPLATE_DIR:-/bootstrap}
default_profile=${HERMES_DEFAULT_PROFILE:-codex}
runtime_uid=${HERMES_UID:-10000}
runtime_gid=${HERMES_GID:-10000}
profile_api_key=${API_SERVER_KEY:-}
vault_name=${OBSIDIAN_VAULT_NAME:-HERMESS}

case "$default_profile" in
  *[!a-z0-9_-]*|'')
    echo "Invalid HERMES_DEFAULT_PROFILE: $default_profile" >&2
    exit 64
    ;;
esac
case "$runtime_uid:$runtime_gid" in
  *[!0-9:]*|:*|*:) echo "HERMES_UID/GID must be numeric" >&2; exit 64 ;;
esac
if [ "${#profile_api_key}" -lt 16 ] || printf '%s' "$profile_api_key" | LC_ALL=C grep -q '[[:space:]]'; then
  echo "API_SERVER_KEY must be at least 16 characters with no whitespace" >&2
  exit 64
fi
case "$vault_name" in
  ''|*/*|*\\*) echo "OBSIDIAN_VAULT_NAME must be a non-empty vault label, not a path" >&2; exit 64 ;;
esac
if [ "${#vault_name}" -gt 120 ]; then
  echo "OBSIDIAN_VAULT_NAME must be at most 120 characters" >&2
  exit 64
fi

provision_profile_api_key() {
  env_file=$1
  temporary_file="${env_file}.bootstrap.$$"
  source_file=$env_file
  [ -f "$source_file" ] || source_file=/dev/null
  awk '
    BEGIN { written = 0 }
    /^API_SERVER_KEY=/ {
      if (!written) {
        print "API_SERVER_KEY=" ENVIRON["API_SERVER_KEY"]
        written = 1
      }
      next
    }
    { print }
    END {
      if (!written) print "API_SERVER_KEY=" ENVIRON["API_SERVER_KEY"]
    }
  ' "$source_file" > "$temporary_file"
  mv "$temporary_file" "$env_file"
  chmod 600 "$env_file"
}

default_config="$template_dir/profiles/$default_profile/config.yaml"
if [ ! -f "$default_config" ]; then
  echo "Missing Hermes profile template: $default_config" >&2
  exit 66
fi

umask 077
mkdir -p "$data_dir" "$data_dir/profiles" "$data_dir/skills"

# Hermes state is authoritative after first boot. Never overwrite dashboard or
# CLI edits on a later container restart.
if [ ! -f "$data_dir/config.yaml" ]; then
  # Named profiles must explicitly disable their own port-binding API adapter
  # under multiplex. The root/default copy omits that one marker so the
  # process-level API_SERVER_* environment owns the shared listener while the
  # template's direct-model routes remain intact.
  root_temporary="${data_dir}/config.yaml.bootstrap.$$"
  sed '/^    enabled: false # named-profile listener guard$/d' "$default_config" > "$root_temporary"
  mv "$root_temporary" "$data_dir/config.yaml"
  chmod 640 "$data_dir/config.yaml"
fi

if [ ! -f "$data_dir/SOUL.md" ] && [ -f "$template_dir/SOUL.md" ]; then
  cp "$template_dir/SOUL.md" "$data_dir/SOUL.md"
  chmod 640 "$data_dir/SOUL.md"
fi

for profile_dir in "$template_dir"/profiles/*; do
  [ -d "$profile_dir" ] || continue
  profile_name=${profile_dir##*/}
  case "$profile_name" in
    *[!a-z0-9_-]*|'') continue ;;
  esac

  destination="$data_dir/profiles/$profile_name"
  mkdir -p "$destination"
  if [ ! -f "$destination/config.yaml" ] && [ -f "$profile_dir/config.yaml" ]; then
    cp "$profile_dir/config.yaml" "$destination/config.yaml"
    chmod 640 "$destination/config.yaml"
  fi
  if [ ! -f "$destination/profile.yaml" ] && [ -f "$profile_dir/profile.yaml" ]; then
    cp "$profile_dir/profile.yaml" "$destination/profile.yaml"
    chmod 640 "$destination/profile.yaml"
  fi
  # SOUL.md is Hermes' marker for a real named profile in the container
  # supervisor. A profile-specific identity wins when supplied; all other
  # profiles inherit the shared safe default.
  profile_soul="$profile_dir/SOUL.md"
  [ -f "$profile_soul" ] || profile_soul="$template_dir/SOUL.md"
  if [ ! -f "$destination/SOUL.md" ] && [ -f "$profile_soul" ]; then
    cp "$profile_soul" "$destination/SOUL.md"
    chmod 640 "$destination/SOUL.md"
  fi
  # The shared listener authenticates /p/<profile>/ requests against the
  # selected profile's secret scope. Keep one deployment key in every named
  # profile without exposing it in config.yaml or command arguments.
  provision_profile_api_key "$destination/.env"
done

# Profiles may also have been created through the native dashboard after the
# chart/templates were installed. Bring every persisted profile into the shared
# multiplex auth scope without changing its model/configuration.
for destination in "$data_dir"/profiles/*; do
  [ -d "$destination" ] || continue
  provision_profile_api_key "$destination/.env"
done

# Hermes v2026.8.3's native startup auto-prune does not exclude pinned or
# archived sessions. Disable an inherited true value before the gateway starts;
# verified manual pruning remains available through HERMESS.
disable_unsafe_auto_prune() {
  config_file=$1
  [ -f "$config_file" ] || return 0
  temporary_file="${config_file}.safety.$$"
  sed -E 's/(^|[,{])([[:space:]]*auto_prune:[[:space:]]*)(true|True|TRUE|yes|Yes|YES|on|On|ON|1)/\1\2false/g' "$config_file" > "$temporary_file"
  mv "$temporary_file" "$config_file"
}

disable_unsafe_auto_prune "$data_dir/config.yaml"
for profile_config in "$data_dir"/profiles/*/config.yaml; do
  disable_unsafe_auto_prune "$profile_config"
done

install_managed_skills() {
  target_home=$1
  [ -d "$template_dir/skills" ] || return 0
  mkdir -p "$target_home/skills"
  for skill_dir in "$template_dir"/skills/*; do
    [ -d "$skill_dir" ] || continue
    skill_name=${skill_dir##*/}
    case "$skill_name" in
      *[!a-z0-9_-]*|'') continue ;;
    esac
    destination="$target_home/skills/$skill_name"
    mkdir -p "$destination"
    # These repository-owned safety skills are upgraded on every bootstrap.
    # User-created skills use other names and remain authoritative on the PVC.
    cp -R "$skill_dir"/. "$destination"/
    chmod -R u=rwX,g=rX,o= "$destination"
  done
}

install_managed_skills "$data_dir"
for profile_home in "$data_dir"/profiles/*; do
  [ -d "$profile_home" ] || continue
  install_managed_skills "$profile_home"
done

# Seeded state belongs to Hermes. Group traversal also lets the read-only
# knowledge index inspect skills when it runs with the configured Hermes GID.
chown "$runtime_uid:$runtime_gid" "$data_dir"
chown -R "$runtime_uid:$runtime_gid" "$data_dir/profiles" "$data_dir/skills"
chmod 750 "$data_dir" "$data_dir/profiles" "$data_dir/skills"
find "$data_dir/profiles" "$data_dir/skills" -type d -exec chmod 750 {} +
find "$data_dir/profiles" "$data_dir/skills" -type f ! -name .env -exec chmod 640 {} +
find "$data_dir/profiles" -type f -name .env -exec chmod 600 {} +
for seeded_file in "$data_dir/config.yaml" "$data_dir/SOUL.md"; do
  if [ -f "$seeded_file" ]; then
    chown "$runtime_uid:$runtime_gid" "$seeded_file"
    chmod 640 "$seeded_file"
  fi
done
