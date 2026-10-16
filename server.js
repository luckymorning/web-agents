// 融合远控网关：单进程 HTTP 服务，向上提供一个 Web UI（tab 切换 ZCode / Codex），
// 向下分别桥接 ZCode（官方 relay 页面）与 Codex（app-server JSON-RPC）。
//
// 关键设计：
//   - 浏览器无法给 WebSocket 设置 Authorization 头，且 Codex app-server 的 ws 鉴权只认
//     Authorization，所以不能让浏览器直连 app-server，必须由本服务做翻译层。
//   - 事件用 SSE 单向推送（通知 / 审批请求 / 驱动状态），命令走 REST。
//   - 默认监听 0.0.0.0（允许局域网访问）。因为这个服务等价于本机 shell 权限，
//     非回环监听时**强制要求访问令牌**：缺失就自动生成并持久化，绝不裸奔。

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import { networkInterfaces } from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';

import { CodexBridge } from './lib/codex-bridge.js';
import { ZcodeBridge } from './lib/zcode-bridge.js';
import { buildZcodeRemoteUrl, readZcodePairing } from './lib/zcode-creds.js';
import { probeHeldLocks } from './lib/writer-locks.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');

const argv = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

// 控制台（console/console.py）写入的配置文件；命令行参数优先级最高，
// 这样既能被控制台管理，也保留了手工用命令行覆盖的能力。
function readConsoleConfig() {
  try {
    const p = join(__dirname, 'console-config.json');
    if (!existsSync(p)) return {};
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}
const CONSOLE_CFG = readConsoleConfig();

const PORT = Number(argValue('--port', process.env.PORT || CONSOLE_CFG.port || 8790));
// 默认监听所有网卡，让手机/平板等同网设备可以直接访问
const HOST = argValue('--host', process.env.HOST || CONSOLE_CFG.host || '0.0.0.0');
let TOKEN = argValue('--token', process.env.REMOTE_HUB_TOKEN || CONSOLE_CFG.token || '');
if (!process.env.CODEX_BIN && CONSOLE_CFG.codexBin) process.env.CODEX_BIN = CONSOLE_CFG.codexBin;

/** 判断监听地址是否只对本机可见。 */
function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

const EXPOSED = !isLoopbackHost(HOST);

/**
 * 非回环监听时必须有令牌 —— 这个服务等价于本机 shell 权限，
 * 同一局域网内任何设备只要能访问端口就能执行任意命令。
 *
 * 这里自动生成一个强随机令牌并**持久化**到 console-config.json：
 *   - 持久化是为了重启后令牌不变（否则已保存的链接、手机上的书签都会失效）；
 *   - 写入前先读一次当前文件做合并，避免覆盖控制台刚写入的其它字段。
 */
let TOKEN_GENERATED = false;
if (EXPOSED && !TOKEN) {
  TOKEN = randomBytes(24).toString('base64url');
  TOKEN_GENERATED = true;
  try {
    const cfgPath = join(__dirname, 'console-config.json');
    const current = readConsoleConfig();
    const merged = { ...current, host: HOST, port: PORT, token: TOKEN };
    writeFileSync(cfgPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  } catch (err) {
    // 注意：此处 log() 尚未定义（它在下方才声明），所以直接用 console
    console.warn(`[warn] 令牌未能写入配置文件（重启后会变化）：${err.message}`);
  }
}

/**
 * 读取网卡标志（仅 Linux 可用）以区分「真实网卡」与「VPN/隧道」。
 *
 * 机器上常有 tun0、Meta、etrust 这类点对点接口，它们同样是"非内部"地址，
 * 但同网段的手机根本连不上。区分依据是内核标志：
 *   IFF_BROADCAST (0x2)   → 真实以太网/Wi-Fi 网卡（能承载局域网广播）
 *   IFF_POINTOPOINT (0x10) → 隧道/VPN
 * Node 的 networkInterfaces() 不暴露这些标志，所以直接读 /sys。
 */
const IFF_BROADCAST = 0x2;
const IFF_POINTOPOINT = 0x10;
const IFF_LOOPBACK = 0x8;

function readInterfaceFlags(name) {
  try {
    const raw = readFileSync(`/sys/class/net/${name}/flags`, 'utf8').trim();
    return Number.parseInt(raw, 16);
  } catch {
    return null; // 非 Linux 或权限不足
  }
}

/**
 * 列出可供局域网访问的 IPv4 地址，**真实网卡优先**。
 * 排序权重越小越靠前；同权重时按接口名。
 */
function lanAddresses() {
  const out = [];
  try {
    for (const [name, addrs] of Object.entries(networkInterfaces() || {})) {
      const flags = readInterfaceFlags(name);
      let kind;
      if (flags === null) {
        kind = 'unknown'; // 拿不到标志（如 Windows），退回地址启发式
      } else if (flags & IFF_LOOPBACK) {
        kind = 'loopback';
      } else if (flags & IFF_POINTOPOINT) {
        kind = 'tunnel'; // VPN / 隧道：同网段设备通常连不上
      } else if (flags & IFF_BROADCAST) {
        kind = 'lan'; // 真实网卡
      } else {
        kind = 'unknown';
      }

      for (const a of addrs || []) {
        // 跳过内部地址与 IPv6（手机通常更容易连 IPv4）
        if (a.family !== 'IPv4' || a.internal) continue;
        out.push({ name, address: a.address, kind, rank: rankLanCandidate(kind, a.address) });
      }
    }
  } catch {
    /* 取不到就返回空，不影响启动 */
  }
  out.sort(
    (x, y) => x.rank - y.rank || x.kind.localeCompare(y.kind) || x.name.localeCompare(y.name),
  );
  return out;
}

/**
 * 排序权重（越小越靠前）。
 * 有内核标志时以标志为准；拿不到标志（Windows 等）则按地址段推测。
 */
function rankLanCandidate(kind, address) {
  if (kind === 'loopback') return 99;

  const p = address.split('.').map(Number);
  const bad = p.length !== 4 || p.some((n) => Number.isNaN(n));
  const [a, b] = bad ? [0, 0] : p;
  // RFC 2544 基准测试段，Clash 等代理软件常用（198.18.0.0/15）
  const isBenchmarkRange = a === 198 && (b === 18 || b === 19);
  // 链路本地，通常是没拿到 DHCP
  const isLinkLocal = a === 169 && b === 254;

  if (kind === 'tunnel') return isLinkLocal ? 90 : 50;
  if (isLinkLocal) return 90;

  if (kind === 'lan') {
    return isBenchmarkRange ? 40 : 0;
  }
  // unknown：只靠地址段推测
  if (isBenchmarkRange) return 45;
  if (a === 192 && b === 168) return 10;
  if (a === 10) return 11;
  if (a === 172 && b >= 16 && b <= 31) return 12;
  return 30;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---------------------------------------------------------------- 事件总线

const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

const log = (...args) => {
  const line = args.join(' ');
  process.stdout.write(`[hub] ${line}\n`);
};

// ---------------------------------------------------------------- 桥接实例

const codex = new CodexBridge({
  log: (...a) => log('[codex]', ...a),
  emit: (evt) => {
    if (evt.kind === 'notification') {
      broadcast('codex-notification', { child: evt.child, method: evt.method, params: evt.params });
      return;
    }
    if (evt.kind === 'request') {
      // 服务端发起、需用户应答的请求（命令审批、提问等）
      broadcast('codex-request', {
        id: evt.id,
        method: evt.method,
        params: evt.params,
        receivedAt: Date.now(),
      });
      return;
    }
    if (evt.kind === 'driver') {
      broadcast('codex-driver', evt);
      return;
    }
    if (evt.kind === 'log') {
      broadcast('log', { source: 'codex', level: evt.level || 'info', message: evt.message });
    }
  },
});

const zcode = new ZcodeBridge({
  log: (...a) => log('[zcode]', ...a),
  emit: (evt) => broadcast('zcode-event', evt),
});

// ---------------------------------------------------------------- HTTP 工具

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

const AUTH_COOKIE = 'remote_hub_token';

function tokenMatches(candidate) {
  if (!TOKEN) return true;
  if (!candidate) return false;
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/**
 * 鉴权来源按优先级：Authorization 头 → ?token= → Cookie。
 *
 * 为什么需要 Cookie：页面里的 /styles.css、/app.js、/markdown.js 是相对路径引用，
 * 浏览器请求它们时不会带上原始 URL 里的 ?token=，若只认 query 就会全部 401，
 * 表现为「HTML 打开了但样式和脚本加载失败」。所以首次用 query 验证通过后
 * 种一个 Cookie，后续同源请求自动携带。
 */
function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  const query = new URL(req.url, 'http://x').searchParams.get('token') || '';
  if (query) return query;
  return parseCookies(req)[AUTH_COOKIE] || '';
}

function authorized(req) {
  return tokenMatches(extractToken(req));
}

/** 构造种 Cookie 的头；仅在「已启用令牌」且从 query 验证成功时使用。 */
function authCookieHeader(req) {
  if (!TOKEN) return null; // 未启用令牌，无需 Cookie
  const query = new URL(req.url, 'http://x').searchParams.get('token') || '';
  if (!query || !tokenMatches(query)) return null;
  const secure = req.socket && req.socket.encrypted ? '; Secure' : '';
  // HttpOnly：前端不需要读它；SameSite=Lax：允许同源导航携带
  return `${AUTH_COOKIE}=${encodeURIComponent(TOKEN)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure}`;
}

/** 未授权时的提示页：给出可输入令牌的表单，而不是一行纯文本。 */
function sendUnauthorized(res, req) {
  const isApi = req.url.startsWith('/api/');
  if (isApi) {
    return sendJson(res, 401, { ok: false, error: 'unauthorized' });
  }
  const body = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>需要访问令牌 · 远程控制网关</title>
<style>
 :root{color-scheme:dark}
 body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
   background:#0f1115;color:#e6e9ef;font:14px/1.6 -apple-system,BlinkMacSystemFont,
   "Segoe UI","Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif}
 .card{width:min(420px,90vw);background:#1b2029;border:1px solid #262c37;
   border-radius:12px;padding:22px}
 h1{margin:0 0 6px;font-size:16px}
 p{margin:0 0 14px;color:#98a1b3;font-size:12.5px}
 label{display:block;font-size:12px;color:#98a1b3;margin-bottom:6px}
 input{width:100%;box-sizing:border-box;padding:9px 11px;border-radius:8px;
   border:1px solid #262c37;background:#161a21;color:#e6e9ef;font:inherit}
 input:focus{outline:none;border-color:#4c8dff}
 button{margin-top:12px;width:100%;padding:10px;border:0;border-radius:8px;
   background:#4c8dff;color:#fff;font:inherit;cursor:pointer}
 code{background:#161a21;border:1px solid #262c37;border-radius:4px;padding:1px 5px;font-size:12px}
</style></head>
<body><div class="card">
  <h1>需要访问令牌</h1>
  <p>本服务已启用访问令牌。请粘贴令牌后进入，验证成功后会写入 Cookie，
     后续访问无需再输入。</p>
  <form method="GET" action="/">
    <label for="t">访问令牌</label>
    <input id="t" name="token" type="password" autocomplete="current-password"
           placeholder="粘贴令牌" autofocus required/>
    <button type="submit">进入</button>
  </form>
  <p style="margin:14px 0 0">也可以在地址栏手动附加 <code>?token=你的令牌</code>。</p>
</div></body></html>`;
  res.writeHead(401, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`invalid JSON: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}


// ---------------------------------------------------------------- 路由

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method || 'GET';

  // --- 健康与总览
  if (pathname === '/api/health' && method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      now: Date.now(),
      codex: {
        available: codex.available,
        bin: codex.bin,
        initialized: codex.initialized,
        version: codex.version,
      },
      zcode: readZcodePairing().ready ? 'ready' : 'not-paired',
    });
  }

  // --- ZCode
  if (pathname === '/api/zcode/status' && method === 'GET') {
    return sendJson(res, 200, await zcode.status());
  }
  if (pathname === '/api/zcode/remote-url' && method === 'GET') {
    const built = buildZcodeRemoteUrl();
    if (!built.ready) {
      return sendJson(res, 409, { ok: false, ...(await zcode.status()) });
    }
    return sendJson(res, 200, {
      ok: true,
      url: built.url,
      deviceSidSuffix: built.pairing.deviceSid.slice(-6),
    });
  }
  if (pathname === '/api/zcode/wait-pairing' && method === 'POST') {
    const body = await readBody(req);
    const r = await zcode.waitForPairing({ timeoutMs: body.timeoutMs || 90000 });
    if (!r.ok) {
      return sendJson(res, 408, { ok: false, ...(await zcode.status()), reason: r.reason });
    }
    const built = buildZcodeRemoteUrl();
    return sendJson(res, 200, { ok: true, url: built.url, relayState: r.relay.state });
  }
  if (pathname === '/api/zcode/launch-desktop' && method === 'POST') {
    return sendJson(res, 200, await zcode.launchDesktop());
  }

  // --- Codex：只读查询
  if (pathname === '/api/codex/threads' && method === 'GET') {
    const limit = Math.min(Number(url.searchParams.get('limit') || 30), 100);
    const cursor = url.searchParams.get('cursor') || null;
    const cwd = url.searchParams.get('cwd') || null;
    const archived = url.searchParams.get('archived') === 'true';
    const r = await codex.listThreads({ limit, cursor, cwd, archived });

    // 标记被其它进程独占的会话。
    // Codex 是单写入者模型：被桌面端加载过的会话会一直持有文件锁，网关既不能接管、
    // 也收不到它的审批请求（实测确认）。这里探测出来让用户一眼看到"要去桌面处理"，
    // 而不是点了发送才失败。审批请求本身无法从外部读取，所以只能提示"被占用"。
    const held = await probeHeldLocks((r.data || []).map((t) => t.id));
    const driverId = codex.driverInfo.threadId;
    const data = (r.data || []).map((t) => {
      const heldByMine = t.id === driverId; // 本网关自己持有的不算冲突
      return {
        ...t,
        busy: Boolean(t.status?.type === 'active'),
        locked: held.has(t.id) && !heldByMine,
        lockedByUs: heldByMine,
      };
    });

    return sendJson(res, 200, { ok: true, ...r, data });
  }

  // --- Codex：归档 / 恢复 / 永久删除
  if (pathname === '/api/codex/archive' && method === 'POST') {
    const body = await readBody(req);
    if (!body.threadId) return sendJson(res, 400, { ok: false, error: 'threadId required' });
    const r = await codex.archiveThread(body.threadId);
    return sendJson(res, 200, { ok: true, ...r });
  }

  if (pathname === '/api/codex/unarchive' && method === 'POST') {
    const body = await readBody(req);
    if (!body.threadId) return sendJson(res, 400, { ok: false, error: 'threadId required' });
    const r = await codex.unarchiveThread(body.threadId);
    return sendJson(res, 200, { ok: true, ...r });
  }

  if (pathname === '/api/codex/delete' && method === 'POST') {
    const body = await readBody(req);
    if (!body.threadId) return sendJson(res, 400, { ok: false, error: 'threadId required' });
    if (body.confirm !== true) {
      // 永久删除不可恢复，要求调用方显式确认，避免误触发。
      return sendJson(res, 400, { ok: false, error: 'permanent delete requires confirm:true' });
    }
    const r = await codex.deleteThread(body.threadId);
    return sendJson(res, 200, { ok: true, ...r });
  }

  if (pathname === '/api/codex/thread' && method === 'GET') {
    const threadId = url.searchParams.get('threadId');
    if (!threadId) return sendJson(res, 400, { ok: false, error: 'threadId required' });
    const r = await codex.readThread(threadId, 'thread/read', {}, { timeoutMs: 30000 });
    const loaded = await codex
      .query('thread/loaded/list', {}, { timeoutMs: 15000 })
      .catch(() => ({ data: [] }));
    const held = await probeHeldLocks([threadId]);
    return sendJson(res, 200, {
      ok: true,
      ...r,
      loadedHere: (loaded.data || []).includes(threadId),
      locked: held.has(threadId) && codex.driverInfo.threadId !== threadId,
      lockedByUs: codex.driverInfo.threadId === threadId,
      driver: codex.driverInfo,
    });
  }

  if (pathname === '/api/codex/items' && method === 'GET') {
    const threadId = url.searchParams.get('threadId');
    const limit = Math.min(Number(url.searchParams.get('limit') || 60), 200);
    const cursor = url.searchParams.get('cursor') || null;
    if (!threadId) return sendJson(res, 400, { ok: false, error: 'threadId required' });
    const params = { limit };
    if (cursor) params.cursor = cursor;
    const r = await codex.readThread(threadId, 'thread/items/list', params, { timeoutMs: 30000 });
    return sendJson(res, 200, { ok: true, ...r });
  }

  if (pathname === '/api/codex/turns' && method === 'GET') {
    const threadId = url.searchParams.get('threadId');
    const limit = Math.min(Number(url.searchParams.get('limit') || 20), 100);
    if (!threadId) return sendJson(res, 400, { ok: false, error: 'threadId required' });
    const r = await codex.readThread(threadId, 'thread/turns/list', { limit }, { timeoutMs: 30000 });
    return sendJson(res, 200, { ok: true, ...r });
  }

  if (pathname === '/api/codex/models' && method === 'GET') {
    const r = await codex.query('model/list', {}, { timeoutMs: 30000 });
    return sendJson(res, 200, { ok: true, ...r });
  }

  if (pathname === '/api/codex/projects' && method === 'GET') {
    const projects = await codex.listProjects();
    return sendJson(res, 200, { ok: true, projects });
  }

  // --- Codex：驱动
  if (pathname === '/api/codex/open' && method === 'POST') {
    const body = await readBody(req);
    if (!body.threadId) return sendJson(res, 400, { ok: false, error: 'threadId required' });
    const r = await codex.openDriver(body.threadId, { model: body.model || null });
    return sendJson(res, 200, { ok: r.mode === 'driver', ...r });
  }

  if (pathname === '/api/codex/close' && method === 'POST') {
    codex.closeDriver('user-request');
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/codex/send' && method === 'POST') {
    const body = await readBody(req);
    const { threadId, text, kind = 'text' } = body;
    if (!threadId || typeof text !== 'string') {
      return sendJson(res, 400, { ok: false, error: 'threadId and text are required' });
    }
    if (codex.driverThreadId !== threadId || !codex.driver?.alive) {
      const opened = await codex.openDriver(threadId, { model: body.model || null });
      if (opened.mode !== 'driver') {
        return sendJson(res, 409, { ok: false, ...opened });
      }
    }
    const input = [{ type: kind, text }];
    const activeTurn = codex.activeTurns.get(threadId);
    if (activeTurn) {
      // 正在跑：用 steer 把新内容插进当前 turn，而不是再开一个。
      const r = await codex.driver.call(
        'turn/steer',
        { threadId, expectedTurnId: activeTurn, input },
        { timeoutMs: 45000 },
      );
      return sendJson(res, 200, { ok: true, steered: true, turnId: activeTurn, ...r });
    }
    const params = { threadId, input };
    if (body.model) params.model = body.model;
    if (body.effort) params.effort = body.effort;
    const r = await codex.driver.call('turn/start', params, { timeoutMs: 60000 });
    if (r?.turn?.id) codex.activeTurns.set(threadId, r.turn.id);
    return sendJson(res, 200, { ok: true, steered: false, ...r });
  }

  if (pathname === '/api/codex/interrupt' && method === 'POST') {
    const body = await readBody(req);
    const threadId = body.threadId;
    const turnId = body.turnId || codex.activeTurns.get(threadId);
    if (!threadId || !turnId) {
      return sendJson(res, 400, { ok: false, error: 'threadId and an active turnId are required' });
    }
    const r = await codex.driver.call('turn/interrupt', { threadId, turnId }, { timeoutMs: 30000 });
    return sendJson(res, 200, { ok: true, ...r });
  }

  if (pathname === '/api/codex/new-thread' && method === 'POST') {
    const body = await readBody(req);
    // 必须在 driver 进程里创建：在 reader 里 start 会让 reader 成为写入者，
    // 之后 driver 再也拿不到这个线程（单写入者约束）。
    const r = await codex.startThread({
      cwd: body.cwd || null,
      model: body.model || null,
      approvalPolicy: body.approvalPolicy || 'on-request',
      sandbox: body.sandbox || 'workspace-write',
      ephemeral: Boolean(body.ephemeral),
      projectId: body.projectId || null,
    });
    return sendJson(res, 200, { ok: true, driver: codex.driverInfo, ...r });
  }

  if (pathname === '/api/codex/respond' && method === 'POST') {
    const body = await readBody(req);
    if (body.id === undefined) return sendJson(res, 400, { ok: false, error: 'id required' });
    const ok = codex.respondToServer(body.id, body.result ?? {});
    return sendJson(res, ok ? 200 : 410, { ok });
  }

  return sendJson(res, 404, { ok: false, error: `no route: ${method} ${pathname}` });
}

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = join(PUBLIC_DIR, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('not found');
  }
  const body = await readFile(filePath);
  res.writeHead(200, {
    'content-type': MIME[extname(filePath)] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/events') {
    if (!authorized(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ now: Date.now() })}\n\n`);
    sseClients.add(res);
    // 立即补推一份当前状态。否则新连上的页面要等到"下一次状态变化"才有数据，
    // 而状态没变时可能长时间没有推送。
    pushZcodeStatusTo(res).catch(() => {});
    const keep = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* ignore */
      }
    }, 20000);
    keep.unref?.();
    req.on('close', () => {
      clearInterval(keep);
      sseClients.delete(res);
    });
    return undefined;
  }

  // 若本次请求是通过 ?token= 验证的，顺手种下 Cookie，
  // 让后续的静态资源与 API 请求（浏览器不会带上原 query）也能通过鉴权。
  const cookie = authCookieHeader(req);
  if (cookie) res.setHeader('Set-Cookie', cookie);

  if (url.pathname.startsWith('/api/')) {
    if (!authorized(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    try {
      return await handleApi(req, res, url);
    } catch (err) {
      log('api error:', err?.message || String(err));
      return sendJson(res, 500, {
        ok: false,
        error: err?.message || String(err),
        reasonCode: err?.reasonCode || err?.code || null,
      });
    }
  }

  if (!authorized(req)) {
    return sendUnauthorized(res, req);
  }
  return serveStatic(req, res, url);
});

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}`);
  log(codex.available ? `codex: ${codex.bin}` : 'codex: 未找到可执行文件（Codex tab 将不可用）');
  log(readZcodePairing().ready ? 'zcode: 凭据已就绪' : 'zcode: 尚未配对（需在桌面端点开开启远控）');

  if (EXPOSED) {
    if (TOKEN_GENERATED) {
      log('⚠️  已启用局域网访问，并自动生成访问令牌（已保存到 console-config.json）');
    } else {
      log('⚠️  已启用局域网访问（需要访问令牌）');
    }
    // 把可直接使用的地址打出来，省去用户自己查 IP。
    // 标注接口类型：真实网卡标「局域网」，VPN/隧道标出来以免用户误用。
    const shownToken = TOKEN ? `?token=${TOKEN}` : '';
    const addrs = lanAddresses();
    const realLan = addrs.filter((a) => a.kind === 'lan');
    for (const { name, address, kind } of addrs) {
      const isFirstLan = kind === 'lan' && realLan[0] && realLan[0].address === address;
      const tag = kind === 'lan' ? (isFirstLan ? '局域网' : '局域网') : '虚拟网卡';
      const star = isFirstLan && addrs.length > 1 ? ' ←手机/平板用这个' : '';
      log(`    ${tag}: http://${address}:${PORT}/${shownToken}    (${name})${star}`);
    }
    log(`    本机:   http://127.0.0.1:${PORT}/${shownToken}`);
    log(`    令牌:   ${TOKEN}`);
  } else {
    log(`    本机:   http://127.0.0.1:${PORT}/`);
  }
});

// 预热 reader，让首屏更快，同时验证 codex 可用性。
if (codex.available) {
  codex.ensureReaderReady().catch((err) => log('[codex] warmup failed:', err.message));
}

// ---------------------------------------------------------------- ZCode 状态推送
//
// 桌面端可能被用户随时关闭或启动，客户端不该要求用户手动刷新才能看到变化。
// 这里由服务端定期比对状态，一有变化就通过 SSE 广播给所有已连接的页面。
//
// 为什么放在服务端而不是让浏览器轮询：
//   - 只有一处探测，多个页面共享同一结果；
//   - 页面切到后台（标签页不可见）时浏览器会降低定时器精度，推送不受影响；
//   - 省掉每个页面各自的请求开销。
//
// 没有客户端连接时直接跳过探测，避免无谓的进程调用与文件读取。

let lastZcodeSignature = null;

/**
 * 取一次状态并推给指定响应对象（不传则推给所有已连接客户端）。
 *
 * 新客户端连上时需要立即补推一份（见 /api/events 处理），否则它要等到
 * 「下一次状态变化」才有数据 —— 而状态长期不变时可能一直收不到任何推送。
 *
 * @param {import('node:http').ServerResponse} [only]
 */
async function pushZcodeStatusTo(only) {
  const s = await zcode.status();
  if (only) {
    try {
      only.write(`event: zcode-status\ndata: ${JSON.stringify(s)}\n\n`);
    } catch {
      sseClients.delete(only);
    }
    return s;
  }
  broadcast('zcode-status', s);
  return s;
}

async function pollZcodeStatusOnce() {
  if (!sseClients.size) return;
  try {
    const s = await zcode.status();
    // 只比较影响展示的字段，避免 stateDir 之类固定值干扰判定
    const signature = JSON.stringify([
      s.pairingReady,
      s.desktopRunning,
      s.relayState,
      s.relayReady,
    ]);
    if (signature === lastZcodeSignature) return;
    lastZcodeSignature = signature;
    broadcast('zcode-status', s);
  } catch (err) {
    log('[zcode] status poll failed:', err?.message || String(err));
  }
}

const ZCODE_POLL_INTERVAL_MS = 3000;
const zcodePollTimer = setInterval(pollZcodeStatusOnce, ZCODE_POLL_INTERVAL_MS);
zcodePollTimer.unref?.();

function shutdown() {
  log('shutting down…');
  codex.dispose();
  for (const res of sseClients) {
    try {
      res.end();
    } catch {
      /* ignore */
    }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref?.();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
