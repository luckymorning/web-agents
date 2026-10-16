"""Windows 托盘图标（Shell_NotifyIcon），纯 ctypes 调用 Win32 API，无第三方依赖。

与 Linux 版的差异：
  - Linux 走 D-Bus 的 StatusNotifierItem 协议，由桌面 shell 渲染；
  - Windows 走经典的 Shell_NotifyIcon + 隐藏消息窗口 + 弹出菜单。

实现要点：
  1. 需要一个能接收消息的窗口。这里注册一个「消息专用窗口」
     （父窗口为 HWND_MESSAGE），不显示、不占任务栏；
  2. 托盘图标通过 NOTIFYICONDATA 注册，回调消息用自定义的 WM_APP+n；
  3. 右键菜单用 CreatePopupMenu + TrackPopupMenu，并用 TPM_RETURNCMD
     取回选中项，避免额外处理菜单消息；
  4. 图标优先用 PIL 现场绘制并转成 HICON，失败则回退系统图标，
     保证任何情况下托盘都能显示。

**关键**：64 位 Windows 上 HWND/HICON/HMENU 等是 64 位指针，而 ctypes 默认把
返回值当 32 位 int 处理，会截断句柄导致程序崩溃。因此下面为每个用到的 Win32
函数显式设置 restype/argtypes —— 这是本文件最重要的正确性保障。
"""

from __future__ import annotations

import ctypes
import threading
from ctypes import wintypes

user32 = ctypes.windll.user32
shell32 = ctypes.windll.shell32
kernel32 = ctypes.windll.kernel32

# ---------------------------------------------------------------- 常量

WM_APP = 0x8000
WM_TRAYICON = WM_APP + 20
WM_DESTROY = 0x0002
WM_COMMAND = 0x0111
WM_LBUTTONUP = 0x0202
WM_LBUTTONDBLCLK = 0x0203
WM_RBUTTONUP = 0x0205

NIM_ADD = 0x00000000
NIM_MODIFY = 0x00000001
NIM_DELETE = 0x00000002

NIF_MESSAGE = 0x00000001
NIF_ICON = 0x00000002
NIF_TIP = 0x00000004

TPM_RETURNCMD = 0x0100
TPM_RIGHTBUTTON = 0x0002
TPM_NONOTIFY = 0x0080

MF_STRING = 0x00000000
MF_SEPARATOR = 0x00000800

CS_HREDRAW = 0x0002
CS_VREDRAW = 0x0001

HWND_MESSAGE = -3
IDI_INFORMATION = 32516

MENU_OPEN = 1001
MENU_QUIT = 1002

LRESULT = ctypes.c_ssize_t
WNDPROC_T = ctypes.WINFUNCTYPE(
    LRESULT, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM
)

# ---------------------------------------------------------------- 结构体


class GUID(ctypes.Structure):
    _fields_ = [
        ("Data1", wintypes.DWORD),
        ("Data2", wintypes.WORD),
        ("Data3", wintypes.WORD),
        ("Data4", ctypes.c_byte * 8),
    ]


class NOTIFYICONDATA(ctypes.Structure):
    """对应 NOTIFYICONDATAW；cbSize 需按实际结构大小填写。"""

    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("hWnd", wintypes.HWND),
        ("uID", wintypes.UINT),
        ("uFlags", wintypes.UINT),
        ("uCallbackMessage", wintypes.UINT),
        ("hIcon", wintypes.HICON),
        ("szTip", wintypes.WCHAR * 128),
        ("dwState", wintypes.DWORD),
        ("dwStateMask", wintypes.DWORD),
        ("szInfo", wintypes.WCHAR * 256),
        ("uVersion", wintypes.UINT),
        ("szInfoTitle", wintypes.WCHAR * 64),
        ("dwInfoFlags", wintypes.DWORD),
        ("guidItem", GUID),
        ("hBalloonIcon", wintypes.HICON),
    ]


class WNDCLASSEX(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.UINT),
        ("style", wintypes.UINT),
        ("lpfnWndProc", WNDPROC_T),
        ("cbClsExtra", ctypes.c_int),
        ("cbWndExtra", ctypes.c_int),
        ("hInstance", wintypes.HINSTANCE),
        ("hIcon", wintypes.HICON),
        ("hCursor", wintypes.HANDLE),
        ("hbrBackground", wintypes.HBRUSH),
        ("lpszMenuName", wintypes.LPCWSTR),
        ("lpszClassName", wintypes.LPCWSTR),
        ("hIconSm", wintypes.HICON),
    ]


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD),
        ("biWidth", ctypes.c_long),
        ("biHeight", ctypes.c_long),
        ("biPlanes", wintypes.WORD),
        ("biBitCount", wintypes.WORD),
        ("biCompression", wintypes.DWORD),
        ("biSizeImage", wintypes.DWORD),
        ("biXPelsPerMeter", ctypes.c_long),
        ("biYPelsPerMeter", ctypes.c_long),
        ("biClrUsed", wintypes.DWORD),
        ("biClrImportant", wintypes.DWORD),
    ]


class ICONINFO(ctypes.Structure):
    _fields_ = [
        ("fIcon", wintypes.BOOL),
        ("xHotspot", wintypes.DWORD),
        ("yHotspot", wintypes.DWORD),
        ("hbmMask", wintypes.HBITMAP),
        ("hbmColor", wintypes.HBITMAP),
    ]


class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


class MSG(ctypes.Structure):
    _fields_ = [
        ("hwnd", wintypes.HWND),
        ("message", wintypes.UINT),
        ("wParam", wintypes.WPARAM),
        ("lParam", wintypes.LPARAM),
        ("time", wintypes.DWORD),
        ("pt", POINT),
        ("lPrivate", wintypes.DWORD),
    ]


# ---------------------------------------------------------------- 函数原型
#
# 逐个声明是必须的：句柄/指针在 64 位下为 8 字节，若按 ctypes 默认的
# c_int 返回会被截断，进而导致句柄无效与崩溃。

user32.RegisterClassExW.argtypes = [ctypes.POINTER(WNDCLASSEX)]
user32.RegisterClassExW.restype = wintypes.WORD

user32.UnregisterClassW.argtypes = [wintypes.LPCWSTR, wintypes.HINSTANCE]
user32.UnregisterClassW.restype = wintypes.BOOL

user32.CreateWindowExW.argtypes = [
    wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
    ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
    wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID,
]
user32.CreateWindowExW.restype = wintypes.HWND

user32.DestroyWindow.argtypes = [wintypes.HWND]
user32.DestroyWindow.restype = wintypes.BOOL

user32.DefWindowProcW.argtypes = [
    wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM
]
user32.DefWindowProcW.restype = LRESULT

user32.GetMessageW.argtypes = [
    ctypes.POINTER(MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT
]
user32.GetMessageW.restype = ctypes.c_int

user32.TranslateMessage.argtypes = [ctypes.POINTER(MSG)]
user32.TranslateMessage.restype = wintypes.BOOL

user32.DispatchMessageW.argtypes = [ctypes.POINTER(MSG)]
user32.DispatchMessageW.restype = LRESULT

user32.PostQuitMessage.argtypes = [ctypes.c_int]
user32.PostQuitMessage.restype = None

user32.PostMessageW.argtypes = [
    wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM
]
user32.PostMessageW.restype = wintypes.BOOL

user32.CreatePopupMenu.argtypes = []
user32.CreatePopupMenu.restype = wintypes.HMENU

user32.DestroyMenu.argtypes = [wintypes.HMENU]
user32.DestroyMenu.restype = wintypes.BOOL

user32.AppendMenuW.argtypes = [
    wintypes.HMENU, wintypes.UINT, wintypes.WPARAM, wintypes.LPCWSTR
]
user32.AppendMenuW.restype = wintypes.BOOL

user32.TrackPopupMenu.argtypes = [
    wintypes.HMENU, wintypes.UINT, ctypes.c_int, ctypes.c_int,
    ctypes.c_int, wintypes.HWND, wintypes.LPVOID,
]
user32.TrackPopupMenu.restype = ctypes.c_int

user32.GetCursorPos.argtypes = [ctypes.POINTER(POINT)]
user32.GetCursorPos.restype = wintypes.BOOL

user32.SetForegroundWindow.argtypes = [wintypes.HWND]
user32.SetForegroundWindow.restype = wintypes.BOOL

user32.GetDC.argtypes = [wintypes.HWND]
user32.GetDC.restype = wintypes.HDC

user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
user32.ReleaseDC.restype = ctypes.c_int

user32.CreateDIBSection.argtypes = [
    wintypes.HDC, ctypes.POINTER(BITMAPINFOHEADER), wintypes.UINT,
    ctypes.POINTER(ctypes.c_void_p), wintypes.HANDLE, wintypes.DWORD,
]
user32.CreateDIBSection.restype = wintypes.HBITMAP

user32.CreateBitmap.argtypes = [
    ctypes.c_int, ctypes.c_int, wintypes.UINT, wintypes.UINT, wintypes.LPVOID
]
user32.CreateBitmap.restype = wintypes.HBITMAP

user32.CreateIconIndirect.argtypes = [ctypes.POINTER(ICONINFO)]
user32.CreateIconIndirect.restype = wintypes.HICON

user32.DestroyIcon.argtypes = [wintypes.HICON]
user32.DestroyIcon.restype = wintypes.BOOL

user32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
user32.DeleteObject.restype = wintypes.BOOL

user32.LoadIconW.argtypes = [wintypes.HINSTANCE, ctypes.c_void_p]
user32.LoadIconW.restype = wintypes.HICON

kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
kernel32.GetModuleHandleW.restype = wintypes.HMODULE

kernel32.GetLastError.argtypes = []
kernel32.GetLastError.restype = wintypes.DWORD

shell32.Shell_NotifyIconW.argtypes = [
    wintypes.DWORD, ctypes.POINTER(NOTIFYICONDATA)
]
shell32.Shell_NotifyIconW.restype = wintypes.BOOL


def _make_hicon(size: int = 32):
    """用 PIL 画一个圆形图标并转成 HICON；失败返回 None（调用方回退系统图标）。"""
    try:
        from PIL import Image, ImageDraw
    except Exception:
        return None

    hbm_color = None
    hbm_mask = None
    try:
        img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        pad = max(1, size // 10)
        d.ellipse([pad, pad, size - pad - 1, size - pad - 1], fill=(74, 141, 255, 255))
        inner = size // 2 - max(2, size // 5)
        d.ellipse([inner, inner, size - inner - 1, size - inner - 1], fill=(15, 17, 21, 255))
        c = size // 2
        r = max(1, size // 8)
        d.ellipse([c - r, c - r, c + r - 1, c + r - 1], fill=(74, 141, 255, 255))

        # CreateDIBSection 用 BGRA；高度取负值表示 top-down
        bgra = bytearray()
        for y in range(size):
            for x in range(size):
                rr, gg, bb, aa = img.getpixel((x, y))
                bgra += bytes((bb, gg, rr, aa))

        hdc = user32.GetDC(None)
        if not hdc:
            return None
        try:
            bmi = BITMAPINFOHEADER()
            bmi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
            bmi.biWidth = size
            bmi.biHeight = -size
            bmi.biPlanes = 1
            bmi.biBitCount = 32
            bmi.biCompression = 0  # BI_RGB

            ppv = ctypes.c_void_p()
            hbm_color = user32.CreateDIBSection(
                hdc, ctypes.byref(bmi), 0, ctypes.byref(ppv), None, 0
            )
            if not hbm_color or not ppv:
                return None
            ctypes.memmove(ppv, bytes(bgra), len(bgra))

            # 32bpp 带 alpha 时掩码内容不影响显示，但结构上必须提供
            mask_row_bytes = ((size + 31) // 32) * 4
            mask_bytes = b"\x00" * (mask_row_bytes * size)
            hbm_mask = user32.CreateBitmap(size, size, 1, 1, mask_bytes)
            if not hbm_mask:
                return None

            ii = ICONINFO()
            ii.fIcon = True
            ii.xHotspot = 0
            ii.yHotspot = 0
            ii.hbmMask = hbm_mask
            ii.hbmColor = hbm_color
            hicon = user32.CreateIconIndirect(ctypes.byref(ii))
            return hicon or None
        finally:
            user32.ReleaseDC(None, hdc)
    except Exception:
        return None
    finally:
        # CreateIconIndirect 会复制位图内容，这里可以安全释放
        if hbm_color:
            try:
                user32.DeleteObject(hbm_color)
            except Exception:
                pass
        if hbm_mask:
            try:
                user32.DeleteObject(hbm_mask)
            except Exception:
                pass


class WindowsTray:
    """Windows 系统托盘。

    接口与 LinuxTray 保持一致，便于控制台侧无差别调用：
        register() / unregister() / set_tooltip() / watcher_available()
    """

    def __init__(self, *, on_open, on_quit, app_id="remote-hub", title="远程控制网关",
                 tooltip="远程控制网关（ZCode + Codex）", log=print):
        self.on_open = on_open
        self.on_quit = on_quit
        self.app_id = app_id
        self.title = title
        self.tooltip = tooltip
        self.log = log
        self.registered = False
        self.last_error: str | None = None

        self._hwnd = None
        self._hicon = None
        self._wndproc_ref = None  # 必须持有引用，否则回调会被 GC 回收
        self._nid: NOTIFYICONDATA | None = None
        self._class_name = f"RemoteHubTray_{app_id}"
        self._thread: threading.Thread | None = None
        self._ready = threading.Event()
        self._loop_done = threading.Event()
        self._stopping = False

    @staticmethod
    def watcher_available() -> bool:
        """Windows 上通知区域由 explorer 提供，视为始终可用。"""
        return True

    # ------------------------------------------------------------ 内部

    @staticmethod
    def _safe(fn):
        try:
            fn()
        except Exception as exc:
            print(f"[tray] 回调异常: {exc}", flush=True)

    def _show_menu(self):
        hmenu = user32.CreatePopupMenu()
        if not hmenu:
            return
        try:
            user32.AppendMenuW(hmenu, MF_STRING, MENU_OPEN, "打开")
            user32.AppendMenuW(hmenu, MF_SEPARATOR, 0, None)
            user32.AppendMenuW(hmenu, MF_STRING, MENU_QUIT, "退出")

            pt = POINT()
            user32.GetCursorPos(ctypes.byref(pt))
            # 必须在弹菜单前把本窗口置于前台，否则菜单可能不响应点击
            user32.SetForegroundWindow(self._hwnd)
            cmd = user32.TrackPopupMenu(
                hmenu,
                TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_NONOTIFY,
                pt.x, pt.y, 0, self._hwnd, None,
            )
            # MSDN 推荐：发一个空消息让菜单正确关闭
            user32.PostMessageW(self._hwnd, WM_COMMAND, 0, 0)

            if cmd == MENU_OPEN:
                self.log("[tray] 菜单：打开")
                self._safe(self.on_open)
            elif cmd == MENU_QUIT:
                self.log("[tray] 菜单：退出")
                self._safe(self.on_quit)
        finally:
            user32.DestroyMenu(hmenu)

    def _wndproc(self, hwnd, msg, wparam, lparam):
        if msg == WM_TRAYICON:
            event = lparam & 0xFFFF
            if event in (WM_LBUTTONUP, WM_LBUTTONDBLCLK):
                self.log("[tray] 左键点击：打开窗口")
                self._safe(self.on_open)
            elif event == WM_RBUTTONUP:
                self._show_menu()
            return 0
        if msg == WM_DESTROY:
            user32.PostQuitMessage(0)
            return 0
        return user32.DefWindowProcW(hwnd, msg, wparam, lparam)

    def _run(self):
        try:
            hinstance = kernel32.GetModuleHandleW(None)

            self._wndproc_ref = WNDPROC_T(self._wndproc)
            wc = WNDCLASSEX()
            wc.cbSize = ctypes.sizeof(WNDCLASSEX)
            wc.style = CS_HREDRAW | CS_VREDRAW
            wc.lpfnWndProc = self._wndproc_ref
            wc.hInstance = hinstance
            wc.lpszClassName = self._class_name

            if not user32.RegisterClassExW(ctypes.byref(wc)):
                err = kernel32.GetLastError()
                if err != 1410:  # 1410 = 类已注册，可忽略
                    self.last_error = f"RegisterClassExW 失败 (error {err})"
                    self.log(f"[tray] {self.last_error}")
                    return

            # 消息专用窗口：不显示、不占任务栏，仅用于接收托盘回调
            self._hwnd = user32.CreateWindowExW(
                0, self._class_name, self.title, 0,
                0, 0, 0, 0,
                wintypes.HWND(HWND_MESSAGE), None, hinstance, None,
            )
            if not self._hwnd:
                err = kernel32.GetLastError()
                self.last_error = f"CreateWindowExW 失败 (error {err})"
                self.log(f"[tray] {self.last_error}")
                return

            self._hicon = _make_hicon(32)
            if not self._hicon:
                self._hicon = user32.LoadIconW(None, ctypes.c_void_p(IDI_INFORMATION))
                self.log("[tray] 自定义图标生成失败，已回退系统图标")

            nid = NOTIFYICONDATA()
            nid.cbSize = ctypes.sizeof(NOTIFYICONDATA)
            nid.hWnd = self._hwnd
            nid.uID = 1
            nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP
            nid.uCallbackMessage = WM_TRAYICON
            nid.hIcon = self._hicon
            nid.szTip = self.tooltip[:127]
            self._nid = nid

            if not shell32.Shell_NotifyIconW(NIM_ADD, ctypes.byref(nid)):
                self.last_error = "Shell_NotifyIconW(NIM_ADD) 失败"
                self.log(f"[tray] {self.last_error}")
                return

            self.registered = True
            self.log(f"[tray] 已注册到任务栏通知区域（{self._class_name}）")

            msg = MSG()
            while not self._stopping:
                ret = user32.GetMessageW(ctypes.byref(msg), None, 0, 0)
                if ret == 0 or ret == -1:
                    break
                user32.TranslateMessage(ctypes.byref(msg))
                user32.DispatchMessageW(ctypes.byref(msg))
        except Exception as exc:
            self.last_error = str(exc)
            self.log(f"[tray] 初始化异常: {exc}")
        finally:
            self._ready.set()
            self._cleanup()
            self._loop_done.set()

    def _cleanup(self):
        if self._nid is not None:
            try:
                shell32.Shell_NotifyIconW(NIM_DELETE, ctypes.byref(self._nid))
            except Exception:
                pass
            self._nid = None
        if self._hicon:
            try:
                user32.DestroyIcon(self._hicon)
            except Exception:
                pass
            self._hicon = None
        if self._hwnd:
            hwnd, self._hwnd = self._hwnd, None
            try:
                user32.DestroyWindow(hwnd)
            except Exception:
                pass
        try:
            user32.UnregisterClassW(self._class_name, kernel32.GetModuleHandleW(None))
        except Exception:
            pass
        self.registered = False

    # ------------------------------------------------------------ 对外

    def register(self, timeout: float = 10.0) -> bool:
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        self._ready.wait(timeout)
        return self.registered

    def set_tooltip(self, text: str):
        self.tooltip = text
        if not self.registered or self._nid is None:
            return
        try:
            self._nid.uFlags = NIF_TIP
            self._nid.szTip = text[:127]
            shell32.Shell_NotifyIconW(NIM_MODIFY, ctypes.byref(self._nid))
        except Exception:
            pass

    def unregister(self):
        self._stopping = True
        if self._hwnd:
            try:
                user32.PostMessageW(self._hwnd, WM_DESTROY, 0, 0)
            except Exception:
                pass
        self._loop_done.wait(2.0)
        self._cleanup()


if __name__ == "__main__":  # 便于在 Windows 上单独冒烟测试
    import time

    def _open():
        print("[smoke] 打开", flush=True)

    def _quit():
        print("[smoke] 退出", flush=True)

    t = WindowsTray(on_open=_open, on_quit=_quit, app_id="smoke")
    print("注册:", t.register(), "错误:", t.last_error, flush=True)
    time.sleep(20)
    t.unregister()
