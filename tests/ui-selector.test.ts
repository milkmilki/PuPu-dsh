import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SelectorReadGuard, selectorCanRepair, selectorRepairRequest, selectorSnapshot, selectorSpeakers } from '../src/ui/SessionSelector.js';

test('session controls reject another conversation or an unavailable role instead of showing ordinary assistant', () => {
  const state = {
    sessionId: 'conversation-a',
    roles: [{ id: 'role-a', name: '璐璐', speakerName: '小夫' }],
    binding: { roleId: 'role-a', speakerName: '知夏姐姐' }, locked: true, busy: false,
    speakers: ['小夫', '知夏姐姐'],
  };
  assert.equal(selectorSnapshot(state, 'conversation-a').binding?.speakerName, '知夏姐姐');
  assert.throws(() => selectorSnapshot(state, 'conversation-b'), /这个对话/);
  assert.throws(() => selectorSnapshot({ ...state, roles: [] }, 'conversation-a'), /角色不可用/);
  assert.equal(selectorSnapshot({ ...state, binding: null }, 'conversation-a').binding, null);
});

test('a late poll cannot overwrite a saved identity or a newer session snapshot', () => {
  const guard = new SelectorReadGuard();
  const beforeSave = guard.begin();
  guard.invalidate();
  const duringSave = guard.begin();
  guard.invalidate();
  assert.equal(guard.accept(beforeSave), false);
  assert.equal(guard.accept(duringSave), false);
  const oldPoll = guard.begin(), newPoll = guard.begin();
  assert.equal(guard.accept(newPoll), true);
  assert.equal(guard.accept(oldPoll), false);
  guard.invalidate();
  assert.equal(guard.accept(newPoll), false);
});

test('speaker choices preserve names from current binding and other roles without duplicate identities', () => {
  assert.deepEqual(selectorSpeakers({
    sessionId: 'session',
    roles: [
      { id: 'a', name: '璐璐', speakerName: '小夫' },
      { id: 'b', name: '仆仆', speakerName: '小夫' },
    ],
    binding: { roleId: 'a', speakerName: '知夏姐姐' },
    locked: true, busy: false, needsRepair: false, speakers: ['小夫', '知夏姐姐', ''],
  }), ['知夏姐姐', '小夫']);
});

test('repair state defaults to healthy for the prior protocol and retains a Host repair error', () => {
  const previous = {
    sessionId: 'session', roles: [{ id: 'a', name: '璐璐', speakerName: '小夫' }],
    binding: { roleId: 'a', speakerName: '知夏姐姐' }, locked: true, busy: false, speakers: [],
  };
  assert.equal(selectorSnapshot(previous, 'session').needsRepair, false);
  const broken = selectorSnapshot({ ...previous, needsRepair: true, error: '人物身份安装与回滚均未完成' }, 'session');
  assert.equal(broken.needsRepair, true);
  assert.equal(broken.error, '人物身份安装与回滚均未完成');
  assert.throws(() => selectorSnapshot({ ...previous, needsRepair: 'yes' }, 'session'), /角色设置/);
});

test('repair requests use the acknowledged identity even when the next-conversation draft chose someone else', () => {
  const snapshot = selectorSnapshot({
    sessionId: 'existing-session', roles: [
      { id: 'lulu', name: '璐璐', speakerName: '小夫' },
      { id: 'pupu', name: '仆仆', speakerName: '知夏姐姐' },
    ],
    binding: { roleId: 'lulu', speakerName: '小夫' }, locked: true, busy: false, speakers: [],
    needsRepair: true,
  }, 'existing-session');
  const nextConversationDraft = { roleId: 'pupu', speakerName: '知夏姐姐' };
  assert.deepEqual(selectorRepairRequest(snapshot), {
    action: 'bindSession', input: { sessionId: 'existing-session', roleId: 'lulu', speakerName: '小夫' },
  });
  assert.notEqual(selectorRepairRequest(snapshot).input?.roleId, nextConversationDraft.roleId);
  assert.equal(selectorCanRepair(snapshot), true);
  assert.equal(selectorCanRepair({ ...snapshot, locked: false }), true);
  assert.equal(selectorCanRepair({ ...snapshot, busy: true }), false);
  assert.equal(selectorCanRepair({ ...snapshot, needsRepair: false }), false);
  assert.deepEqual(selectorRepairRequest({ ...snapshot, binding: null, locked: false }), {
    action: 'bindSession', input: { sessionId: 'existing-session', roleId: null, speakerName: '' },
  });
});
