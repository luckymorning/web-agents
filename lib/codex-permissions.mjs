// Web 权限预设。未指定时保留已有会话的配置，不能隐式提升权限。
const PRESETS = new Map([
  ['read-only', { approvalPolicy: 'never', sandbox: 'read-only', type: 'readOnly' }],
  ['workspace-write', { approvalPolicy: 'on-request', sandbox: 'workspace-write', type: 'workspaceWrite' }],
  ['full-access', { approvalPolicy: 'never', sandbox: 'danger-full-access', type: 'dangerFullAccess' }],
]);

export function validatePermissionMode(mode) {
  if (mode == null || mode === 'inherit' || PRESETS.has(mode)) return;
  const err = new Error('无效的权限模式');
  err.statusCode = 400;
  throw err;
}

export function threadPermissionParams(mode) {
  validatePermissionMode(mode);
  const preset = PRESETS.get(mode);
  return preset ? { approvalPolicy: preset.approvalPolicy, sandbox: preset.sandbox } : {};
}

export function turnPermissionParams(mode) {
  validatePermissionMode(mode);
  const preset = PRESETS.get(mode);
  if (!preset) return {};
  const sandboxPolicy = { type: preset.type };
  if (mode !== 'full-access') sandboxPolicy.networkAccess = false;
  // 不继承上一档的额外写入目录或网络权限；Codex 自动包含当前工作目录。
  if (mode === 'workspace-write') sandboxPolicy.writableRoots = [];
  return { approvalPolicy: preset.approvalPolicy, sandboxPolicy };
}
