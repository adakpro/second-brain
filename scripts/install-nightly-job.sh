#!/bin/sh
set -eu

task_schedule=${1:-"0 2 * * *"}

docker compose exec --user hermes hermes hermes cron create \
  "$task_schedule" \
  "Run the daily-synthesis skill. Incubate the local knowledge vault, publish the dated synthesis note, and return a concise run summary." \
  --name "nightly-incubation" \
  --skill daily-synthesis \
  --provider openai-codex \
  --model gpt-5.6-sol \
  --deliver local

echo "Installed nightly-incubation on schedule: $task_schedule"
echo "Trigger it now with: docker compose exec --user hermes hermes hermes cron run nightly-incubation"
