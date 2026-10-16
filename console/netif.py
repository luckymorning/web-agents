"""枚举本机可用于监听的 IPv4 地址（网卡列表）。

控制台的「监听地址」下拉框需要展示所有网卡，并区分真实网卡与 VPN/隧道：
后者虽然也有非内部 IPv4 地址，但同网段的手机通常连不上，混在一起会误导用户。

判定方式与 server.js 保持一致：Linux 上读 /sys/class/net/<if>/flags，
    IFF_BROADCAST(0x2)    → 真实网卡（能承载局域网广播）
    IFF_POINTOPOINT(0x10) → 隧道 / VPN
其它平台退回 socket.getaddrinfo（拿不到类型信息，统一按局域网处理）。
"""

from __future__ import annotations

import socket
import subprocess

IFF_BROADCAST = 0x2
IFF_LOOPBACK = 0x8
IFF_POINTOPOINT = 0x10

KIND_LAN = "lan"
KIND_TUNNEL = "tunnel"
KIND_LOOPBACK = "loopback"
KIND_OTHER = "other"

# 排序权重：真实网卡在前，隧道/虚拟网卡靠后
_RANK = {KIND_LAN: 0, KIND_OTHER: 30, KIND_TUNNEL: 50, KIND_LOOPBACK: 99}


def _read_flags(name: str):
    """读取网卡标志（仅 Linux）。拿不到返回 None。"""
    try:
        with open(f"/sys/class/net/{name}/flags", "r", encoding="ascii") as fh:
            return int(fh.read().strip(), 16)
    except Exception:
        return None


def _kind_from_flags(flags):
    """由内核标志推断网卡类型；flags 为 None 时返回 None。"""
    if flags is None:
        return None
    if flags & IFF_LOOPBACK:
        return KIND_LOOPBACK
    if flags & IFF_POINTOPOINT:
        return KIND_TUNNEL
    if flags & IFF_BROADCAST:
        return KIND_LAN
    return KIND_OTHER


def _linux_addresses():
    """用 ip(8) 枚举 IPv4 地址；ip 不可用或无结果时返回 None。"""
    try:
        out = subprocess.run(
            ["ip", "-o", "-4", "addr", "show"],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except Exception:
        return None
    if out.returncode != 0 or not out.stdout.strip():
        return None

    found = []
    for line in out.stdout.splitlines():
        parts = line.split()
        if len(parts) < 4:
            continue
        name = parts[1].rstrip(":")
        try:
            idx = parts.index("inet")
        except ValueError:
            continue
        address = parts[idx + 1].split("/")[0]

        # scope host 就是回环，下拉框里已有固定项，跳过避免重复
        if "scope" in parts and parts[parts.index("scope") + 1] == "host":
            continue

        kind = _kind_from_flags(_read_flags(name)) or KIND_OTHER
        if kind == KIND_LOOPBACK:
            continue
        found.append({"name": name, "address": address, "kind": kind})

    return found or None


def _fallback_addresses():
    """非 Linux 或 ip 不可用时的退路：解析主机名 + 探测对外出口地址。

    这种途径拿不到网卡名与类型，统一按局域网处理（只用于列表展示）。
    """
    addresses = set()

    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            addr = info[4][0]
            if addr and not addr.startswith("127."):
                addresses.add(addr)
    except Exception:
        pass

    # 某些机器上 getaddrinfo 只返回回环，这里用 UDP「连接」探测默认出口地址
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.connect(("8.8.8.8", 80))
            addr = sock.getsockname()[0]
            if addr and not addr.startswith("127."):
                addresses.add(addr)
        finally:
            sock.close()
    except Exception:
        pass

    return [{"name": "本机网卡", "address": a, "kind": KIND_LAN} for a in sorted(addresses)]


def list_ipv4_addresses():
    """返回 [{'name','address','kind'}]，按「真实网卡优先」排好序。"""
    items = _linux_addresses()
    if not items:
        items = _fallback_addresses()
    items.sort(key=lambda x: (_RANK.get(x["kind"], 40), x["name"], x["address"]))
    return items
