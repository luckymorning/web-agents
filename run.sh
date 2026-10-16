#!/usr/bin/env bash
# 远程控制网关启动入口。
#
#   ./run.sh            启动图形控制台（推荐）—— 有桌面环境时用这个
#   ./run.sh start      后台启动服务（无界面，适用于服务器/SSH）
#   ./run.sh stop       停止后台服务
#   ./run.sh status     查看状态
#   ./run.sh --server   前台运行服务（调试用，Ctrl-C 结束）
#
# 依赖说明
#   源码运行需要：Node.js >= 20（服务端）
#                 Electron（GUI 控制台，通过 npm install 安装）
#   安装包运行不需要任何额外依赖：deb / exe 已内置 Node 运行时。
#
# 默认监听 0.0.0.0（允许局域网访问）。此服务等同于本机 shell 权限，
# 因此非回环监听时强制要求访问令牌（缺失会自动生成并写入 console-config.json）。
# 只想本机访问时用：./run.sh start --host 127.0.0.1
set -euo pipefail
cd "$(dirname "$0")"

LOG="${REMOTE_HUB_LOG:-${TMPDIR:-/tmp}/remote-hub.log}"
PIDFILE="${REMOTE_HUB_PID:-${TMPDIR:-/tmp}/remote-hub.pid}"
SERVICE="server.mjs"

# 优先用本地 electron（GUI 控制台）；没有就提示安装
has_electron() { [[ -x node_modules/.bin/electron ]]; }

pidfile_running() {
  [[ -f "$PIDFILE" ]] || return 1
  local pid; pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

svc_start() {
  if pidfile_running; then echo "already running (pid $(cat "$PIDFILE"))"; exit 0; fi
  setsid nohup node "$SERVICE" "$@" >>"$LOG" 2>&1 </dev/null &
  echo $! >"$PIDFILE"
  disown || true
  sleep 1
  if pidfile_running; then
    echo "started (pid $(cat "$PIDFILE")) → log: $LOG"
  else
    echo "failed to start; last lines:" >&2; tail -20 "$LOG" >&2 || true; exit 1
  fi
}

svc_stop() {
  if pidfile_running; then
    local pid; pid="$(cat "$PIDFILE")"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 25); do pidfile_running || break; sleep 0.2; done
    pidfile_running && kill -9 "$pid" 2>/dev/null || true
    echo "stopped"
  else
    echo "not running"
  fi
  rm -f "$PIDFILE"
}

launch_console() {
  if pidfile_running; then
    echo "检测到后台服务在运行，先停止它以便控制台接管…"
    svc_stop
  fi
  if has_electron; then
    exec node_modules/.bin/electron .
  fi
  echo "未找到 Electron（GUI 控制台需要它）。" >&2
  echo "  安装：npm install" >&2
  echo "  或改用无界面模式：./run.sh start" >&2
  echo "  或安装发行包（已内置运行时，无需任何依赖）" >&2
  exit 1
}

case "${1:-}" in
  start)   shift; svc_start "$@" ;;
  stop)    svc_stop ;;
  restart) shift; svc_stop >/dev/null || true; exec "$0" start "$@" ;;
  status)
    if pidfile_running; then
      echo "running (pid $(cat "$PIDFILE"))"
      curl -s -m 5 "http://127.0.0.1:${PORT:-8790}/api/health" || true; echo
    else echo "not running"; exit 1; fi ;;
  --server) shift; exec node "$SERVICE" "$@" ;;
  ""|--console) launch_console ;;
  *) exec node "$SERVICE" "$@" ;;
esac
