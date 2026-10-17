// 前端：Codex 会话浏览器 + 驱动器，以及 ZCode 官方远控页的承载与切换。
//
// 数据来源：
//   - REST 拉取（会话列表 / 历史 / 模型）
//   - SSE 推送（/api/events）：codex-notification、codex-request（审批）、codex-driver、log
// 流式渲染策略：item/started 建占位，*delta 追加，item/completed 用最终值覆盖。

import { renderMarkdown } from './markdown.js';

const TOKEN = new URLSearchParams(location.search).get('token') || '';
const qs = (obj) => new URLSearchParams(Object.entries(obj).filter(([, v]) => v != null)).toString();

// 拿到令牌后立刻把它从地址栏抹掉。
// 服务端在首次带 ?token= 访问时已种下 HttpOnly Cookie，后续请求（含 SSE）会自动携带，
// 所以 URL 里不再需要它；留在 URL 里会进入浏览器历史，并可能随 Referer 泄露给第三方。
if (TOKEN) {
  try {
    const clean = new URL(location.href);
    clean.searchParams.delete('token');
    const q = clean.searchParams.toString();
    history.replaceState(null, '', clean.pathname + (q ? `?${q}` : '') + clean.hash);
  } catch {
    /* 忽略：纯属体验优化，失败不影响功能 */
  }
}

async function api(path, { method = 'GET', body, timeoutMs = 60000 } = {}) {
  const url = `/api${path}${path.includes('?') ? '&' : '?'}${TOKEN ? `token=${encodeURIComponent(TOKEN)}` : ''}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      const err = new Error(data.reason || data.error || `HTTP ${res.status}`);
      err.payload = data;
      err.status = res.status;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- 状态

const state = {
  threads: [],
  cursor: null,
  activeThreadId: null,
  activeThread: null,
  driver: { mode: 'none', threadId: null, activeTurnId: null, reason: null },
  models: [],
  model: null,
  permissionModes: new Map(),
  sendingThreadId: null,
  // item 渲染索引：itemId -> DOM 节点
  nodes: new Map(),
  // 当前 turn 的流式目标：turnId -> { agentItemId, agentEl }
  live: new Map(),
  requests: new Map(),
  // 乐观回显中的用户消息：[{ text, el }]
  pendingUser: [],
  // 用户手动展开过的思考块 id（默认折叠，展开后不被流式更新重置）
  expandedReasoning: new Set(),
  // Codex 原生项目（用于会话分组与新建时的目录候选）
  projects: [],
  // 折叠的分组 key
  collapsedGroups: new Set(),
  // 当前列表视图：active（默认）| archived
  view: 'active',
  // 展开了操作菜单的 threadId
  openMenuId: null,
  // 等待二次确认删除的 threadId
  confirmingDeleteId: null,
  zcode: { ready: false, url: null, placeholderHtml: null },
};

// ---------------------------------------------------------------- DOM

const $ = (id) => document.getElementById(id);
const els = {
  connDot: $('conn-dot'),
  driverPill: $('driver-pill'),
  threadList: $('thread-list'),
  threadSearch: $('thread-search'),
  threadTitle: $('thread-title'),
  threadMeta: $('thread-meta'),
  lockBadge: $('lock-badge'),
  btnRelease: $('btn-release'),
  btnInterrupt: $('btn-interrupt'),
  btnMore: $('btn-more'),
  btnNewThread: $('btn-new-thread'),
  newthreadWrap: $('newthread'),
  newthreadDir: $('newthread-dir'),
  newthreadCwd: $('newthread-cwd'),
  newthreadPermission: $('newthread-permission'),
  newthreadPermissionHint: $('newthread-permission-hint'),
  btnNewThreadCreate: $('btn-newthread-create'),
  stream: $('stream'),
  streamEmpty: $('stream-empty'),
  pending: $('pending'),
  input: $('input'),
  btnSend: $('btn-send'),
  modelSelect: $('model-select'),
  permissionSelect: $('permission-select'),
  permissionHint: $('permission-hint'),
  sendHint: $('send-hint'),
  zcodeBadge: $('zcode-badge'),
  zcodeHint: $('zcode-hint'),
  zcodeFrame: $('zcode-frame'),
  zcodePlaceholder: $('zcode-placeholder'),
  btnSidebar: $('btn-sidebar'),
  sidebar: $('thread-list-wrap'),
  sidebarBackdrop: $('sidebar-backdrop'),
  toasts: $('toasts'),
};

// ---------------------------------------------------------------- 工具

const PERMISSION_DESCRIPTIONS = {
  inherit: '沿用会话已有的权限设置',
  'read-only': '只读文件，不允许写入或联网，也不申请提权',
  'workspace-write': '允许修改工作区；联网或工作区外操作需按需审批',
  'full-access': '允许访问全部文件和网络，执行操作无需审批',
};

function permissionModeFor(threadId) {
  if (!threadId) return 'inherit';
  if (state.permissionModes.has(threadId)) return state.permissionModes.get(threadId);
  let mode;
  try { mode = localStorage.getItem(`codex-permission:${threadId}`); } catch { /* 禁用存储时使用内存 */ }
  return Object.hasOwn(PERMISSION_DESCRIPTIONS, mode) ? mode : 'inherit';
}

function rememberPermissionMode(threadId, mode) {
  state.permissionModes.set(threadId, mode);
  try { localStorage.setItem(`codex-permission:${threadId}`, mode); } catch { /* 不影响当前页面切换 */ }
}

function updatePermissionUi() {
  const mode = permissionModeFor(state.activeThreadId);
  const locked = state.driver.threadId === state.activeThreadId && state.driver.mode === 'locked';
  const selected = state.activeThread?.id === state.activeThreadId && Boolean(state.activeThreadId);
  els.permissionSelect.value = mode;
  els.permissionSelect.disabled = !selected || locked || Boolean(state.sendingThreadId);
  els.permissionHint.classList.toggle('full-access', mode === 'full-access');
  els.permissionHint.textContent = !selected ? '选择会话后可设置权限' : locked
    ? '该会话被桌面端占用，请在桌面端修改权限'
    : mode === 'inherit' ? PERMISSION_DESCRIPTIONS[mode]
      : `${PERMISSION_DESCRIPTIONS[mode]}。下一轮发送时生效；运行中追加消息沿用当前轮次权限。`;
}

function updateNewThreadPermissionUi() {
  const mode = els.newthreadPermission.value;
  els.newthreadPermissionHint.textContent = PERMISSION_DESCRIPTIONS[mode];
  els.newthreadPermissionHint.classList.toggle('full-access', mode === 'full-access');
}

/**
 * 手机端会话列表抽屉的显隐。
 * 桌面端没有抽屉（侧栏常驻），这里改的类名不会产生任何视觉效果。
 */
function setSidebarOpen(open) {
  if (!els.sidebar) return;
  els.sidebar.classList.toggle('open', open);
  els.btnSidebar?.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function toggleSidebar() {
  setSidebarOpen(!els.sidebar?.classList.contains('open'));
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  els.toasts.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function fmtTime(sec) {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return `${Math.floor(diff / 60e3)} 分钟前`;
  if (diff < 86400e3) return `${Math.floor(diff / 3600e3)} 小时前`;
  return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function titleOf(thread) {
  if (thread.name) return thread.name;
  const p = (thread.preview || '').replace(/\s+/g, ' ').trim();
  return (p || thread.id).slice(0, 70);
}

function cwdShort(p) {
  if (!p) return '';
  const parts = p.split('/').filter(Boolean);
  return parts.slice(-2).join('/') || p;
}

function scrollToBottom(force = false) {
  const s = els.stream;
  const nearBottom = s.scrollHeight - s.scrollTop - s.clientHeight < 160;
  if (force || nearBottom) s.scrollTop = s.scrollHeight;
}

function esc(str) {
  return String(str ?? '');
}

// ---------------------------------------------------------------- 会话分组

/**
 * 把会话按「项目 / 目录」分组。
 *
 * 优先用 Codex 的原生项目：桌面端创建的项目有名字和 root 目录，thread 上的 projectId
 * 指向它（注意：在本服务里新建的 thread 会带 projectId，而更早的 thread 可能为 null，
 * 所以还要按 cwd 兜底匹配到项目）。
 * 匹配不到项目的会话，退回按 cwd 归到「目录」分组。
 */
function groupThreads(list) {
  const projects = state.projects || [];
  const byId = new Map(projects.map((p) => [p.id, p]));
  // cwd -> project：一个项目可能有多个 root，取最长匹配，避免父目录抢占子目录
  const rootIndex = [];
  for (const p of projects) {
    for (const root of p.roots || []) rootIndex.push({ root, project: p });
  }
  rootIndex.sort((a, b) => b.root.length - a.root.length);

  const findProjectByCwd = (cwd) => {
    if (!cwd) return null;
    for (const { root, project } of rootIndex) {
      if (cwd === root || cwd.startsWith(root.endsWith('/') ? root : `${root}/`)) return project;
    }
    return null;
  };

  const groups = new Map(); // key -> { key, kind, name, path, projectId, threads, sortKey }
  const orphanKey = (cwd) => `cwd:${cwd || '(无目录)'}`;

  for (const t of list) {
    let g;
    const byProjectId = t.projectId ? byId.get(t.projectId) : null;
    if (byProjectId) {
      g = { key: `proj:${byProjectId.id}`, kind: 'project', name: byProjectId.name, path: byProjectId.roots?.[0] || '', projectId: byProjectId.id };
    } else {
      const matched = findProjectByCwd(t.cwd);
      if (matched) {
        g = { key: `proj:${matched.id}`, kind: 'project', name: matched.name, path: matched.roots?.[0] || '', projectId: matched.id };
      } else {
        const cwd = t.cwd || '';
        g = { key: orphanKey(cwd), kind: 'dir', name: cwd ? cwdShort(cwd) : '其他', path: cwd, projectId: null };
      }
    }
    if (!groups.has(g.key)) groups.set(g.key, { ...g, threads: [], sortKey: 0 });
    const entry = groups.get(g.key);
    entry.threads.push(t);
    entry.sortKey = Math.max(entry.sortKey, t.recencyAt || t.updatedAt || 0);
  }

  const arr = [...groups.values()];
  for (const g of arr) {
    g.threads.sort((a, b) => (b.recencyAt || b.updatedAt || 0) - (a.recencyAt || a.updatedAt || 0));
  }
  // 有项目的分组排前（按 position），目录分组按最近活跃排后
  arr.sort((a, b) => {
    const pa = a.kind === 'project' ? (byId.get(a.projectId)?.position ?? 99) : 1000;
    const pb = b.kind === 'project' ? (byId.get(b.projectId)?.position ?? 99) : 1000;
    if (pa !== pb) return pa - pb;
    return b.sortKey - a.sortKey;
  });
  return arr;
}

function renderThreadItem(t) {
  const el = document.createElement('div');
  const archived = state.view === 'archived';
  el.className = 'thread' + (t.id === state.activeThreadId ? ' is-active' : '')
    + (state.openMenuId === t.id ? ' is-menu-open' : '');
  el.dataset.threadId = t.id;

  const busy = t.status?.type === 'active';
  const flags = (t.status?.activeFlags || []).join(',');
  const isConfirming = state.confirmingDeleteId === t.id;
  // locked: 会话被其它进程（桌面客户端 / 别的 app-server）独占。
  // 此时网关不能接管、也收不到它的审批请求，所以要提前提示去桌面处理。
  const locked = Boolean(t.locked) && !archived;

  if (locked) el.classList.add('is-locked');
  el.innerHTML = `
    <div class="row1">
      <span class="title"></span>
      <span class="time">${fmtTime(t.recencyAt || t.updatedAt)}</span>
      <button class="rowmenu" title="更多操作">⋯</button>
    </div>
    <div class="row2">
      <span class="cwd"></span>
      ${archived ? '<span class="busy">已归档</span>' : ''}
      ${locked ? '<span class="lockflag" title="该会话正被桌面客户端占用，需在桌面端处理审批；此处只能查看历史">🔒 桌面占用</span>' : ''}
      ${busy ? `<span class="busy">● 运行中${flags ? ' · ' + flags : ''}</span>` : ''}
    </div>`;
  el.querySelector('.title').textContent = titleOf(t);
  el.querySelector('.cwd').textContent = cwdShort(t.cwd);

  // 点行进会话；点 ⋯ 只开合菜单，不切换会话
  el.addEventListener('click', (e) => {
    if (e.target.closest('.rowmenu') || e.target.closest('.actions')) return;
    selectThread(t.id);
  });
  el.querySelector('.rowmenu').addEventListener('click', (e) => {
    e.stopPropagation();
    state.openMenuId = state.openMenuId === t.id ? null : t.id;
    state.confirmingDeleteId = null;
    renderThreadList();
  });

  if (state.openMenuId === t.id) {
    const bar = document.createElement('div');
    bar.className = 'actions';
    if (!archived) {
      const b = document.createElement('button');
      b.textContent = '归档';
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        archiveThread(t.id);
      });
      bar.appendChild(b);
    } else {
      const b = document.createElement('button');
      b.textContent = '恢复';
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        unarchiveThread(t.id);
      });
      bar.appendChild(b);
    }

    if (!isConfirming) {
      const d = document.createElement('button');
      d.className = 'del';
      d.textContent = '删除';
      d.addEventListener('click', (e) => {
        e.stopPropagation();
        state.confirmingDeleteId = t.id;
        renderThreadList();
      });
      bar.appendChild(d);
    } else {
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = '永久删除，不可恢复：';
      bar.appendChild(hint);

      const yes = document.createElement('button');
      yes.className = 'confirm-del';
      yes.textContent = '确认删除';
      yes.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteThread(t.id, titleOf(t));
      });
      bar.appendChild(yes);

      const no = document.createElement('button');
      no.textContent = '取消';
      no.addEventListener('click', (e) => {
        e.stopPropagation();
        state.confirmingDeleteId = null;
        renderThreadList();
      });
      bar.appendChild(no);
    }
    el.appendChild(bar);
  }

  return el;
}

async function archiveThread(threadId) {
  try {
    await api('/codex/archive', { method: 'POST', body: { threadId }, timeoutMs: 40000 });
    state.openMenuId = null;
    if (state.activeThreadId === threadId) {
      // 归档后无法再驱动，清掉当前打开状态
      state.activeThreadId = null;
      state.driver = { mode: 'none', threadId: null, activeTurnId: null, reason: null };
      updateDriverUi();
      els.threadTitle.textContent = '选择左侧会话';
      els.threadMeta.textContent = '或新建一个会话开始';
      resetStream();
      addMsg('sys', '该会话已归档。可在「已归档」视图里恢复。');
    }
    await loadThreads();
    toast('已归档', 'ok');
  } catch (err) {
    toast(`归档失败：${err.message}`, 'err');
  }
}

async function unarchiveThread(threadId) {
  try {
    await api('/codex/unarchive', { method: 'POST', body: { threadId }, timeoutMs: 40000 });
    state.openMenuId = null;
    state.confirmingDeleteId = null;
    // 会话已回到活动列表，如果还停在「已归档」视图，自动切回去，否则用户看不到恢复结果
    if (state.view === 'archived') {
      await switchView('active');
    } else {
      await loadThreads();
    }
    toast('已恢复到活动列表', 'ok');
  } catch (err) {
    toast(`恢复失败：${err.message}`, 'err');
  }
}

/** 切换 活动 / 已归档 视图。 */
async function switchView(view) {
  if (state.view === view) return;
  state.view = view;
  state.openMenuId = null;
  state.confirmingDeleteId = null;
  state.cursor = null;
  document.querySelectorAll('.viewtab').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.view === view);
  });
  els.btnNewThread.disabled = view === 'archived';
  els.btnNewThread.title = view === 'archived' ? '归档视图下不能新建会话' : '新建会话';
  await loadThreads();
}

async function deleteThread(threadId, title) {
  try {
    await api('/codex/delete', {
      method: 'POST',
      body: { threadId, confirm: true },
      timeoutMs: 90000,
    });
    state.openMenuId = null;
    state.confirmingDeleteId = null;
    if (state.activeThreadId === threadId) {
      state.activeThreadId = null;
      state.driver = { mode: 'none', threadId: null, activeTurnId: null, reason: null };
      updateDriverUi();
      els.threadTitle.textContent = '选择左侧会话';
      els.threadMeta.textContent = '或新建一个会话开始';
      resetStream();
      addMsg('sys', '该会话已被永久删除。');
    }
    // 归档视图里删掉最后一条后会剩一个空列表，切回活动视图更符合预期
    if (state.view === 'archived' && !state.threads.some((t) => t.id !== threadId)) {
      await switchView('active');
    } else {
      await loadThreads();
    }
    toast(`已永久删除：${String(title).slice(0, 24)}`, 'ok');
  } catch (err) {
    toast(`删除失败：${err.message}`, 'err');
  }
}

function renderThreadList() {
  const q = els.threadSearch.value.trim().toLowerCase();

  // 过滤时同时匹配「会话标题 / 目录」，以及命中所属分组名与项目目录，
  // 否则刚创建、标题还是 UUID 的会话按项目名搜索会搜不到。
  const groupOf = new Map(); // threadId -> group（用于按分组名匹配）
  if (q) {
    for (const g of groupThreads(state.threads)) {
      const gText = `${g.name} ${g.path || ''}`.toLowerCase();
      if (!gText.includes(q)) continue;
      for (const t of g.threads) groupOf.set(t.id, g);
    }
  }

  const list = state.threads.filter((t) => {
    if (!q) return true;
    if (groupOf.has(t.id)) return true;
    return `${titleOf(t)} ${t.cwd || ''}`.toLowerCase().includes(q);
  });

  els.threadList.innerHTML = '';
  if (!list.length) {
    els.threadList.innerHTML = '<div class="empty"><p>没有匹配的会话</p></div>';
    return;
  }

  const groups = groupThreads(list);
  for (const g of groups) {
    const wrap = document.createElement('div');
    wrap.className = 'group' + (state.collapsedGroups.has(g.key) ? ' is-collapsed' : '');

    const head = document.createElement('div');
    head.className = 'group-head';
    head.innerHTML = `
      <span class="caret">▼</span>
      <span class="gname"></span>
      <span class="gpath"></span>
      <span class="gcount"></span>`;
    head.querySelector('.gname').textContent = g.name;
    head.querySelector('.gpath').textContent = g.kind === 'project' ? cwdShort(g.path) : '';
    head.querySelector('.gcount').textContent = String(g.threads.length);
    head.title = g.path || g.name;
    head.addEventListener('click', () => {
      if (state.collapsedGroups.has(g.key)) state.collapsedGroups.delete(g.key);
      else state.collapsedGroups.add(g.key);
      renderThreadList();
    });

    const body = document.createElement('div');
    body.className = 'group-body';
    for (const t of g.threads) body.appendChild(renderThreadItem(t));

    wrap.appendChild(head);
    wrap.appendChild(body);
    els.threadList.appendChild(wrap);
  }
}

async function loadThreads({ append = false } = {}) {
  const archived = state.view === 'archived';
  const data = await api(
    `/codex/threads?${qs({
      limit: 30,
      cursor: append ? state.cursor : null,
      archived: archived ? 'true' : null,
    })}`,
  );
  const items = data.data || [];
  state.threads = append ? [...state.threads, ...items] : items;
  state.cursor = data.nextCursor || null;
  els.btnMore.disabled = !state.cursor;
  renderThreadList();
  els.threadList.scrollTop = append ? els.threadList.scrollTop : 0;
}

async function loadProjects() {
  try {
    const data = await api('/codex/projects', { timeoutMs: 30000 });
    state.projects = data.projects || [];
  } catch {
    state.projects = [];
  }
  renderThreadList();
  renderDirOptions();
}

/**
 * 新建会话的目录候选：优先列 Codex 已有项目的 root，其次是当前会话列表里出现过
 * 的 cwd，最后提供「自定义目录」让用户手填。
 */
function renderDirOptions() {
  const sel = els.newthreadDir;
  if (!sel) return;
  const seen = new Set();
  const opts = [];

  for (const p of state.projects) {
    for (const root of p.roots || []) {
      if (!root || seen.has(root)) continue;
      seen.add(root);
      opts.push({ value: root, label: `${p.name}`, sub: cwdShort(root), projectId: p.id });
    }
  }
  for (const t of state.threads) {
    const cwd = t.cwd || '';
    if (!cwd || seen.has(cwd)) continue;
    seen.add(cwd);
    opts.push({ value: cwd, label: cwdShort(cwd), sub: '', projectId: null });
  }

  const prev = sel.value;
  sel.innerHTML = '';
  for (const o of opts) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.sub ? `${o.label} — ${o.sub}` : o.label;
    opt.dataset.projectId = o.projectId || '';
    sel.appendChild(opt);
  }
  const custom = document.createElement('option');
  custom.value = '__custom__';
  custom.textContent = '自定义目录…';
  sel.appendChild(custom);
  const def = document.createElement('option');
  def.value = '__default__';
  def.textContent = '使用默认目录';
  sel.appendChild(def);

  // 尽量保持用户原来的选择
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
  syncDirInputVisibility();
}

function syncDirInputVisibility() {
  const sel = els.newthreadDir;
  const input = els.newthreadCwd;
  const isCustom = sel.value === '__custom__';
  input.hidden = !isCustom;
  if (isCustom) {
    input.focus();
  } else {
    input.value = '';
  }
}

// ---------------------------------------------------------------- 消息渲染

function resetStream() {
  els.stream.innerHTML = '';
  state.nodes.clear();
  state.live.clear();
  state.pendingUser.length = 0;
  state.expandedReasoning.clear();
}

/**
 * 添加一条消息。agent 的消息按 Markdown 渲染（模型几乎总是输出 Markdown），
 * 用户自己输入的内容按纯文本渲染，避免误把用户写的 # 或 * 变成格式。
 */
function addMsg(kind, text, { markdown = kind === 'agent' } = {}) {
  const el = document.createElement('div');
  el.className = `msg ${kind}`;
  el.innerHTML = `<div class="who"></div><div class="body"></div>`;
  const body = el.querySelector('.body');
  setMsgContent(body, text, markdown);
  els.stream.appendChild(el);
  scrollToBottom();
  return el;
}

/** 写入消息内容；markdown 为 true 时走渲染器，否则按纯文本。 */
function setMsgContent(body, text, markdown) {
  if (markdown) {
    body.classList.add('md');
    body.innerHTML = renderMarkdown(text);
  } else {
    body.classList.remove('md');
    body.textContent = text ?? '';
  }
}

function textOfUserInput(content) {
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => {
      if (c.type === 'text') return c.text;
      if (c.type === 'image') return `[图片 ${c.url || c.fileId || ''}]`;
      return `[${c.type}]`;
    })
    .join('\n');
}

function renderUserMessage(item, entry) {
  // 若这条与本地乐观回显对应，撤掉本地那条，只留服务端这一条。
  consumeOptimisticUser(textOfUserInput(item.content));
  const el = addMsg('user', textOfUserInput(item.content));
  el.querySelector('.who').textContent = '你';
  state.nodes.set(item.id, el);
}

function renderAgentMessage(item, entry) {
  const existing = state.nodes.get(item.id);
  const el = existing || addMsg('agent', '', { markdown: true });
  el.querySelector('.who').textContent = 'Codex';
  const body = el.querySelector('.body');
  // 若该节点已由流式 delta 填充过，不能用 item/started 里可能为空的快照覆盖，
  // 否则会把已经流出来的文字清掉；只有在拿到最终文本（item/completed）时才覆盖。
  const streamed = el.dataset.streamed === '1';
  const isFinal = Boolean(entry?.final);
  if (!streamed || isFinal) {
    setMsgContent(body, item.text ?? '', true);
    el.dataset.streamed = '0';
  }
  body.classList.remove('typing');
  state.nodes.set(item.id, el);
  return el;
}

/**
 * 思考过程：默认折叠，只显示一行摘要。展开状态由用户控制，流式更新不会把它重新收起来。
 * 结构只建一次（避免 innerHTML 重建丢掉展开状态），后续只更新标题与正文。
 */
function ensureReasoningEl(itemId) {
  let el = state.nodes.get(itemId);
  if (el) return el;

  el = document.createElement('details');
  el.className = 'reasoning-block';
  el.innerHTML = `
    <summary>
      <span class="rcaret" aria-hidden="true">▶</span>
      <span class="rlabel">思考过程</span>
      <span class="rmeta"></span>
      <span class="rpreview"></span>
    </summary>
    <div class="rbody"></div>`;
  el.open = state.expandedReasoning.has(itemId);
  el.addEventListener('toggle', () => {
    if (el.open) state.expandedReasoning.add(itemId);
    else state.expandedReasoning.delete(itemId);
  });

  els.stream.appendChild(el);
  state.nodes.set(itemId, el);
  return el;
}

/**
 * 更新思考块。text 是累积的原始文本；streaming 为 true 时标题显示进行中状态。
 * 折叠状态下只在标题里露一行摘要（单行截断），不展示全部内容。
 */
function paintReasoning(el, text, { streaming = false, startedAt = 0 } = {}) {
  el.dataset.raw = text;
  const body = el.querySelector('.rbody');
  const raw = String(text || '');
  const trimmed = raw.trim();

  if (!trimmed) {
    // 尚未产生内容：整体隐藏，避免流式开始时闪一个空块
    el.hidden = true;
    return;
  }
  el.hidden = false;

  if (streaming) {
    body.innerHTML = renderMarkdown(raw);
  } else {
    body.innerHTML = renderMarkdown(raw);
  }

  const lines = trimmed.split('\n').filter((l) => l.trim()).length;
  const seconds =
    !streaming && startedAt ? Math.max(1, Math.round((Date.now() - startedAt) / 1000)) : 0;

  const meta = el.querySelector('.rmeta');
  meta.textContent = streaming ? '进行中…' : `${seconds ? `${seconds} 秒 · ` : ''}${lines} 行`;

  const preview = el.querySelector('.rpreview');
  preview.textContent = trimmed.split('\n')[0].slice(0, 120);

  el.classList.toggle('is-streaming', Boolean(streaming));
  el.classList.toggle('is-open', el.open);
}

function renderReasoning(item, entry) {
  const text = [...(item.summary || []), ...(item.content || [])].join('\n');
  const existing = state.nodes.get(item.id);

  if (existing) {
    const streamed = existing.dataset.streamed === '1';
    if (!streamed || entry?.final) {
      paintReasoning(existing, text, {
        streaming: false,
        startedAt: Number(existing.dataset.startedAt) || 0,
      });
      existing.dataset.streamed = '0';
    }
    return existing;
  }

  if (!text.trim()) return undefined;
  const el = ensureReasoningEl(item.id);
  paintReasoning(el, text, { streaming: false, startedAt: Number(el.dataset.startedAt) || 0 });
  return el;
}

function renderTool(item) {
  const kind = item.type;
  let label = kind;
  let detail = '';
  let statusKind = '';
  let statusText = '';

  if (kind === 'commandExecution') {
    label = `$ ${item.command}`;
    detail = item.aggregatedOutput || '';
    statusText = item.status;
    statusKind = item.status === 'completed' ? 'ok' : item.status === 'failed' ? 'bad' : '';
  } else if (kind === 'fileChange') {
    label = `✎ ${(item.changes || []).map((c) => c.path).join(', ')}`;
    detail = (item.changes || [])
      .map((c) => `${c.path} (${c.kind}):\n${c.diff || ''}`)
      .join('\n\n');
    statusText = item.status;
    statusKind = item.status === 'completed' ? 'ok' : item.status === 'failed' ? 'bad' : '';
  } else if (kind === 'mcpToolCall') {
    label = `⚙ ${item.server}.${item.tool}`;
    detail = JSON.stringify({ arguments: item.arguments, result: item.result, error: item.error }, null, 2);
    statusText = item.status;
    statusKind = item.status === 'completed' ? 'ok' : item.status === 'failed' ? 'bad' : '';
  } else if (kind === 'webSearch') {
    label = `🔍 ${item.query}`;
  } else if (kind === 'plan') {
    label = `计划`;
    detail = item.text;
  } else if (kind === 'reasoning') {
    return renderReasoning(item);
  } else if (kind === 'userMessage' || kind === 'agentMessage') {
    return;
  } else {
    detail = JSON.stringify(item, null, 2);
  }

  const el = document.createElement('details');
  el.className = 'tool';
  el.innerHTML = `
    <summary>
      <span class="k"></span>
      ${statusText ? `<span class="status ${statusKind}">${statusText}</span>` : ''}
    </summary>
    <pre></pre>`;
  el.querySelector('.k').textContent = String(label).slice(0, 200);
  el.querySelector('pre').textContent = detail;
  els.stream.appendChild(el);
  state.nodes.set(item.id, el);
  scrollToBottom();
  return el;
}

function renderItem(item, entry) {
  if (state.nodes.has(item.id)) {
    // 已存在：按类型更新内容
    if (item.type === 'agentMessage') return renderAgentMessage(item, entry);
    if (item.type === 'reasoning') return renderReasoning(item, entry);
    const node = state.nodes.get(item.id);
    if (item.type === 'userMessage') {
      setMsgContent(node.querySelector('.body'), textOfUserInput(item.content), false);
      return node;
    }
    if (['commandExecution', 'fileChange', 'mcpToolCall'].includes(item.type)) {
      // 用完整条目重建，保证最终状态（输出/退出码）准确
      node.remove();
      state.nodes.delete(item.id);
      return renderTool(item, entry);
    }
    return node;
  }
  switch (item.type) {
    case 'userMessage':
      return renderUserMessage(item, entry);
    case 'agentMessage':
      return renderAgentMessage(item, entry);
    case 'reasoning':
      return renderReasoning(item);
    default:
      return renderTool(item, entry);
  }
}

// ---------------------------------------------------------------- 打开会话

async function selectThread(threadId, { silent = false } = {}) {
  state.activeThreadId = threadId;
  state.activeThread = null;
  updatePermissionUi();
  renderThreadList();
  resetStream();

  const data = await api(`/codex/thread?threadId=${encodeURIComponent(threadId)}`);
  if (state.activeThreadId !== threadId) return;
  const thread = data.thread;
  state.activeThread = thread;
  els.threadTitle.textContent = titleOf(thread);
  els.threadMeta.textContent = `${cwdShort(thread.cwd)} · ${thread.model || '默认模型'} · ${
    thread.status?.type || 'unknown'
  }`;

  els.streamEmpty.hidden = true;
  // 浏览是只读的：不主动抢占写入权，等到第一次发送时才尝试接管。
  // 但如果这个线程正是当前 driver 持有的，就保留驱动状态（例如新建后立刻打开）。
  if (data.locked) {
    state.driver = { mode: 'locked', threadId, activeTurnId: null, reason: '该会话正被桌面客户端占用' };
  } else if (data.driver?.alive && data.driver.threadId === threadId) {
    state.driver = { mode: 'driver', ...data.driver };
  } else if (state.driver.threadId !== threadId || state.driver.mode !== 'driver') {
    state.driver = { mode: 'none', threadId, activeTurnId: null, reason: null };
  }
  updateDriverUi();

  const items = await api(`/codex/items?threadId=${encodeURIComponent(threadId)}&limit=120`);
  if (state.activeThreadId !== threadId) return;
  const entries = items.data || [];
  if (!entries.length) {
    addMsg('sys', '（无历史消息）');
  }
  for (const entry of entries) renderItem(entry.item, entry);
  scrollToBottom(true);

  // 会话被其它进程独占时的提示。
  // 单写入者约束下，网关既拿不到写入权、也收不到该会话的审批请求（实测确认），
  // 所以这里明确说明"要去桌面处理"，而不是让用户点了发送才发现不行。
  if (data.locked) {
    state.driver = {
      mode: 'locked',
      threadId,
      activeTurnId: null,
      reason: '该会话正被桌面客户端占用',
    };
    updateDriverUi();
    const tip = document.createElement('div');
    tip.className = 'lock-banner';
    tip.textContent =
      '该会话正被桌面客户端占用：这里可以查看历史，但发送消息和审批都需在桌面端进行。' +
      '若想在此处接管，请先在桌面端关闭该会话（或退出桌面端）后重新打开本页。';
    els.stream.appendChild(tip);
    scrollToBottom();
  } else if (data.loadedHere) {
    state.driver = {
      mode: 'locked',
      threadId,
      activeTurnId: null,
      reason: '该会话已被另一个 app-server 加载',
    };
    updateDriverUi();
  }
  // 选中会话后收起抽屉，把空间让给消息区（桌面端无效果）
  if (!silent) setSidebarOpen(false);
}

// ---------------------------------------------------------------- 发送

/**
 * 把后端的「接管失败」结果映射到本地驱动状态。
 *
 * 后端在会话被其它进程独占时返回 mode:'readonly' + 占用原因；这里进一步区分为
 * mode:'locked'，因为两者的界面表现不同：locked 要禁用输入框（发了也白发），
 * readonly 只是不能写入但界面照常。
 *
 * @returns {boolean} 是否成功映射（payload 里带了 mode 才映射）
 */
function applyDriverFailure(payload, threadId) {
  if (!payload || !payload.mode) return false;
  const occupied =
    payload.mode === 'locked' ||
    /占用|active writer|active observer|已加载/i.test(payload.reason || '');
  state.driver = {
    mode: occupied ? 'locked' : payload.mode,
    threadId,
    activeTurnId: null,
    reason: payload.reason,
  };
  updateDriverUi();
  return true;
}

async function send() {
  const text = els.input.value.trim();
  const threadId = state.activeThreadId;
  if (!text || !threadId || state.sendingThreadId || state.activeThread?.id !== threadId) return;
  const permissionMode = permissionModeFor(threadId);

  // 已知被占用时不必走一遍"发送→失败"，直接说明该去哪处理
  if (state.driver.mode === 'locked' && state.driver.threadId === state.activeThreadId) {
    toast('该会话正被桌面客户端占用，请在桌面端发送消息与处理审批', 'err');
    return;
  }

  els.input.value = '';
  state.sendingThreadId = threadId;
  updateDriverUi();

  // 乐观回显：先插一条本地节点，等 app-server 回传真实的 userMessage item 时再撤掉，
  // 否则会出现“自己发的消息显示两遍”。
  const optimisticId = `optimistic-${Date.now()}`;
  const el = addMsg('user', text);
  el.querySelector('.who').textContent = '你 · 发送中';
  state.pendingUser.push({ text, el });
  state.nodes.set(optimisticId, el);

  try {
    const r = await api('/codex/send', {
      method: 'POST',
      body: { threadId, text, model: state.model, permissionMode },
      timeoutMs: 90000,
    });
    el.querySelector('.who').textContent = '你';
    if (state.activeThreadId === threadId) {
      state.driver = { mode: 'driver', threadId, activeTurnId: r.turnId || null, reason: null };
      updateDriverUi();
      if (r.permissionDeferred) toast('消息已追加；所选权限将在下一轮发送时生效');
    }
  } catch (err) {
    state.pendingUser = state.pendingUser.filter((p) => p.el !== el);
    el.querySelector('.who').textContent = '你 · 失败';
    const payload = err.payload || {};
    if (state.activeThreadId !== threadId || !applyDriverFailure(payload, threadId)) {
      toast(err.message, 'err');
    }
  } finally {
    state.sendingThreadId = null;
    // 该会话可能在此过程中被判定为被占用，交给 updateDriverUi 决定按钮是否可用
    updateDriverUi();
    if (!els.input.disabled) els.input.focus();
  }
}

/** 真实 userMessage 到达时，撤掉对应的乐观回显节点。 */
function consumeOptimisticUser(text) {
  if (!state.pendingUser.length) return false;
  const norm = (s) => String(s ?? '').trim();
  const idx = state.pendingUser.findIndex((p) => norm(p.text) === norm(text));
  if (idx < 0) return false;
  const [{ el }] = state.pendingUser.splice(idx, 1);
  el?.remove();
  return true;
}

async function interrupt() {
  if (!state.activeThreadId) return;
  try {
    await api('/codex/interrupt', {
      method: 'POST',
      body: { threadId: state.activeThreadId },
    });
    toast('已请求中断', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function releaseDriver() {
  try {
    await api('/codex/close', { method: 'POST' });
    state.driver = { mode: 'none', threadId: state.activeThreadId, activeTurnId: null, reason: null };
    updateDriverUi();
    // 释放后占用标记可能已变化（例如锁被别的进程接手），刷新列表
    loadThreads().catch(() => {});
    toast('已释放会话写入权', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

// ---------------------------------------------------------------- 驱动 UI

function updateDriverUi() {
  const d = state.driver;
  const isDriver = d.mode === 'driver' && d.threadId === state.activeThreadId;
  const isLocked = d.mode === 'locked' && d.threadId === state.activeThreadId;
  const running = isDriver && d.activeTurnId;

  if (isDriver) {
    els.lockBadge.className = 'badge driver';
    els.lockBadge.textContent = running ? '驱动中 · 运行中' : '驱动中 · 独占写入';
    els.lockBadge.hidden = false;
    els.btnRelease.hidden = false;
  } else if (isLocked) {
    els.lockBadge.className = 'badge locked';
    els.lockBadge.textContent = '🔒 桌面占用 · 仅可查看';
    els.lockBadge.hidden = false;
    els.btnRelease.hidden = true;
  } else if (d.mode === 'readonly') {
    els.lockBadge.className = 'badge ro';
    els.lockBadge.textContent = '只读（会话被占用）';
    els.lockBadge.hidden = false;
    els.btnRelease.hidden = true;
  } else {
    els.lockBadge.hidden = true;
    els.btnRelease.hidden = true;
  }

  els.btnInterrupt.hidden = !running;

  // 被占用时直接禁用输入框，避免用户白打一段字才被拒
  if (els.input) {
    els.input.disabled = isLocked;
    els.input.placeholder = isLocked
      ? '该会话被桌面端占用，请到桌面端发送消息与审批'
      : '输入消息…（Enter 发送，Shift+Enter 换行）';
  }
  if (els.btnSend) els.btnSend.disabled = isLocked || Boolean(state.sendingThreadId);
  updatePermissionUi();

  els.sendHint.textContent = isLocked
    ? '需在桌面端处理'
    : isDriver
      ? 'Enter 发送 · 运行中发送将插入当前轮次'
      : '发送时会自动尝试接管该会话';

  els.driverPill.textContent = isDriver
    ? `驱动 ${String(state.activeThreadId).slice(0, 8)}`
    : isLocked
      ? '桌面占用'
      : d.mode === 'readonly'
        ? '只读模式'
        : '未连接会话';
  els.driverPill.className = 'pill' + (isDriver ? ' live' : isLocked ? ' locked' : '');
}

// ---------------------------------------------------------------- 审批

function renderPending() {
  if (!state.requests.size) {
    els.pending.hidden = true;
    els.pending.innerHTML = '';
    return;
  }
  els.pending.hidden = false;
  els.pending.innerHTML = '';
  for (const [id, req] of state.requests) {
    const row = document.createElement('div');
    const p = req.params || {};
    let desc = req.method;
    if (req.method.includes('commandExecution')) desc = `命令审批：${p.command || ''}`;
    else if (req.method.includes('fileChange')) desc = '文件变更审批';
    else if (req.method.includes('requestUserInput')) desc = 'Codex 需要你补充信息';
    else if (req.method.includes('elicitation')) desc = `MCP 询问（${p.serverName || ''}）`;
    row.textContent = `${desc} `;

    const decisions =
      req.method.includes('commandExecution') || req.method.includes('fileChange')
        ? [
            ['accept', '允许'],
            ['acceptForSession', '本会话都允许'],
            ['decline', '拒绝'],
            ['cancel', '取消'],
          ]
        : [['accept', '确认'], ['decline', '拒绝']];

    for (const [value, label] of decisions) {
      const b = document.createElement('button');
      b.className = 'mini' + (value === 'decline' || value === 'cancel' ? ' danger' : '');
      b.textContent = label;
      b.addEventListener('click', () => respond(id, { decision: value }));
      row.appendChild(b);
    }
    els.pending.appendChild(row);
  }
}

async function respond(id, result) {
  try {
    await api('/codex/respond', { method: 'POST', body: { id, result } });
    state.requests.delete(id);
    renderPending();
  } catch (err) {
    toast(`应答失败：${err.message}`, 'err');
    state.requests.delete(id);
    renderPending();
  }
}

// ---------------------------------------------------------------- SSE

function connectEvents() {
  const src = new EventSource(`/api/events${TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ''}`);
  src.addEventListener('hello', () => {
    els.connDot.classList.add('ok');
  });
  src.addEventListener('log', (e) => {
    const d = JSON.parse(e.data);
    console.debug('[hub]', d.message);
  });
  // 服务端在检测到 ZCode 状态变化时主动推送，客户端无需轮询/手动刷新。
  // 桌面端被关闭、被启动、远控开或关，都会经由这里自动更新界面。
  src.addEventListener('zcode-status', (e) => {
    let s;
    try {
      s = JSON.parse(e.data);
    } catch {
      return;
    }
    applyZcodeStatus(s);
  });
  src.addEventListener('codex-driver', (e) => {
    const d = JSON.parse(e.data);
    if (d.state === 'released' || d.state === 'closed') {
      if (state.driver.threadId === d.threadId) {
        state.driver.mode = 'none';
        state.driver.activeTurnId = null;
        updateDriverUi();
      }
    }
  });
  src.addEventListener('codex-request', (e) => {
    const d = JSON.parse(e.data);
    state.requests.set(d.id, d);
    renderPending();
    toast(`Codex 需要确认：${d.method}`, '');
  });
  src.addEventListener('codex-notification', (e) => {
    handleNotification(JSON.parse(e.data));
  });
  src.addEventListener('error', () => {
    els.connDot.classList.remove('ok');
  });
  src.addEventListener('open', () => els.connDot.classList.add('ok'));
  return src;
}

function handleNotification({ method, params }) {
  if (!params) return;
  const active = params.threadId && params.threadId === state.activeThreadId;

  switch (method) {
    case 'item/started': {
      if (active) renderItem(params.item, { turnId: params.turnId });
      break;
    }
    case 'item/completed': {
      // final: 通知携带的是终态，可以覆盖流式累积的结果
      if (active) renderItem(params.item, { turnId: params.turnId, final: true });
      break;
    }
    case 'item/agentMessage/delta': {
      if (!active) break;
      let el = state.nodes.get(params.itemId);
      if (!el) {
        el = addMsg('agent', '', { markdown: true });
        el.querySelector('.who').textContent = 'Codex';
        state.nodes.set(params.itemId, el);
      }
      el.dataset.streamed = '1';
      const body = el.querySelector('.body');
      // 累积原始 Markdown 再整体渲染：Markdown 是有结构的（列表、代码块跨多行），
      // 逐片直接转 HTML 会把跨片的结构切坏。
      const acc = (el.dataset.raw || '') + params.delta;
      el.dataset.raw = acc;
      setMsgContent(body, acc, true);
      body.classList.add('typing');
      scrollToBottom();
      break;
    }
    case 'item/reasoning/textDelta':
    case 'item/reasoning/summaryTextDelta': {
      if (!active) break;
      const el = ensureReasoningEl(params.itemId);
      if (!el.dataset.startedAt) el.dataset.startedAt = String(Date.now());
      el.dataset.streamed = '1';
      // 累积原始文本再整体渲染：思考内容也可能含 Markdown 结构，逐片拼接会切坏
      paintReasoning(el, `${el.dataset.raw || ''}${params.delta}`, {
        streaming: true,
        startedAt: Number(el.dataset.startedAt),
      });
      scrollToBottom();
      break;
    }
    case 'item/commandExecution/outputDelta': {
      if (!active) break;
      let el = state.nodes.get(params.itemId);
      const pre = el?.querySelector('pre');
      if (pre) {
        pre.textContent += esc(params.delta);
        el.open = true;
        scrollToBottom();
      }
      break;
    }
    case 'turn/started': {
      if (active) {
        state.driver.activeTurnId = params.turn?.id || null;
        updateDriverUi();
      }
      break;
    }
    case 'turn/completed': {
      if (active) {
        state.driver.activeTurnId = null;
        updateDriverUi();
        for (const el of state.nodes.values()) el.querySelector?.('.typing')?.classList.remove('typing');
        if (params.turn?.error) {
          addMsg('err', `本轮失败：${params.turn.error.message || JSON.stringify(params.turn.error)}`);
        }
      }
      refreshThreadRow(params.threadId);
      break;
    }
    case 'thread/status/changed': {
      if (active && params.status?.type !== 'active') {
        state.driver.activeTurnId = null;
        updateDriverUi();
      }
      refreshThreadRow(params.threadId);
      break;
    }
    case 'error': {
      if (active) {
        addMsg('err', `${params.error?.message || 'error'}${params.willRetry ? '（将重试）' : ''}`);
      }
      break;
    }
    default:
      break;
  }
}

async function refreshThreadRow(threadId) {
  try {
    const data = await api(`/codex/thread?threadId=${encodeURIComponent(threadId)}`, { timeoutMs: 20000 });
    const idx = state.threads.findIndex((t) => t.id === threadId);
    if (idx >= 0 && data.thread) {
      state.threads[idx] = { ...state.threads[idx], ...data.thread };
      renderThreadList();
    }
  } catch {
    /* 忽略 */
  }
}

// ---------------------------------------------------------------- ZCode

/**
 * 把一份 ZCode 状态渲染到界面。
 *
 * 同时服务于两条数据通路：主动拉取（refreshZcode）与服务端推送（SSE zcode-status）。
 * 两条路走同一套渲染逻辑，避免显示不一致。
 *
 * @param {object} s 服务端 /api/zcode/status 的返回
 * @param {{silent?: boolean}} opts silent 时不改写按钮文案（轮询期间用）
 */
function applyZcodeStatus(s, { silent = false } = {}) {
  if (!s) return;
  state.zcode.ready = s.pairingReady;
  state.zcode.relayReady = s.relayReady;
  state.zcode.relayState = s.relayState;
  state.zcode.desktopRunning = s.desktopRunning;

  // 徽章按「就绪 → 桌面端未运行 → 未配对 → 桌面端已启动但远控未开」的顺序表达，
  // 把"桌面端没跑"排在靠前，因为这是用户最容易误解、也最容易自行解决的情况。
  let cls = 'badge';
  let text = '';
  if (s.relayReady) {
    cls += ' driver';
    text = `就绪 · ${s.deviceSidSuffix || ''}`;
  } else if (!s.desktopRunning && s.pairingReady) {
    cls += ' err';
    text = '桌面端未运行';
  } else if (!s.pairingReady && !s.desktopRunning) {
    cls += ' err';
    text = '未配对 · 桌面端未运行';
  } else if (!s.pairingReady) {
    cls += ' err';
    text = '未配对';
  } else {
    cls += ' ro';
    text = `待桌面端开启 · ${s.relayLabel || s.relayState}`;
  }
  els.zcodeBadge.className = cls;
  els.zcodeBadge.textContent = text;
  els.zcodeHint.textContent = s.hint || '';

  // 桌面端远控没跑起来时，把「内嵌」按钮改成更贴切的下一步提示
  if (!silent) {
    const embedBtn = document.getElementById('btn-zcode-embed');
    if (embedBtn) {
      embedBtn.textContent = s.relayReady || !s.pairingReady ? '内嵌' : '内嵌（并等待配对）';
    }
  }
}

/**
 * 主动拉取一次 ZCode 状态并渲染。
 * @param {{silent?: boolean}} opts silent 时不改变按钮文字等副作用，仅更新状态
 */
async function refreshZcode({ silent = false } = {}) {
  try {
    const s = await api('/zcode/status');
    applyZcodeStatus(s, { silent });
    return s;
  } catch (err) {
    els.zcodeBadge.className = 'badge err';
    els.zcodeBadge.textContent = '不可用';
    els.zcodeHint.textContent = err.message;
    return null;
  }
}

// ------------------------------------------------------------------ 自动轮询
//
// 唤起桌面端之后，桌面端要经历「进程起来 → host 就绪 → 连上 relay」几个阶段，
// 全程数秒到数十秒。这段时间不应让用户手动点刷新，所以点击唤起后自动轮询状态，
// 直到就绪或超时。
//
// 用一个自增的 generation 作令牌：新的轮询会作废旧的，避免多次点击时出现
// 多个轮询循环同时打接口。

let zcodePollToken = 0;

function stopZcodePolling() {
  zcodePollToken += 1;
}

/**
 * 启动状态轮询。
 * @param {{intervalMs?: number, timeoutMs?: number, onTick?: Function, onDone?: Function}} opts
 */
async function startZcodePolling({
  intervalMs = 2000,
  timeoutMs = 90000,
  onTick,
  onDone,
} = {}) {
  const myToken = ++zcodePollToken;
  const deadline = Date.now() + timeoutMs;
  let last = null;

  while (myToken === zcodePollToken && Date.now() < deadline) {
    last = await refreshZcode({ silent: true });
    if (myToken !== zcodePollToken) return null; // 已被新的轮询取代

    if (onTick) onTick(last);

    if (last && last.relayReady) {
      // 就绪：恢复完整的按钮文案并通知调用方
      await refreshZcode();
      if (myToken !== zcodePollToken) return null;
      onDone?.({ ok: true, status: last });
      return last;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  if (myToken !== zcodePollToken) return null;
  onDone?.({ ok: false, status: last });
  return last;
}

async function zcodeRemoteUrl() {
  const r = await api('/zcode/remote-url', { timeoutMs: 20000 });
  state.zcode.url = r.url;
  return r.url;
}

/**
 * 当前页面是否是「安全上下文」。
 *
 * 这直接决定内嵌远控页能否工作：官方页面用 crypto.subtle 计算 HMAC 证明
 * （见其 calculateProof），而 crypto.subtle 只在安全上下文存在。
 *   - http://127.0.0.1 与 http://localhost → 浏览器特批为安全上下文（可用）
 *   - http://<局域网IP>                    → 非安全上下文（crypto.subtle 为 undefined）
 * 后者会让 iframe 里的页面在配对时报 AUTH_FAILED，且无法用代码绕过。
 */
function isSecureContextForEmbed() {
  return typeof window !== 'undefined' && window.isSecureContext === true;
}

async function zcodeEmbed() {
  const s = await refreshZcode();

  // 非安全上下文时先给出明确解释，而不是让 iframe 里报一个看不懂的 AUTH_FAILED
  if (!isSecureContextForEmbed()) {
    els.zcodePlaceholder.hidden = false;
    els.zcodeFrame.classList.remove('on');
    // 记住原始占位内容，之后若地址变可用（或用户切换）能还原
    if (!state.zcode.placeholderHtml) {
      state.zcode.placeholderHtml = els.zcodePlaceholder.innerHTML;
    }
    els.zcodePlaceholder.innerHTML = '';

    const box = document.createElement('div');
    box.className = 'embed-blocked';
    const h = document.createElement('h3');
    h.textContent = '无法内嵌：当前不是安全上下文';
    const p1 = document.createElement('p');
    p1.textContent =
      '浏览器规定 crypto.subtle 只在安全上下文可用，而远控页用它计算配对证明。' +
      '当前通过局域网 IP 以 http 访问，因此该 API 被禁用。';
    const ul = document.createElement('ul');
    for (const t of [
      `改用 http://127.0.0.1:${location.port}/ 或 http://localhost:${location.port}/ 打开本页面`,
      '点上方「打开官方远控页」在新标签页使用（官方页是 https，不受此限制）',
      '或为本服务配置 HTTPS，再用 https 地址访问',
    ]) {
      const li = document.createElement('li');
      li.textContent = t;
      ul.appendChild(li);
    }
    box.append(h, p1, ul);
    els.zcodePlaceholder.appendChild(box);
    toast('当前 http 地址不是安全上下文，无法内嵌远控页；请用 127.0.0.1 或新标签页打开', 'err');
    return;
  }

  try {
    const url = await zcodeRemoteUrl();
    els.zcodeFrame.src = url;
    els.zcodeFrame.classList.add('on');
    els.zcodePlaceholder.hidden = true;
    // 桌面端还没连中继时，官方页面会自己停在“等待桌面端确认配对”，这里顺带轮询提示
    if (s && s.pairingReady && !s.relayReady) {
      toast('远控页已加载，正在等待桌面端开启远控…');
      zcodeWaitForRelay({ quiet: true });
    }
  } catch (err) {
    const p = err.payload || {};
    if (p.pairingReady === false) {
      toast('尚未配对：请先在 ZCode 桌面端开启「Web 远程控制」', 'err');
    } else {
      toast(`无法获取远控地址：${err.message}`, 'err');
    }
  }
}

/** 轮询等待桌面端把远控跑起来；成功后会刷新 iframe 让它重新配对。 */
async function zcodeWaitForRelay({ quiet = false } = {}) {
  try {
    const r = await api('/zcode/wait-pairing', { method: 'POST', body: {}, timeoutMs: 100000 });
    state.zcode.relayReady = true;
    state.zcode.url = r.url;
    await refreshZcode();
    if (!quiet) toast('桌面端已就绪，正在重新配对…', 'ok');
    if (els.zcodeFrame.classList.contains('on')) {
      els.zcodeFrame.src = r.url; // 重新加载，让页面立即完成配对
    }
    return r.url;
  } catch (err) {
    const p = err.payload || {};
    toast(p.reason || err.message, 'err');
    await refreshZcode();
    return null;
  }
}

async function zcodeOpenTab() {
  try {
    const url = await zcodeRemoteUrl();
    window.open(url, '_blank', 'noopener');
  } catch (err) {
    toast(err.message, 'err');
  }
}


// ---------------------------------------------------------------- 事件绑定

function bindUi() {
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('is-active', b === btn));
      const name = btn.dataset.tab;
      document.querySelectorAll('.pane').forEach((p) => {
        p.classList.toggle('is-active', p.id === `pane-${name}`);
      });
      // 会话列表只属于 Codex 面板；切到 ZCode 时隐藏菜单按钮并收起抽屉，
      // 否则按钮会去开一个已经不显示的面板里的抽屉。
      if (els.btnSidebar) els.btnSidebar.hidden = name !== 'codex';
      setSidebarOpen(false);
      if (name === 'zcode') refreshZcode();
    });
  });

  els.btnMore.addEventListener('click', () => loadThreads({ append: true }).catch((e) => toast(e.message, 'err')));
  els.threadSearch.addEventListener('input', renderThreadList);

  // 手机端：顶栏按钮拉出/收起会话列表抽屉，点遮罩或按 Esc 收起
  els.btnSidebar?.addEventListener('click', toggleSidebar);
  els.sidebarBackdrop?.addEventListener('click', () => setSidebarOpen(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setSidebarOpen(false);
  });
  // 旋转屏幕/拉宽窗口后抽屉已无意义（侧栏常驻），清掉状态避免残留遮罩
  const narrow = window.matchMedia('(max-width: 760px)');
  narrow.addEventListener('change', (e) => {
    if (!e.matches) setSidebarOpen(false);
  });

  // 代码块「复制」按钮（用事件委托，避免给每个块单独绑定）
  els.stream.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    const code = btn.closest('.md-code')?.querySelector('code');
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.textContent || '');
      const prev = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(() => { btn.textContent = prev; }, 1500);
    } catch {
      toast('复制失败，请手动选择文本', 'err');
    }
  });

  // 活动 / 已归档 视图切换
  document.querySelectorAll('.viewtab').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await switchView(btn.dataset.view);
      } catch (err) {
        toast(`加载列表失败：${err.message}`, 'err');
      }
    });
  });
  els.btnSend.addEventListener('click', send);
  els.btnInterrupt.addEventListener('click', interrupt);
  els.btnRelease.addEventListener('click', releaseDriver);
  els.permissionSelect.addEventListener('change', () => {
    if (!state.activeThreadId || els.permissionSelect.disabled) return;
    rememberPermissionMode(state.activeThreadId, els.permissionSelect.value);
    updatePermissionUi();
  });
  els.newthreadPermission.addEventListener('change', updateNewThreadPermissionUi);
  updateNewThreadPermissionUi();
  updatePermissionUi();
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  // 新建会话：内联表单（移动端不依赖 prompt 对话框）
  const newWrap = els.newthreadWrap;
  els.btnNewThread.addEventListener('click', () => {
    if (state.view === 'archived') {
      toast('归档视图下不能新建会话，请先切回「活动」', 'err');
      return;
    }
    newWrap.hidden = !newWrap.hidden;
    if (!newWrap.hidden) {
      renderDirOptions();
      els.newthreadDir.focus();
    }
  });
  $('btn-newthread-cancel').addEventListener('click', () => {
    newWrap.hidden = true;
  });
  els.newthreadDir.addEventListener('change', syncDirInputVisibility);

  async function createThread() {
    const sel = els.newthreadDir;
    const useCustom = sel.value === '__custom__';
    const useDefault = sel.value === '__default__';
    const cwd = useCustom ? els.newthreadCwd.value.trim() : useDefault ? '' : sel.value;
    const projectId = useCustom || useDefault ? null : sel.selectedOptions?.[0]?.dataset?.projectId || null;
    const permissionMode = els.newthreadPermission.value;

    if (useCustom && !cwd) {
      toast('请填写自定义目录路径', 'err');
      return;
    }

    const btn = els.btnNewThreadCreate;
    btn.disabled = true;
    btn.textContent = '创建中…';
    try {
      const r = await api('/codex/new-thread', {
        method: 'POST',
        body: { cwd: cwd || undefined, model: state.model || undefined, projectId: projectId || undefined,
          permissionMode },
        timeoutMs: 90000,
      });
      const id = r.thread?.id;
      if (id) {
        rememberPermissionMode(id, permissionMode);
        state.driver = { mode: 'driver', threadId: id, activeTurnId: null, reason: null };
        newWrap.hidden = true;
        els.newthreadCwd.value = '';
        await loadProjects();
        await loadThreads();
        await selectThread(id);
        toast(projectId ? '新会话已创建并归入所选项目' : '新会话已创建（由本页独占驱动）', 'ok');
      }
    } catch (err) {
      toast(`新建失败：${err.message}`, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '创建';
    }
  }

  els.btnNewThreadCreate.addEventListener('click', createThread);
  els.newthreadCwd.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createThread();
  });

  $('btn-zcode-open').addEventListener('click', zcodeOpenTab);
  $('btn-zcode-embed').addEventListener('click', zcodeEmbed);
  $('btn-zcode-reload').addEventListener('click', () => {
    if (els.zcodeFrame.classList.contains('on')) els.zcodeFrame.src = els.zcodeFrame.src;
    else refreshZcode();
  });
  $('btn-zcode-launch').addEventListener('click', async () => {
    const btn = $('btn-zcode-launch');
    btn.disabled = true;
    const prev = btn.textContent;

    // 记录点击前的状态：用于区分「本来就是就绪的」与「刚被我启动起来的」
    const wasReady = Boolean(state.zcode.relayReady);
    if (!wasReady) btn.textContent = '唤起中…';

    // 唤起之后，桌面端还要经历「进程起来 → host 就绪 → 连上 relay」，
    // 这里同时开始轮询，把阶段变化实时反映到按钮与徽章上，用户无需手动刷新。
    const polling = startZcodePolling({
      intervalMs: 2000,
      timeoutMs: 75000,
      onTick: (s) => {
        if (!s || s.relayReady) return; // 就绪时轮询会自行结束
        if (!s.desktopRunning) btn.textContent = '桌面端启动中…';
        else if (!s.pairingReady) btn.textContent = '等待开启远控…';
        else btn.textContent = '等待远控就绪…';
      },
      onDone: ({ ok, status }) => {
        if (ok) {
          toast(wasReady ? '窗口已调至前台（若未出现请查看系统托盘）' : '桌面端已就绪，可以开始使用', 'ok');
        } else if (status && status.desktopRunning) {
          toast('桌面端已启动，但远控仍未就绪：请在桌面端开启「Web 远程控制」', 'err');
        } else {
          toast('未能确认桌面端已启动，请检查是否已手动打开', 'err');
        }
      },
    });

    try {
      const r = await api('/zcode/launch-desktop', { method: 'POST', timeoutMs: 40000 });
      if (!r.launched) {
        toast(`唤起失败：${r.reason}${r.detail ? `（${r.detail}）` : ''}`, 'err');
        stopZcodePolling();
        return;
      }
      // 接口返回不代表已经就绪（还要等 host / relay），交给轮询继续跟踪
      if (!r.confirmed) {
        toast(r.reason || '已发起启动，正在检测状态…');
      }
      await polling;
    } catch (err) {
      toast(`唤起失败：${err.message}`, 'err');
      stopZcodePolling();
    } finally {
      btn.textContent = prev;
      btn.disabled = false;
    }
  });
  $('btn-zcode-wait').addEventListener('click', () => zcodeWaitForRelay());

  // 模型下拉
  els.modelSelect.addEventListener('change', () => {
    state.model = els.modelSelect.value || null;
  });
}

// ---------------------------------------------------------------- 启动

async function boot() {
  bindUi();
  connectEvents();
  refreshZcode();

  try {
    const m = await api('/codex/models', { timeoutMs: 30000 });
    state.models = m.data || [];
    els.modelSelect.innerHTML = '<option value="">默认模型</option>';
    for (const model of state.models) {
      const opt = document.createElement('option');
      opt.value = model.id;
      opt.textContent = model.displayName || model.id;
      els.modelSelect.appendChild(opt);
    }
  } catch (err) {
    els.sendHint.textContent = `Codex 不可用：${err.message}`;
  }

  // 项目用于会话分组与新建时的目录候选，先加载再渲染列表
  await loadProjects().catch(() => {});

  try {
    await loadThreads();
  } catch (err) {
    toast(`加载会话失败：${err.message}`, 'err');
  }
}

boot();
