// 控制台界面逻辑。所有主进程能力都通过 window.hub（preload 暴露）访问。

const $ = (id) => document.getElementById(id);

const el = {
  dot: $('dot'),
  pillText: $('pillText'),
  host: $('host'),
  port: $('port'),
  token: $('token'),
  codexBin: $('codexBin'),
  hostHint: $('hostHint'),
  closeHint: $('closeHint'),
  statusText: $('statusText'),
  healthText: $('healthText'),
  urlText: $('urlText'),
  log: $('log'),
  btnApply: $('btnApply'),
  btnStart: $('btnStart'),
  btnStop: $('btnStop'),
  btnExit: $('btnExit'),
  btnGenToken: $('btnGenToken'),
  btnRefreshHosts: $('btnRefreshHosts'),
  btnOpenBrowser: $('btnOpenBrowser'),
};

let hostOptions = []; // [{label, value}]
let running = false;

// ---------------------------------------------------------------- 工具

function toast(msg) {
  // 用日志区承载提示，避免额外引入通知组件
  appendLog(`[console] ${msg}`);
}

function appendLog(line) {
  el.log.textContent += line + '\n';
  // 只保留最近 3000 行，避免长时间运行后 DOM 过大
  const lines = el.log.textContent.split('\n');
  if (lines.length > 3000) {
    el.log.textContent = lines.slice(-2000).join('\n');
  }
  el.log.scrollTop = el.log.scrollHeight;
}

function currentHostValue() {
  const opt = hostOptions.find((o) => o.label === el.host.value);
  return opt ? opt.value : el.host.value.trim() || '127.0.0.1';
}

function updateHostHint() {
  const host = currentHostValue();
  if (host === '127.0.0.1' || host === 'localhost') {
    el.hostHint.textContent = '仅本机可访问，无需访问令牌。';
  } else if (host === '0.0.0.0') {
    el.hostHint.textContent =
      '监听所有网卡，同网段的手机/平板可访问；未填令牌时会自动生成一个。';
  } else {
    const label = el.host.value;
    const isTunnel = label.includes('VPN/隧道');
    el.hostHint.textContent = isTunnel
      ? `${host} 属于 VPN/隧道网卡，同网段的手机通常连不上。若要让其它设备访问，建议改选「局域网任意」。`
      : `只绑定 ${host}，仅该网段的设备可访问。想覆盖所有网段就选「局域网任意」。`;
  }
}

function computeUrl() {
  const host = currentHostValue();
  const shown = host === '0.0.0.0' ? '127.0.0.1' : host;
  const port = el.port.value.trim() || '8790';
  const token = el.token.value.trim();
  return `http://${shown}:${port}/${token ? '?token=' + encodeURIComponent(token) : ''}`;
}

// ---------------------------------------------------------------- 渲染

function renderStatus(st) {
  running = st.running;

  el.pillText.textContent = running ? '运行中' : '已停止';
  el.dot.className = 'dot' + (running ? ' ok' : '');

  el.statusText.textContent = running ? `运行中　pid ${st.pid}` : '未运行';
  el.closeHint.textContent = st.closeHint;
  el.urlText.textContent = running ? computeUrl() : '(服务未运行)';

  // 启动/停止互斥；退出按钮文案随服务状态切换
  el.btnStart.disabled = running;
  el.btnStop.disabled = !running;

  // 托盘不可用时不能收窗口（收起来就没有入口了），按钮如实说明
  if (running && st.trayAvailable === false) {
    el.btnExit.textContent = '最小化';
    el.btnExit.title = '系统托盘不可用，点击不会收起窗口（可在日志区查看原因）';
  } else {
    el.btnExit.textContent = running ? '最小化' : '退出';
    el.btnExit.title = running
      ? '最小化到托盘，服务继续运行'
      : '退出程序（服务未运行）';
  }
}

function renderHostOptions(options) {
  hostOptions = options;
  el.host.innerHTML = '';
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.label;
    opt.textContent = o.label;
    el.host.appendChild(opt);
  }
}

async function refreshHosts(keepValue) {
  const options = await window.hub.listHosts();
  const target = keepValue ?? currentHostValue();
  renderHostOptions(options);
  const match = options.find((o) => o.value === target);
  el.host.value = match ? match.label : options[0].label;
  updateHostHint();
}

async function refreshHealth() {
  if (!running) {
    el.healthText.textContent = '点「启动」拉起服务';
    return;
  }
  const h = await window.hub.health();
  if (!h) {
    el.healthText.textContent = 'HTTP 尚未就绪，若持续如此请查看下方日志';
    return;
  }
  const cx = h.codex && h.codex.available ? '可用' : '不可用';
  el.healthText.textContent = `Codex：${cx}　·　ZCode：${h.zcode || '?'}`;
}

let healthTimer = null;
function scheduleHealth() {
  clearInterval(healthTimer);
  healthTimer = setInterval(refreshHealth, 2500);
  refreshHealth();
}

// ---------------------------------------------------------------- 操作

async function loadInitial() {
  const st = await window.hub.getStatus();
  renderStatus(st);
  await refreshHosts(st.host);
  el.port.value = st.port;
  el.token.value = st.token;
  el.codexBin.value = st.codexBin || '';
  scheduleHealth();
}

/** 读取界面上的配置表单。 */
function readForm() {
  return {
    host: currentHostValue(),
    port: Number(el.port.value.trim()),
    token: el.token.value.trim(),
    codexBin: el.codexBin.value.trim(),
  };
}

/** 把主进程返回的配置回填到界面（令牌可能被自动生成）。 */
async function fillForm(cfg, generated) {
  if (!cfg) return;
  await refreshHosts(cfg.host);
  el.port.value = cfg.port;
  el.token.value = cfg.token;
  if (generated) {
    toast('已自动生成访问令牌（非本机监听必须设置），请妥善保存');
  }
}

async function applyConfig() {
  const r = await window.hub.applyConfig(readForm());
  toast(r.msg || (r.ok ? '配置已保存' : '配置保存失败'));
  await fillForm(r.config, r.generated);
  const st = await window.hub.getStatus();
  renderStatus(st);
}

async function start() {
  el.btnStart.disabled = true;
  try {
    // 启动会先应用界面上的配置，无需先点「应用配置」
    const r = await window.hub.start(readForm());
    toast(r.msg);
    await fillForm(r.config, r.generated);
  } finally {
    const st = await window.hub.getStatus();
    renderStatus(st);
    refreshHealth();
  }
}

async function stop() {
  el.btnStop.disabled = true;
  const r = await window.hub.stop();
  toast(r.msg);
  const st = await window.hub.getStatus();
  renderStatus(st);
}

/**
 * 退出/最小化：服务未运行则退出应用，运行中则最小化到托盘。
 * 实际行为由主进程按服务状态判定，界面只负责显示提示。
 */
async function exitApp() {
  const r = await window.hub.exit();
  if (r && r.msg) toast(r.msg);
}

// ---------------------------------------------------------------- 事件绑定

function bind() {
  el.host.addEventListener('change', updateHostHint);

  // 端口/令牌变化时同步刷新展示用的 URL
  el.port.addEventListener('input', () => {
    if (running) el.urlText.textContent = computeUrl();
  });
  el.token.addEventListener('input', () => {
    if (running) el.urlText.textContent = computeUrl();
  });

  el.btnApply.addEventListener('click', applyConfig);
  el.btnStart.addEventListener('click', start);
  el.btnStop.addEventListener('click', stop);
  el.btnExit.addEventListener('click', exitApp);
  el.btnOpenBrowser.addEventListener('click', () => window.hub.openBrowser());

  el.btnGenToken.addEventListener('click', async () => {
    el.token.value = await window.hub.genToken();
    toast('已生成新的随机令牌');
  });

  el.btnRefreshHosts.addEventListener('click', async () => {
    await refreshHosts();
    toast('网卡列表已刷新');
  });

  // 主进程推送的状态与日志
  window.hub.onStatus((st) => {
    renderStatus(st);
    if (st.host !== undefined && !el.port.value) loadInitial();
  });
  window.hub.onLog((line) => appendLog(line));
}

bind();
loadInitial();
