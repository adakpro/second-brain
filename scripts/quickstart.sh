#!/bin/sh
set -eu

task_env_file=.env
task_generated_password=""
task_tmp_file="${task_env_file}.tmp.$$"
umask 077
trap 'rm -f "$task_tmp_file"' EXIT HUP INT TERM

task_replace_env() {
  task_key=$1
  task_value=$2
  sed "s|^${task_key}=.*|${task_key}=${task_value}|" "$task_env_file" > "$task_tmp_file"
  mv "$task_tmp_file" "$task_env_file"
}

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker with Compose is required." >&2
  exit 69
fi

if [ ! -f "$task_env_file" ]; then
  if ! command -v openssl >/dev/null 2>&1; then
    echo "OpenSSL is required to generate first-boot credentials." >&2
    exit 69
  fi

  cp .env.example "$task_env_file"
  task_generated_password=$(openssl rand -base64 24 | tr -d '\n/+=')
  task_caddy_hash=$(docker run --rm caddy:2.11.4-alpine caddy hash-password --plaintext "$task_generated_password")
  task_hermes_key=$(openssl rand -hex 32)
  task_knowledge_key=$(openssl rand -hex 32)
  task_session_secret=$(openssl rand -hex 32)

  task_replace_env CADDY_BASIC_AUTH_HASH "'$task_caddy_hash'"
  task_replace_env HERMES_API_KEY "$task_hermes_key"
  task_replace_env KNOWLEDGE_API_KEY "$task_knowledge_key"
  task_replace_env HERMES_DASHBOARD_BASIC_AUTH_PASSWORD "$task_generated_password"
  task_replace_env HERMES_DASHBOARD_BASIC_AUTH_SECRET "$task_session_secret"
  chmod 600 "$task_env_file"
fi

docker compose up --build -d

echo "Hermess is starting at http://localhost"
echo "Official Hermes dashboard: http://dashboard.localhost"
if [ -n "$task_generated_password" ]; then
  echo "First-boot username: hermes"
  echo "First-boot password: $task_generated_password"
  echo "Save this password now; only its hash is retained for the outer gateway."
fi
