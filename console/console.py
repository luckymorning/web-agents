#!/usr/bin/env python3
"""远程控制网关的桌面控制台（ZCode + Codex 融合远控）。

提供三件事：
  1. 可视化配置：端口、监听地址、访问令牌、Codex 可执行文件路径等；
  2. 服务进程管理：启动 / 停止 / 重启，实时查看日志；
  3. 系统托盘：最小化后可从托盘「打开」恢复窗口、「退出」停止服务并结束进程。

关闭按钮的行为由「后台运行」开关决定：
  - 开（默认）：关闭按钮只把窗口收起（相当于最小化到托盘），服务继续运行；
  - 关：关闭按钮停止服务并退出整个进程。

技术选型说明见 console/tray.py（托盘为何自己实现而不用 appindicator 绑定）。

架构：
  本程序是独立进程，通过 HTTP 调用网关的 /api 接口读写配置与状态，
  并且自己负责拉起/停止 `server.js` 子进程 —— 这样控制台崩溃不会带走服务，
  反之亦然。
"""

from __future__ import annotations

import json
import os
import queue
import signal
import subprocess
import sys
import threading
import time
import tkinter as tk
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from tkinter import messagebox, ttk

sys.path.insert(0, str(Path(__file__).resolve().parent))

from tray import TrayItem  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "console-config.json"

IS_WINDOWS = sys.platform.startswith("win")
IS_LINUX = sys.platform.startswith("linux")
# Windows 上 node 是可执行文件名，POSIX 上通常能直接在 PATH 找到
NODE_BIN_DEFAULT = "node.exe" if IS_WINDOWS else "node"

# 日志与 pid 的默认位置按平台选择（Windows 没有 /tmp）
_DEFAULT_LOG = (
    str(Path(os.environ.get("TEMP", ".")) / "remote-hub.log")
    if IS_WINDOWS
    else "/tmp/remote-hub.log"
)
SERVER_JS = ROOT / "server.js"
LOG_PATH = Path(os.environ.get("REMOTE_HUB_LOG", _DEFAULT_LOG))

DEFAULTS = {
    # 控制台默认选中「仅本机」—— 最安全的一档，用户需要局域网访问时再从
    # 下拉框里显式选择（列表里会给出各网卡地址与影响范围提示）。
    "host": "127.0.0.1",
    "port": 8790,
    "token": "",
    "codexBin": "",
}

def is_loopback_host(host: str) -> bool:
    return host in ("127.0.0.1", "localhost", "::1")


# 扁平化配色，与 Web 界面（public/styles.css）保持同一套色值，
# 让命令行控制台和网页看起来是同一个产品。
C = {
    "bg": "#0f1115",        # 窗口底色
    "card": "#161a21",      # 卡片底色（比窗口稍亮，形成层次）
    "field": "#1b2029",     # 输入框 / 按钮底色
    "line": "#262c37",      # 分隔线与描边
    "fg": "#e6e9ef",        # 主文字
    "dim": "#98a1b3",       # 次要文字与标签
    "accent": "#4c8dff",    # 主色（启动按钮、可点击地址）
    "accent_hi": "#3d78e0", # 主色悬停
    "ok": "#3fbf7f",        # 正常状态点
    "warn": "#e0a336",      # 警告状态点
    "danger": "#e0605f",    # 危险/错误状态点
}


# --------------------------------------------------------------------- 配置


def load_config() -> dict:
    cfg = dict(DEFAULTS)
    try:
        if CONFIG_PATH.exists():
            data = json.loads(CONFIG_PATH.read_text("utf-8"))
            if isinstance(data, dict):
                cfg.update({k: v for k, v in data.items() if k in DEFAULTS})
    except Exception:
        pass
    return cfg


def save_config(cfg: dict) -> None:
    try:
        CONFIG_PATH.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), "utf-8")
    except Exception as exc:
        print(f"[console] 保存配置失败: {exc}", flush=True)


# --------------------------------------------------------------------- 服务管理


class ServiceManager:
    """负责以子进程方式拉起/停止 `node server.js`，并把输出汇入日志文件。"""

    def __init__(self, log_cb):
        self.proc: subprocess.Popen | None = None
        self.log_cb = log_cb
        self._lock = threading.Lock()

    # ---- 内部

    def _spawn(self, cfg: dict) -> subprocess.Popen:
        node = os.environ.get("NODE_BIN") or NODE_BIN_DEFAULT
        args = [node, str(SERVER_JS), "--port", str(cfg["port"]), "--host", cfg["host"]]
        if cfg.get("token"):
            args += ["--token", cfg["token"]]

        env = dict(os.environ)
        if cfg.get("codexBin"):
            env["CODEX_BIN"] = cfg["codexBin"]

        kwargs = dict(
            args=args,
            cwd=str(ROOT),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        if IS_WINDOWS:
            # Windows 用 CREATE_NEW_PROCESS_GROUP 隔离，停止时可直接 terminate
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            # POSIX 用独立会话，停止时可以连同整个进程组一起收掉
            kwargs["start_new_session"] = True
        return subprocess.Popen(**kwargs)

    def _pump(self, proc: subprocess.Popen):
        try:
            with open(LOG_PATH, "a", encoding="utf-8") as fh:
                fh.write(f"\n=== 服务启动 {time.strftime('%Y-%m-%d %H:%M:%S')} ===\n")
                fh.flush()
                assert proc.stdout is not None
                for line in proc.stdout:
                    fh.write(line)
                    fh.flush()
                    self.log_cb(line.rstrip("\n"))
        except Exception as exc:
            self.log_cb(f"[console] 读取服务输出失败: {exc}")

    # ---- 对外

    @property
    def running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def start(self, cfg: dict) -> tuple[bool, str]:
        with self._lock:
            if self.running:
                return True, "服务已在运行"
            if not SERVER_JS.exists():
                return False, f"找不到 {SERVER_JS}"
            try:
                self.proc = self._spawn(cfg)
            except FileNotFoundError:
                return False, "找不到 node 命令，请确认已安装 Node.js"
            except Exception as exc:
                return False, f"启动失败: {exc}"
            threading.Thread(target=self._pump, args=(self.proc,), daemon=True).start()
            return True, f"已启动（端口 {cfg['port']}）"

    def stop(self, timeout: float = 10.0) -> tuple[bool, str]:
        with self._lock:
            proc = self.proc
            if proc is None or proc.poll() is not None:
                self.proc = None
                return True, "服务未在运行"

            if IS_WINDOWS:
                self._terminate_windows(proc, timeout)
            else:
                self._terminate_posix(proc, timeout)

            self.proc = None
            return True, "服务已停止"

    @staticmethod
    def _terminate_posix(proc: subprocess.Popen, timeout: float):
        """POSIX：先给整个进程组发 TERM，超时后 KILL。

        用进程组（负 pid）是因为 server.js 还会拉起 codex 等子进程，
        只杀父进程会留下孤儿。
        """
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except Exception:
            try:
                proc.terminate()
            except Exception:
                pass
        deadline = time.time() + timeout
        while time.time() < deadline:
            if proc.poll() is not None:
                return
            time.sleep(0.15)
        if proc.poll() is None:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass

    @staticmethod
    def _terminate_windows(proc: subprocess.Popen, timeout: float):
        """Windows：优先用 taskkill /T 连带子进程；失败则 terminate/kill。

        Windows 没有进程组信号，taskkill /T 是收掉整棵进程树的标准做法。
        """
        try:
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                capture_output=True,
                timeout=max(5, int(timeout)),
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except Exception:
            try:
                proc.terminate()
            except Exception:
                pass
            deadline = time.time() + timeout
            while time.time() < deadline:
                if proc.poll() is not None:
                    return
                time.sleep(0.15)
            if proc.poll() is None:
                try:
                    proc.kill()
                except Exception:
                    pass

    def restart(self, cfg: dict) -> tuple[bool, str]:
        self.stop()
        time.sleep(0.4)
        return self.start(cfg)


# --------------------------------------------------------------------- HTTP 工具


def api_get(cfg: dict, path: str, timeout: float = 5.0):
    url = f"http://{cfg['host'] if cfg['host'] != '0.0.0.0' else '127.0.0.1'}:{cfg['port']}/api{path}"
    if cfg.get("token"):
        url += ("&" if "?" in url else "?") + "token=" + urllib.parse.quote(cfg["token"])
    req = urllib.request.Request(url, headers={"accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


# --------------------------------------------------------------------- 主窗口


class ConsoleApp:
    def __init__(self):
        self.cfg = load_config()
        self.log_queue: queue.Queue[str] = queue.Queue()
        # 托盘线程 → 主线程的命令通道（tkinter 跨线程调用会死锁，必须走队列）
        self.cmd_queue: queue.Queue[str] = queue.Queue()
        self.svc = ServiceManager(log_cb=self.log_queue.put)
        self.tray: TrayItem | None = None
        self._quitting = False
        self._tray_thread: threading.Thread | None = None
        self._tray_available = False

        self.root = tk.Tk()
        self.root.title("远程控制网关 · 控制台")
        self.root.geometry("840x820")
        self.root.minsize(700, 560)
        self.root.configure(bg=C["bg"])
        self._set_window_icon()

        # Windows/macOS 上有原生托盘；这里是 Linux，走自实现的 SNI。
        self.root.protocol("WM_DELETE_WINDOW", self.on_close_clicked)

        self._build_ui()
        self._install_tray()
        self._tick_logs()
        self._tick_status()

        # 注意：控制台启动时**不自动拉起服务**。
        # 「后台运行」开关只表示"关闭窗口时最小化到托盘"，与是否自动启动无关 ——
        # 服务由用户点「启动」显式拉起，避免打开控制台就意外对外监听。

    # ------------------------------------------------------------ UI

    def _build_ui(self):
        """构建扁平化界面。

        设计取舍：
          - 深色主题，与 Web 界面同一套配色 —— 两个界面看起来属于同一个产品；
          - 用「卡片」取代 ttk.LabelFrame：扁平风格靠背景色分层，而不是立体描边；
          - 按钮自绘（tk.Button + relief="flat"）：ttk 按钮在多数主题下无法精确改色，
            扁平化必须能控制常态/hover/禁用三种状态的配色；
          - 区块标题用小号灰字，弱化层级感，让内容成为视觉主体。
        """
        self._init_fonts()
        self._init_ttk_style()

        def card(parent, title=None):
            """返回一个卡片容器 (外框, 内容区)。"""
            outer = tk.Frame(parent, bg=C["card"], highlightthickness=1,
                             highlightbackground=C["line"], highlightcolor=C["line"])
            if title:
                tk.Label(outer, text=title, bg=C["card"], fg=C["dim"],
                         font=self.f_small, anchor="w").pack(
                    fill="x", padx=16, pady=(10, 0))
            inner = tk.Frame(outer, bg=C["card"])
            inner.pack(fill="both", expand=True, padx=16, pady=(6, 12))
            return outer, inner

        def field_label(parent, text):
            return tk.Label(parent, text=text, bg=C["card"], fg=C["dim"],
                            font=self.f_body, anchor="w")

        # ============================================================ 顶部标题栏
        header = tk.Frame(self.root, bg=C["card"])
        header.pack(fill="x")

        head_inner = tk.Frame(header, bg=C["card"])
        head_inner.pack(fill="x", padx=18, pady=12)

        tk.Label(head_inner, text="远程控制网关", bg=C["card"], fg=C["fg"],
                 font=self.f_title).pack(side="left")

        # 右上角状态胶囊：色点 + 文字，比一整行文字更醒目且省空间
        self.head_pill = tk.Frame(head_inner, bg=C["field"], highlightthickness=1,
                                  highlightbackground=C["line"])
        self.head_pill.pack(side="right")
        self.head_dot = tk.Label(self.head_pill, text="●", bg=C["field"],
                                 fg=C["dim"], font=self.f_small)
        self.head_dot.pack(side="left", padx=(10, 0), pady=4)
        self.var_head_status = tk.StringVar(value="未运行")
        tk.Label(self.head_pill, textvariable=self.var_head_status, bg=C["field"],
                 fg=C["fg"], font=self.f_small).pack(side="left", padx=(5, 11), pady=4)

        tk.Frame(self.root, bg=C["line"], height=1).pack(fill="x")

        # ============================================================ 内容区
        # 不用可滚动 Canvas：Canvas 里的子框架高度由内容决定，
        # 会让「日志区撑满剩余空间」失效（实测日志被截断）。
        # 这里直接顺序布局，最下面的日志区用 expand=True 吃掉剩余高度；
        # 窗口设了 minsize，缩小到极限也不会挤坏布局。
        wrap = tk.Frame(self.root, bg=C["bg"])
        wrap.pack(fill="both", expand=True)

        # ============================================================ 服务配置
        cfg_card, cfg = card(wrap, "服务配置")

        self.var_host = tk.StringVar(value=self.cfg["host"])
        self.var_port = tk.StringVar(value=str(self.cfg["port"]))
        self.var_token = tk.StringVar(value=self.cfg["token"])
        self.var_codex = tk.StringVar(value=self.cfg["codexBin"])

        grid = tk.Frame(cfg, bg=C["card"])
        grid.pack(fill="x")
        grid.columnconfigure(1, weight=1)

        # 监听地址：下拉列出「仅本机 / 局域网任意 / 各网卡地址」，免手打 IP
        field_label(grid, "监听地址").grid(row=0, column=0, sticky="w", pady=5, padx=(0, 12))
        self.cmb_host = ttk.Combobox(grid, textvariable=self.var_host, state="readonly",
                                     style="Flat.TCombobox")
        self.cmb_host.grid(row=0, column=1, sticky="ew", pady=5)
        self.cmb_host.bind("<<ComboboxSelected>>", self._update_host_hint)
        self._btn(grid, "刷新网卡", self._refresh_host_options).grid(
            row=0, column=2, sticky="w", padx=(10, 0))

        field_label(grid, "端口").grid(row=1, column=0, sticky="w", pady=5, padx=(0, 12))
        port_wrap = tk.Frame(grid, bg=C["card"])
        port_wrap.grid(row=1, column=1, columnspan=2, sticky="w", pady=5)
        self._entry(port_wrap, self.var_port, width=10).pack(side="left")

        field_label(grid, "访问令牌").grid(row=2, column=0, sticky="w", pady=5, padx=(0, 12))
        self._entry(grid, self.var_token).grid(row=2, column=1, sticky="ew", pady=5)
        self._btn(grid, "随机生成", self._gen_token).grid(
            row=2, column=2, sticky="w", padx=(10, 0))

        field_label(grid, "Codex 路径").grid(row=3, column=0, sticky="w", pady=5, padx=(0, 12))
        self._entry(grid, self.var_codex).grid(
            row=3, column=1, columnspan=2, sticky="ew", pady=5)

        # 监听范围的安全提示：随选择变化，属重要信息，单独占一行
        self.var_host_hint = tk.StringVar(value="")
        tk.Label(cfg, textvariable=self.var_host_hint, bg=C["card"], fg=C["dim"],
                 font=self.f_small, anchor="w", justify="left", wraplength=620).pack(
            fill="x", pady=(8, 0))

        self._host_values = {}
        self._host_kinds = {}
        self._refresh_host_options()

        cfg_card.pack(fill="x", padx=16, pady=(14, 0))

        # ============================================================ 开关与操作
        ctrl_card, ctrl = card(wrap)

        # 关闭按钮的行为不再由用户选择，而是随服务状态自动变化；
        # 这里用一行小字说明当前行为，避免用户对"关掉窗口后服务还在跑"感到意外。
        self.var_close_hint = tk.StringVar(value="")
        tk.Label(ctrl, textvariable=self.var_close_hint, bg=C["card"], fg=C["dim"],
                 font=self.f_small, anchor="w").pack(side="left")

        btns = tk.Frame(ctrl, bg=C["card"])
        btns.pack(side="right")
        self.btn_apply = self._btn(btns, "应用配置", self._apply_config)
        self.btn_apply.pack(side="left", padx=(0, 8))
        self.btn_start = self._btn(btns, "启动", self._start, kind="primary")
        self.btn_start.pack(side="left", padx=(0, 8))
        self.btn_stop = self._btn(btns, "停止", self._stop, kind="danger")
        self.btn_stop.pack(side="left", padx=(0, 8))
        self.btn_restart = self._btn(btns, "重启", self._restart)
        self.btn_restart.pack(side="left")

        ctrl_card.pack(fill="x", padx=16, pady=(10, 0))

        # ============================================================ 运行状态
        st_card, st = card(wrap, "运行状态")

        self.var_status = tk.StringVar(value="正在检查…")
        self.var_health = tk.StringVar(value="")
        tk.Label(st, textvariable=self.var_status, bg=C["card"], fg=C["fg"],
                 font=self.f_strong, anchor="w").pack(fill="x")
        tk.Label(st, textvariable=self.var_health, bg=C["card"], fg=C["dim"],
                 font=self.f_small, anchor="w").pack(fill="x", pady=(4, 0))

        link_row = tk.Frame(st, bg=C["card"])
        link_row.pack(fill="x", pady=(10, 0))
        self.var_url = tk.StringVar(value="")
        # 地址用强调色表示可点击
        tk.Label(link_row, textvariable=self.var_url, bg=C["card"], fg=C["accent"],
                 font=self.f_body, anchor="w").pack(side="left")
        self._btn(link_row, "在浏览器打开", self._open_browser).pack(side="right")

        st_card.pack(fill="x", padx=16, pady=(10, 0))

        # ============================================================ 服务日志
        log_card, log_inner = card(wrap, "服务日志")
        # 日志区用比卡片更深的底色，形成内嵌面板的层次
        self.txt_log = tk.Text(
            log_inner, height=10, wrap="none", font=self.f_mono,
            bg="#0b0d11", fg="#cbd3e1", insertbackground=C["fg"],
            relief="flat", bd=0, highlightthickness=0, padx=10, pady=8,
        )
        yscroll = ttk.Scrollbar(log_inner, orient="vertical",
                                command=self.txt_log.yview,
                                style="Flat.Vertical.TScrollbar")
        self.txt_log.configure(yscrollcommand=yscroll.set)
        self.txt_log.pack(side="left", fill="both", expand=True)
        yscroll.pack(side="right", fill="y")
        self.txt_log.configure(state="disabled")
        log_card.pack(fill="both", expand=True, padx=16, pady=(10, 16))

        self._refresh_buttons()

    # ------------------------------------------------------------ 扁平化样式

    def _set_window_icon(self):
        """设置窗口图标：现场画一个与托盘一致的圆形图标。

        不依赖外部图片文件 —— 避免因缺少资源文件而在某些环境下报错。
        """
        try:
            from PIL import Image, ImageDraw, ImageTk

            size = 64
            img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
            d = ImageDraw.Draw(img)
            pad = 6
            d.ellipse([pad, pad, size - pad - 1, size - pad - 1], fill=(76, 141, 255, 255))
            inner = size // 2 - 13
            d.ellipse([inner, inner, size - inner - 1, size - inner - 1], fill=(15, 17, 21, 255))
            c, r = size // 2, 8
            d.ellipse([c - r, c - r, c + r - 1, c + r - 1], fill=(76, 141, 255, 255))

            # 必须持有引用，否则 PhotoImage 会被回收导致图标变空白
            self._icon_img = ImageTk.PhotoImage(img)
            self.root.iconphoto(True, self._icon_img)
        except Exception:
            # 图标属装饰，失败不影响使用
            pass

    def _init_fonts(self):
        """准备各处使用的字体。用系统默认字体族，避免缺字/回退到难看的字形。"""
        import tkinter.font as tkfont

        try:
            family = tkfont.nametofont("TkDefaultFont").actual("family")
        except Exception:
            family = "TkDefaultFont"
        mono = "Consolas" if IS_WINDOWS else "DejaVu Sans Mono"

        self.f_title = (family, 13, "bold")
        self.f_strong = (family, 10, "bold")
        self.f_body = (family, 10)
        self.f_small = (family, 9)
        self.f_mono = (mono, 9)
        self.family = family

    def _init_ttk_style(self):
        """给 ttk 控件（下拉框、滚动条）套上扁平配色。

        ttk 的配色能力受主题限制：默认主题下多数颜色改不动，
        所以切到 clam（可自定义程度最高）再逐项覆盖。
        """
        style = ttk.Style(self.root)
        try:
            style.theme_use("clam")
        except Exception:
            pass

        # 下拉框
        style.configure(
            "Flat.TCombobox",
            fieldbackground=C["field"], background=C["field"],
            foreground=C["fg"], arrowcolor=C["dim"],
            bordercolor=C["line"], lightcolor=C["field"], darkcolor=C["field"],
            selectbackground=C["accent"], selectforeground="#ffffff",
            padding=6,
        )
        style.map(
            "Flat.TCombobox",
            fieldbackground=[("readonly", C["field"])],
            background=[("readonly", C["field"])],
            foreground=[("readonly", C["fg"])],
            bordercolor=[("focus", C["accent"])],
            arrowcolor=[("active", C["accent"])],
        )

        # 滚动条：去掉立体箭头感，做成细条
        # arrowsize=0 去掉两端的立体箭头；宽度收窄成细条
        style.configure(
            "Flat.Vertical.TScrollbar",
            background=C["line"], troughcolor=C["bg"],
            bordercolor=C["bg"], arrowcolor=C["bg"],
            lightcolor=C["line"], darkcolor=C["line"],
            relief="flat", width=8, arrowsize=0,
        )
        style.map(
            "Flat.Vertical.TScrollbar",
            background=[("active", C["dim"])],
        )

    def _btn(self, parent, text, command, kind="default", width=None):
        """扁平按钮：常态 / hover / 禁用三态配色都用背景色表达，无立体边框。"""
        # (常态底色, 文字色, 描边色, 悬停底色)
        palette = {
            "default": (C["field"], C["fg"], C["line"], "#232a35"),
            "primary": (C["accent"], "#ffffff", C["accent"], C["accent_hi"]),
            "danger": (C["field"], C["danger"], C["line"], "#2a1f22"),
            # ghost：透明底 + 暗色文字，用于次要/离开类操作
            "ghost": (C["card"], C["dim"], C["line"], C["field"]),
        }
        bg, fg, border, hover = palette.get(kind, palette["default"])

        btn = tk.Button(
            parent, text=text, command=command,
            bg=bg, fg=fg, activebackground=hover, activeforeground=fg,
            font=self.f_body, relief="flat", bd=0,
            highlightthickness=1, highlightbackground=border, highlightcolor=border,
            padx=14, pady=6, cursor="hand2",
            disabledforeground=C["dim"],
        )
        if width:
            btn.configure(width=width)

        # hover 用 <Enter>/<Leave> 手动实现：tk.Button 的 activebackground
        # 只在按下时生效，不覆盖悬停态。
        def on_enter(_e):
            if str(btn["state"]) != "disabled":
                btn.configure(bg=hover)

        def on_leave(_e):
            btn.configure(bg=bg)

        btn.bind("<Enter>", on_enter)
        btn.bind("<Leave>", on_leave)
        # 记住原色，供禁用/恢复时使用
        btn._flat_bg = bg  # type: ignore[attr-defined]
        return btn

    def _entry(self, parent, var, width=None):
        """扁平输入框：深底、无边框，聚焦时用描边色提示。"""
        ent = tk.Entry(
            parent, textvariable=var, font=self.f_body,
            bg=C["field"], fg=C["fg"], insertbackground=C["fg"],
            relief="flat", bd=0, highlightthickness=1,
            highlightbackground=C["line"], highlightcolor=C["accent"],
        )
        ent.configure(highlightcolor=C["accent"])
        if width:
            ent.configure(width=width)
        # Entry 自身没有内边距选项，用 ipady 在 pack/grid 时补
        return ent

    # ------------------------------------------------------------ 托盘

    def _install_tray(self):
        self.tray = TrayItem(
            on_open=self._tray_open,
            on_quit=self._tray_quit,
            app_id="remote-hub-console",
            title="远程控制网关",
            tooltip="远程控制网关（ZCode + Codex）",
            log=lambda m: self.log_queue.put(m),
        )

        if not TrayItem.watcher_available():
            # 桌面环境没有托盘宿主。Linux 上通常是 ubuntu-appindicators 扩展未加载；
            # macOS 则是不支持（占位实现）。
            # 本次运行内强制关闭「后台运行」，否则窗口一收起，用户没有任何途径把它调回来。
            # 注意：不把关闭状态写回配置 —— 那是用户偏好，等托盘可用后应自动生效。
            self._tray_available = False
            self.log_queue.put(
                "[console] ⚠ 当前环境未提供系统托盘。"
                + (
                    "若使用 GNOME，请启用 ubuntu-appindicators 扩展并重新登录会话。"
                    if IS_LINUX
                    else f"平台 {sys.platform} 暂不支持托盘。"
                )
            )
            self.log_queue.put(
                "[console] 托盘不可用，因此关闭窗口将直接停止服务并退出"
                "（无法最小化，否则窗口收起后无法恢复）。"
            )
            self._refresh_buttons()
            return

        # 托盘注册在各平台都在独立线程里完成：
        #   Linux  → 该线程随后跑 GLib 主循环（D-Bus 需要事件循环才响应）
        #   Windows→ 该线程随后跑 Win32 消息循环（托盘回调靠它投递）
        def run():
            try:
                ok = self.tray.register()
                if not ok:
                    self.log_queue.put(
                        f"[console] 托盘注册失败：{self.tray.last_error or '未知原因'}"
                    )
                else:
                    # 注册成功但尚未进入循环前，先把状态同步给托盘提示
                    self.tray.set_tooltip(
                        "远程控制网关（运行中）" if self.svc.running else "远程控制网关（已停止）"
                    )
            except Exception as exc:
                self.log_queue.put(f"[console] 托盘初始化异常: {exc}")

            if IS_LINUX:
                try:
                    import gi

                    gi.require_version("GLib", "2.0")
                    from gi.repository import GLib

                    self._glib_loop = GLib.MainLoop()
                    self._glib_loop.run()
                except Exception as exc:
                    self.log_queue.put(f"[console] 托盘事件循环异常: {exc}")
            # Windows 的消息循环由 WindowsTray.register() 内部线程自己跑，
            # 这里不能再跑第二个循环。

        self._tray_available = True
        self._tray_thread = threading.Thread(target=run, daemon=True)
        self._tray_thread.start()

    def _tray_open(self):
        # 托盘回调运行在各自的循环线程（Linux: GLib；Windows: Win32 消息循环）。
        # tkinter 不是线程安全的：直接调用 root.after() 会死锁
        # （在 Linux 上实测表现为 D-Bus 调用超时），所以统一投递到命令队列，
        # 由主线程轮询执行。
        self.cmd_queue.put("show")

    def _tray_quit(self):
        self.cmd_queue.put("quit")

    def _drain_commands(self):
        """主线程消费来自托盘线程的命令。"""
        try:
            while True:
                cmd = self.cmd_queue.get_nowait()
                if cmd == "show":
                    self._show_window()
                elif cmd == "quit":
                    self._quit_all()
                    return
        except queue.Empty:
            pass
        except Exception as exc:
            self.log_queue.put(f"[console] 处理托盘命令出错: {exc}")

    # ------------------------------------------------------------ 窗口行为

    def _show_window(self):
        try:
            self.root.deiconify()
            self.root.lift()
            self.root.focus_force()
        except Exception:
            pass

    def on_close_clicked(self):
        """点窗口右上角关闭按钮。

        行为随服务状态自动决定，不需要用户配置：
          - 服务未运行 → 直接退出程序（没什么需要在后台保留的）；
          - 服务运行中 → 最小化到托盘，让服务继续跑（否则关窗就把服务带走了）。
        """
        if not self.svc.running:
            self.log_queue.put("[console] 服务未运行，关闭窗口即退出程序")
            self._quit_all()
            return
        self._hide_to_tray()

    def _hide_to_tray(self):
        if not self._tray_available:
            # 没有托盘就无法最小化 —— 窗口收起后用户没有任何途径唤回它。
            # 这种情况明确询问，避免既不提示又悄悄留着后台进程。
            keep = messagebox.askyesno(
                "无法最小化到托盘",
                "当前桌面环境未提供系统托盘，窗口收起后将无法恢复。\n\n"
                "是否停止服务并退出程序？\n"
                "（选「否」则取消关闭，窗口保持打开）",
                parent=self.root,
            )
            if keep:
                self._quit_all()
            return
        try:
            self.root.withdraw()
        except Exception:
            pass
        self.log_queue.put(
            "[console] 服务运行中，窗口已最小化到托盘；"
            "左键托盘图标可恢复窗口，右键「退出」停止服务并结束程序"
        )

    def _update_close_hint(self):
        """随服务状态更新"关闭窗口会怎样"的说明。"""
        try:
            if self.svc.running:
                self.var_close_hint.set("关闭窗口将最小化到托盘（服务继续运行）")
            else:
                self.var_close_hint.set("关闭窗口将退出程序")
        except Exception:
            pass

    def _quit_all(self):
        if self._quitting:
            return
        self._quitting = True
        self.log_queue.put("[console] 正在退出：停止服务…")
        try:
            ok, msg = self.svc.stop()
            self.log_queue.put(f"[console] {msg}")
        except Exception as exc:
            self.log_queue.put(f"[console] 停止服务时出错: {exc}")
        try:
            self.tray.unregister()
        except Exception:
            pass
        try:
            self.root.destroy()
        except Exception:
            pass
        # destroy 后主循环退出，进程自然结束；保险起见再强制退出
        os._exit(0)

    # ------------------------------------------------------------ 监听地址下拉

    def _refresh_host_options(self):
        """重建监听地址下拉项：仅本机 / 局域网任意 / 各网卡地址。

        下拉项的显示文本带说明，实际值存在 self._host_values 里 ——
        ttk.Combobox 只能绑定字符串，用映射表把「显示」与「值」分开最直观。
        """
        values = {}

        # 固定项。用 0.0.0.0 作为「局域网任意」的值：它让服务监听所有网卡。
        loopback_label = "仅本机 (127.0.0.1)"
        any_label = "局域网任意 (0.0.0.0)"
        values[loopback_label] = "127.0.0.1"
        values[any_label] = "0.0.0.0"

        # 逐块网卡列出具体地址，便于用户把服务绑定到某个特定网段。
        # 同时记下每项的网卡类型，供提示文案区分「真实网卡」与「VPN/隧道」——
        # 两者的可访问性完全不同，用同一套提示会误导。
        nic_items = []
        kinds = {}
        try:
            import netif

            for item in netif.list_ipv4_addresses():
                kind = item["kind"]
                suffix = " [VPN/隧道]" if kind == "tunnel" else ""
                label = f"{item['address']}  ({item['name']}){suffix}"
                values[label] = item["address"]
                kinds[label] = kind
                nic_items.append(label)
        except Exception as exc:
            self.log_queue.put(f"[console] 枚举网卡失败：{exc}")

        self._host_values = values
        self._host_kinds = kinds
        ordered = [loopback_label, any_label] + nic_items
        try:
            self.cmb_host.configure(values=ordered)
        except Exception:
            return

        # 保持当前选择：优先匹配现有值对应的项，找不到就默认「仅本机」
        current = self.var_host.get().strip() or "127.0.0.1"
        matched = next((lbl for lbl, val in values.items() if val == current), None)
        if matched is None and current:
            # 配置里可能是下拉列表外的地址（手工改过配置文件），临时补一项显示
            matched = f"{current} (当前配置)"
            values[matched] = current
            ordered.insert(0, matched)
            self.cmb_host.configure(values=ordered)
        self.var_host.set(matched or loopback_label)
        self._update_host_hint()

    def _selected_host(self) -> str:
        """把下拉框显示的文本翻译成实际监听地址。"""
        label = self.var_host.get().strip()
        return self._host_values.get(label, label or "127.0.0.1")

    def _update_host_hint(self, *_args):
        """随选择更新提示：说明影响范围与令牌要求。"""
        host = self._selected_host()
        if is_loopback_host(host):
            self.var_host_hint.set("仅本机可访问，无需访问令牌。")
            return
        if host == "0.0.0.0":
            self.var_host_hint.set(
                "监听所有网卡，同网段的手机/平板可访问；未填令牌时会自动生成一个。"
            )
            return

        # 具体地址：按网卡类型区分提示，避免把真实网卡也说成"可能连不上"
        kind = self._host_kinds.get(self.var_host.get().strip())
        if kind == "tunnel":
            self.var_host_hint.set(
                f"{host} 属于 VPN/隧道网卡，同网段的手机通常连不上。"
                "若目标是让其它设备访问，建议改选「局域网任意」。"
            )
        elif kind == "lan":
            self.var_host_hint.set(
                f"只绑定 {host}（本机网卡），仅该网段的设备可访问。"
                "想覆盖所有网段就选「局域网任意」。"
            )
        else:
            self.var_host_hint.set(f"只绑定 {host}，仅该网段的设备可访问。")

    # ------------------------------------------------------------ 配置动作

    def _gen_token(self):
        import base64
        import secrets

        self.var_token.set(base64.urlsafe_b64encode(secrets.token_bytes(24)).decode().rstrip("="))

    def _read_form(self) -> dict | None:
        try:
            port = int(self.var_port.get().strip())
            if not (1 <= port <= 65535):
                raise ValueError("端口需在 1-65535 之间")
        except Exception as exc:
            messagebox.showerror("配置有误", f"端口无效：{exc}")
            return None
        # var_host 存的是下拉项的显示文本，需要经映射表翻译成实际地址
        host = self._selected_host()
        if host != "0.0.0.0" and not host.replace(".", "").replace(":", "").isalnum():
            messagebox.showerror("配置有误", "监听地址格式不正确")
            return None

        token = self.var_token.get().strip()

        # 暴露到局域网但没有令牌时自动补一个：这个服务等价于 shell 权限，
        # 同网任何设备都能连上，不能裸奔。同时把新令牌回填到输入框，
        # 让用户能立刻看到并复制。
        if not is_loopback_host(host) and not token:
            import base64 as _b64
            import secrets as _secrets

            token = _b64.urlsafe_b64encode(_secrets.token_bytes(24)).decode().rstrip("=")
            self.var_token.set(token)
            self.log_queue.put(
                "[console] 监听非本机地址但未填写令牌，已自动生成一个并填入（请保存好）"
            )

        return {
            "host": host,
            "port": port,
            "token": token,
            "codexBin": self.var_codex.get().strip(),
        }

    def _apply_config(self):
        form = self._read_form()
        if form is None:
            return
        changed = {k: (self.cfg.get(k), form[k]) for k in form if self.cfg.get(k) != form[k]}
        self.cfg = form
        save_config(self.cfg)

        if not changed:
            self.log_queue.put("[console] 配置未变化")
            self._refresh_buttons()
            return

        detail = "，".join(f"{k} 已更新" for k in changed)
        self.log_queue.put(f"[console] 配置已保存（{detail}）")

        # 服务正在运行时，改动不会自动生效（端口/令牌等都是启动时读取的），
        # 所以询问是否立即重启 —— 避免用户以为已生效却仍在用旧配置。
        if self.svc.running:
            if messagebox.askyesno(
                "需要重启服务",
                "配置已更新，但服务仍在用旧配置运行。\n\n是否立即重启服务以应用新配置？",
                parent=self.root,
            ):
                self.log_queue.put("[console] 用户选择重启服务以应用配置")
                self._restart()
                return
            self.log_queue.put("[console] 已取消重启；新配置将在下次启动服务时生效")
        else:
            self.log_queue.put("[console] 服务未运行，新配置将在启动服务时生效")

        self._refresh_buttons()

    def _start(self):
        ok, msg = self.svc.start(self.cfg)
        self.log_queue.put(f"[console] {msg}")
        self._refresh_buttons()
        if not ok:
            messagebox.showerror("启动失败", msg)

    def _stop(self):
        ok, msg = self.svc.stop()
        self.log_queue.put(f"[console] {msg}")
        self._refresh_buttons()

    def _restart(self):
        self._apply_config_silent()
        ok, msg = self.svc.restart(self.cfg)
        self.log_queue.put(f"[console] {msg}")
        self._refresh_buttons()

    def _apply_config_silent(self):
        form = self._read_form()
        if form is not None:
            self.cfg = form
            save_config(self.cfg)

    def _open_browser(self):
        import webbrowser

        webbrowser.open(self._url())

    def _url(self) -> str:
        host = "127.0.0.1" if self.cfg["host"] in ("0.0.0.0", "") else self.cfg["host"]
        url = f"http://{host}:{self.cfg['port']}/"
        if self.cfg.get("token"):
            url += "?token=" + urllib.parse.quote(self.cfg["token"])
        return url

    def _refresh_buttons(self):
        running = self.svc.running
        # 关闭窗口的行为由服务状态决定，提示需同步刷新 ——
        # 放在这里是因为所有状态变化（启停/重启）最终都会走到 _refresh_buttons。
        self._update_close_hint()
        # tk.Button 用 state= 控制。
        # 禁用时不仅压暗底色，还要弱化文字与描边 —— 否则蓝色描边会让它看起来仍可点。
        def set_btn(btn, enabled, border_color):
            btn.configure(state="normal" if enabled else "disabled")
            btn.configure(
                bg=getattr(btn, "_flat_bg", C["field"]) if enabled else C["line"],
                highlightbackground=border_color if enabled else C["line"],
                highlightcolor=border_color if enabled else C["line"],
            )

        set_btn(self.btn_start, not running, C["accent"])
        set_btn(self.btn_stop, running, C["line"])
        self.var_url.set(self._url() if running else "(服务未运行)")

    # ------------------------------------------------------------ 定时任务

    def _tick_logs(self):
        # 先处理托盘来的命令（打开/退出），再刷日志
        self._drain_commands()
        try:
            drained = 0
            while drained < 200:
                line = self.log_queue.get_nowait()
                self.txt_log.configure(state="normal")
                self.txt_log.insert("end", line + "\n")
                self.txt_log.see("end")
                self.txt_log.configure(state="disabled")
                drained += 1
            if drained:
                # 只在有新增时裁剪，避免频繁操作
                total = int(self.txt_log.index("end-1c").split(".")[0])
                if total > 3000:
                    self.txt_log.configure(state="normal")
                    self.txt_log.delete("1.0", f"{total - 2000}.0")
                    self.txt_log.configure(state="disabled")
        except queue.Empty:
            pass
        except Exception:
            pass
        # 命令队列用更短的轮询间隔：托盘点击后要尽快响应
        self.root.after(150, self._tick_logs)

    def _tick_status(self):
        dot_color = C["dim"]
        if self.svc.running:
            pid = self.svc.proc.pid if self.svc.proc else "?"
            dot_color = C["ok"]
            try:
                health = api_get(self.cfg, "/health", timeout=2.5)
                z = health.get("zcode", "?")
                cx = "可用" if health.get("codex", {}).get("available") else "不可用"
                self.var_status.set(f"运行中　pid {pid}")
                self.var_health.set(f"Codex：{cx}　·　ZCode：{z}")
                self.var_head_status.set("运行中")
            except urllib.error.URLError:
                dot_color = C["warn"]
                self.var_status.set(f"进程在运行　pid {pid}")
                self.var_health.set("HTTP 尚未就绪，若持续如此请查看下方日志")
                self.var_head_status.set("启动中")
            except Exception as exc:
                dot_color = C["warn"]
                self.var_status.set(f"运行中　pid {pid}")
                self.var_health.set(f"健康检查失败：{exc}")
                self.var_head_status.set("异常")
        else:
            self.var_status.set("未运行")
            self.var_health.set("点「启动」拉起服务")
            self.var_head_status.set("已停止")

        # 顶部胶囊的色点与文字同步反映状态
        try:
            self.head_dot.configure(fg=dot_color)
        except Exception:
            pass
        # 关闭窗口的行为随服务状态变化，提示也要跟着刷新
        self._update_close_hint()
        if self.tray:
            self.tray.set_tooltip(
                "远程控制网关（运行中）" if self.svc.running else "远程控制网关（已停止）"
            )
        self._refresh_buttons()
        self.root.after(2000, self._tick_status)

    # ------------------------------------------------------------ 启动

    def run(self):
        self.root.mainloop()


def main():
    # 允许 Ctrl+C 结束（tkinter 默认会吞掉）
    signal.signal(signal.SIGINT, lambda *_: os._exit(0))
    app = ConsoleApp()
    app.run()


if __name__ == "__main__":
    main()
