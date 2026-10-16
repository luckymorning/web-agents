// 读取本机 ZCode 桌面客户端的远控配对凭据，并构造官方 Web 远控页面地址。
//
// 原理（来自对 ZCode 客户端 app.asar 的逆向）：
//   - 桌面端作为 relay 的 “device” 角色。注册后把凭据持久化在本地：
//       deviceSid -> ~/.zcode/v2/setting.json
//                    .webRemoteControlExternalRelayDevice.deviceSid
//       passHash  -> ~/.zcode/v2/credentials.json 的
//                    "web-remote-control:external-relay:pass_hash"
//   - credentialService 会对凭据做信封加密后再落盘，格式为
//     `enc:v1:<base64url(iv)>.<base64url(authTag)>.<base64url(ciphertext)>`，
//     算法 aes-256-gcm，密钥 = sha256(secret)，
//     secret = process.env.ZCODE_CREDENTIAL_SECRET
//               || `zcode-credential-fallback:<platform>:<homedir>:<username>`
//     因此本机可以自行解密，拿到与桌面端内存中一致的 passHash。
//   - 手机扫码打开的官方页面地址，就是把 sid/hash/... 拼在 /remote/v3|v4 上；
//     页面自己以 “terminal” 角色连 wss://zcode.z.ai/ws 完成配对。
//
// 结论：网关读出并解密这两项，就能给出一个可直接用的官方远控页地址，无需重新扫码，
// 也无需自己实现 relay 的 device/terminal 协议与 host Channel RPC。

import { createDecipheriv, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { homedir, hostname, platform, userInfo } from 'node:os';
import { join } from 'node:path';

// ZCode 的状态目录。
//   默认：<home>/.zcode/v2

//   Windows 上 home 是 C:\Users\<用户名>（与 ZCode 桌面端 app.getPath('home') 一致），
//   目录结构相同，所以两个平台用同一套规则。
//   另外 ZCode 自己支持 ZCODE_HOME 覆盖基础目录，这里跟随该约定。
const ZCODE_HOME_BASE = process.env.ZCODE_HOME || join(homedir(), '.zcode');
const ZCODE_STATE_DIR = process.env.ZCODE_STATE_DIR || join(ZCODE_HOME_BASE, 'v2');
const PASS_HASH_KEY = 'web-remote-control:external-relay:pass_hash';
const ENC_PREFIX = 'enc:v1:';
const DEFAULT_SECRET_ENV = 'ZCODE_CREDENTIAL_SECRET';

function readJson(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function deriveKey(env = process.env) {
  const secret =
    env[DEFAULT_SECRET_ENV] ||
    `zcode-credential-fallback:${platform()}:${homedir()}:${(() => {
      try {
        return userInfo().username;
      } catch {
        return 'unknown';
      }
    })()}`;
  return createHash('sha256').update(secret).digest();
}

/**
 * 解密 ZCode credentialService 的信封格式；非加密值原样返回。
 * 与客户端实现一致：aes-256-gcm，iv 12B、authTag 16B，各段 base64url。
 */
export function decryptCredential(value, env = process.env) {
  if (typeof value !== 'string' || !value.startsWith(ENC_PREFIX)) return value;
  const parts = value.slice(ENC_PREFIX.length).split('.');
  if (parts.length !== 3) throw new Error('凭据密文格式非法');
  const [iv, tag, data] = parts.map((s) => Buffer.from(s, 'base64url'));
  if (iv.length !== 12) throw new Error('凭据 IV 长度非法');
  if (tag.length !== 16) throw new Error('凭据 authTag 长度非法');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(env), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function readZcodePairing() {
  const setting = readJson(join(ZCODE_STATE_DIR, 'setting.json')) || {};
  const creds = readJson(join(ZCODE_STATE_DIR, 'credentials.json')) || {};
  const telemetry = readJson(join(ZCODE_STATE_DIR, 'telemetry-state.json')) || {};

  const deviceSid = setting?.webRemoteControlExternalRelayDevice?.deviceSid?.trim() || null;
  const raw = typeof creds[PASS_HASH_KEY] === 'string' ? creds[PASS_HASH_KEY].trim() : null;

  let passHash = null;
  let decryptError = null;
  if (raw) {
    try {
      passHash = decryptCredential(raw);
    } catch (err) {
      decryptError = err.message;
    }
  }

  return {
    ready: Boolean(deviceSid && passHash),
    deviceSid,
    passHash,
    encrypted: Boolean(raw && raw.startsWith(ENC_PREFIX)),
    decryptError,
    deviceMid: telemetry?.deviceMid?.trim() || null,
    deviceName: hostname(),
    stateDir: ZCODE_STATE_DIR,
  };
}

/**
 * 构造官方 Web 远控页面地址，参数与桌面端 buildWebRemoteControlExternalQrUrl 一致：
 *   <base>?sid=&hash=&t=&mid=&name=&app_version=
 */
export function buildZcodeRemoteUrl({
  baseUrl = process.env.ZCODE_REMOTE_URL_BASE || 'https://zcode.z.ai/remote/v4',
  appVersion = process.env.ZCODE_APP_VERSION || '3.15.3',
} = {}) {
  const p = readZcodePairing();
  if (!p.ready) return { ready: false, pairing: p, url: null };

  const url = new URL(baseUrl);
  url.searchParams.set('sid', p.deviceSid);
  url.searchParams.set('hash', p.passHash);
  url.searchParams.set('t', String(Date.now()));
  if (p.deviceMid) url.searchParams.set('mid', p.deviceMid);
  if (p.deviceName) url.searchParams.set('name', p.deviceName);
  if (appVersion) url.searchParams.set('app_version', appVersion);
  return { ready: true, pairing: p, url: url.toString() };
}

let desktopCache = { at: 0, running: false };

/**
 * 探测 ZCode 桌面进程是否在运行（带 5 秒缓存）。
 *
 * 跨平台差异：
 *   - Linux/macOS：用 pgrep 匹配进程命令行；
 *   - Windows：没有 pgrep，改用 tasklist 按映像名查找
 *     （ZCode 桌面版的可执行文件名通常为 ZCode.exe）。
 */
export function isZcodeDesktopRunning({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - desktopCache.at < 5000) return Promise.resolve(desktopCache.running);

  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'tasklist' : 'pgrep';
  const args = isWin
    ? ['/FI', 'IMAGENAME eq ZCode.exe', '/NH']
    : ['-f', '/opt/ZCode/zcode|ZCode/resources'];

  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 4000 }, (err, stdout) => {
      const text = String(stdout || '');
      // tasklist 在找不到进程时会输出 "INFO: No tasks..."，需要排除
      const running = isWin
        ? !err && /ZCode\.exe/i.test(text)
        : !err && text.trim().length > 0;
      desktopCache = { at: now, running };
      resolve(running);
    });
  });
}

// ---------------------------------------------------------------------------
// 桌面端 relay 连接状态
//
// 为什么需要它：本地凭据存在 ≠ 远控可用。桌面端必须实际连上 relay 并停在
// waiting_terminal / paired，手机页面才能配对成功；否则官方页面会一直停在
// “等待桌面端确认配对”。桌面端把这个状态机写进了日志
//   ~/.zcode/v2/logs/<date>.log
// 形如 `[main] [web-remote-control] external relay device state {"state":"paired"}`，
// 所以读取日志尾部即可得到权威状态（没有可用的 IPC / socket / 调试端口可从外部查询，
// 打包版 Electron 不开放 remote debugging）。
// ---------------------------------------------------------------------------

const RELAY_STATES = new Set([
  'idle',
  'connecting',
  'registering',
  'authenticating',
  'waiting_terminal',
  'paired',
  'error',
  'kicked',
]);

/** 从文件末尾向前分块扫描，返回第一个满足 predicate 的行（含时间戳）。 */
function findLastLineMatching(filePath, predicate, { chunkBytes = 1024 * 1024, maxScanBytes = 16 * 1024 * 1024 } = {}) {
  let fd;
  try {
    const size = statSync(filePath).size;
    if (size === 0) return null;
    fd = openSync(filePath, 'r');
    let end = size;
    let scanned = 0;
    let carry = '';
    while (end > 0 && scanned < maxScanBytes) {
      const start = Math.max(0, end - chunkBytes);
      const length = end - start;
      const buf = Buffer.alloc(length);
      readSync(fd, buf, 0, length, start);
      scanned += length;
      // 与上一次的 carry 拼接，避免把跨块的行截断
      const text = buf.toString('utf8') + carry;
      const lines = text.split('\n');
      // 最后一段可能是被截断的半个行，留给下一轮
      carry = lines.pop() ?? '';
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i];
        if (!line.trim()) continue;
        const hit = predicate(line);
        if (hit) return { line, hit };
      }
      end = start;
    }
    // 处理文件开头的那一行（没有被换行结尾）
    if (carry.trim()) {
      const hit = predicate(carry);
      if (hit) return { line: carry, hit };
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

export function readZcodeRelayState() {
  const logsDir = join(ZCODE_STATE_DIR, 'logs');
  if (!existsSync(logsDir)) {
    return { state: 'unknown', reason: '日志目录不存在', at: null };
  }
  let files = [];
  try {
    files = readdirSync(logsDir)
      .filter((f) => f.endsWith('.log'))
      .sort();
  } catch {
    return { state: 'unknown', reason: '无法读取日志目录', at: null };
  }
  if (!files.length) return { state: 'unknown', reason: '暂无日志文件', at: null };

  // 从最新的日志往前找，直到命中一条远控状态记录。
  for (let fi = files.length - 1; fi >= 0; fi -= 1) {
    const file = join(logsDir, files[fi]);
    const found = findLastLineMatching(file, (line) => {
      if (!line.includes('[web-remote-control]')) return false;

      const ts = line.match(/^\[([\d\-: .]+)\]/)?.[1] || null;

      if (/\] stopped window=/.test(line)) {
        const reason = line.match(/reason=([\w-]+)/)?.[1] || 'manual-stop';
        return { state: 'stopped', reason, at: ts };
      }
      if (/heartbeat ack timeout/.test(line)) {
        return { state: 'stalled', reason: 'heartbeat-timeout', at: ts };
      }
      if (/device KICKED/.test(line)) {
        return { state: 'kicked', reason: 'relay-kicked', at: ts };
      }
      const st = line.match(/device state \{"state":"([a-z_]+)"\}/)?.[1];
      if (st && RELAY_STATES.has(st)) {
        return { state: st, reason: null, at: ts };
      }
      if (/device connecting/.test(line)) {
        return { state: 'connecting', reason: null, at: ts };
      }
      if (/workspace bridge active/.test(line)) {
        return { state: 'paired', reason: null, at: ts };
      }
      return false;
    });

    if (found) return { ...found.hit, logFile: file };
  }
  return {
    state: 'unknown',
    reason: '日志中未找到远控记录',
    at: null,
    logFile: join(logsDir, files[files.length - 1]),
  };
}

/** 桌面端是否已经可以与手机页面配对。 */
export function isRelayReadyForPairing(state) {
  return state?.state === 'waiting_terminal' || state?.state === 'paired';
}
