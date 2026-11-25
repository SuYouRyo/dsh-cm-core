#!/usr/bin/env node
// reinject 自测：上下文压缩之后的强制重注入（工单 T-20261115-019）。
//
// 跑法：node src/reinject.selftest.mjs        全绿才退 0
//
// 四个场景就是工单要求的反证对照，顺序与工单一致：
//   A 无压缩 + 未到阈值        → 不注入（阴性对照：阈值仍然生效）
//   B 无压缩 + 到阈值          → 注入
//   C 发生压缩 → 下一轮即使未到阈值也强制注入一次（阳性）
//   D 压缩后连续两轮           → 只注入一次，第二轮回归阈值判定
//
// 另外补三条边界：拿不到代次 / 上层判死 / 换会话与代次回退。
// 断言一律带自己的话，不用 assert.ok(true) 兜底。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const memDir = path.join(os.tmpdir(), `reinject-selftest-${process.pid}-${Date.now()}`);
fs.mkdirSync(memDir, { recursive: true });
process.env.CM_ROLE = 'work';
process.env.CM_SELFNOTE_TTL = '43200000';

const handoff = await import('../src/handoff.js');
const reinject = await import('../src/reinject.js');

let pass = 0;
const fails = [];
function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fails.push(`${name}: ${e.message}`);
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}

// 每个用例一个干净库，互不串味。
function newDir() {
  const d = path.join(memDir, `c${pass}${fails.length}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function seedNote(d) {
  handoff.selfNoteAdd(d, '我回话前会先确认一遍日期', { source: 'imagined' });
}
const NOW = Date.UTC(2026, 10, 15, 10, 0, 0);
const SID = 'sess-X';

// —— 一次「轮询」的完整动作，复刻 cm-boot.js L4 段的真实顺序 ——
// 先问阈值（selfNoteDecision），再问压缩（reinjectDecide），决定注不注，最后记账。
function round(dir, { sessionId = SID, epoch = null, now = NOW } = {}) {
  const base = handoff.selfNoteDecision(dir, { sessionId, now });
  const d = reinject.reinjectDecide(dir, { sessionId, epoch, key: 'selfNote', base, now });
  const injected = base.inject || d.action === 'force';
  const forced = !base.inject && d.action === 'force';
  if (injected) handoff.selfNoteMarkInjected(dir, { sessionId, now });
  // 没注入也记账，把代次基线落下来（否则压缩事件会被吞掉）。
  reinject.reinjectCommit(dir, { sessionId, epoch, key: 'selfNote', injected, forced, now });
  const block = injected ? handoff.selfNoteBlock(dir, { now, maxChars: 700 }) : { text: '', chars: 0 };
  return { injected, forced, baseReason: base.reason, action: d.action, reason: d.reason, text: block.text };
}

// ============================================================
// A 无压缩 + 未到阈值 → 不注入
// ============================================================
test('A 无压缩、同会话已注入过、代次没变 → 不注入（阴性对照，阈值仍生效）', () => {
  const dir = newDir();
  seedNote(dir);
  // 先跑一轮把「已注入」记号打上，代次基线 = 5。
  const first = round(dir, { epoch: 5 });
  assert.equal(first.injected, true, 'A 前置：第一轮该注入（first-session）');
  assert.equal(first.action, 'adopt', 'A 前置：第一轮只登记代次基线，不该是 force');

  const second = round(dir, { epoch: 5 });
  assert.equal(second.injected, false, 'A：代次没变、同会话，必须不注入');
  assert.equal(second.action, 'threshold', 'A：action 应回落到 threshold');
  assert.equal(second.reason, 'epoch-same', 'A：理由应为 epoch-same');
  assert.equal(second.text, '', 'A：没有注入，注入块必须是空的');
  assert.equal(reinject.reinjectState(dir, 'selfNote').lastEpoch, 5, 'A：代次基线应保持 5');
  assert.equal(reinject.reinjectState(dir, 'selfNote').forcedCount, 0, 'A：不该有任何强制记录');
});

// ============================================================
// B 无压缩 + 到阈值 → 注入
// ============================================================
test('B 无压缩、换了会话 → 阈值判定放行，正常注入', () => {
  const dir = newDir();
  seedNote(dir);
  round(dir, { epoch: 7 });                       // sess-X 注入过
  const other = round(dir, { sessionId: 'sess-Y', epoch: 7 });
  assert.equal(other.injected, true, 'B：换会话，阈值判定应放行');
  assert.equal(other.baseReason, 'new-session', 'B：理由应来自阈值层（new-session），不是压缩');
  assert.equal(other.forced, false, 'B：这一轮不是压缩强制，forced 必须为 false');
  assert.match(other.text, /【我是谁·我自己的话】/, 'B：注入块应带旧我画像标题');
});

test('B2 无压缩、无 sessionId 退化成 TTL 到期 → 注入', () => {
  const dir = newDir();
  seedNote(dir);
  const first = round(dir, { sessionId: null, epoch: 3 });
  assert.equal(first.injected, true, 'B2 前置：无会话身份且从未注入 → 注入');
  const ttl = Number(process.env.CM_SELFNOTE_TTL);
  const later = round(dir, { sessionId: null, epoch: 3, now: NOW + ttl + 1000 });
  assert.equal(later.injected, true, 'B2：过了 12h TTL，应再次注入');
  assert.equal(later.baseReason, 'ttl-expired', 'B2：理由应是 ttl-expired');
  assert.equal(later.forced, false, 'B2：这不是压缩强制');
});

// ============================================================
// C 发生压缩 → 下一轮即使未到阈值也强制注入一次（阳性）
// ============================================================
test('C 压缩（代次 +1）→ 下一轮无视阈值，强制注入一次', () => {
  const dir = newDir();
  seedNote(dir);
  const before = round(dir, { epoch: 2 });
  assert.equal(before.injected, true, 'C 前置：第一轮注入');
  // 压缩之前的普通一轮：确认此时是「不注入」的状态。
  const quiet = round(dir, { epoch: 2 });
  assert.equal(quiet.injected, false, 'C 前置：压缩前稳定态是不注入');

  // 宿主做完一次 Context Compaction → surface.replaceGeneration 由 2 变 3。
  const after = round(dir, { epoch: 3 });
  assert.equal(after.injected, true, 'C：压缩后这一轮必须注入，哪怕阈值说不注');
  assert.equal(after.action, 'force', 'C：action 必须是 force');
  assert.equal(after.reason, 'compact-detected', 'C：理由应是 compact-detected');
  assert.equal(after.forced, true, 'C：应标记 forced');
  assert.equal(after.baseReason, 'same-session', 'C：阈值层给的是 same-session —— 强制注入正是要覆盖它');
  assert.match(after.text, /【我是谁·我自己的话】/, 'C：强制注入的确实是旧我画像');
  const st = reinject.reinjectState(dir, 'selfNote');
  assert.equal(st.lastEpoch, 3, 'C：代次基线应推进到 3');
  assert.equal(st.forcedCount, 1, 'C：强制记录应为 1 次');
});

test('C3 压缩检测：从会话对象读 replaceGeneration（真信号，不是猜的）', () => {
  // 形状照抄宿主 SurfaceManager：session.surface.replaceGeneration。
  const session = { surface: { replaceGeneration: 4 } };
  assert.equal(reinject.compactionEpochOf(session), 4, 'C3：应从 session.surface.replaceGeneration 读到 4');
  assert.equal(reinject.compactionEpochOf({ surface: { replaceGeneration: 0 } }), 0, 'C3：0 是合法代次');
  assert.equal(reinject.compactionEpochOf({}), null, 'C3：读不到必须是 null，不能冒充 0');
  assert.equal(reinject.compactionEpochOf(null), null, 'C3：无会话也是 null');
  assert.equal(reinject.parseEpoch('12'), 12, 'C3：命令行/env 传来的串可解析');
  assert.equal(reinject.parseEpoch('x'), null, 'C3：非数字解析成 null');
  assert.equal(reinject.parseEpoch('-1'), null, 'C3：负数解析成 null');
  assert.equal(reinject.parseEpoch(''), null, 'C3：空串解析成 null');
});

// ============================================================
// D 压缩后连续两轮 → 只注入一次，第二轮回归阈值
// ============================================================
test('D 压缩后连续两轮 → 只强制一次，第二轮回归阈值判定', () => {
  const dir = newDir();
  seedNote(dir);
  round(dir, { epoch: 10 });
  round(dir, { epoch: 10 });                      // 稳定态
  const c = round(dir, { epoch: 11 });            // 压缩 → 强制
  assert.equal(c.injected, true, 'D 前置：压缩那轮注入');
  assert.equal(c.forced, true, 'D 前置：压缩那轮是强制');

  const next = round(dir, { epoch: 11 });         // 紧接着的一轮，代次没再变
  assert.equal(next.injected, false, 'D：紧接着的第二轮不该再注入（防刷屏）');
  assert.equal(next.action, 'threshold', 'D：第二轮应回落 threshold');
  assert.equal(next.reason, 'epoch-same', 'D：理由 epoch-same');
  assert.equal(reinject.reinjectState(dir, 'selfNote').forcedCount, 1, 'D：整段只应留下 1 次强制记录');

  // 第二轮之后阈值层仍然说了算：换会话照样放行。
  const other = round(dir, { sessionId: 'sess-Z', epoch: 11 });
  assert.equal(other.injected, true, 'D：阈值层未被破坏，换会话仍注入');
  assert.equal(other.forced, false, 'D：且不是强制');
});

test('D2 连续两次压缩 → 两次都能各强制一次（代次是单调计数器）', () => {
  const dir = newDir();
  seedNote(dir);
  round(dir, { epoch: 1 });
  const c1 = round(dir, { epoch: 2 });
  const q1 = round(dir, { epoch: 2 });
  const c2 = round(dir, { epoch: 3 });
  const q2 = round(dir, { epoch: 3 });
  assert.equal(c1.forced, true, 'D2：第一次压缩强制注入');
  assert.equal(q1.injected, false, 'D2：中间一轮不注入');
  assert.equal(c2.forced, true, 'D2：第二次压缩再次强制注入');
  assert.equal(q2.injected, false, 'D2：再次回落');
  assert.equal(reinject.reinjectState(dir, 'selfNote').forcedCount, 2, 'D2：共 2 次强制');
});

// ============================================================
// 边界：拿不到信号 / 上层判死 / 换会话 / 代次回退
// ============================================================
test('边界 拿不到代次（null）→ 明说 no-epoch，退回落差判定，绝不假装压缩过', () => {
  const dir = newDir();
  seedNote(dir);
  round(dir, { epoch: 4 });
  const r = round(dir, { epoch: null });
  assert.equal(r.action, 'threshold', '边界：无代次应走 threshold');
  assert.equal(r.reason, 'no-epoch', '边界：理由必须明说是 no-epoch');
  assert.equal(r.injected, false, '边界：没有压缩信号就不该强制注入');
  assert.equal(reinject.reinjectState(dir, 'selfNote').lastEpoch, 4, '边界：null 代次不该污染已有基线');
});

test('边界 CM_NO_SELFNOTE=1 / 库里没有条目 → skip，且不登记基线', () => {
  const empty = newDir();
  const d1 = reinject.reinjectDecide(empty, { sessionId: SID, epoch: 9, key: 'selfNote', base: { inject: false, reason: 'empty' }, now: NOW });
  assert.equal(d1.action, 'skip', '边界：库里没有条目 → skip');
  assert.equal(d1.reason, 'empty', '边界：理由 empty');

  const dir = newDir();
  seedNote(dir);
  const old = process.env.CM_NO_SELFNOTE;
  process.env.CM_NO_SELFNOTE = '1';
  try {
    const d2 = reinject.reinjectDecide(dir, { sessionId: SID, epoch: 9, key: 'selfNote', base: { inject: false, reason: 'disabled' }, now: NOW });
    assert.equal(d2.action, 'skip', '边界：总闸关掉 → skip');
    assert.equal(d2.reason, 'disabled', '边界：理由 disabled');
  } finally {
    if (old === undefined) delete process.env.CM_NO_SELFNOTE; else process.env.CM_NO_SELFNOTE = old;
  }
});

test('边界 换会话时不继承上一个会话的代次与强制记录', () => {
  const dir = newDir();
  seedNote(dir);
  round(dir, { sessionId: 'sess-A', epoch: 6 });
  round(dir, { sessionId: 'sess-A', epoch: 7 });   // A 遇到压缩，forcedCount=1
  const stA = reinject.reinjectState(dir, 'selfNote');
  assert.equal(stA.forcedCount, 1, '边界前置：A 会话已有 1 次强制');

  const b = round(dir, { sessionId: 'sess-B', epoch: 7 });
  assert.equal(b.injected, true, '边界：换会话，阈值放行');
  const stB = reinject.reinjectState(dir, 'selfNote');
  assert.equal(stB.lastSessionId, 'sess-B', '边界：会话标记应换成 B');
  assert.equal(stB.forcedCount, 0, '边界：换会话后强制记录应归零，不继承');
});

test('边界 代次回退（换了容器/重启）→ 只登记新基线，不误判成压缩', () => {
  const dir = newDir();
  seedNote(dir);
  round(dir, { epoch: 20 });
  round(dir, { epoch: 20 });
  const back = round(dir, { epoch: 3 });
  assert.equal(back.action, 'adopt', '边界：代次变小应 adopt，不是 force');
  assert.equal(back.reason, 'epoch-reset', '边界：理由 epoch-reset');
  assert.equal(back.forced, false, '边界：不该误报压缩');
  const again = round(dir, { epoch: 4 });
  assert.equal(again.action, 'force', '边界：新基线之后真正的压缩仍能识别');
});

test('可观测日志：默认不写，CM_REINJECT_LOG=1 才写，且不抛', () => {
  const dir = newDir();
  const off = reinject.writeReinjectLog(dir, { layer: 'selfNote', action: 'force' }, { enabled: false });
  assert.equal(off, false, '日志：关掉时返回 false');
  assert.equal(fs.existsSync(reinject.reinjectLogPathOf(dir)), false, '日志：关掉时不该落文件');

  const file = path.join(dir, 'logs', 'reinject.log');
  const on = reinject.writeReinjectLog(dir, { layer: 'selfNote', action: 'force', why: 'compact-detected', epoch: 3 }, { enabled: true });
  assert.equal(on, true, '日志：打开时返回 true');
  const body = fs.readFileSync(file, 'utf8');
  assert.match(body, /^\[reinject\] t=\d{4}-\d{2}-\d{2}T/, '日志：每行应以 [reinject] t=ISO 开头');
  assert.match(body, /action=force/, '日志：应记下 action');
  assert.match(body, /why=compact-detected/, '日志：应记下原因');
  assert.match(body, /epoch=3/, '日志：应记下代次');
});

// ============================================================
// 清理 + 结算
// ============================================================
try { fs.rmSync(memDir, { recursive: true, force: true }); } catch { /* 留个临时目录不影响结论 */ }

console.log('');
console.log(`reinject 自测：${pass} 通过 / ${fails.length} 失败`);
if (fails.length) {
  for (const f of fails) console.error(`  ✗ ${f}`);
}
process.exit(fails.length ? 1 : 0);
