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

# ---------------------------------------------------------------- 沙箱
#
# Electron 在 Linux 上有两条沙箱路径：
#   1) user namespace 沙箱（现代默认，不需要 root）；
#   2) setuid 沙箱，要求 chrome-sandbox 属 root 且权限 4755。
#
# 当系统禁用了非特权 user namespace（Ubuntu 24.04+ 的 AppArmor 默认策略、
# 或在容器/受限环境里）时，Electron 会退回 setuid 路径；而 npm 安装的
# chrome-sandbox 属当前用户、没有 setuid 位，于是直接中止并报：
#   "The SUID sandbox helper binary was found, but is not configured correctly"
#
# 这里先探测 userns 是否可用：
#   - 可用   → 正常启动（走 userns 沙箱，安全性最好）；
#   - 不可用 → 提示用户二选一：用 sudo 修好 setuid 位，或本次以 --no-sandbox 启动。
#
# 说明：--no-sandbox 会关闭渲染进程沙箱。本控制台只加载本地打包的 HTML/JS，
# 不访问远程内容，因此该降级是可接受的；但仍优先建议修复 setuid。

userns_available() {
  # unshare(1) 能成功创建 user namespace 就说明可用
  unshare --user --map-root-user true 2>/dev/null
}

# 判断 setuid 沙箱是否**可能**生效：需要 4755 + root 属主，
# 且所在文件系统不能以 nosuid 挂载（nosuid 会让内核忽略 setuid 位）。
setuid_sandbox_usable() {
  local sb="$1"
  [[ -u "$sb" ]] || return 1
  [[ "$(stat -c %U "$sb" 2>/dev/null)" == "root" ]] || return 1
  local opts
  opts="$(findmnt -n -o OPTIONS -T "$sb" 2>/dev/null || true)"
  [[ "$opts" != *nosuid* ]]
}

# 打印精确的失败原因与可选方案（区分 nosuid 与 userns 两种情况）
explain_sandbox_failure() {
  local sb="$1"
  local opts
  opts="$(findmnt -n -o OPTIONS -T "$sb" 2>/dev/null || true)"

  echo "" >&2
  if [[ "$opts" == *nosuid* ]]; then
    # 这是最容易踩坑的情况：用户按提示 chmod 4755 后仍然失败，
    # 因为 nosuid 挂载让 setuid 位形同虚设。
    echo "无法启用 Electron 沙箱，原因有二（本机同时命中）：" >&2
    echo "  1) 项目所在文件系统以 nosuid 挂载：$(findmnt -n -o TARGET -T "$sb" 2>/dev/null)" >&2
    echo "     内核会忽略 setuid 位，因此 chmod 4755 无效。" >&2
    echo "  2) 系统禁用了非特权 user namespace（Ubuntu 24.04+ 的 AppArmor 策略）。" >&2
    echo "" >&2
    echo "可选方案：" >&2
    echo "  【A】以 --no-sandbox 运行（本控制台只加载本地资源，可接受）" >&2
    echo "       ./run.sh --no-sandbox" >&2
    echo "  【B】为 Electron 二进制添加 AppArmor 白名单（保留 userns 沙箱，需 sudo）" >&2
    echo "       见 README「Linux 沙箱问题」一节" >&2
    echo "  【C】安装发行包（deb 装到 /opt，该分区支持 setuid）" >&2
    echo "       sudo dpkg -i dist/remote-hub_*_amd64.deb" >&2
  else
    echo "当前系统禁用了非特权 user namespace，Electron 需要 setuid 沙箱。" >&2
    echo "请二选一：" >&2
    echo "" >&2
    echo "  【推荐】赋予 chrome-sandbox 正确的属主与权限：" >&2
    echo "      sudo chown root:root $sb" >&2
    echo "      sudo chmod 4755 $sb" >&2
    echo "" >&2
    echo "  【临时】本次以 --no-sandbox 运行：" >&2
    echo "      ./run.sh --no-sandbox" >&2
  fi
  echo "" >&2
}

launch_console() {
  if pidfile_running; then
    echo "检测到后台服务在运行，先停止它以便控制台接管…"
    svc_stop
  fi
  if ! has_electron; then
    echo "未找到 Electron（GUI 控制台需要它）。" >&2
    echo "  安装：npm install" >&2
    echo "  或改用无界面模式：./run.sh start" >&2
    echo "  或安装发行包（已内置运行时，无需任何依赖）" >&2
    exit 1
  fi

  local sb="node_modules/electron/dist/chrome-sandbox"
  local args=("$@")
  local force_no_sandbox=0
  for a in "${args[@]}"; do
    [[ "$a" == "--no-sandbox" ]] && force_no_sandbox=1
  done
  [[ "${ELECTRON_DISABLE_SANDBOX:-}" =~ ^(1|true|yes|on)$ ]] && force_no_sandbox=1

  # 只有 userns 不可用时才需要关心 setuid 沙箱
  if [[ $force_no_sandbox -eq 0 ]] && ! userns_available; then
    if setuid_sandbox_usable "$sb"; then
      : # setuid 沙箱可用，交给 Electron 自行选择
    else
      # 两条沙箱路径都不可用 —— 自动降级，保证 ./run.sh 开箱可用，
      # 同时把原因与「如何恢复沙箱」讲清楚。
      explain_sandbox_failure "$sb"
      echo "→ 已自动改用 --no-sandbox 启动（功能不受影响）。" >&2
      echo "" >&2
      args+=("--no-sandbox")
    fi
  fi

  exec node_modules/.bin/electron . "${args[@]}"
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
  "")
    # 无参数：启动控制台（此时不能 shift，否则空参数下 set -e 会退出）
    launch_console ;;
  --console)
    shift
    launch_console "$@" ;;
  # Electron / Chromium 开关：原样透传给控制台。若不单列，会落到下面的服务端
  # 分支，变成 node server.mjs --no-sandbox，报「Cannot find module」。
  --no-sandbox|--disable-gpu|--enable-logging|--inspect|--inspect=*|--inspect-brk|--remote-debugging-port=*)
    launch_console "$@" ;;
  *) exec node "$SERVICE" "$@" ;;
esac
