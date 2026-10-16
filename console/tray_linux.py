#!/usr/bin/env python3
"""Linux 托盘图标（StatusNotifierItem over D-Bus），纯 Gio/GDBus 实现。

为什么不用现成的库：
  - `gir1.2-ayatanaappindicator3` 未安装且需要管理员密码；
  - `dbusmenu-qt`/`Dbusmenu` 的 GI 绑定确实存在，但它内部用独立的 GDBus 连接导出菜单，
    而同一 bus name 只能被一条连接持有 —— 与 dbus-python 的 StatusNotifierItem 混用会
    直接失败（实测：object_path 断言错误）。混用两套 D-Bus 栈不可行。

因此这里统一走 Gio/GDBus，并自己实现最小可用的 com.canonical.dbusmenu 协议，
使图标与菜单落在同一条连接、同一个 bus name 下。菜单只需「打开 / 退出」两项，
协议实现量很小。
"""

from __future__ import annotations

import io

import gi

gi.require_version("Gio", "2.0")
gi.require_version("GLib", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

SNI_XML = """
<node>
  <interface name="org.kde.StatusNotifierItem">
    <method name="Activate">
      <arg name="x" type="i" direction="in"/>
      <arg name="y" type="i" direction="in"/>
      <arg name="result" type="b" direction="out"/>
    </method>
    <method name="SecondaryActivate">
      <arg name="x" type="i" direction="in"/>
      <arg name="y" type="i" direction="in"/>
    </method>
    <method name="ContextMenu">
      <arg name="x" type="i" direction="in"/>
      <arg name="y" type="i" direction="in"/>
    </method>
    <method name="Scroll">
      <arg name="delta" type="i" direction="in"/>
      <arg name="orientation" type="s" direction="in"/>
    </method>
    <signal name="NewIcon"/>
    <signal name="NewStatus"><arg name="status" type="s"/></signal>
    <signal name="NewToolTip"/>
    <signal name="NewTitle"/>
    <property name="Category" type="s" access="read"/>
    <property name="Id" type="s" access="read"/>
    <property name="Title" type="s" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="IconName" type="s" access="read"/>
    <property name="IconPixmap" type="a(iiay)" access="read"/>
    <property name="OverlayIconName" type="s" access="read"/>
    <property name="OverlayIconPixmap" type="a(iiay)" access="read"/>
    <property name="AttentionIconName" type="s" access="read"/>
    <property name="AttentionIconPixmap" type="a(iiay)" access="read"/>
    <property name="AttentionMovieName" type="s" access="read"/>
    <property name="ToolTip" type="(sa(iiay)ss)" access="read"/>
    <property name="ItemIsMenu" type="b" access="read"/>
    <property name="Menu" type="o" access="read"/>
  </interface>
  <interface name="com.canonical.dbusmenu">
    <method name="GetLayout">
      <arg name="parentId" type="i" direction="in"/>
      <arg name="recursionDepth" type="i" direction="in"/>
      <arg name="propertyNames" type="as" direction="in"/>
      <arg name="revision" type="u" direction="out"/>
      <arg name="layout" type="(ia{sv}av)" direction="out"/>
    </method>
    <method name="GetGroupProperties">
      <arg name="ids" type="ai" direction="in"/>
      <arg name="propertyNames" type="as" direction="in"/>
      <arg name="properties" type="a(ia{sv})" direction="out"/>
    </method>
    <method name="GetProperty">
      <arg name="id" type="i" direction="in"/>
      <arg name="name" type="s" direction="in"/>
      <arg name="value" type="v" direction="out"/>
    </method>
    <method name="Event">
      <arg name="id" type="i" direction="in"/>
      <arg name="eventId" type="s" direction="in"/>
      <arg name="data" type="v" direction="in"/>
      <arg name="timestamp" type="u" direction="in"/>
    </method>
    <method name="EventGroup">
      <arg name="events" type="a(isvu)" direction="in"/>
      <arg name="idErrors" type="ai" direction="out"/>
    </method>
    <method name="AboutToShow">
      <arg name="id" type="i" direction="in"/>
      <arg name="needUpdate" type="b" direction="out"/>
    </method>
    <method name="AboutToShowGroup">
      <arg name="ids" type="ai" direction="in"/>
      <arg name="updatesNeeded" type="ai" direction="out"/>
      <arg name="idErrors" type="ai" direction="out"/>
    </method>
    <signal name="ItemsPropertiesUpdated">
      <arg name="updatedProps" type="a(ia{sv})"/>
      <arg name="removedProps" type="a(ias)"/>
    </signal>
    <signal name="LayoutUpdated">
      <arg name="revision" type="u"/>
      <arg name="parent" type="i"/>
    </signal>
    <property name="Version" type="u" access="read"/>
    <property name="TextDirection" type="s" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="IconThemePath" type="as" access="read"/>
  </interface>
</node>
"""

MENU_VERSION = 3
ROOT_ID = 0


def make_icon_pixmap(size: int = 22):
    """用 PIL 画一个简单的圆形图标，返回 StatusNotifierItem 需要的 IconPixmap 结构。

    IconPixmap 是 a(iiay)：每项为 (宽, 高, 字节数组)，字节为 ARGB32、网络字节序。
    直接给像素比依赖图标主题里的名字更可靠（不同发行版主题差异大）。
    """
    try:
        from PIL import Image, ImageDraw
    except Exception:
        return []

    # 多尺寸，让 shell 按 HiDPI 选择
    out = []
    for s in (size, size * 2):
        img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        pad = max(1, s // 10)
        # 外环
        d.ellipse([pad, pad, s - pad - 1, s - pad - 1], fill=(74, 141, 255, 255))
        # 内圈（示意“远程连接”）
        inner = s // 2 - max(2, s // 5)
        d.ellipse([inner, inner, s - inner - 1, s - inner - 1], fill=(15, 17, 21, 255))
        # 中心点
        c = s // 2
        r = max(1, s // 8)
        d.ellipse([c - r, c - r, c + r - 1, c + r - 1], fill=(74, 141, 255, 255))

        data = bytearray()
        for y in range(s):
            for x in range(s):
                rr, gg, bb, aa = img.getpixel((x, y))
                # ARGB32，网络字节序
                data += bytes((aa, rr, gg, bb))
        out.append((s, s, bytes(data)))
    return out


class LinuxTray:
    """把 StatusNotifierItem + dbusmenu 注册到 GNOME 顶栏。

    用法：
        tray = TrayItem(on_open=..., on_quit=..., tooltip="…")
        tray.register()
    """

    def __init__(self, *, on_open, on_quit, app_id="remote-hub", title="远程控制网关",
                 tooltip="远程控制网关（ZCode + Codex）", log=print):
        self.on_open = on_open
        self.on_quit = on_quit
        self.app_id = app_id
        self.title = title
        self.tooltip = tooltip
        self.log = log
        self._menu_revision = 1
        self._items = {
            1: {"label": "打开", "enabled": True, "visible": True},
            2: {"label": "退出", "enabled": True, "visible": True},
        }
        self._conn: Gio.DBusConnection | None = None
        self._reg_ids: list[int] = []
        self._name_id = 0
        self._bus_name = f"org.kde.StatusNotifierItem.{app_id}"
        self._icon_pixmap = make_icon_pixmap()
        self.registered = False
        self.last_error: str | None = None
        # 供平台分发器等待注册结果（与 WindowsTray 保持同一接口）
        import threading as _threading

        self._ready = _threading.Event()

    @staticmethod
    def watcher_available() -> bool:
        """桌面环境是否提供托盘宿主（StatusNotifierWatcher）。"""
        try:
            conn = Gio.bus_get_sync(Gio.BusType.SESSION, None)
            rep = conn.call_sync(
                "org.freedesktop.DBus",
                "/org/freedesktop/DBus",
                "org.freedesktop.DBus",
                "NameHasOwner",
                GLib.Variant("(s)", ("org.kde.StatusNotifierWatcher",)),
                None,
                Gio.DBusCallFlags.NONE,
                3000,
                None,
            )
            return bool(rep.unpack()[0])
        except Exception:
            return False

    # ---------------------------------------------------------------- 属性

    def _sni_props(self):
        tip = (self.tooltip, [], self.title, "")
        return {
            "Category": GLib.Variant("s", "ApplicationStatus"),
            "Id": GLib.Variant("s", self.app_id),
            "Title": GLib.Variant("s", self.title),
            "Status": GLib.Variant("s", "Active"),
            # 同时给 IconName 与 IconPixmap：有的宿主偏好其中一个
            "IconName": GLib.Variant("s", "utilities-terminal"),
            "IconPixmap": GLib.Variant("a(iiay)", self._icon_pixmap),
            "OverlayIconName": GLib.Variant("s", ""),
            "OverlayIconPixmap": GLib.Variant("a(iiay)", []),
            "AttentionIconName": GLib.Variant("s", ""),
            "AttentionIconPixmap": GLib.Variant("a(iiay)", []),
            "AttentionMovieName": GLib.Variant("s", ""),
            "ToolTip": GLib.Variant("(sa(iiay)ss)", tip),
            # False 表示左键点击触发 Activate（而不是直接弹菜单），
            # 这样左键=打开窗口、右键=菜单，符合用户预期。
            "ItemIsMenu": GLib.Variant("b", False),
            "Menu": GLib.Variant("o", "/MenuBar"),
        }

    def _menu_props(self):
        return {
            "Version": GLib.Variant("u", MENU_VERSION),
            "TextDirection": GLib.Variant("s", "ltr"),
            "Status": GLib.Variant("s", "normal"),
            "IconThemePath": GLib.Variant("as", []),
        }

    # ---------------------------------------------------------------- 菜单数据

    def _item_props(self, item_id: int):
        item = self._items.get(item_id)
        if item is None:
            return None
        return {
            "label": GLib.Variant("s", item["label"]),
            "enabled": GLib.Variant("b", item["enabled"]),
            "visible": GLib.Variant("b", item["visible"]),
        }

    def _root_props(self):
        return {
            "children-display": GLib.Variant("s", "submenu"),
            "visible": GLib.Variant("b", True),
        }

    def _layout(self, parent_id: int, depth: int):
        """构造 (ia{sv}av) 形式的菜单布局。

        注意 av 里的每个元素必须是 GLib.Variant（其内部为 (ia{sv}av) 结构），
        直接塞 Python tuple 会被 GI 拒绝（实测报 "Expected GLib.Variant, but got tuple"）。
        """
        if parent_id == ROOT_ID:
            props = self._root_props()
            children = []
            if depth != 0:
                for cid in sorted(self._items):
                    children.append(GLib.Variant("(ia{sv}av)", self._layout(cid, depth - 1)))
            return (ROOT_ID, props, children)
        props = self._item_props(parent_id)
        if props is None:
            return (parent_id, {}, [])
        return (parent_id, props, [])

    # ---------------------------------------------------------------- 事件

    def _activate(self, item_id: int):
        # 菜单项点击：按 id 分派。GDBus 的回调运行在主循环里，
        # 直接调用即可（tkinter 侧的回调会自行用 after 切线程）。
        if item_id == 1:
            self.log("[tray] 菜单：打开")
            self._safe(self.on_open)
        elif item_id == 2:
            self.log("[tray] 菜单：退出")
            self._safe(self.on_quit)

    @staticmethod
    def _safe(fn, *args):
        try:
            fn(*args)
        except Exception as exc:  # 回调里的异常不能影响 D-Bus 服务
            print(f"[tray] 回调异常: {exc}", flush=True)

    # ---------------------------------------------------------------- D-Bus 处理

    def _on_method_call(self, _conn, _sender, _path, _iface, method, params, invocation):
        try:
            if method == "Activate":
                self.log("[tray] 左键点击：打开窗口")
                self._safe(self.on_open)
                invocation.return_value(GLib.Variant("(b)", (True,)))
                return
            if method in ("SecondaryActivate", "Scroll", "ContextMenu"):
                invocation.return_value(None)
                return

            if method == "GetLayout":
                parent_id = params.unpack()[0]
                depth = params.unpack()[1]
                rev, layout = self._menu_revision, self._layout(parent_id, depth)
                invocation.return_value(GLib.Variant("(u(ia{sv}av))", (rev, layout)))
                return
            if method == "GetGroupProperties":
                ids, _names = params.unpack()
                out = []
                for i in (ids or sorted(self._items)):
                    props = self._root_props() if i == ROOT_ID else self._item_props(i)
                    if props is not None:
                        out.append((i, props))
                invocation.return_value(GLib.Variant("(a(ia{sv}))", (out,)))
                return
            if method == "GetProperty":
                item_id, name = params.unpack()
                props = self._root_props() if item_id == ROOT_ID else self._item_props(item_id)
                val = (props or {}).get(name, GLib.Variant("s", ""))
                invocation.return_value(GLib.Variant("(v)", (val,)))
                return
            if method == "Event":
                item_id, event_id, _data, _ts = params.unpack()
                if event_id == "clicked":
                    self._activate(item_id)
                invocation.return_value(None)
                return
            if method == "EventGroup":
                events = params.unpack()[0]
                for item_id, event_id, _data, _ts in events:
                    if event_id == "clicked":
                        self._activate(item_id)
                invocation.return_value(GLib.Variant("(ai)", ([],)))
                return
            if method == "AboutToShow":
                invocation.return_value(GLib.Variant("(b)", (False,)))
                return
            if method == "AboutToShowGroup":
                invocation.return_value(GLib.Variant("(aiai)", ([], [])))
                return

            invocation.return_value(None)
        except Exception as exc:
            self.log(f"[tray] 处理 {method} 出错: {exc}")
            try:
                invocation.return_dbus_error("org.kde.StatusNotifierItem.Error", str(exc))
            except Exception:
                pass

    def _on_get_property(self, _conn, _sender, _path, iface, prop, _invocation=None):
        try:
            if iface == "org.kde.StatusNotifierItem":
                return self._sni_props().get(prop)
            if iface == "com.canonical.dbusmenu":
                return self._menu_props().get(prop)
        except Exception:
            return None
        return None

    # ---------------------------------------------------------------- 注册

    def register(self) -> bool:
        """注册到会话总线与 StatusNotifierWatcher。返回是否成功。

        供平台分发器以「线程 + wait_registered」的方式调用，因此这里
        用 _ready 事件报告完成（成功或失败），不阻塞调用方。
        """
        self.registered = False
        try:
            self._conn = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        except Exception as exc:
            self.log(f"[tray] 无法连接会话总线: {exc}")
            self.last_error = str(exc)
            self._ready.set()
            return False

        node = Gio.DBusNodeInfo.new_for_xml(SNI_XML)

        # 先占有 bus name，再导出对象（顺序无所谓，但 name 必须在 watcher 注册前就位）
        try:
            self._name_id = Gio.bus_own_name_on_connection(
                self._conn, self._bus_name, Gio.BusNameOwnerFlags.NONE, None, None
            )
        except Exception as exc:
            self.log(f"[tray] 占有 bus name 失败: {exc}")
            self.last_error = str(exc)
            self._ready.set()
            return False

        for iface in node.interfaces:
            try:
                rid = self._conn.register_object(
                    "/StatusNotifierItem",
                    iface,
                    self._on_method_call,
                    self._on_get_property,
                    None,
                )
                self._reg_ids.append(rid)
            except Exception as exc:
                self.log(f"[tray] 导出接口 {iface.name} 失败: {exc}")
                self.last_error = str(exc)
                self._ready.set()
                return False

        # 菜单对象路径
        menu_node = Gio.DBusNodeInfo.new_for_xml(SNI_XML)
        for iface in menu_node.interfaces:
            if iface.name != "com.canonical.dbusmenu":
                continue
            try:
                rid = self._conn.register_object(
                    "/MenuBar", iface, self._on_method_call, self._on_get_property, None
                )
                self._reg_ids.append(rid)
            except Exception as exc:
                self.log(f"[tray] 导出菜单失败: {exc}")
                self.last_error = str(exc)
                self._ready.set()
                return False

        # 注册到宿主。
        # 注意：watcher 由桌面环境（GNOME 上是 ubuntu-appindicators 扩展）提供。
        # 若该扩展未启用/未加载，watcher 名字不在总线上，这里会报 ServiceUnknown。
        # 这不是本程序的错误，但必须向上报告，以便界面给出提示而不是静默失败。
        try:
            self._conn.call_sync(
                "org.kde.StatusNotifierWatcher",
                "/StatusNotifierWatcher",
                "org.kde.StatusNotifierWatcher",
                "RegisterStatusNotifierItem",
                GLib.Variant("(s)", (self._bus_name,)),
                None,
                Gio.DBusCallFlags.NONE,
                5000,
                None,
            )
            self.log(f"[tray] 已注册到顶栏（{self._bus_name}）")
            self.registered = True
            self._ready.set()
            return True
        except Exception as exc:
            msg = str(exc)
            if "ServiceUnknown" in msg or "was not provided" in msg:
                self.log(
                    "[tray] 桌面环境没有提供 StatusNotifierWatcher（托盘宿主）。"
                    "在 GNOME 上通常是 ubuntu-appindicators 扩展未启用；"
                    "启用后重新打开本控制台即可。"
                )
                self.last_error = "no-watcher"
            else:
                self.log(f"[tray] 注册到 StatusNotifierWatcher 失败: {msg}")
                self.last_error = msg
            self.registered = False
            self._ready.set()
            return False

    def wait_registered(self, timeout: float = 8.0) -> bool:
        """等待注册完成（与 WindowsTray 接口一致）。"""
        self._ready.wait(timeout)
        return self.registered

    def set_tooltip(self, text: str):
        """更新悬浮提示（暂停/运行状态变化时调用）。"""
        self.tooltip = text
        if self._conn:
            try:
                self._conn.emit_signal(
                    None, "/StatusNotifierItem", "org.kde.StatusNotifierItem", "NewToolTip", None
                )
            except Exception:
                pass

    def unregister(self):
        if self._conn:
            for rid in self._reg_ids:
                try:
                    self._conn.unregister_object(rid)
                except Exception:
                    pass
            self._reg_ids.clear()
            if self._name_id:
                try:
                    Gio.bus_unown_name(self._name_id)
                except Exception:
                    pass
                self._name_id = 0
