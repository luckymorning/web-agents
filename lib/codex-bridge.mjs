// Codex app-server 桥接层。
//
// 协议要点（均在本机对 codex 0.162.0-alpha.17.2 实测确认）：
//   - `codex app-server` 默认走 stdio，逐行 JSON-RPC：每条消息是一行 JSON，以 \n 结尾。
//   - 客户端发请求（带 id），服务端回 {id,result} 或 {id,error}；此外服务端会主动发
//     通知（无 id，只有 method）和请求（带 id，例如命令审批），后者必须用同一个 id 回结果。
//   - 会话是“单写入者”模型：thread/resume 会占用 ~/.codex/thread-writer-locks/<id>.lock，
//     锁在 app-server 进程存活期间一直持有，thread/unsubscribe 并不释放；进程退出后锁被
//     判定为陈旧并自动清理。因此这里拆成两个进程：
//       reader —— 常驻，只做 list/read/turns/items 查询，从不 resume，不占任何锁；
//       driver —— 按需创建，只 resume 一个线程，切换线程时杀掉旧进程重建以释放锁。
//     这样“浏览任意会话”永远可用，而“驱动某个会话”是独占且可释放的。

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { threadPermissionParams, turnPermissionParams } from './codex-permissions.mjs';

const IS_WINDOWS = process.platform === 'win32';
const HOME = homedir();

// codex 可执行文件的常见位置，按平台排列。
// Windows 上 ChatGPT 桌面版把它放在 %LOCALAPPDATA%\Programs 下，
// 另外 ~/.codex/plugins/.plugin-appserver 里也会有一份副本。
const BIN_CANDIDATES = (
  IS_WINDOWS
    ? [
        process.env.CODEX_BIN,
        join(HOME, '.codex', 'plugins', '.plugin-appserver', 'codex.exe'),
        join(HOME, '.codex', 'plugins', '.plugin-appserver', 'codex'),
        join(process.env.LOCALAPPDATA || join(HOME, 'AppData', 'Local'),
             'Programs', 'ChatGPT', 'resources', 'codex.exe'),
        join(process.env.LOCALAPPDATA || join(HOME, 'AppData', 'Local'),
             'Programs', 'Codex', 'resources', 'codex.exe'),
        join(process.env.PROGRAMFILES || 'C:\\Program Files',
             'ChatGPT', 'resources', 'codex.exe'),
        join(HOME, 'AppData', 'Local', 'Programs', 'codex', 'codex.exe'),
        'codex.exe',
      ]
    : [
        process.env.CODEX_BIN,
        '/usr/lib/chatgpt/resources/codex',
        join(HOME, '.codex', 'plugins', '.plugin-appserver', 'codex'),
        join(HOME, '.local', 'bin', 'codex'),
        '/usr/local/bin/codex',
        '/usr/bin/codex',
      ]
).filter(Boolean);

export function resolveCodexBin() {
  for (const c of BIN_CANDIDATES) {
    try {
      if (existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** 单个 app-server 子进程 + 逐行 JSON-RPC 客户端。 */
class CodexProc {
  constructor(name, { bin, cwd, onNotification, onRequest, onExit, log }) {
    this.name = name;
    this.bin = bin;
    this.cwd = cwd;
    this.onNotification = onNotification;
    this.onRequest = onRequest;
    this.onExit = onExit;
    this.log = log;
    this.pending = new Map();
    this.seq = 1;
    this.alive = false;
    this.disposed = false;
    this.stderrTail = '';
    this.#start();
  }

  #start() {
    const proc = spawn(this.bin, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.cwd,
      env: process.env,
    });
    this.proc = proc;
    this.alive = true;
    this.buf = '';

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => this.#onData(chunk));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });
    proc.on('error', (err) => {
      this.log?.(`[${this.name}] spawn error: ${err.message}`);
      this.#settle(new Error(`${this.name} spawn failed: ${err.message}`));
    });
    proc.on('exit', (code, signal) => {
      this.alive = false;
      this.log?.(`[${this.name}] exited code=${code} signal=${signal}`);
      this.#settle(new Error(`${this.name} exited (code=${code})`));
      if (!this.disposed) this.onExit?.(this, code, signal);
    });

    this.ready = this.call('initialize', {
      clientInfo: { name: 'remote-hub', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    }).then(
      (res) => res,
      (err) => {
        this.log?.(`[${this.name}] initialize failed: ${err.message}`);
        return null;
      },
    );
  }

  #settle(err) {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  #onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.log?.(`[${this.name}] non-JSON line dropped: ${line.slice(0, 120)}`);
        continue;
      }
      this.#dispatch(msg);
    }
  }

  #dispatch(msg) {
    const hasId = msg.id !== undefined && msg.id !== null;
    const isResponse = hasId && (msg.result !== undefined || msg.error !== undefined);
    if (isResponse) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        msg.error ? p.reject(makeRpcError(msg.error)) : p.resolve(msg.result);
      }
      return;
    }
    if (hasId && msg.method) {
      // 服务端发起的请求（审批、提问等），需要原样回同一个 id。
      this.onRequest?.({ child: this.name, id: msg.id, method: msg.method, params: msg.params });
      return;
    }
    if (msg.method) this.onNotification?.({ child: this.name, method: msg.method, params: msg.params });
  }

  call(method, params = {}, { timeoutMs = 45000 } = {}) {
    if (!this.alive || !this.proc?.stdin?.writable) {
      return Promise.reject(new Error(`${this.name} is not running`));
    }
    const id = this.seq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name} ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  respond(id, result) {
    if (!this.alive || !this.proc?.stdin?.writable) return false;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
    return true;
  }

  respondError(id, message) {
    if (!this.alive || !this.proc?.stdin?.writable) return false;
    this.proc.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } }) + '\n',
    );
    return true;
  }

  kill() {
    this.disposed = true;
    this.#settle(new Error(`${this.name} disposed`));
    try {
      this.proc?.kill('SIGTERM');
      setTimeout(() => {
        try {
          if (this.proc && !this.proc.killed) this.proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 1500).unref?.();
    } catch {
      /* ignore */
    }
  }
}

function makeRpcError(error) {
  const err = new Error(error?.message || 'codex rpc error');
  err.code = error?.code;
  err.data = error?.data;
  return err;
}

export class CodexBridge {
  /**
   * @param {(evt: {kind:'notification'|'request'|'driver'|'log', ...}) => void} emit
   */
  constructor({ emit, log = () => {} } = {}) {
    this.emit = emit || (() => {});
    this.log = log;
    this.bin = resolveCodexBin();
    this.cwd = homedir();
    this.reader = null;
    this.driver = null;
    this.driverThreadId = null;
    this.activeTurns = new Map(); // threadId -> turnId
    // 本进程刚创建、还没跑过 turn 的线程。
    // app-server 在这段时间内不会把它写进 rollout，因此它既不出现在 thread/list，
    // thread/read 的 projectId 也读成 null（内部报 no rollout found）。
    // 这里记一份本地元数据，在上面两个接口里补merge进去。
    this.localThreads = new Map(); // threadId -> { projectId, cwd, createdAt, updatedAt }
    this.initialized = false;
    this.version = null;
  }

  get available() {
    return Boolean(this.bin);
  }

  get driverInfo() {
    return {
      threadId: this.driverThreadId,
      alive: Boolean(this.driver?.alive),
      activeTurnId: this.driverThreadId ? this.activeTurns.get(this.driverThreadId) || null : null,
    };
  }

  #emit(evt) {
    try {
      this.emit(evt);
    } catch (err) {
      this.log(`emit failed: ${err.message}`);
    }
  }

  getReader() {
    if (this.reader?.alive) return this.reader;
    this.reader = new CodexProc('reader', {
      bin: this.bin,
      cwd: this.cwd,
      log: this.log,
      onNotification: (n) => this.#handleNotification(n),
      onRequest: (r) => this.#handleRequest(r),
      onExit: (proc) => {
        this.#emit({ kind: 'log', level: 'warn', message: 'codex reader 进程退出，已标记为不可用' });
      },
    });
    return this.reader;
  }

  async ensureReaderReady() {
    const r = this.getReader();
    const res = await r.ready;
    if (res?.userAgent && !this.version) {
      this.version = String(res.userAgent).split(' ')[0];
      this.initialized = true;
    }
    return r;
  }

  /** 只读查询（永不占用写入者锁） */
  async query(method, params = {}, opts) {
    if (!this.available) throw new Error('未找到 codex 可执行文件');
    const r = await this.ensureReaderReady();
    if (!r) throw new Error('codex reader 不可用');
    return r.call(method, params, opts);
  }

  /**
   * 读取某个线程的数据，自动路由到正确的进程。
   *
   * 必须这么做，因为 app-server 里线程状态分两处：
   *   - 已被某个 app-server 加载（resume/start）的线程只存在于那个进程的内存里，
   *     另一个进程读它只会得到 `thread not loaded` / `thread/items/list is not supported yet`；
   *   - 已落盘的线程任何进程都能按 rollout 历史读。
   * 所以当 driver 正持有该线程时，一律走 driver；否则走常驻 reader。
   *
   * 另外，刚创建、还没跑过任何 turn 的线程即使由 driver 持有，也可能不支持
   * turns/items 分页查询。这种情况回退到 thread/read?includeTurns=true，把 turns
   * 拍平成和 items/list 相同形状，保证上层无需区分。
   */
  async readThread(threadId, method, params = {}, opts) {
    if (!this.available) throw new Error('未找到 codex 可执行文件');
    const driverHolds = () => Boolean(this.driver?.alive && this.driverThreadId === threadId);

    const viaItemsFallback = async () => {
      // 注意：兜底读取也必须沿用同样的路由，否则 reader 读不到 driver 内存里的线程。
      const reader = driverHolds() ? this.driver : await this.ensureReaderReady();
      try {
        const full = await reader.call('thread/read', { threadId, includeTurns: true }, opts);
        const turns = full?.thread?.turns || [];
        const flat = [];
        for (const turn of turns) {
          for (const item of turn.items || []) {
            flat.push({
              turnId: turn.id,
              item,
              startedAtMs: turn.startedAt != null ? turn.startedAt * 1000 : undefined,
              completedAtMs: turn.completedAt != null ? turn.completedAt * 1000 : undefined,
            });
          }
        }
        return { data: flat, nextCursor: null, __fallback: 'thread/read+includeTurns' };
      } catch (fallbackErr) {
        // 刚创建、尚无任何 turn 的线程：app-server 内部走的是同一个 list_turns，
        // 同样会报 “not supported yet”。语义上这就是“历史为空”，返回空列表即可。
        if (/not supported yet/i.test(String(fallbackErr.message || fallbackErr))) {
          return { data: [], nextCursor: null, __fallback: 'empty-fresh-thread' };
        }
        throw fallbackErr;
      }
    };

    const attempt = async () => {
      if (driverHolds()) return this.driver.call(method, { ...params, threadId }, opts);
      return this.query(method, { ...params, threadId }, opts);
    };

    /** rollout 落盘前的线程读不到 projectId，用本地记录补上。 */
    const mergeLocal = (res) => {
      if (method !== 'thread/read' || !res?.thread) return res;
      const meta = this.localThreads.get(threadId);
      if (!meta) return res;
      const thread = { ...res.thread };
      if (thread.projectId == null && meta.projectId) thread.projectId = meta.projectId;
      if (thread.cwd == null && meta.cwd) thread.cwd = meta.cwd;
      return { ...res, thread, __local: true };
    };

    try {
      return mergeLocal(await attempt());
    } catch (err) {
      const msg = String(err.message || err);
      // 竞态：reader 读不到但 driver 其实持有 → 换 driver 再试一次
      if (driverHolds() && /not loaded/i.test(msg)) {
        try {
          return mergeLocal(await this.driver.call(method, { ...params, threadId }, opts));
        } catch (retryErr) {
          const m2 = String(retryErr.message || retryErr);
          if (/not supported yet/i.test(m2) && method !== 'thread/read') return viaItemsFallback();
          throw retryErr;
        }
      }
      // 该线程的历史不支持分页查询（例如刚创建或旧版历史模式）→ 用 includeTurns 兜底
      if (/not supported yet/i.test(msg) && method !== 'thread/read') return viaItemsFallback();
      throw err;
    }
  }

  #handleNotification({ child, method, params }) {
    if (method === 'turn/started' && params?.threadId && params?.turn?.id) {
      this.activeTurns.set(params.threadId, params.turn.id);
    }
    if (method === 'turn/completed' && params?.threadId) {
      this.activeTurns.delete(params.threadId);
    }
    if (method === 'thread/status/changed' && params?.threadId) {
      const t = params.status?.type;
      if (t && t !== 'active') this.activeTurns.delete(params.threadId);
    }
    this.#emit({ kind: 'notification', child, method, params });
  }

  #handleRequest(req) {
    // 审批/提问类请求：转发给前端，前端回 /api/codex/respond。
    this.#emit({ kind: 'request', ...req });
  }

  /** 让 driver 持有某个线程；失败时返回 readonly 模式而不是抛错。 */
  async openDriver(threadId, { model = null, effort = null, permissionMode } = {}) {
    const permissions = threadPermissionParams(permissionMode);
    if (!this.available) throw new Error('未找到 codex 可执行文件');
    if (this.driver?.alive && this.driverThreadId === threadId) {
      return { mode: 'driver', threadId };
    }
    if (this.driver?.alive && this.driverThreadId && this.driverThreadId !== threadId) {
      if (this.activeTurns.get(this.driverThreadId)) {
        // 正在跑 turn，拒绝抢占，避免中断正在进行的工作。
        return {
          mode: 'busy',
          reason: `上一个会话仍在执行中（${this.driverThreadId}），请先中断或稍后再试`,
        };
      }
      this.closeDriver('switch-thread');
    }

    const proc = await this.#spawnDriverProc();
    this.#emit({ kind: 'driver', state: 'starting', threadId });

    try {
      const resumeParams = { threadId, excludeTurns: true, ...permissions };
      if (model) resumeParams.model = model;
      const res = await proc.call('thread/resume', resumeParams, { timeoutMs: 60000 });
      this.driverThreadId = threadId;
      if (effort) {
        try {
          await proc.call('turn/settings/update', { threadId, effort }, { timeoutMs: 15000 });
        } catch {
          /* 尽力而为 */
        }
      }
      this.#emit({ kind: 'driver', state: 'ready', threadId });
      return { mode: 'driver', threadId, thread: res?.thread ?? null };
    } catch (err) {
      const msg = String(err.message || err);
      this.closeDriver('resume-failed');
      if (/active writer|active observer|live local writer/i.test(msg)) {
        return { mode: 'readonly', reason: '该会话正被另一端占用（ZCode/桌面 Codex CLI 或另一个 app-server）' };
      }
      return { mode: 'readonly', reason: msg };
    }
  }

  closeDriver(reason = 'manual') {
    const t = this.driverThreadId;
    if (this.driver) {
      this.driver.kill();
      this.driver = null;
    }
    if (t) this.activeTurns.delete(t);
    this.driverThreadId = null;
    this.#emit({ kind: 'driver', state: 'released', threadId: t, reason });
  }

  /** 确保存在一个可取用的 driver 进程（不预先绑定线程）。 */
  async #spawnDriverProc() {
    if (this.driver?.alive) {
      if (this.driverThreadId) throw new Error(`driver 已持有会话 ${this.driverThreadId}`);
      return this.driver;
    }
    const proc = new CodexProc('driver', {
      bin: this.bin,
      cwd: this.cwd,
      log: this.log,
      onNotification: (n) => this.#handleNotification(n),
      onRequest: (r) => this.#handleRequest(r),
      onExit: () => {
        if (this.driver === proc) {
          this.driver = null;
          this.driverThreadId = null;
          this.#emit({ kind: 'driver', state: 'closed' });
        }
      },
    });
    this.driver = proc;
    const init = await proc.ready;
    if (!init) {
      this.closeDriver('init-failed');
      throw new Error('codex app-server 启动失败');
    }
    return proc;
  }

  /**
   * 新建会话并由 driver 直接持有。
   * 必须在 driver 进程里创建：如果在 reader 里 thread/start，reader 就成了该线程的
   * 写入者，随后 driver 再也拿不到它（单写入者约束）。
   */
  async startThread({
    cwd = null,
    model = null,
    approvalPolicy,
    sandbox,
    permissionMode,
    ephemeral = false,
    projectId = null,
  } = {}) {
    const permissions = threadPermissionParams(permissionMode);
    if (!this.available) throw new Error('未找到 codex 可执行文件');
    // 释放当前持有的会话，避免 driver 同时持有两个线程时语义含糊
    if (this.driverThreadId) this.closeDriver('new-thread');

    const proc = await this.#spawnDriverProc();
    const params = {};
    if (cwd) params.cwd = cwd;
    if (model) params.model = model;
    if (approvalPolicy) params.approvalPolicy = approvalPolicy;
    if (sandbox) params.sandbox = sandbox;
    Object.assign(params, permissions);
    if (ephemeral) params.ephemeral = true;
    // 归属到 Codex 原生项目：这样新建的会话会出现在桌面端对应项目分组里。
    if (projectId) params.projectId = projectId;
    // 必须显式选分页历史：只有 paginated 模式的线程才支持
    // thread/turns/list 与 thread/items/list（默认模式下会报 "not supported yet"）。
    params.historyMode = 'paginated';

    const res = await proc.call('thread/start', params, { timeoutMs: 60000 });
    const threadId = res?.thread?.id;
    if (threadId) {
      this.driverThreadId = threadId;
      this.#emit({ kind: 'driver', state: 'ready', threadId });
      // 记下本地元数据，供列表/详情在 rollout 落盘前查用
      const t = res.thread || {};
      this.localThreads.set(threadId, {
        projectId: t.projectId || projectId || null,
        cwd: t.cwd || cwd || null,
        name: t.name || null,
        preview: t.preview || '',
        createdAt: t.createdAt || Math.floor(Date.now() / 1000),
        updatedAt: t.updatedAt || Math.floor(Date.now() / 1000),
      });
      this.#pruneLocalThreads();
    }
    return res;
  }

  /** 权限只在新一轮开始时应用；steer 继续沿用正在执行的轮次配置。 */
  async sendMessage({ threadId, text, kind = 'text', model, effort, permissionMode }) {
    const permissions = turnPermissionParams(permissionMode);
    if (this.driverThreadId !== threadId || !this.driver?.alive) {
      const opened = await this.openDriver(threadId, { model, permissionMode });
      if (opened.mode !== 'driver') return { ok: false, ...opened };
    }
    const input = [{ type: kind, text }];
    const activeTurn = this.activeTurns.get(threadId);
    if (activeTurn) {
      const r = await this.driver.call('turn/steer',
        { threadId, expectedTurnId: activeTurn, input }, { timeoutMs: 45000 });
      return { ...r, ok: true, steered: true, turnId: activeTurn,
        permissionDeferred: Object.keys(permissions).length > 0 };
    }
    const params = { threadId, input, ...permissions };
    if (model) params.model = model;
    if (effort) params.effort = effort;
    const r = await this.driver.call('turn/start', params, { timeoutMs: 60000 });
    if (r?.turn?.id) this.activeTurns.set(threadId, r.turn.id);
    return { ...r, ok: true, steered: false, turnId: r?.turn?.id || null };
  }

  /** 丢弃过期的本地线程记录，避免无界增长。 */
  #pruneLocalThreads() {
    const cutoff = Math.floor(Date.now() / 1000) - 3600;
    for (const [id, meta] of this.localThreads) {
      if ((meta.updatedAt || meta.createdAt || 0) < cutoff) this.localThreads.delete(id);
    }
  }

  /**
   * 会话列表：拿 app-server 的结果，再把「刚创建、尚未落盘」的本地线程补进去，
   * 这样新建的会话能立刻出现在正确分组里。
   */
  async listThreads({ limit = 30, cursor = null, cwd = null, archived = false } = {}) {
    if (!this.available) throw new Error('未找到 codex 可执行文件');
    const params = { limit, sortKey: 'recency_at', archived: Boolean(archived) };
    if (cursor) params.cursor = cursor;
    if (cwd) params.cwd = cwd;
    const r = await this.query('thread/list', params, { timeoutMs: 30000 });
    const data = Array.isArray(r?.data) ? [...r.data] : [];
    const present = new Set(data.map((t) => t.id));

    // 本地未落盘的线程一律属于「活动」视图；归档视图没有本地记录可补。
    if (archived) return { ...r, data };

    for (const [id, meta] of this.localThreads) {
      if (present.has(id)) {
        // 已经落盘了：以服务端为准，本地记录可以丢掉
        if (data.find((t) => t.id === id)?.projectId != null || this.driverThreadId !== id) {
          this.localThreads.delete(id);
        }
        continue;
      }
      if (cursor) continue; // 只有第一页才补本地新建的会话
      data.unshift({
        id,
        sessionId: id,
        preview: meta.preview || '',
        cwd: meta.cwd,
        projectId: meta.projectId,
        name: meta.name,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        recencyAt: meta.updatedAt,
        status: { type: this.activeTurns.has(id) ? 'active' : 'idle' },
        ephemeral: false,
        turns: 0,
        __local: true,
      });
    }
    return { ...r, data, __merged: true };
  }

  /**
   * 列出 Codex 原生项目（桌面端的“项目”分组）。
   * 每个项目带一个或多个 root 目录，新建会话时可据此把会话归入项目。
   */
  async listProjects({ limit = 100 } = {}) {
    if (!this.available) throw new Error('未找到 codex 可执行文件');
    const r = await this.query('project/list', { limit }, { timeoutMs: 30000 });
    return (r?.data || []).map((p) => ({
      id: p.id,
      name: p.name,
      position: p.position ?? 0,
      recencyAt: p.recencyAt ?? null,
      roots: (p.roots || []).map((x) => x.path).filter(Boolean),
    }));
  }

  /**
   * 对某个线程执行变更类操作，并自动路由到持有它的进程。
   *
   * archive / unarchive / delete 这类操作也受单写入者约束：如果线程正被 driver 持有，
   * 通过 reader 调用会失败（`already has an active writer`）。所以统一在这里选进程。
   */
  async #mutateThread(threadId, method, params = {}, opts) {
    const driverHolds = () => Boolean(this.driver?.alive && this.driverThreadId === threadId);
    const call = (who) => who.call(method, { ...params, threadId }, opts);

    if (driverHolds()) {
      try {
        return await call(this.driver);
      } catch (err) {
        // driver 刚挂掉之类的竞态：回退到 reader 再试一次
        if (!driverHolds()) return call(await this.ensureReaderReady());
        throw err;
      }
    }
    return call(await this.ensureReaderReady());
  }

  /**
   * 归档会话。
   *
   * 三个坑：
   *   1. 线程若由 driver 持有，通过 reader 调用会报 `already has an active writer`，
   *      所以要先对持有者调用归档，再释放 driver；
   *   2. 归档后 app-server 拒绝 resume（`session ... is archived`），所以释放 driver
   *      是必须的，否则会留下"内存里还活着但再也驱动不了"的假象；
   *   3. 刚创建、尚未写 rollout 的会话磁盘上不存在，归档会报 `no rollout found`；
   *      对用户而言这就是"把这个临时会话移出列表"，所以按成功处理。
   * 另外把重复归档也视为成功（幂等），避免用户二次点击时看到报错。
   */
  async archiveThread(threadId) {
    if (!this.available) throw new Error('未找到 codex 可执行文件');
    const wasLocal = this.localThreads.has(threadId);

    let note = null;
    try {
      await this.#mutateThread(threadId, 'thread/archive', {}, { timeoutMs: 40000 });
    } catch (err) {
      const msg = String(err.message || err);
      const already = /already (archived|has an active)/i.test(msg);
      const noRollout = /no rollout found/i.test(msg);
      if (already || noRollout || wasLocal) {
        // 已经归档 / 尚未落盘的临时会话：都按成功处理
        note = noRollout || wasLocal ? 'discarded' : 'already-archived';
      } else {
        throw err;
      }
    }

    if (this.driverThreadId === threadId) this.closeDriver('archived');
    this.localThreads.delete(threadId);
    return { ok: true, note };
  }

  /** 取消归档，会话回到活动列表。 */
  async unarchiveThread(threadId) {
    if (!this.available) throw new Error('未找到 codex 可执行文件');
    try {
      await this.#mutateThread(threadId, 'thread/unarchive', {}, { timeoutMs: 40000 });
    } catch (err) {
      // 未归档的会话再取消一次，语义上同样是"它已在活动列表"，按成功处理
      if (!/not archived|no rollout found|already has an active/i.test(String(err.message || err))) {
        throw err;
      }
    }
    return { ok: true };
  }

  /**
   * 永久删除会话。不可恢复。
   * 同样先释放 driver：删除后进程内存里的线程已无意义。
   */
  async deleteThread(threadId) {
    if (!this.available) throw new Error('未找到 codex 可执行文件');
    const wasLocal = this.localThreads.has(threadId);

    let note = null;
    try {
      await this.#mutateThread(threadId, 'thread/delete', {}, { timeoutMs: 60000 });
    } catch (err) {
      const msg = String(err.message || err);
      // 尚未落盘的本地会话没有可删的磁盘数据；已不存在也视作目标达成
      if (wasLocal || /no rollout found|not found/i.test(msg)) note = 'discarded';
      else throw err;
    }

    if (this.driverThreadId === threadId) this.closeDriver('deleted');
    this.localThreads.delete(threadId);
    this.activeTurns.delete(threadId);
    return { ok: true, note };
  }

  respondToServer(id, result) {
    if (this.driver?.alive && this.driver.respond(id, result)) return true;
    const r = this.reader;
    if (r?.alive && r.respond(id, result)) return true;
    return false;
  }

  dispose() {
    this.closeDriver('dispose');
    this.reader?.kill();
    this.reader = null;
  }
}
