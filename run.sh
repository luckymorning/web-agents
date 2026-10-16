#!/usr/bin/env bash
# 远程控制网关的启动入口。
#
#   ./run.sh            启动控制台（推荐，带窗口 + 托盘）
#   ./run.sh --server   只启动服务（无界面，等价于旧行为）
#   ./run.sh start      后台启动服务，不带控制台
#   ./run.sh stop       停止后台服务
#   ./run.sh status     查看状态
#
# 默认监听 0.0.0.0（允许局域网访问）。此服务等同于本机 shell 权限，
# 因此非回环监听时强制要求访问令牌：缺失会自动生成并写入 console-config.json。
# 只想本机访问时用：./run.sh start --host 127.0.0.1
#
# 控制台模式下：服务由控制台作为子进程管理，关闭窗口的行为取决于
# 界面上的「后台运行」开关。
set -euo pipefail
cd "$(dirname "$0")"

LOG="${REMOTE_HUB_LOG:-/tmp/remote-hub.log}"
PIDFILE="${REMOTE_HUB_PID:-/tmp/remote-hub.pid}"

# ---- 仅服务模式（命令行/无头场景） ----

pidfile_running() {
  [[ -f "$PIDFILE" ]] || return 1
  local pid; pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

svc_start() {
  if pidfile_running; then echo "already running (pid $(cat "$PIDFILE"))"; exit 0; fi
  setsid nohup node server.js "$@" >>"$LOG" 2>&1 </dev/null &
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
  # 控制台自己管理服务子进程；若命令行/后台模式的服务在跑，先停掉避免端口冲突
  if pidfile_running; then
    echo "检测到后台服务在运行，先停止它以便控制台接管…"
    svc_stop
  fi
  exec python3 console/console.py "$@"
}

case "${1:-}" in
  start)  shift; svc_start "$@" ;;
  stop)   svc_stop ;;
  restart) shift; svc_stop >/dev/null || true; exec "$0" start "$@" ;;
  status)
    if pidfile_running; then
      echo "running (pid $(cat "$PIDFILE"))"
      curl -s -m 5 "http://127.0.0.1:${PORT:-8790}/api/health" || true; echo
    else echo "not running"; exit 1; fi ;;
  --server) shift; exec node server.js "$@" ;;
  ""|--console) launch_console ;;
  *) exec node server.js "$@" ;;
esac
