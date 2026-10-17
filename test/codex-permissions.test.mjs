import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexBridge } from '../lib/codex-bridge.mjs';
import { threadPermissionParams, turnPermissionParams } from '../lib/codex-permissions.mjs';

function bridgeWithDriver(threadId = 'thread-a') {
  const calls = [];
  const bridge = new CodexBridge();
  bridge.bin = 'mock-codex';
  bridge.driverThreadId = threadId;
  bridge.driver = {
    alive: true,
    ready: Promise.resolve({}),
    call: async (method, params) => {
      calls.push({ method, params });
      return { thread: { id: 'thread-a' }, turn: { id: 'turn-a' } };
    },
    kill: () => { throw new Error('must not release the driver'); },
  };
  return { bridge, calls };
}

const presets = [
  ['read-only', 'never', 'read-only', { type: 'readOnly', networkAccess: false }],
  ['workspace-write', 'on-request', 'workspace-write',
    { type: 'workspaceWrite', networkAccess: false, writableRoots: [] }],
  ['full-access', 'never', 'danger-full-access', { type: 'dangerFullAccess' }],
];

for (const [mode, approvalPolicy, sandbox, sandboxPolicy] of presets) {
  test(`${mode}: create, resume and send use the correct protocol fields`, async () => {
    const fresh = bridgeWithDriver(null);
    await fresh.bridge.startThread({
      permissionMode: mode, approvalPolicy: 'on-request', sandbox: 'workspace-write',
    });
    assert.equal(fresh.calls[0].method, 'thread/start');
    assert.equal(fresh.calls[0].params.approvalPolicy, approvalPolicy);
    assert.equal(fresh.calls[0].params.sandbox, sandbox);

    const resumed = bridgeWithDriver(null);
    await resumed.bridge.openDriver('thread-a', { permissionMode: mode });
    assert.deepEqual(resumed.calls[0], { method: 'thread/resume', params: {
      threadId: 'thread-a', excludeTurns: true, approvalPolicy, sandbox,
    } });

    const result = await resumed.bridge.sendMessage({
      threadId: 'thread-a', text: 'test', permissionMode: mode, model: 'test-model', effort: 'high',
    });
    assert.deepEqual(resumed.calls[1], { method: 'turn/start', params: {
      threadId: 'thread-a', input: [{ type: 'text', text: 'test' }],
      approvalPolicy, sandboxPolicy, model: 'test-model', effort: 'high',
    } });
    assert.equal(result.turnId, 'turn-a');
    assert.equal(resumed.bridge.activeTurns.get('thread-a'), 'turn-a');
  });
}

test('omitted/inherit modes preserve existing permissions on resume and send', async () => {
  for (const permissionMode of [undefined, null, 'inherit']) {
    assert.deepEqual(threadPermissionParams(permissionMode), {});
    assert.deepEqual(turnPermissionParams(permissionMode), {});
    const { bridge, calls } = bridgeWithDriver(null);
    await bridge.sendMessage({ threadId: 'thread-a', text: 'test', permissionMode });
    assert.deepEqual(calls.map(({ method }) => method), ['thread/resume', 'turn/start']);
    for (const { params } of calls) {
      assert.equal('approvalPolicy' in params, false);
      assert.equal('sandboxPolicy' in params, false);
      assert.equal('sandbox' in params, false);
    }
  }
});

test('omitting the new option preserves legacy new-thread settings', async () => {
  const { bridge, calls } = bridgeWithDriver(null);
  await bridge.startThread({ approvalPolicy: 'untrusted', sandbox: 'read-only' });
  assert.equal(calls[0].params.approvalPolicy, 'untrusted');
  assert.equal(calls[0].params.sandbox, 'read-only');
});

test('switching permissions between turns replaces the previous policy', async () => {
  const { bridge, calls } = bridgeWithDriver();
  for (const permissionMode of ['full-access', 'workspace-write', 'read-only']) {
    bridge.activeTurns.clear();
    await bridge.sendMessage({ threadId: 'thread-a', text: 'test', permissionMode });
  }
  assert.deepEqual(calls.map(({ params }) => params.sandboxPolicy), presets.slice().reverse().map(p => p[3]));
});

test('steering leaves the active turn unchanged and applies the choice on the next turn', async () => {
  const { bridge, calls } = bridgeWithDriver();
  bridge.activeTurns.set('thread-a', 'running-turn');
  const message = { threadId: 'thread-a', text: 'test', permissionMode: 'read-only' };
  const result = await bridge.sendMessage(message);
  assert.equal(result.permissionDeferred, true);
  assert.deepEqual(calls[0], { method: 'turn/steer', params: {
    threadId: 'thread-a', expectedTurnId: 'running-turn', input: [{ type: 'text', text: 'test' }],
  } });
  bridge.activeTurns.clear();
  await bridge.sendMessage(message);
  assert.equal(calls[1].method, 'turn/start');
  assert.equal(calls[1].params.sandboxPolicy.type, 'readOnly');
});

test('invalid modes fail before any RPC, driver takeover or release', async () => {
  for (const permissionMode of ['', 'typo', 'toString', '__proto__', false, 1, {}]) {
    const { bridge, calls } = bridgeWithDriver();
    const isBadRequest = err => err.statusCode === 400;
    await assert.rejects(bridge.startThread({ permissionMode }), isBadRequest);
    await assert.rejects(bridge.openDriver('other-thread', { permissionMode }), isBadRequest);
    await assert.rejects(bridge.sendMessage({ threadId: 'other-thread', text: 'test', permissionMode }), isBadRequest);
    assert.deepEqual(calls, []);
    assert.equal(bridge.driverThreadId, 'thread-a');
  }
});

test('another active thread cannot be taken over to change permissions', async () => {
  const { bridge, calls } = bridgeWithDriver();
  bridge.activeTurns.set('thread-a', 'running-turn');
  const result = await bridge.sendMessage({ threadId: 'thread-b', text: 'test', permissionMode: 'full-access' });
  assert.equal(result.ok, false);
  assert.equal(result.mode, 'busy');
  assert.deepEqual(calls, []);
});

test('RPC failures are surfaced and never start a turn with fallback permissions', async () => {
  const { bridge, calls } = bridgeWithDriver();
  bridge.driver.call = async (method, params) => {
    calls.push({ method, params });
    throw new Error('policy rejected');
  };
  await assert.rejects(bridge.sendMessage({
    threadId: 'thread-a', text: 'test', permissionMode: 'read-only',
  }), /policy rejected/);
  assert.equal(calls.length, 1);
  assert.equal(bridge.activeTurns.size, 0);
});
