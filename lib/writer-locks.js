// 会话写入者占用探测（跨平台）。
//
// 背景：Codex 的 app-server 对每个会话实行单写入者约束，靠
//   <codexHome>/thread-writer-locks/<threadId>.lock
// 这把文件锁协调。只要某个 app-server 进程加载（resume/start）过该会话，
// 它就一直持有这把锁，其它进程既不能接管、也收不到该会话的审批请求。
//
// 为什么不能只看文件是否存在：
//   锁文件是 0 字节且不会被删除——进程正常退出、被强杀、甚至崩溃后文件都留在那里，
//   所以"文件存在"完全不能说明有人占用。
//
// 跨平台探测策略：
//   - POSIX：用 flock -n 尝试非阻塞加锁，能拿到说明没人持有（文件只是残留）。
//   - Windows：Codex 用的是一种"独占打开"的文件锁。这里用「以独占方式打开」
//     来探测：能打开说明无人持有；报 EBUSY/EACCES/EPERM 说明被占用。
//     注意 Windows 上删除/重命名也会受占用影响，所以只做只读探测、不改动文件。
//
// 实测（Linux）该判定准确跟踪进程存活：进程被 SIGKILL 后立刻变为可获取。

import { execFile, execFileSync } from 'node:child_process';
import { existsSync, openSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex');
const LOCK_DIR = join(CODEX_HOME, 'thread-writer-locks');
const IS_WINDOWS = process.platform === 'win32';

/** 同步探测单个锁文件是否被持有（POSIX 用 flock，Windows 用独占打开）。 */
function isLockHeldSync(lockPath) {
  if (!existsSync(lockPath)) return false;

  if (IS_WINDOWS) {
    // Windows：以独占共享模式打开。被其它进程锁住时 Node 抛
    // EBUSY（资源忙）/EACCES/EPERM，据此判定占用。
    try {
      const fd = openSync(lockPath, 'r+');
      closeSync(fd);
      return false;
    } catch (err) {
      const code = err && err.code;
      if (code === 'EBUSY' || code === 'EACCES' || code === 'EPERM') return true;
      return false; // ENOENT 等竞争情况视为未占用
    }
  }

  // POSIX：flock -n 能拿到锁 → 没人持有
  try {
    execFileSync('flock', ['-n', lockPath, 'true'], { stdio: 'ignore', timeout: 4000 });
    return false;
  } catch {
    return true;
  }
}

/**
 * 批量探测哪些会话正被某个进程独占。
 * @param {string[]} threadIds
 * @returns {Promise<Set<string>>} 被占用的 threadId 集合
 */
export function probeHeldLocks(threadIds) {
  const ids = (threadIds || []).filter((x) => typeof x === 'string' && x);
  if (!ids.length) return Promise.resolve(new Set());

  if (IS_WINDOWS) {
    // Windows 没有 flock；逐个用独占打开探测。
    // 列表通常几十条，同步打开文件很快，无需额外进程开销。
    const held = new Set();
    for (const id of ids) {
      try {
        if (isLockHeldSync(join(LOCK_DIR, `${id}.lock`))) held.add(id);
      } catch {
        /* 单个失败不影响整体 */
      }
    }
    return Promise.resolve(held);
  }

  // POSIX：一次 shell 调用批量探测，避免为每个会话起一个进程
  const script = `
for t in "$@"; do
  f="$LOCK_DIR/$t.lock"
  if [ -e "$f" ] && ! flock -n "$f" true 2>/dev/null; then
    printf '%s\\n' "$t"
  fi
done`;
  return new Promise((resolve) => {
    execFile(
      'sh',
      ['-c', script, 'sh', ...ids],
      { timeout: 8000, env: { ...process.env, LOCK_DIR } },
      (err, stdout) => {
        if (err && !stdout) {
          // 探测失败（例如缺少 flock）：返回空集合，前端会退化为"不显示占用标记"，
          // 不会误报成占用。
          resolve(new Set());
          return;
        }
        const held = String(stdout || '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
        resolve(new Set(held));
      },
    );
  });
}

/** 单个会话是否被占用（用于保存前的复核）。 */
export async function isThreadHeld(threadId) {
  if (!threadId) return false;
  const held = await probeHeldLocks([threadId]);
  return held.has(threadId);
}

export function lockDirExists() {
  return existsSync(LOCK_DIR);
}
