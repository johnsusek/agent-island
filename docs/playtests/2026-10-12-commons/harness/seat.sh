#!/bin/bash
# Supervise one seat: relaunch claude -p until the world ends; stop on a restart storm.
P="$(cd "$(dirname "$0")" && pwd)"; NAME="$1"; MODEL="$2"; EFFORT="$3"; SERVER="$4"
mkdir -p "$P/seats/$NAME.work"; cd "$P/seats/$NAME.work"
CFG="{\"mcpServers\":{\"commons\":{\"type\":\"http\",\"url\":\"http://127.0.0.1:3920/$SERVER\"}}}"
DIS="Agent,Task,TaskCreate,Workflow,ScheduleWakeup,CronCreate,CronDelete,CronList,DesignSync,EnterWorktree,ExitWorktree,Monitor,NotebookEdit,PushNotification,RemoteTrigger,ReportFindings,SendMessage,Skill,TaskGet,TaskList,TaskOutput,TaskStop,TaskUpdate,WebFetch,WebSearch,Bash"
fast=0; pass=0
while true; do
  ended=$(curl -s localhost:3920/api/state | python3 -c "import sys,json;print(json.load(sys.stdin)['liveness']['ended'])" 2>/dev/null)
  [ "$ended" = "True" ] && { echo "$(date +%T) world ended; $NAME stops" >> "$P/logs/supervisor.log"; break; }
  [ -z "$ended" ] && { echo "$(date +%T) server gone; $NAME stops" >> "$P/logs/supervisor.log"; break; }
  pass=$((pass+1)); start=$(date +%s)
  echo "$(date +%T) $NAME pass $pass" >> "$P/logs/supervisor.log"
  claude -p "$(cat "$P/seats/$NAME.prompt.txt")" --model "$MODEL" --effort "$EFFORT" \
    --output-format stream-json --verbose --no-session-persistence --setting-sources "" \
    --permission-mode acceptEdits --allowedTools "mcp__commons" --disallowedTools "$DIS" \
    --mcp-config "$CFG" --strict-mcp-config >> "$P/logs/$NAME.jsonl" 2>> "$P/logs/$NAME.err"
  if [ $(( $(date +%s) - start )) -lt 15 ]; then fast=$((fast+1)); else fast=0; fi
  [ $fast -ge 4 ] && { echo "$(date +%T) $NAME restart storm; stopping" >> "$P/logs/supervisor.log"; break; }
  sleep 2
done
