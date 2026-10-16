// ZCode 侧接入。
//
// 为什么用官方页面而不是自己实现 relay 协议：
//   桌面端以 “device” 角色连 wss://zcode.z.ai/ws，手机页面以 “terminal” 角色连同一个
//   relay，两端靠 passHash 做 HMAC 挑战应答配对。自己重新实现 “terminal” 一侧不仅要
//   复刻认证，还要复刻 app payload（workspace-bridge-* / rpc-frame 分片 + CRC32 + ACK +
//   重放）以及 host 侧 Channel RPC 的二进制序列化，成本高且随客户端版本漂移。
//   而凭据（deviceSid + passHash）在本地明文可读，直接构造官方页面 URL 即可复用整套链路。
//
// 这里额外做一层保底：如果桌面端尚未开启远控（没有凭据），就通过 ZCode 的 deep-link
// 协议唤起桌面并提示用户开启，然后轮询等凭据出现。

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import {
  readZcodePairing,
  isZcodeDesktopRunning,
  readZcodeRelayState,
  isRelayReadyForPairing,
} from './zcode-creds.mjs';

const STATE_LABEL = {
  idle: '桌面端远控空闲',
  connecting: '桌面端正在连接中继…',
  registering: '桌面端正在注册设备…',
  authenticating: '桌面端正在认证…',
  waiting_terminal: '桌面端已就绪，等待手机端配对',
  paired: '已配对，通道已建立',
  stalled: '桌面端心跳超时，正在重连',
  kicked: '桌面端连接被抢占，正在重连',
  stopped: '桌面端远控已停止',
  error: '桌面端远控出错',
  unknown: '未检测到桌面端远控状态',
};

/**
 * 由「凭据 + relay 日志状态 + 桌面端进程」推导对外展示的 ZCode 状态。
 *
 * 这是纯函数，便于单测覆盖各种组合。
 *
 * 关键点：**桌面端进程不在时，relay 状态一律视为无效**。
 * 原因是 relay 状态读取的是日志里最后一条记录，而 ZCode 被关闭（或被杀）时进程
 * 直接消失、不会补写 `stopped`，于是最后一条可能永远停留在 `paired`。
 * 若不加以区分，关闭客户端后页面仍显示"就绪"，与事实不符。
 */
export function deriveZcodeView({ pairingReady, relayState, relayReason, desktopRunning }) {
  const relayReady = Boolean(desktopRunning) && isRelayReadyForPairing({ state: relayState });

  let hint;
  if (!desktopRunning) {
    hint = pairingReady
      ? '桌面端未运行，点「唤起桌面端」启动它即可（状态会自动更新）。'
      : '桌面端未运行。点「唤起桌面端」启动后，请在桌面端开启「Web 远程控制」。';
  } else if (relayReady) {
    hint = '凭据与中继连接均已就绪，可直接使用远控页面。';
  } else if (!pairingReady) {
    hint = '尚未检测到远控凭据：请在 ZCode 桌面端打开「Web 远程控制」生成二维码。';
  } else if (relayState === 'stopped' || relayState === 'idle') {
    hint =
      '桌面端已启动，但远控尚未开启。请在桌面端点击「Web 远程控制」；开启后本页会自动完成配对。';
  } else if (relayState === 'unknown') {
    // 桌面端刚起来、日志里还没有远控记录时的中间态
    hint = '正在等待桌面端初始化远控…若长时间无进展，请确认桌面端是否已开启「Web 远程控制」。';
  } else {
    hint = `桌面端远控状态：${STATE_LABEL[relayState] || relayState}${
      relayReason ? `（${relayReason}）` : ''
    }`;
  }

  return { relayReady, hint };
}

export class ZcodeBridge {
  constructor({ emit, log = () => {} } = {}) {
    this.emit = emit || (() => {});
    this.log = log;
    this.waiters = new Set();
  }

  /**
   * 汇总 ZCode 侧状态。
   *
   * 除了凭据与 relay 状态，还带上「桌面端进程是否在运行」——
   * 前端需要区分三种情况：进程没起来 / 进程起来了但远控未开启 / 已就绪，
   * 这样唤起后才能给出准确的进度反馈。
   */
  async status() {
    const pairing = readZcodePairing();
    const relay = readZcodeRelayState();
    const desktopRunning = await isZcodeDesktopRunning();

    // 派生逻辑集中在纯函数里（见 deriveZcodeView），这里只负责取数
    const { relayReady, hint } = deriveZcodeView({
      pairingReady: pairing.ready,
      relayState: relay.state,
      relayReason: relay.reason,
      desktopRunning,
    });

    return {
      side: 'zcode',
      mode: 'official-page',
      pairingReady: pairing.ready,
      pairingState: pairing.ready ? 'ok' : 'missing',
      desktopRunning,
      relayState: relay.state,
      relayLabel: STATE_LABEL[relay.state] || relay.state,
      relayStateAt: relay.at,
      relayReady,
      deviceSidSuffix: pairing.deviceSid ? pairing.deviceSid.slice(-6) : null,
      deviceMid: pairing.deviceMid,
      credentialEncrypted: pairing.encrypted,
      decryptError: pairing.decryptError || null,
      stateDir: pairing.stateDir,
      hint,
    };
  }

  /**
   * 等待“两侧都能配对”：凭据存在，且桌面端已连上中继（waiting_terminal / paired）。
   * 桌面端此刻若未开启远控，官方页面会停在“等待桌面端确认配对”，一旦桌面端开启即自动配对，
   * 所以这里只需轮询状态并在超时前给出明确指引。
   */
  waitForPairing({ timeoutMs = 90000, intervalMs = 1500 } = {}) {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      let lastState = null;
      const timer = setInterval(() => {
        const pairing = readZcodePairing();
        const relay = readZcodeRelayState();
        lastState = relay.state;
        if (pairing.ready && isRelayReadyForPairing(relay)) {
          clearInterval(timer);
          resolve({ ok: true, pairing, relay });
          return;
        }
        if (Date.now() > deadline) {
          clearInterval(timer);
          resolve({
            ok: false,
            pairingReady: pairing.ready,
            relayState: lastState,
            reason: !pairing.ready
              ? '等待远控凭据超时：请在 ZCode 桌面端开启「Web 远程控制」'
              : `等待桌面端连接中继超时（当前状态：${STATE_LABEL[lastState] || lastState}）`,
          });
        }
      }, intervalMs);
      timer.unref?.();
    });
  }

  /**
   * 唤起 ZCode 桌面端。
   *
   * 关键：**即使检测到进程已在运行，也照样发起启动**，而不是提前返回。
   *
   * 原因：ZCode 是 Electron 应用，关闭窗口时进程往往仍在后台驻留（托盘行为），
   * 此时"进程存在"并不等于"用户能看到窗口"。而用户点这个按钮的真实意图是
   * 「把 ZCode 弄出来」，不是「启动一个进程」。
   * Electron 的单实例机制会把重复启动的请求转交给已有实例，通常表现为
   * 激活/前置已有窗口 —— 所以重复启动是安全且正是我们想要的行为。
   *
   * 不等待、不杀被启动的进程：GUI 冷启动需要数秒，要让 host / relay 安静地拉起来。
   */
  async launchDesktop() {
    const wasRunning = await isZcodeDesktopRunning();
    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';
    const errors = [];

    // 每个平台用最常见的启动方式，失败就试下一个。
    const attempts = isWin
      ? [
          // start 是 shell 内建，必须经 cmd；'' 是窗口标题占位
          { cmd: 'cmd', args: ['/c', 'start', '', 'ZCode.exe'] },
          {
            cmd: join(process.env.LOCALAPPDATA || '', 'Programs', 'ZCode', 'ZCode.exe'),
            args: [],
          },
        ]
      : isMac
        ? [{ cmd: 'open', args: ['-a', 'ZCode'] }]
        : [
            // 优先走桌面项，这样能复用发行版配置的启动环境
            { cmd: 'gtk-launch', args: ['zcode'] },
            { cmd: '/opt/ZCode/zcode', args: [] },
          ];

    for (const att of attempts) {
      if (!att.cmd) continue;
      const r = await spawnDetached(att.cmd, att.args);
      if (!r.ok) {
        errors.push(`${att.cmd}: ${r.error || 'unknown'}`);
        continue;
      }

      // spawn 成功只代表进程创建成功，不代表窗口真的出现了
      // （单实例机制下新进程会立刻退出）。这里做一次短轮询确认。
      // force:true 绕过检测缓存，否则前 5 秒会一直读到旧值。
      for (let i = 0; i < 8; i += 1) {
        await new Promise((res) => setTimeout(res, 1000));
        if (await isZcodeDesktopRunning({ force: true })) {
          return {
            launched: true,
            via: att.cmd,
            confirmed: true,
            alreadyRunning: wasRunning,
          };
        }
      }

      // 没检测到进程，但启动请求已经发出去了 —— 不判定为失败，
      // 慢机器上冷启动可能更久，且单实例下"进程消失"也是正常结果。
      return {
        launched: true,
        via: att.cmd,
        confirmed: false,
        alreadyRunning: wasRunning,
        reason: wasRunning
          ? '已向运行中的桌面端发送激活请求；若窗口未出现，请查看系统托盘'
          : '已发起启动，但暂未检测到进程，可能仍在启动中',
      };
    }

    return {
      launched: false,
      reason: '未能唤起桌面端，请手动打开',
      detail: errors.join('; ') || undefined,
    };
  }
}

/**
 * 以「完全脱离」的方式拉起一个 GUI 程序，只等它成功启动、不等它退出。
 *
 * 三个必须遵守的要点，都是实测踩过的坑：
 *   1. stdio 必须是 'ignore'。否则被启动的 GUI 进程会继承我们的 stdout/stderr 管道，
 *      当管道所有者（本服务）退出或关闭管道后，它再写日志就会拿到 EPIPE。
 *      实证：执行 gtk-launch 启 ZCode 时，ZCode 自己的启动日志直接打进了调用者的 stdout。
 *   2. 必须 detached + unref。GUI 是独立应用，本服务重启/退出不该带走它。
 *   3. 绝不能用 execFile 的 timeout。那个 timeout 到点会给被启动进程发 SIGTERM，
 *      而 GUI 冷启动要好几秒 —— 等于在它启动到一半时把它杀掉，
 *      症状正是「窗口起来了但会话一直加载中、远控连不上」。
 */
function spawnDetached(cmd, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    } catch (err) {
      resolve({ ok: false, error: `${err.code || ''} ${err.message}`.trim() });
      return;
    }
    let settled = false;
    const done = (ok, error) => {
      if (settled) return;
      settled = true;
      if (ok) child.unref();
      resolve({ ok, error });
    };
    child.once('error', (err) => done(false, `${err.code || ''} ${err.message}`.trim()));
    child.once('spawn', () => done(true));
  });
}

