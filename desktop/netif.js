// 网卡枚举（跨平台），供控制台的「监听地址」下拉使用。
//
// 为什么要区分「真实网卡」与「VPN/隧道」：后者（tun0、Meta、Clash 等）也有非内部
// IPv4 地址，但同网段的手机通常连不上。混在一起会让用户选错。
//
// 判定依据与 server.mjs 一致：Linux 读 /sys/class/net/<if>/flags 的内核标志
//   IFF_BROADCAST (0x2)    → 真实网卡（能承载局域网广播）
//   IFF_POINTOPOINT (0x10) → 隧道 / VPN
// Windows/macOS 拿不到这些标志，退回「按接口名与地址段推测」。

const { networkInterfaces } = require('node:os');
const { readFileSync } = require('node:fs');

const IFF_BROADCAST = 0x2;
const IFF_LOOPBACK = 0x8;
const IFF_POINTOPOINT = 0x10;

const IS_WINDOWS = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';

/** 隧道/VPN 常见接口名前缀（Windows 与 macOS 上没有内核标志可用） */
const TUNNEL_HINTS = /^(tun|tap|utun|wg|ppp|ipsec|nordlynx|zt|tailscale|Meta|etrust|clash|singbox)/i;
/** 虚拟网卡常见厂商关键词 */
const VIRTUAL_HINTS = /(virtual|vmware|virtualbox|hyper-v|loopback|vethernet|docker|br-|veth|vEthernet)/i;

function readFlags(name) {
  if (!IS_LINUX) return null;
  try {
    return Number.parseInt(readFileSync(`/sys/class/net/${name}/flags`, 'utf8').trim(), 16);
  } catch {
    return null;
  }
}

function classify(name, address) {
  const flags = readFlags(name);
  if (flags !== null) {
    if (flags & IFF_LOOPBACK) return 'loopback';
    if (flags & IFF_POINTOPOINT) return 'tunnel';
    if (flags & IFF_BROADCAST) return 'lan';
    return 'other';
  }
  // 无内核标志：靠名字与地址段推测
  if (TUNNEL_HINTS.test(name)) return 'tunnel';
  if (VIRTUAL_HINTS.test(name)) return 'virtual';

  const p = address.split('.').map(Number);
  const [a, b] = p.length === 4 ? p : [0, 0];
  // RFC 2544 基准测试段，Clash 等代理软件常用
  if (a === 198 && (b === 18 || b === 19)) return 'tunnel';
  if (a === 169 && b === 254) return 'other'; // 链路本地，通常是没拿到 DHCP
  if ((a === 192 && b === 168) || a === 10 || (a === 172 && b >= 16 && b <= 31)) return 'lan';
  return 'other';
}

const RANK = { lan: 0, other: 20, virtual: 30, tunnel: 50, loopback: 99 };

/**
 * 列出可用于局域网访问的 IPv4 地址。
 * @returns {Array<{name:string,address:string,kind:string}>} 已按可用性排序
 */
function listIPv4Addresses() {
  const out = [];
  let ifaces = {};
  try {
    ifaces = networkInterfaces() || {};
  } catch {
    return out;
  }

  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      // Node 18+ 的 family 可能是数字 4 或字符串 'IPv4'
      const isV4 = a.family === 'IPv4' || a.family === 4;
      if (!isV4 || a.internal) continue;
      const kind = classify(name, a.address);
      if (kind === 'loopback') continue;
      out.push({ name, address: a.address, kind });
    }
  }

  out.sort(
    (x, y) =>
      (RANK[x.kind] ?? 40) - (RANK[y.kind] ?? 40) ||
      x.name.localeCompare(y.name) ||
      x.address.localeCompare(y.address),
  );
  return out;
}

/** 下拉用的中文标签；VPN/隧道会额外标注，避免用户误选。 */
const KIND_LABEL = {
  lan: '局域网',
  tunnel: 'VPN/隧道',
  virtual: '虚拟网卡',
  other: '其他',
};

function describe(item) {
  return `${item.address}  (${item.name})  [${KIND_LABEL[item.kind] || item.kind}]`;
}

module.exports = { listIPv4Addresses, describe, KIND_LABEL };
