// 预加载脚本：在隔离上下文中为渲染进程暴露一组最小、明确的 IPC 接口。
//
// 不开 nodeIntegration，渲染进程只能通过这里列出的方法访问主进程能力，
// 避免界面代码（以及任何被注入的内容）直接拿到 Node API。

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hub', {
  // 查询
  getStatus: () => ipcRenderer.invoke('get-status'),
  listHosts: () => ipcRenderer.invoke('list-hosts'),
  genToken: () => ipcRenderer.invoke('gen-token'),
  health: () => ipcRenderer.invoke('health'),

  // 操作
  applyConfig: (form) => ipcRenderer.invoke('apply-config', form),
  // 启动会先保存界面上的配置再拉起服务
  start: (form) => ipcRenderer.invoke('start', form),
  stop: () => ipcRenderer.invoke('stop'),
  openBrowser: () => ipcRenderer.invoke('open-browser'),
  quit: () => ipcRenderer.invoke('quit'),

  // 事件订阅（返回取消订阅函数）
  onStatus: (cb) => {
    const h = (_e, s) => cb(s);
    ipcRenderer.on('status', h);
    return () => ipcRenderer.removeListener('status', h);
  },
  onLog: (cb) => {
    const h = (_e, line) => cb(line);
    ipcRenderer.on('log', h);
    return () => ipcRenderer.removeListener('log', h);
  },
});
