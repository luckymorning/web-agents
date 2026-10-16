"""托盘实现的平台分发器。

对外只暴露一个 `TrayItem`，控制台无需关心运行在哪个平台：

    Linux   →  tray_linux.LinuxTray   （D-Bus StatusNotifierItem）
    Windows →  tray_win.WindowsTray   （Shell_NotifyIcon）
    macOS   →  暂不支持（返回一个"不可用"的桩实现，控制台会自动降级）

两个实现都提供同一组接口：
    register() -> bool
    wait_registered(timeout) -> bool
    set_tooltip(text)
    unregister()
    watcher_available()  (staticmethod)
    .registered / .last_error
"""

from __future__ import annotations

import sys


class UnsupportedTray:
    """平台不支持时的占位实现：始终报告不可用，让控制台走降级路径。"""

    def __init__(self, *, app_id="remote-hub", log=print, **_kwargs):
        self.app_id = app_id
        self.log = log
        self.registered = False
        self.last_error = "unsupported-platform"

    @staticmethod
    def watcher_available() -> bool:
        return False

    def register(self, timeout: float = 5.0) -> bool:
        self.log(f"[tray] 当前平台（{sys.platform}）暂不支持系统托盘")
        return False

    def wait_registered(self, timeout: float = 5.0) -> bool:
        return False

    def set_tooltip(self, text: str):
        pass

    def unregister(self):
        pass


def _pick():
    if sys.platform.startswith("win"):
        from tray_win import WindowsTray

        return WindowsTray
    if sys.platform.startswith("linux"):
        try:
            from tray_linux import LinuxTray

            return LinuxTray
        except Exception as exc:  # 缺少 GI/D-Bus 等
            print(f"[tray] 无法加载 Linux 托盘实现: {exc}", flush=True)
            return UnsupportedTray
    return UnsupportedTray


TrayItem = _pick()
