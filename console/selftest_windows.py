"""Windows 环境自检：确认托盘、依赖与 Codex 路径都能用。

在 Windows 上运行：
    python console\\selftest_windows.py

它会逐项检查并给出明确结论，便于快速定位"为什么托盘没出来"。
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

OK = "[ OK ]"
BAD = "[FAIL]"
WARN = "[WARN]"


def line(status: str, text: str):
    print(f"{status} {text}", flush=True)


def check_platform():
    if not sys.platform.startswith("win"):
        line(BAD, f"当前不是 Windows（sys.platform={sys.platform}）")
        return False
    line(OK, f"平台: {sys.platform}")
    return True


def check_python_gui():
    try:
        import tkinter  # noqa: F401

        line(OK, f"tkinter 可用（Tk {tkinter.TkVersion}）")
    except Exception as exc:
        line(BAD, f"tkinter 不可用：{exc}")
        print("       → 安装 Python 时需勾选 tcl/tk 组件")
        return False

    try:
        import PIL

        line(OK, f"Pillow 可用（{PIL.__version__}），托盘用自绘图标")
    except Exception:
        line(WARN, "未安装 Pillow — 托盘图标将回退为系统图标（不影响功能）")
        print("       → 可选：pip install pillow")
    return True


def check_win32():
    try:
        import ctypes

        ctypes.windll.user32
        ctypes.windll.shell32
        line(OK, "Win32 API 可访问（user32 / shell32）")
        return True
    except Exception as exc:
        line(BAD, f"无法访问 Win32 API：{exc}")
        return False


def check_tray_module():
    try:
        from tray import TrayItem
        from tray_win import WindowsTray

        if TrayItem is not WindowsTray:
            line(BAD, f"平台分发器选错实现：{TrayItem.__name__}（应为 WindowsTray）")
            return False
        line(OK, "托盘模块加载正常（WindowsTray）")
        return True
    except Exception as exc:
        line(BAD, f"托盘模块加载失败：{exc}")
        return False


def check_explorer():
    """托盘由 explorer.exe 提供，确认它在本会话中运行。"""
    try:
        out = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq explorer.exe", "/NH"],
            capture_output=True, text=True, timeout=10,
        ).stdout
        if "explorer.exe" in out:
            line(OK, "explorer.exe 在运行（通知区域可用）")
            return True
        line(WARN, "未检测到 explorer.exe — 托盘图标可能不显示")
        return False
    except Exception as exc:
        line(WARN, f"无法检测 explorer.exe：{exc}")
        return False


def check_node():
    try:
        out = subprocess.run(
            ["node", "--version"], capture_output=True, text=True, timeout=10
        )
        if out.returncode == 0:
            line(OK, f"Node.js 可用（{out.stdout.strip()}）")
            return True
        line(BAD, "node 命令返回非零")
        return False
    except Exception:
        line(BAD, "未找到 node — 服务无法启动")
        print("       → 安装 Node.js 并确保在 PATH 中")
        return False


def check_codex():
    try:
        sys.path.insert(0, str(ROOT))
        # 复用服务端同一套候选逻辑的思路，这里直接按 Windows 候选列一遍
        home = Path(os.path.expanduser("~"))
        local = Path(os.environ.get("LOCALAPPDATA", home / "AppData" / "Local"))
        cands = [
            os.environ.get("CODEX_BIN"),
            home / ".codex" / "plugins" / ".plugin-appserver" / "codex.exe",
            local / "Programs" / "ChatGPT" / "resources" / "codex.exe",
            local / "Programs" / "Codex" / "resources" / "codex.exe",
        ]
        found = next((c for c in cands if c and Path(c).exists()), None)
        if found:
            line(OK, f"找到 codex：{found}")
        else:
            line(WARN, "未自动找到 codex — Codex tab 会不可用")
            print("       → 用 --codexBin 或在控制台里指定路径")
        return bool(found)
    except Exception as exc:
        line(WARN, f"检查 codex 路径时出错：{exc}")
        return False


def check_zcode_state():
    home = Path(os.path.expanduser("~"))
    base = Path(os.environ.get("ZCODE_HOME", home / ".zcode"))
    state = Path(os.environ.get("ZCODE_STATE_DIR", base / "v2"))
    if not state.exists():
        line(WARN, f"未找到 ZCode 状态目录：{state}")
        print("       → ZCode tab 无法读取配对凭据（需在桌面端开启过远控）")
        return False
    setting = state / "setting.json"
    if not setting.exists():
        line(WARN, "状态目录存在但没有 setting.json（远控可能未开启过）")
        return False
    import json

    try:
        data = json.loads(setting.read_text("utf-8"))
        sid = (data.get("webRemoteControlExternalRelayDevice") or {}).get("deviceSid")
        if sid:
            line(OK, f"ZCode 远控凭据存在（sid 末尾 {sid[-6:]}）")
        else:
            line(WARN, "setting.json 里没有远控凭据 — 请先在桌面端开启「Web 远程控制」")
        return bool(sid)
    except Exception as exc:
        line(WARN, f"读取 setting.json 失败：{exc}")
        return False


def main():
    print("=" * 62)
    print(" 远程控制网关 · Windows 环境自检")
    print("=" * 62)
    results = []
    if not check_platform():
        return 1
    results.append(check_python_gui())
    results.append(check_win32())
    results.append(check_tray_module())
    results.append(check_explorer())
    results.append(check_node())
    results.append(check_codex())
    results.append(check_zcode_state())
    print("-" * 62)
    if all(r is not False for r in results):
        print("结论：环境可用。运行  run.bat  启动控制台。")
        return 0
    print("结论：存在阻塞项（见上面 FAIL）。请先解决再启动。")
    return 1


if __name__ == "__main__":
    sys.exit(main())
