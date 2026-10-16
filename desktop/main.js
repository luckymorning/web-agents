// Electron 主进程：控制台窗口 + 系统托盘 + 服务进程管理。
//
// 与旧 Python 控制台相比的关键差异：
//   - 不再需要 Python / tkinter / PyGObject / Pillow —— Electron 自带运行时；
//   - 托盘用 Electron 原生 API（Linux 走 StatusNotifierItem，Windows 走 Shell_NotifyIcon），
//     不再手写 D-Bus 或 Win32 调用；
//   - 服务端 server.mjs 以子进程方式运行，其 Node 运行时就是 Electron 自带的
//     （ELECTRON_RUN_AS_NODE=1），因此用户无需单独安装 Node。

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, dialog } = require('electron');
const { spawn, execFile } = require('node:child_process');
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { join, dirname } = require('node:path');
const http = require('node:http');

const netif = require('./netif');

const IS_WINDOWS = process.platform === 'win32';

// ---------------------------------------------------------------- 路径
//
// 打包后代码在 resources/app.asar 内，而服务端需要作为独立进程运行，
// 所以被放进 extraResources（app.asar 外的 resources/app/）。
// 开发模式下直接引用仓库根目录。

const DEV_ROOT = join(__dirname, '..');
const IS_PACKAGED = app.isPackaged;
const APP_ROOT = IS_PACKAGED ? join(process.resourcesPath, 'app') : DEV_ROOT;

const SERVER_ENTRY = join(APP_ROOT, 'server.mjs');
const PUBLIC_DIR = join(APP_ROOT, 'public');

// 配置写到用户数据目录，避免安装目录只读；同时与旧的仓库内配置兼容。
const USER_DIR = app.getPath('userData');
const CONFIG_PATH = join(USER_DIR, 'console-config.json');

const DEFAULTS = { host: '127.0.0.1', port: 8790, token: '', codexBin: '' };

function logPath() {
  return join(app.getPath('logs') || USER_DIR, 'service.log');
}

// ---------------------------------------------------------------- 配置

function readConfig() {
  const cfg = { ...DEFAULTS };
  // 兼容：优先用户目录，其次安装目录/仓库里的旧配置
  for (const p of [CONFIG_PATH, join(APP_ROOT, 'console-config.json')]) {
    try {
      if (!existsSync(p)) continue;
      const data = JSON.parse(readFileSync(p, 'utf8'));
      if (data && typeof data === 'object') Object.assign(cfg, data);
      break;
    } catch {
      /* 忽略损坏的配置 */
    }
  }
  return cfg;
}

function writeConfig(cfg) {
  try {
    mkdirSync(USER_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    return true;
  } catch (err) {
    console.error('[console] 保存配置失败:', err.message);
    return false;
  }
}

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/** 非回环监听必须有令牌 —— 此服务等价于 shell 权限，不能裸奔。 */
function genToken() {
  return require('node:crypto').randomBytes(24).toString('base64url');
}

/**
 * 校验界面提交的配置并落盘。
 * 「启动」与「应用配置」共用，避免两处各写一套校验。
 */
function persistConfig(form) {
  const next = {
    host: String((form && form.host) || '127.0.0.1'),
    port: Number(form && form.port),
    token: String((form && form.token) || ''),
    codexBin: String((form && form.codexBin) || ''),
  };
  if (!Number.isInteger(next.port) || next.port < 1 || next.port > 65535) {
    return { ok: false, msg: '端口需在 1-65535 之间' };
  }

  // 非回环监听且无令牌 → 自动生成，避免把 shell 权限裸暴露到局域网
  let generated = false;
  if (!isLoopbackHost(next.host) && !next.token) {
    next.token = genToken();
    generated = true;
  }

  const prev = readConfig();
  const changed = Object.keys(next).filter((k) => prev[k] !== next[k]);
  if (!writeConfig(next)) return { ok: false, msg: '配置写入失败' };
  return { ok: true, changed, generated, config: next };
}

// ---------------------------------------------------------------- 状态

let win = null;
let tray = null;
let quitting = false;
const svc = { proc: null, buffer: [] };

function svcRunning() {
  return Boolean(svc.proc && svc.proc.exitCode === null && !svc.proc.killed);
}

function pushLog(line) {
  // 日志同时写入文件（便于排查）并推给渲染进程显示
  if (win && !win.isDestroyed()) {
    try {
      win.webContents.send('log', line);
    } catch {
      /* 窗口可能正在销毁 */
    }
  }
}

function currentStatus() {
  const cfg = readConfig();
  return {
    running: svcRunning(),
    pid: svc.proc ? svc.proc.pid : null,
    host: cfg.host,
    port: cfg.port,
    token: cfg.token,
    codexBin: cfg.codexBin,
    closeHint: svcRunning() ? '关闭窗口将最小化到托盘（服务继续运行）' : '关闭窗口将退出程序',
  };
}

function broadcastStatus() {
  if (win && !win.isDestroyed()) {
    try {
      win.webContents.send('status', currentStatus());
    } catch {
      /* ignore */
    }
  }
  updateTray();
  updateTitle();
}

function updateTitle() {
  if (!win || win.isDestroyed()) return;
  const st = svcRunning() ? '运行中' : '已停止';
  win.setTitle(`远程控制网关 · ${st}`);
}

// ---------------------------------------------------------------- 服务进程

function startService(cfg) {
  if (svcRunning()) return { ok: true, msg: '服务已在运行' };
  if (!existsSync(SERVER_ENTRY)) return { ok: false, msg: `找不到服务入口：${SERVER_ENTRY}` };

  const args = [SERVER_ENTRY, '--port', String(cfg.port), '--host', cfg.host];
  if (cfg.token) args.push('--token', cfg.token);

  const env = { ...process.env };
  // 关键：让 Electron 以纯 Node 模式运行服务端，用户无需另装 Node
  env.ELECTRON_RUN_AS_NODE = '1';
  if (cfg.codexBin) env.CODEX_BIN = cfg.codexBin;

  try {
    const proc = spawn(process.execPath, args, {
      env,
      cwd: APP_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Windows 用独立进程组，便于整棵进程树终止
      ...(IS_WINDOWS ? {} : { detached: false }),
    });
    svc.proc = proc;

    const onData = (chunk) => {
      const text = String(chunk);
      for (const line of text.split('\n')) {
        if (line.trim()) pushLog(line);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code, signal) => {
      pushLog(`[console] 服务进程已退出 (code=${code}, signal=${signal || '-'})`);
      svc.proc = null;
      broadcastStatus();
    });
    proc.on('error', (err) => {
      pushLog(`[console] 服务进程启动失败：${err.message}`);
      svc.proc = null;
      broadcastStatus();
    });

    broadcastStatus();
    return { ok: true, msg: `已启动（端口 ${cfg.port}）` };
  } catch (err) {
    return { ok: false, msg: `启动失败：${err.message}` };
  }
}

function stopService() {
  return new Promise((resolve) => {
    const proc = svc.proc;
    if (!proc || proc.exitCode !== null) {
      svc.proc = null;
      resolve({ ok: true, msg: '服务未在运行' });
      return;
    }

    const done = () => {
      svc.proc = null;
      broadcastStatus();
      resolve({ ok: true, msg: '服务已停止' });
    };

    if (IS_WINDOWS) {
      // Windows 无进程组信号，用 taskkill /T 收掉整棵进程树
      // （服务端可能还持有 codex 等子进程）
      execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], (err) => {
        if (err) {
          try {
            proc.kill('SIGKILL');
          } catch {
            /* ignore */
          }
          setTimeout(done, 400);
        } else {
          done();
        }
      });
      return;
    }

    try {
      proc.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    const t = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      done();
    }, 5000);
    proc.once('exit', () => {
      clearTimeout(t);
      done();
    });
  });
}

function restartService(cfg) {
  return stopService().then(() => new Promise((r) => setTimeout(r, 350))).then(() => startService(cfg));
}

// ---------------------------------------------------------------- 健康检查

function apiGet(cfg, path, timeout = 2500) {
  return new Promise((resolve, reject) => {
    const host = isLoopbackHost(cfg.host) || cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host;
    let url = `http://${host}:${cfg.port}/api${path}`;
    if (cfg.token) url += (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(cfg.token);
    const req = http.get(url, { timeout }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- 窗口

function createWindow() {
  win = new BrowserWindow({
    width: 820,
    height: 720,
    minWidth: 700,
    minHeight: 560,
    title: '远程控制网关 · 控制台',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    icon: join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(join(__dirname, 'renderer', 'index.html'));

  // 关闭按钮：服务未运行 → 退出；服务运行中 → 最小化到托盘
  win.on('close', (e) => {
    if (quitting) return;
    if (!svcRunning()) {
      quitting = true;
      return; // 允许关闭
    }
    e.preventDefault();
    win.hide();
    if (tray) tray.displayBalloon?.({ title: '远程控制网关', content: '已最小化到托盘，服务继续运行' });
  });

  win.on('closed', () => {
    win = null;
  });

  win.webContents.once('did-finish-load', () => {
    // 把构建时缓存的日志补发给刚加载的界面
    for (const line of svc.buffer.splice(0)) {
      win.webContents.send('log', line);
    }
    broadcastStatus();
  });
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  else {
    win.show();
    win.focus();
  }
}

// ---------------------------------------------------------------- 托盘

function trayIconPath() {
  // Windows 用 .ico（支持多尺寸），Linux 用 .png
  const name = IS_WINDOWS ? 'icon.ico' : 'icon.png';
  const packed = join(process.resourcesPath || '', 'icon', name);
  const dev = join(__dirname, '..', 'build', name);
  return existsSync(packed) ? packed : dev;
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: svcRunning() ? '打开控制台（服务运行中）' : '打开控制台（服务已停止）', click: showWindow },
    { type: 'separator' },
    {
      label: '在浏览器中打开',
      enabled: svcRunning(),
      click: () => {
        const cfg = readConfig();
        const host = isLoopbackHost(cfg.host) || cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host;
        let url = `http://${host}:${cfg.port}/`;
        if (cfg.token) url += '?token=' + encodeURIComponent(cfg.token);
        shell.openExternal(url);
      },
    },
    { type: 'separator' },
    {
      label: '退出（停止服务）',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
}

function updateTray() {
  if (!tray) return;
  tray.setToolTip(svcRunning() ? '远程控制网关（运行中）' : '远程控制网关（已停止）');
  tray.setContextMenu(buildTrayMenu());
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(trayIconPath());
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
    tray.setToolTip('远程控制网关');
    tray.setContextMenu(buildTrayMenu());
    // 左键直接打开窗口（Windows 上 click 即为左键）
    tray.on('click', showWindow);
    updateTray();
  } catch (err) {
    console.error('[console] 托盘创建失败（不影响主功能）:', err.message);
    tray = null;
  }
}

// ---------------------------------------------------------------- IPC

function registerIpc() {
  ipcMain.handle('get-status', () => currentStatus());

  ipcMain.handle('list-hosts', () => {
    const hosts = [
      { label: '仅本机 (127.0.0.1)', value: '127.0.0.1' },
      { label: '局域网任意 (0.0.0.0)', value: '0.0.0.0' },
    ];
    for (const item of netif.listIPv4Addresses()) {
      hosts.push({ label: netif.describe(item), value: item.address });
    }
    return hosts;
  });

  ipcMain.handle('gen-token', () => genToken());

  ipcMain.handle('apply-config', async (_e, form) => {
    const saved = persistConfig(form);
    if (!saved.ok) return saved;

    const { changed, generated, config: next } = saved;
    if (!changed.length) return { ok: true, msg: '配置未变化', generated, config: next };

    const detail = changed.join('、');
    if (svcRunning()) {
      const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['立即重启', '稍后手动重启'],
        defaultId: 0,
        cancelId: 1,
        title: '需要重启服务',
        message: '配置已更新，但服务仍在用旧配置运行。',
        detail: '是否立即重启服务以应用新配置？',
      });
      if (response === 0) {
        const r = await restartService(next);
        broadcastStatus();
        return { ok: r.ok, msg: `配置已保存（${detail}）；服务已重启`, generated, config: next };
      }
      broadcastStatus();
      return {
        ok: true,
        msg: `配置已保存（${detail}）；已取消重启，下次启动服务时生效`,
        generated,
        config: next,
      };
    }
    broadcastStatus();
    return {
      ok: true,
      msg: `配置已保存（${detail}）；服务未运行，将在启动时生效`,
      generated,
      config: next,
    };
  });

  // 启动即应用界面上的配置，用户不必先点「应用配置」
  ipcMain.handle('start', async (_e, form) => {
    const saved = persistConfig(form);
    if (!saved.ok) return saved;

    const { changed, generated, config: next } = saved;

    if (svcRunning()) {
      // 界面在运行时会禁用「启动」，这里只做兜底：
      // 配置有变化就重启一次，保证「服务状态」与「界面所填」始终一致。
      if (!changed.length) {
        return { ok: true, msg: '服务已在运行', generated, config: next };
      }
      const r = await restartService(next);
      broadcastStatus();
      return {
        ok: r.ok,
        msg: r.ok ? `配置已更新（${changed.join('、')}）；服务已重启` : r.msg,
        generated,
        config: next,
      };
    }

    const r = startService(next);
    broadcastStatus();
    return { ...r, generated, config: next };
  });

  ipcMain.handle('stop', async () => {
    const r = await stopService();
    broadcastStatus();
    return r;
  });

  ipcMain.handle('health', async () => {
    if (!svcRunning()) return null;
    try {
      return await apiGet(readConfig(), '/health');
    } catch {
      return null;
    }
  });

  ipcMain.handle('open-browser', () => {
    const cfg = readConfig();
    const host = isLoopbackHost(cfg.host) || cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host;
    let url = `http://${host}:${cfg.port}/`;
    if (cfg.token) url += '?token=' + encodeURIComponent(cfg.token);
    shell.openExternal(url);
  });

  ipcMain.handle('quit', () => {
    quitting = true;
    app.quit();
  });
}

// ---------------------------------------------------------------- 生命周期

// 单实例：重复启动时把已有窗口带到前台，而不是开第二个实例
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    // 托盘需要在窗口之前或同时建立；失败也不影响主功能
    if (!existsSync(logPath())) {
      try {
        mkdirSync(dirname(logPath()), { recursive: true });
      } catch {
        /* ignore */
      }
    }
    registerIpc();
    createTray();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWindow();
    });
  });

  // 注意：这里**不自动启动服务**。服务由用户点「启动」显式拉起，
  // 避免打开控制台就意外对外监听。
  app.on('window-all-closed', () => {
    // 服务还在跑时窗口不应真正消失（已被 close 事件拦下），
    // 走到这里说明用户确实要退出。
    if (!svcRunning()) app.quit();
  });

  app.on('before-quit', async (e) => {
    if (!svcRunning()) return;
    if (quitting) {
      // 已经在退出流程中：同步等一次服务停止
      e.preventDefault();
      await stopService();
      app.exit(0);
    }
  });
}
