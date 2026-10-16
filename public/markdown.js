// 轻量 Markdown 渲染器（零依赖）。
//
// 安全前提（会话内容来自模型输出，按不可信内容处理）：
//   1. 所有文本先做 HTML 转义，再做结构与行内替换，绝不把原文当 HTML 插入；
//   2. 链接只放行 http/https/mailto 与相对路径，其它协议（javascript:、data: 等）拒绝；
//   3. 不自动加载远程图片 —— ![]() 渲染成可点击的链接而不是 <img>，
//      避免模型输出直接向第三方发起请求、泄露 IP 与浏览行为；
//   4. 不使用 innerHTML 拼接未转义内容，生成的标签全部由本模块控制。
//
// 支持范围（覆盖模型输出里的常见写法）：
//   标题 / 粗体 / 斜体 / 删除线 / 行内代码 / 围栏代码块 / 有序与无序列表（含嵌套、
//   任务清单）/ 引用 / 分割线 / 链接 / 表格 / 段落换行。

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

/** 只放行安全协议；返回 null 表示该链接不可用。 */
function safeHref(raw) {
  const url = String(raw || '').trim();
  if (!url) return null;
  // 明确拒绝带协议的伪协议（含大小写与空白混淆，如 "java\nscript:"）
  const compact = url.replace(/[\u0000-\u0020]/g, '');
  const scheme = compact.match(/^([a-z][a-z0-9+.-]*):/i);
  if (scheme) {
    const s = scheme[1].toLowerCase();
    return s === 'http' || s === 'https' || s === 'mailto' ? url : null;
  }
  // 无协议：视为相对路径；但以 // 开头的是协议相对 URL，按当前协议处理 → 放行
  return url;
}

function renderInline(raw) {
  const stash = [];
  const keep = (html) => {
    stash.push(html);
    return `\u0000S${stash.length - 1}\u0000`;
  };
  const restore = (text) => {
    let out = text;
    // 占位符可能嵌套（如链接文本里还有行内代码），循环还原到稳定
    for (let guard = 0; guard < 6; guard += 1) {
      if (!out.includes('\u0000S')) break;
      out = out.replace(/\u0000S(\d+)\u0000/g, (_, idx) => stash[Number(idx)] ?? '');
    }
    return out;
  };

  let text = String(raw ?? '');

  // 1) 先摘出行内代码，其中的 * _ [ ] 等不应被当作标记
  text = text.replace(/(`+)([\s\S]*?)\1/g, (_, __, code) => {
    const trimmed = String(code).replace(/^ (.*) $/, '$1');
    return keep(`<code>${escapeHtml(trimmed)}</code>`);
  });

  // 2) 从这里开始进入“已转义”语境
  text = escapeHtml(text);

  // 3) 图片：渲染为链接而非自动加载
  text = text.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
    (_, alt, url) => {
      const href = safeHref(url);
      const label = `🖼 ${alt || '图片'}`;
      return href
        ? keep(`<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`)
        : label;
    },
  );

  // 4) 普通链接
  text = text.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
    (_, label, url) => {
      const href = safeHref(url);
      if (!href) return label;
      return keep(
        `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`,
      );
    },
  );

  // 5) 裸 URL 也变成链接（去掉尾部标点，避免把句号吞进链接）
  text = text.replace(
    /(^|[\s(（\[>])(https?:\/\/[^\s<>()（）\[\]]+)/g,
    (_, pre, url) => {
      const trimmed = url.replace(/[.,;:!?、。]+$/u, '');
      const tail = url.slice(trimmed.length);
      return `${pre}${keep(
        `<a href="${escapeHtml(trimmed)}" target="_blank" rel="noopener noreferrer">${trimmed}</a>`,
      )}${tail}`;
    },
  );

  // 6) 强调。先处理三连与双连，避免 ** 被单星号规则拆开
  text = text
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[\s(（])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[\s(（])_([^_\n]+)_/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  // 7) 行内换行
  text = text.replace(/ {2,}$/gm, '<br>');

  return restore(text);
}

const RE_FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+.#-]*)\s*$/;
const RE_HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RE_HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const RE_QUOTE = /^\s{0,3}>\s?(.*)$/;
const RE_UL = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const RE_TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/;

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

/**
 * 把 Markdown 源文渲染为 HTML 字符串。
 * 输出中所有文本都经过转义，可安全赋给 innerHTML。
 */
export function renderMarkdown(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let para = [];
  // 列表栈：记录当前打开的 ul/ol 及其缩进
  let listStack = [];

  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p>${renderInline(para.join('\n')).replace(/\n/g, '<br>')}</p>`);
    para = [];
  };

  // 关闭一层列表：先收起该层未闭合的 li，再闭合列表标签
  const closeLevel = () => {
    const lvl = listStack.pop();
    if (!lvl) return;
    if (lvl.liOpen) out.push('</li>');
    out.push(lvl.type === 'ol' ? '</ol>' : '</ul>');
  };
  // 把所有缩进深于 indent 的层收掉
  const closeListsTo = (indent) => {
    while (listStack.length && listStack[listStack.length - 1].indent > indent) closeLevel();
  };
  const closeAllLists = () => {
    while (listStack.length) closeLevel();
  };

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块
    const fence = line.match(RE_FENCE);
    if (fence) {
      flushPara();
      closeAllLists();
      const marker = fence[1][0];
      const lang = fence[2] || '';
      const body = [];
      i += 1;
      while (i < lines.length) {
        const nxt = lines[i];
        const close = nxt.match(RE_FENCE);
        if (close && close[1][0] === marker) {
          i += 1;
          break;
        }
        body.push(nxt);
        i += 1;
      }
      const cls = lang ? ` class="lang-${escapeHtml(lang)}"` : '';
      const label = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : '';
      out.push(
        `<div class="md-code">${label}<button class="code-copy" type="button" data-copy>复制</button>` +
          `<pre><code${cls}>${escapeHtml(body.join('\n'))}</code></pre></div>`,
      );
      continue;
    }

    // 空行
    if (!line.trim()) {
      flushPara();
      closeAllLists();
      i += 1;
      continue;
    }

    // 分割线
    if (RE_HR.test(line)) {
      flushPara();
      closeAllLists();
      out.push('<hr>');
      i += 1;
      continue;
    }

    // 标题
    const heading = line.match(RE_HEADING);
    if (heading) {
      flushPara();
      closeAllLists();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    // 引用（连续行合成一个 blockquote，内部可再包含列表等）
    if (RE_QUOTE.test(line)) {
      flushPara();
      closeAllLists();
      const buf = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) {
        buf.push(lines[i].match(RE_QUOTE)[1]);
        i += 1;
      }
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
      continue;
    }

    // 表格：当前行含 | 且下一行是分隔行
    if (line.includes('|') && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1])) {
      flushPara();
      closeAllLists();
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      const th = head.map((c) => `<th>${renderInline(c)}</th>`).join('');
      const trs = rows
        .map((r) => {
          const tds = [];
          for (let c = 0; c < head.length; c += 1) {
            tds.push(`<td>${renderInline(r[c] ?? '')}</td>`);
          }
          return `<tr>${tds.join('')}</tr>`;
        })
        .join('');
      out.push(`<div class="md-table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>`);
      continue;
    }

    // 列表（含嵌套与任务清单）
    const item = line.match(RE_UL);
    if (item) {
      flushPara();
      const indent = item[1].replace(/\t/g, '    ').length;
      const ordered = /^\d/.test(item[2]);
      const type = ordered ? 'ol' : 'ul';
      const startAttr = ordered ? ` start="${Number.parseInt(item[2], 10) || 1}"` : '';

      // 缩进变浅：把更深的层收掉
      closeListsTo(indent);

      const top = listStack[listStack.length - 1];
      if (!top || top.indent < indent) {
        // 进入更深一层：父层的 <li> 保持打开，新列表嵌在它内部（形成合法嵌套）
        out.push(ordered ? `<ol${startAttr}>` : '<ul>');
        listStack.push({ type, indent, liOpen: false });
      } else if (top.type !== type) {
        // 同缩进但列表类型变了：换一个列表
        closeLevel();
        out.push(ordered ? `<ol${startAttr}>` : '<ul>');
        listStack.push({ type, indent, liOpen: false });
      } else if (top.liOpen) {
        // 同层的下一个条目
        out.push('</li>');
      }

      let content = item[3];
      let checkbox = '';
      const task = content.match(/^\[([ xX])\]\s+(.*)$/);
      if (task) {
        checkbox = `<input type="checkbox" disabled${task[1].toLowerCase() === 'x' ? ' checked' : ''}> `;
        content = task[2];
      }

      // 收集条目的续行。两类内容分开处理：
      //   - 普通续行 → 并入本条目的行内文本；
      //   - 缩进的代码块 → 作为块级元素直接输出（它不能塞进 <li> 的行内文本里）；
      // 子列表（更深的列表项）不在这里处理，留给外层循环按缩进嵌套。
      const inlineParts = [];
      const blockParts = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        if (RE_UL.test(next)) break; // 子列表

        if (RE_FENCE.test(next)) {
          const inner = next.match(RE_FENCE);
          const marker = inner[1][0];
          const lang = inner[2] || '';
          const buf = [];
          i += 2;
          while (i < lines.length) {
            const cl = lines[i].match(RE_FENCE);
            if (cl && cl[1][0] === marker) break;
            buf.push(lines[i].replace(/^\s{2,}/, ''));
            i += 1;
          }
          const label = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : '';
          blockParts.push(
            `<div class="md-code">${label}<button class="code-copy" type="button" data-copy>复制</button>` +
              `<pre><code>${escapeHtml(buf.join('\n'))}</code></pre></div>`,
          );
          continue;
        }

        if (!next.trim()) {
          // 空行后还有更深缩进的内容才算同一条目，否则本条目结束
          const after = lines[i + 2];
          if (after && after.trim() && /^\s{2,}/.test(after) && !RE_UL.test(after)) {
            inlineParts.push('');
            i += 1;
            continue;
          }
          break;
        }
        if (!/^\s{2,}/.test(next)) break; // 顶格内容不属于本条目
        inlineParts.push(next.trim());
        i += 1;
      }

      const inlineHtml = renderInline([content, ...inlineParts].join('\n')).replace(/\n/g, '<br>');
      // 先不闭合 li：紧随其后的更深层列表会嵌进来；否则下一轮或收尾时闭合
      out.push(`<li>${checkbox}${inlineHtml}`);
      for (const block of blockParts) out.push(block);
      listStack[listStack.length - 1].liOpen = true;
      i += 1;
      continue;
    }

    // 普通段落
    closeAllLists();
    para.push(line);
    i += 1;
  }

  flushPara();
  closeAllLists();
  return out.join('\n');
}
