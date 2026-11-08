#!/usr/bin/env bash
# Keeps the bot running; restarts on disconnect. Logs to bot-<name>.log too.
cd "$(dirname "$0")"
while true; do
  npx tsx src/index.ts 2>&1 | tee -a "bot-${BOT_NAME:-bot}.log"
  echo "bot exited; restarting in 2s…"
  sleep 2
done
