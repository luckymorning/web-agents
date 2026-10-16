# ZCode + Codex 融合 Web 远控

一个零依赖的 Node 服务，把本机的 **ZCode** 与 **Codex** 两个编码 agent 的远程控制能力
聚合到同一个 Web 页面上，用 tab 切换。手机、平板、另一台电脑的浏览器都能用。

```
┌───────────── 浏览器（手机/平板/PC）─────────────┐
│  [Codex]  [ZCode]        ← 顶部 tab 切换        │
│   ┌──────────────┐  ┌─────────────────────────┐ │
│   │ 会话列表      │  │ 对话流 / 审批 / 输入框   │ │
│   └──────────────┘  └─────────────────────────┘ │
└────────────────────────┬───────────────────────┘
                         │ HTTP + SSE（本服务）
        ┌────────────────┴─────────────────┐
        ▼                                  ▼
  Codex app-server                  ZCode 官方远控页
  (JSON-RPC over stdio)             (zcode.z.ai/remote/v4)
        │                                  │
   本机 ~/.codex                     ZCode 中继 wss://zcode.z.ai/ws
   （thread 历史 + 写入者锁）                  │
                                    ZCode 桌面端（device 角色）
```

## 快速开始

支持 **Linux** 与 **Windows** 桌面端。**默认监听 `0.0.0.0`，同网段的手机/平板可直接访问。**

```bash
# Linux
./run.sh                # 启动控制台（带窗口 + 系统托盘，推荐）
./run.sh stop           # 停止服务
./run.sh status         # 查看状态
./run.sh start          # 后台启动服务（无界面）
./run.sh --server       # 前台运行服务（调试）

./run.sh start --host 127.0.0.1   # 只允许本机访问
```

启动后日志会直接给出可用地址（真实网卡会标出「手机/平板用这个」）：

```
[hub] ⚠️  已启用局域网访问，并自动生成访问令牌（已保存到 console-config.json）
[hub]     局域网: http://192.168.1.100:8790/?token=xxxx    (eth0) ←手机/平板用这个
[hub]     虚拟网卡: http://10.8.0.2:8790/?token=xxxx    (tun0)
[hub]     本机:   http://127.0.0.1:8790/?token=xxxx
[hub]     令牌:   xxxx
```

> **安全约束（重要）**：这个服务等价于本机 shell 权限 —— 能连上就能执行任意命令。
> 所以**非回环监听时强制要求访问令牌**：没有就自动生成一个强随机值并写入
> `console-config.json`（持久化是为了重启后令牌不变，否则已保存的链接会失效）。
> 自动生成的令牌会打印在启动日志里，控制台窗口也能看到。
>
> 若不需要局域网访问，用 `--host 127.0.0.1` 关闭；此时不会强制令牌，行为与以前一致。

```bat
:: Windows
run.bat                 :: 启动控制台（带窗口 + 托盘）
run.bat stop            :: 停止服务
run.bat status          :: 查看状态
run.bat start           :: 后台启动服务
run.bat --server        :: 前台运行服务（调试）

:: 首次使用建议先自检
python console\selftest_windows.py
```

### 平台依赖

| 组件 | Linux | Windows |
|---|---|---|
| Node.js | 必须 | 必须 |
| Python 3 + tkinter | 控制台需要 | 控制台需要（官方安装包自带） |
| 托盘 | `ubuntu-appindicators` 扩展（GNOME） | 系统自带（explorer.exe） |
| Pillow | 可选，缺省用系统图标 | 可选，缺省用系统图标 |

Windows 首次使用建议先跑 `python console\selftest_windows.py`，它会逐项检查
tkinter / Win32 API / 托盘模块 / explorer / Node / codex 路径 / ZCode 凭据，
并明确告诉你是哪一项阻塞。

## 桌面控制台

`./run.sh`（不带参数）会打开控制台窗口，用来管理服务配置与进程，无需手改命令行。

```
┌─ 远程控制网关 · 控制台 ──────────────────────────┐
│ 服务配置                                          │
│   监听地址 [仅本机 (127.0.0.1)      ▼] [刷新网卡] │
│   端口 [8790]                                     │
│   访问令牌 [___________] [随机生成]               │
│   Codex 路径 [___________________]                │
│                                                   │
│ ☑ 后台运行（关闭窗口时最小化到托盘）              │
│                        [应用配置][启动][停止][重启]│
│ 运行状态                                          │
│   ● 运行中（pid 12345）                           │
│   Codex：可用 | ZCode：ready                      │
│   http://127.0.0.1:8790/        [在浏览器打开]    │
│ 服务日志                                          │
│   …实时输出…                                      │
└───────────────────────────────────────────────────┘
```

### 关闭按钮的行为

由「后台运行」开关决定（**默认打开**）：

| 开关 | 点窗口关闭按钮的效果 |
|---|---|
| 打开（默认） | 窗口**最小化到系统托盘**，服务继续运行 |
| 关闭 | **停止服务并结束进程** |

### 托盘菜单

窗口最小化到托盘后，托盘图标提供两个菜单项：

- **打开** —— 弹出控制台窗口（左键点图标效果相同）；
- **退出** —— 停止服务，然后结束进程。

配置项存在 `console-config.json`，`server.js` 会读取它作为默认值，
所以控制台改完端口/令牌后点「重启」即可生效（命令行参数优先级更高）。

### 托盘实现说明

托盘层按平台分为两个独立实现，由 `console/tray.py` 作为分发器选择，
控制台只依赖统一接口（`register` / `wait_registered` / `set_tooltip` / `unregister`）：

| 平台 | 模块 | 机制 |
|---|---|---|
| Linux | `console/tray_linux.py` | D-Bus StatusNotifierItem + com.canonical.dbusmenu |
| Windows | `console/tray_win.py` | Shell_NotifyIcon + 隐藏消息窗口 + 弹出菜单 |

#### 为什么 Linux 要自己实现

- `gir1.2-ayatanaappindicator3` 常未安装，且安装需要管理员权限；
- `Dbusmenu` 的 GI 绑定虽存在，但它内部用独立的 GDBus 连接导出菜单，
  与 dbus-python 的 StatusNotifierItem 混用时同一 bus name 会被两条连接争抢，
  实测直接触发 `object_path != NULL` 断言失败。

所以统一走 Gio/GDBus，让图标与菜单落在同一条连接、同一个 bus name 下。
**托盘依赖桌面环境提供 `org.kde.StatusNotifierWatcher`**（GNOME 上由
`ubuntu-appindicators` 扩展提供）。

#### 为什么 Windows 要显式声明 Win32 原型

64 位 Windows 上 `HWND`/`HICON`/`HMENU` 是 64 位指针，而 ctypes 默认把返回值
当 32 位 int 处理，**会截断句柄并导致崩溃**。因此 `tray_win.py` 为用到的全部
27 个 Win32 函数显式设置了 `argtypes`/`restype`，这是该文件最重要的正确性保障。

Windows 侧另外两个要点：
- 托盘需要一个能收消息的窗口，这里用「消息专用窗口」（父窗口 `HWND_MESSAGE`），
  不显示、不占任务栏；
- 图标优先用 PIL 现场绘制并转成 HICON，失败则回退系统图标，保证托盘一定可见。

托盘交互（两平台一致）：**左键**点图标直接打开窗口，**右键**出菜单
（「打开」恢复窗口、「退出」停止服务并结束进程）。

#### 托盘不可用时的降级

控制台启动时会主动检测托盘可用性（Windows 视为始终可用）：

- 可用 → 正常注册，「后台运行」开关可用；
- 不可用 → 在界面日志里说明原因，并**在本次运行内临时禁用「后台运行」**
  （避免窗口收起后无法恢复）；**不会覆盖你保存的偏好**，等托盘恢复后自动生效。

Linux 排查方法：

```bash
# 宿主是否存在
busctl --user call org.freedesktop.DBus /org/freedesktop/DBus \
  org.freedesktop.DBus NameHasOwner s org.kde.StatusNotifierWatcher

# 扩展状态（已启用但 INACTIVE 时，重新登录会话即可恢复）
gnome-extensions info ubuntu-appindicators@ubuntu.com
```

> 技术细节：托盘回调运行在各自的循环线程（Linux: GLib 主循环；
> Windows: Win32 消息循环），而 tkinter 不是线程安全的 ——
> 直接调用 `root.after()` 会死锁（在 Linux 上实测表现为 D-Bus 调用超时），
> 所以两平台都通过线程安全队列把托盘事件投递给主线程处理。


## 两个 tab 的工作原理

### Codex tab —— 真正的双向控制

直接驱动本机 `codex app-server`（ChatGPT 桌面版内置的二进制）。实测确认的能力：

- **读**：`thread/list`（分页）、`thread/read`、`thread/turns/list`、`thread/items/list`
- **写**：`thread/start`（新建）、`turn/start`（发消息）、`turn/steer`（运行中插入）、
  `turn/interrupt`（中断）
- **项目**：`project/list`，用于会话分组与新建时选择目录
- **流**：`item/agentMessage/delta`、`item/commandExecution/outputDelta`、
  `item/reasoning/*Delta`、`turn/completed` 等通知，经 SSE 推到前端逐字渲染
- **审批**：服务端发起的 `item/commandExecution/requestApproval`、
  `item/fileChange/requestApproval`、`item/tool/requestUserInput` 等请求会转成页面上的
  按钮，点击即以同一 JSON-RPC id 应答

#### 会话按项目 / 目录分组

列表按 Codex 原生项目（桌面端创建的「项目」）分组，组头可折叠，显示组内会话数。

- 优先用 thread 上的 `projectId` 匹配项目；
- 老会话 `projectId` 为 null，则按 `cwd` 匹配项目的 root 目录（取最长匹配，
  避免父目录抢占子目录）；
- 都匹配不上时按 `cwd` 归入「目录」分组兜底。

新建会话时，目录下拉直接列出所有已有项目的 root（标为「项目名 — 目录」），
选中即把新会话归入该项目；也可选「自定义目录…」手填路径，或「使用默认目录」。

> 注意：`thread/start` 带 `projectId` 会立刻在响应里返回该项目，但此时线程还没写 rollout，
> 因此 `thread/list` 里看不到它、`thread/read` 的 `projectId` 读出来是 null
> （内部报 `no rollout found`）。跑过一次 turn 之后才落盘并持久生效。
> 本服务对这类"刚创建还没跑过 turn"的线程做本地登记，在列表和详情里补回
> `projectId`/`cwd`，所以新建后立刻就能出现在正确分组里。

搜索框同时匹配会话标题、目录，以及所属分组名与项目目录——这样刚创建、标题还是 UUID
的会话，按项目名也能搜到。

#### Markdown 预览

模型回复几乎总是 Markdown，所以会话内容是**渲染后的预览**而不是源码。支持标题、粗体/斜体/
删除线、行内代码、围栏代码块（带语言标签与一键复制）、有序与无序列表（含嵌套与任务清单）、
引用、分割线、链接、表格。

实现是零依赖的 `public/markdown.js`，自己写的解析器，因为会话内容属于不可信输入
（模型输出可能被 prompt 注入操纵），必须自己控制转义与过滤：

- 所有文本先 HTML 转义再做结构替换，绝不把原文当 HTML 插入；
- 链接只放行 `http` / `https` / `mailto` 与相对路径，`javascript:`、`data:`、`vbscript:`
  等一律拒绝（含大小写与空白字符混淆的变体）；
- **图片不作为图片加载**，`![](url)` 渲染成一个可点击的链接。否则模型输出就能让浏览器
  直接向任意外部地址发起请求，泄露 IP 与访问行为；
- 用户自己发的消息仍按纯文本渲染，避免内容里的 `#` 或 `*` 被误当格式。

流式输出时按"累积原始 Markdown 再整体重渲染"处理，而不是逐片转 HTML——Markdown 的结构
（列表、代码块）会跨多个数据片，逐片转换会把结构切坏。

#### 思考过程默认折叠

模型的思考过程（reasoning）默认折叠，只占一行：

```
▶ 思考过程   91 行 · We need answer detailed reasoning 123*456. Need compl…
```

- 折叠时只在标题露一行摘要（单行截断），不展示全部内容；点击展开才显示完整思考，
  展开后同样按 Markdown 渲染；
- 标题显示行数，完成后再补上耗时；流式生成期间显示「进行中…」并带一个脉动圆点，
  但**不会自动展开**——默认保持折叠，避免思考内容刷屏；
- 用户手动展开的块在流式更新中不会被重新收起（展开状态记在 `state.expandedReasoning`，
  且只创建一次 DOM 结构，不重建）；
- 无内容的空思考块整体隐藏，避免流式开始时闪一个空框。

这一行为对齐桌面端：思考过程默认收起，需要时再展开查看。

#### 会话被桌面端占用时的提示

Codex 是单写入者模型：某个会话只要被桌面客户端加载过，客户端就一直持有
`~/.codex/thread-writer-locks/<id>.lock` 这把文件锁，网关既不能接管、**也收不到该会话的
审批请求**（实测确认：客户端创建的会话，审批请求只发给客户端；网关侧用 `thread/read`
看状态是 `notLoaded`，用 `thread/list` 看不到 `waitingOnApproval` 标记，收到的通知里
也没有任何相关事件）。根源是审批属于"写者"职责，而写者身份由文件锁保证，
锁只在持有进程退出时才释放。

所以网关把这些会话在列表里标出来（🔒 桌面占用），打开时：

- 顶部徽章显示「🔒 桌面占用 · 仅可查看」；
- 消息流里插入一条说明，讲清"要接管需先在桌面端关闭该会话或退出桌面端"；
- 输入框与发送按钮直接禁用，占位符改为「该会话被桌面端占用，请到桌面端发送消息与审批」。

这样用户在点发送之前就知道该去哪处理，而不是打完一段字才失败。

> 注意：API 不暴露"正在等待审批"这个精确状态，所以只能提示"被占用"，
> 无法保证占用就是因为卡在审批上。

##### 探测手段

判定依据是**用 `flock` 尝试非阻塞获取该锁**，而不是看文件是否存在——锁文件是 0 字节且
从不被删除，进程正常退出、被强杀、崩溃后文件都留在原地，所以"文件存在"完全不能说明有人占用。

实测该判定准确跟踪进程存活：

| 场景 | 探测结果 |
|---|---|
| 进程持有锁 | `HELD` |
| 进程被 `SIGKILL` | `FREE`（文件仍在，但锁已释放） |
| 会话被删除 | 锁文件消失 |

实现见 `lib/writer-locks.js`：列表按批一次 shell 调用探测，避免为每个会话起进程；
探测失败时返回空集合（退化为不显示标记），不会误报成占用。

#### 归档与永久删除

会话列表顶部有「活动 / 已归档」两个视图。每行右侧的 ⋯ 展开操作菜单：

| 视图 | 可用操作 |
|---|---|
| 活动 | 归档、删除 |
| 已归档 | 恢复、删除 |

- **归档**（`thread/archive`）把会话移出活动列表，可随时在「已归档」视图里恢复。
  归档后 app-server 会拒绝 `resume`（`session ... is archived`），所以网关会同时释放
  持有它的 driver，避免留下"内存里还活着但再也驱动不了"的状态。
- **永久删除**（`thread/delete`）不可恢复，因此界面上需要点两次（「删除」→「确认删除」），
  API 侧也要求显式传 `confirm: true` 才执行。
- 删除或归档当前正在查看的会话时，右侧会自动清空并提示。
- 在「已归档」视图恢复某条会话后，界面会自动切回活动视图，否则用户看不到恢复结果。

这里同样要处理单写入者约束：`archive` / `unarchive` / `delete` 对**正被 driver 持有**的线程
调用时会报 `already has an active writer`，所以网关统一按"谁持有就找谁"来路由这些变更操作。
另外，刚创建、尚未写 rollout 的会话（磁盘上还不存在）归档会报 `no rollout found`，
对用户而言这就是"把这个临时会话移出列表"，网关按成功处理；重复归档也做成幂等，
避免二次点击报错。

#### 关键约束：单写入者

Codex 的一个线程同一时刻只能有一个"writer"，靠 `~/.codex/thread-writer-locks/<id>.lock`
协调，且 **`thread/unsubscribe` 不释放锁，只有持有者进程退出才释放**（陈旧锁会被自动清理）。
因此本服务拆成两个进程：

| 进程 | 用途 | 特点 |
|---|---|---|
| `reader` | 常驻，只做 list/read/查询 | 从不 `resume`，所以永远不占锁；任意会话随便浏览 |
| `driver` | 按需创建，只持有当前操作的那个线程 | 切换线程时杀掉旧进程重建，从而释放锁 |

由此得到的行为：**浏览任何会话都是只读的；发消息时才尝试接管，被占用时降级为只读并明确提示**
（不会静默失败，也不会去抢桌面正在用的会话）。

#### 其它实测细节

- **线程状态分两处**：被 app-server 加载的线程只存在于该进程内存，别的进程读会得到
  `thread not loaded`；已落盘的线程才能按 rollout 历史读。所以读操作按"driver 是否持有"
  路由到正确进程。
- **历史模式**：只有 `historyMode: "paginated"` 的线程支持 `turns/list` / `items/list`。
  本服务新建线程时显式指定该模式；遇到旧模式线程自动回退到 `thread/read?includeTurns=true`；
  零 turn 的新线程返回空列表而不是报错。

### ZCode tab —— 复用官方远控页面

ZCode 桌面端以 relay 的 **device** 角色连 `wss://zcode.z.ai/ws`，手机页面以 **terminal**
角色连同一个 relay，两端用 `passHash` 做 HMAC 挑战应答配对。自己实现 terminal 一侧不仅要复刻
认证，还要复刻 app payload（`workspace-bridge-*`、`rpc-frame` 分片 + CRC32 + ACK + 重放）
以及 host 侧 Channel RPC 的二进制序列化——成本高且随客户端版本漂移。

所以这里**直接复用官方页面**：桌面端的配对凭据在本地，读出并解密后拼成官方页面 URL
（`?sid=&hash=&t=&mid=&name=&app_version=`），用 iframe 或新标签页打开即可，无需重新扫码。

#### 凭据读取

| 项目 | 位置 |
|---|---|
| `deviceSid` | `~/.zcode/v2/setting.json` → `webRemoteControlExternalRelayDevice.deviceSid` |
| `passHash` | `~/.zcode/v2/credentials.json` → `web-remote-control:external-relay:pass_hash` |

`credentialService` 落盘前做信封加密：`enc:v1:<iv>.<authTag>.<ciphertext>`，
`aes-256-gcm`，密钥 `sha256(secret)`，
`secret = $ZCODE_CREDENTIAL_SECRET` 或 `zcode-credential-fallback:<平台>:<home>:<用户名>`。
本服务按同样规则解密，因此也能在设置了 `ZCODE_CREDENTIAL_SECRET` 的机器上工作。

#### 必须知道的一点

**凭据存在 ≠ 远控可用。** 桌面端还必须处于「远控运行中」并连上 relay（`waiting_terminal` /
`paired`），否则官方页面会停在"等待桌面端确认配对"。本服务从
`~/.zcode/v2/logs/<date>.log` 反向扫描 `[web-remote-control]` 记录来判定真实状态
（打包版 Electron 不开放调试端口，没有更权威的外部查询途径），并在页面上区分：

| 状态 | 页面表现 |
|---|---|
| 凭据缺失 | 提示去桌面端开启远控 |
| 凭据存在、桌面前端已连 relay | 显示"就绪"，正常使用 |
| 凭据存在、桌面远控已停止 | 显示"待桌面端开启"，按钮变为"内嵌（并等待配对）"，开启后自动完成配对 |

桌面端开启过一次后会把上下文写入 `webRemoteControlLastEnabledContext`，之后重启会自动恢复。

#### 内嵌远控页要求「安全上下文」

**通过局域网 IP 以 http 访问时，内嵌会失败并报 `AUTH_FAILED` —— 这是浏览器限制，无法用代码绕过。**

原因是官方远控页用 `crypto.subtle` 计算配对用的 HMAC 证明（与其 `calculateProof` 对应），
而 Web Crypto 只在**安全上下文**可用。浏览器对「安全上下文」的判定：

| 访问地址 | isSecureContext | crypto.subtle |
|---|---|---|
| `http://127.0.0.1:8790` | true | 可用 |
| `http://localhost:8790` | true | 可用 |
| `http://192.168.1.100:8790`（局域网 IP） | **false** | **undefined** |
| `https://...` | true | 可用 |

`127.0.0.1` 与 `localhost` 被浏览器特批为「潜在可信来源」，因此本机 http 也能用。
这也是为什么现象是「本机内嵌正常、局域网 IP 内嵌失败，但新标签页打开正常」
（新标签页是 `https://zcode.z.ai`，天然是安全上下文）。

点击内嵌时前端会先检测 `window.isSecureContext`，不满足就**直接给出原因与三种可用替代**，
而不是让 iframe 里抛出难懂的 `AUTH_FAILED`：

1. 改用 `http://127.0.0.1:8790/` 或 `http://localhost:8790/` 打开本页面；
2. 用「打开官方远控页」在新标签页使用；
3. 给本服务配置 HTTPS 后再以 https 访问。

#### 唤起桌面端

页面上的「唤起桌面端」按钮对应 `POST /api/zcode/launch-desktop`，它会在桌面端未运行时
把它拉起来。这里有几个容易踩的坑，都已修正：

**1. 绝不能用带 timeout 的 execFile。** 早先的实现是
`execFile(cmd, args, { timeout: 5000 })`，而 execFile 的 timeout 到点会给子进程发
`SIGTERM`。ZCode 冷启动要好几秒（要拉起 host、连 relay），结果就是**被启动到一半杀掉**，
表现为「窗口出现了，但项目目录下的会话一直卡在加载中，远程控制也连不上」。
对照实验验证过：同样一个需 6 秒启动的进程，旧实现会在第 5 秒收到 SIGTERM，
新实现能完整跑完。

**2. stdio 必须设为 `'ignore'`。** 否则被启动的 GUI 会继承本服务的 stdout/stderr 管道，
当服务重启或退出、管道关闭后，它再写日志就会拿到 EPIPE。实证：用默认管道启动时，
ZCode 自己的启动日志会直接打进本服务的 stdout。

**3. 进程已在运行时也要继续发起启动。** ZCode 是 Electron 应用，关闭窗口时进程常常
仍在后台驻留（托盘行为），此时「进程存在」不等于「窗口可见」。而用户点这个按钮的真实
意图是「把 ZCode 弄出来」。Electron 的单实例机制会把重复启动的请求转交给已有实例
（表现为激活/前置窗口），所以重复启动是安全且正是想要的行为。早先的实现直接
`if (running) return 失败`，导致用户看到「未唤起：桌面端已在运行」这种无用提示。

因此现在的实现是 `spawn(cmd, args, { detached: true, stdio: 'ignore' })`，
只等 `spawn` 事件确认进程创建成功，随后 `unref()` 放手 —— 不等待、不超时、不代为管理生命周期；
之后再短轮询（最多 8 秒）确认桌面端进程确实起来了，并把 `alreadyRunning` 一并返回，
前端据此给出准确提示。

> 排查提示：若唤起失败，接口会返回 `detail` 字段说明每种启动方式的具体错误
> （如 `ENOENT` 或 `spawn is not defined`），而不是只给一句「未能唤起」。

**4. 唤起后自动检测，无需手动刷新。** 桌面端启动后还要经历
「进程起来 → host 就绪 → 连上 relay」几个阶段，全程数秒到数十秒。点击唤起后前端会
自动轮询 `/api/zcode/status`，把阶段变化实时反映到按钮文案与状态徽章上：

| 阶段 | 按钮文案 | 徽章 |
|---|---|---|
| 进程未起 | 桌面端启动中… | 桌面端未运行 |
| 进程已起、远控未开 | 等待开启远控… | 待桌面端开启 · … |
| 已连 relay | （恢复）唤起桌面端 | 就绪 · xxxxxx |

为此 `/api/zcode/status` 增加了 `desktopRunning` 字段，用来区分「进程没起来」与
「进程起来了但远控未开启」——这两种情况的处理方式完全不同。

轮询用自增令牌（generation）作废过期循环：重复点击不会产生多个并发的轮询。
就绪后立即停止并提示；超时（75 秒）也会收敛并给出明确结论。
若点击时状态本来就已就绪，则只把窗口调到前台并立即返回，不做无意义的等待。

#### 桌面端状态变化自动推送

桌面端可能被用户随时关闭或启动，页面不应要求手动刷新才能看到变化。服务端每 3 秒
比对一次状态，**一有变化就通过 SSE 广播**给所有已连接的页面（事件名 `zcode-status`）。
新客户端连上时也会立即补推一份当前状态，避免"状态长期不变时收不到任何推送"。

推送放在服务端而不是让浏览器各自轮询，好处是：只有一处探测、多页面共享结果；
页面切到后台时浏览器会降低定时器精度，而推送不受影响；也省掉每个页面各自的请求开销。
没有客户端连接时直接跳过探测，不做无谓的进程调用与文件读取。

##### 一个必须修正的判定问题

relay 状态是读日志里**最后一条** `[web-remote-control]` 记录得来的。
而 ZCode 被关闭（或被杀）时进程直接消失、**不会补写 `stopped`**，
于是最后一条可能永远停留在 `paired` —— 若只看日志，关闭客户端后页面仍显示"就绪"，
与事实不符。

所以状态推导里加了一条硬约束：**桌面端进程不在时，relay 状态一律视为无效**
（`relayReady = desktopRunning && isRelayReadyForPairing(...)`）。
这段逻辑抽成了纯函数 `deriveZcodeView()`，便于单测覆盖各种组合，
例如「日志残留 paired 但进程已关」这种最容易出错的场景。

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查与两侧可用性 |
| GET | `/api/events` | SSE 事件流：`codex-notification`、`codex-request`、`codex-driver`、`log` |
| GET | `/api/codex/threads?limit=&cursor=&archived=` | 会话列表（`archived=true` 取归档视图） |
| GET | `/api/codex/thread?threadId=` | 单个会话元信息 |
| GET | `/api/codex/items?threadId=&limit=&cursor=` | 会话消息（拍平为 item 列表） |
| GET | `/api/codex/turns?threadId=&limit=` | 会话的 turn 列表 |
| GET | `/api/codex/models` | 可用模型 |
| GET | `/api/codex/projects` | Codex 原生项目（用于分组与目录候选） |
| POST | `/api/codex/open` | 接管会话（获取写入权） |
| POST | `/api/codex/close` | 释放写入权 |
| POST | `/api/codex/new-thread` | 新建会话（可带 `projectId` 归入项目） |
| POST | `/api/codex/archive` | 归档会话（幂等） |
| POST | `/api/codex/unarchive` | 恢复已归档会话 |
| POST | `/api/codex/delete` | 永久删除会话（需 `confirm: true`） |
| POST | `/api/codex/send` | 发消息（运行中自动改用 `turn/steer`） |
| POST | `/api/codex/interrupt` | 中断当前 turn |
| POST | `/api/codex/respond` | 应答服务端请求（审批/提问） |
| GET | `/api/zcode/status` | 凭据 + relay 连接状态 |
| GET | `/api/zcode/remote-url` | 构造官方远控页地址 |
| POST | `/api/zcode/wait-pairing` | 等待桌面端就绪 |
| POST | `/api/zcode/launch-desktop` | 尝试唤起 ZCode 桌面端 |

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `--port` | `8790` | 监听端口 |
| `HOST` / `--host` | `127.0.0.1` | 监听地址 |
| `REMOTE_HUB_TOKEN` / `--token` | 空 | 访问令牌（非回环监听时应设置） |
| `CODEX_BIN` | 自动探测 | codex 可执行文件路径 |
| `ZCODE_STATE_DIR` | `~/.zcode/v2` | ZCode 状态目录 |
| `ZCODE_CREDENTIAL_SECRET` | 派生 | 凭据解密密钥（与桌面端一致时需设置） |
| `ZCODE_REMOTE_URL_BASE` | `https://zcode.z.ai/remote/v4` | 官方远控页基地址 |
| `ZCODE_APP_VERSION` | `3.15.3` | 拼进远控 URL 的版本号 |

## 访问令牌与鉴权

启用令牌后（`--token` / 控制台里设置），鉴权按以下优先级识别：

| 方式 | 用途 |
|---|---|
| `Authorization: Bearer <token>` | 脚本 / API 客户端 |
| URL 里的 `?token=<token>` | 首次从浏览器打开 |
| Cookie | 首次用 query 验证后自动种下，页面内后续请求用它 |

**为什么需要 Cookie**：页面里的 `/styles.css`、`/app.js`、`/markdown.js` 是相对路径引用，
浏览器请求它们时**不会**带上原始 URL 的 `?token=`。如果只认 query，这些资源会全部 401，
表现为「HTML 打得开，但样式和脚本加载失败、页面渲染异常」。所以首次用 query 验证通过后，
服务端会种一个 `HttpOnly; SameSite=Lax` 的 Cookie（有效期 7 天），后续同源请求自动携带。

配套的几点：

- 未授权访问非 API 路径时返回一个**令牌输入页**（而不是一行纯文本或 JSON），
  粘贴令牌提交即可进入；
- 前端拿到令牌后会立刻用 `history.replaceState` **把它从地址栏抹掉**，
  避免留在浏览器历史、或随 `Referer` 泄露给第三方；
- 未配置令牌时完全不种 Cookie，行为与之前一致；
- 跨网访问建议在反向代理上启用 TLS，此时 Cookie 会带上 `Secure` 标记。

## 安全

- Codex 侧的 `app-server` 等价于**本机 shell 权限**：拿到控制权就能让 agent 执行任意命令。
  本服务不额外暴露 app-server，全部经本服务鉴权。
- **控制台里监听地址是下拉选择**：`仅本机 (127.0.0.1)` / `局域网任意 (0.0.0.0)` /
  各网卡地址。**默认选中「仅本机」**（最安全的一档），需要局域网访问时显式切换。
  下拉列表会标出每块网卡的类型，选 VPN/隧道地址时会提示"同网段设备通常连不上"。
- 命令行启动（`run.sh start` / `run.bat start`）默认监听 `0.0.0.0` 以便直接对外；
  **非回环监听时强制要求令牌**（缺失则自动生成并持久化），因此不会出现"裸奔"的配置。
- 局域网内谁能访问端口，谁就等同于拿到了这台机器的 shell —— 请确认所处网络可信
  （家庭网络 / 公司内网），不要在公共 Wi-Fi、咖啡厅等环境开启。
- 通过 Codex 的 `approvalPolicy` / `sandbox` 可以限制爆炸半径，页面上的审批按钮就是这个闸门。
- 手机跨网访问建议走 Tailscale/WireGuard 或反向代理 + TLS；注意 https 页面不能 iframe `ws://`
  或裸 http 资源。启用 TLS 时令牌 Cookie 会自动带 `Secure`。

## 文件结构

```
server.js              HTTP 服务、路由、SSE 总线
console/console.py     桌面控制台（窗口、配置、跨平台进程管理）
console/tray.py        托盘分发器（按平台选择实现）
console/tray_linux.py  Linux 托盘（D-Bus StatusNotifierItem）
console/tray_win.py    Windows 托盘（Shell_NotifyIcon，Win32 原型已声明）
console/selftest_windows.py  Windows 环境自检
lib/codex-bridge.js    Codex app-server 子进程管理、JSON-RPC、reader/driver 路由
lib/zcode-creds.js     ZCode 凭据读取/解密、relay 状态判定、远控 URL 构造
lib/zcode-bridge.js    ZCode 侧状态聚合与等待逻辑
lib/writer-locks.js    探测会话是否被其它进程独占（POSIX 用 flock / Windows 用独占打开）
public/index.html      页面骨架（两个 tab）
public/app.js          前端：会话列表、流式渲染、审批、SSE
public/markdown.js     零依赖 Markdown 渲染器（含 XSS 过滤）
public/styles.css      样式（含移动端适配）
run.sh                 Linux 启动入口（控制台 / 服务两种模式）
run.bat                Windows 启动入口
console-config.json    控制台保存的配置（server.js 读取为默认值）
```

### 跨平台实现要点

| 关注点 | Linux | Windows |
|---|---|---|
| 托盘 | D-Bus SNI（Gio） | Shell_NotifyIcon（ctypes） |
| 停止服务 | `killpg` 整个进程组（连带 codex 子进程） | `taskkill /T /F` 收整棵进程树 |
| 子进程隔离 | `start_new_session=True` | `CREATE_NEW_PROCESS_GROUP` |
| 写入者锁探测 | `flock -n` | 独占方式打开文件 |
| codex 探测 | `/usr/lib/chatgpt/resources/codex` 等 | `%LOCALAPPDATA%\Programs\...\codex.exe` 等 |
| 桌面端进程检测 | `pgrep -f` | `tasklist /FI IMAGENAME` |
| ZCode 状态目录 | `~/.zcode/v2` | `%USERPROFILE%\.zcode\v2`（同样支持 `ZCODE_HOME`） |
| 日志位置 | `/tmp/remote-hub.log` | `%TEMP%\remote-hub.log` |
| 等宽字体 | Monospace | Consolas |


## 已知限制

- 只能 `thread/list` 列出的、以及本服务创建的会话才能驱动；跨机器（远程 workspace）的场景未覆盖。
- 只做 `turn/steer` 的单轮插入，未实现队列（`thread/queue/*`）与多 agent 协同。
- ZCode tab 依赖官方页面，样式与交互由官方决定，本服务只负责承载与状态引导。
- 终端（PTY）交互未实现；Codex 的命令输出以只读方式展示，需要交互式输入时请用桌面端。
