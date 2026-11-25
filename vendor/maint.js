// N-01「终止指令」进程层（2026-11-21 落地）。
//
// ⚠️ 先说清这条最容易被误解的物理边界：
//   **容器里看不见也杀不了真机进程。** 容器与 Android 宿主是两个 PID 命名空间，
//   container 内 ps 只有自己的几个进程，kill -0 <真机 pid> 一律 EPERM。
//   实测：真机 adb-shell 看得到 5 个（loop.sh / 两个 guard / 两个 worker），
//   同一个时刻容器内 ps -eo pid,args | grep -E 'cm-watch\.js|cm-reflect\.js' 是空的。
//   所以本模块**不自己 kill**，它只往真机能读到的那一份盘上写标记文件：
//
//       <memDir>/.maint/STOP       停（停完进 STOPPED 持续态，不会 20 秒后被拉回来）
//       <memDir>/.maint/RESUME     恢复（清 STOPPED，回到正常判活）
//       <memDir>/.maint/RESTART    先停后拉（重拉一次拿新参数）
//       <memDir>/.maint/REASON     写给人看的原因（消费方会记进 LAST-ACTION）
//
//   真正的执行者是设备侧 KSU 模块的 loop.sh —— deploy/dsha-mem-keepalive/common.sh
//   的 run_maintenance()（v3.8 起）。它每轮（默认 20 秒）读一次这些标记，
//   做完把结果写进 <memDir>/.maint/LAST-ACTION（AT / ACTION / REASON / RESULT 四行）。
//
// ⚠️ 第二条边界：**写了标记 ≠ 停成功了。**
//   模块没跑、loop 没转、盘不对（例如 rootfs 探测到旧树）时，标记会静静躺着没人理。
//   所以本模块所有动作都分两步：写标记 → **等 LAST-ACTION 更新**；
//   等不到就如实报「标记已写，设备侧未回执」，绝不把「我写了个文件」说成「进程停了」。
//   （这正是 2026-11-18~21 那三天假绿的形状：探测全绿、面板全绿、实际在旧树上空转。）
//
// ⚠️ 第三条：**标记文件必须本地专属。**
//   STOP 是「这台设备此刻别写」，同步到电脑端等于远端替我拍了个停机的板 —— 比不停更坏。
//   故 .maint/ 已进 bin/cm-remote.js 的 LOCAL_ONLY 与 .gitignore。
//
// 与 N-01 另外两层的关系（设计稿 doc-08-runs/.../设计稿-终止指令让一切可控-20261111.md §一）：
//   · 进程层（本模块）—— 停常驻进程，让设备安静
//   · 写入层（src/freeze-guard.mjs）—— 冻结记忆库写入，读仍可用
//   · 会话层 —— DSH 宿主/会话编排层，不在本仓库内（登记为超范围，未做）
//   两层可以独立使用，也可以一起用：freeze 挡写、maint 停进程，互不依赖。

import fs from 'node:fs';
import path from 'node:path';

/** 标记目录名（与设备侧 common.sh 的 MAINT_DIR 末段一致，改这里必须同步改那边）。 */
export const MAINT_DIR_NAME = '.maint';

/** 三个动作标记。 */
export const MAINT_ACTIONS = Object.freeze(['stop', 'resume', 'restart']);

/** 动作 → 标记文件名。 */
export const MAINT_FLAG_FILE = Object.freeze({
  stop: 'STOP',
  resume: 'RESUME',
  restart: 'RESTART'
});

/** 持续态文件名：存在 = 停着（设备侧靠它防止「停了 20 秒又被拉起」）。 */
export const MAINT_STOPPED_FILE = 'STOPPED';

/** 回执文件名。设备侧每做一次动作覆写这一份。 */
export const MAINT_ACTION_LOG = 'LAST-ACTION';

/**
 * 设备侧 loop 的一轮间隔（秒）。只用于「等多久算没回执」的默认值，不是权威配置：
 * 权威在设备侧 loop.sh 的 INTERVAL（默认 20s）。
 */
export const DEFAULT_LOOP_SECONDS = 20;

export function maintDirOf(memDir) {
  return path.join(String(memDir), MAINT_DIR_NAME);
}

/** 读一个标记文件的内容（去首尾空白、截 200 字符），不存在返回空串。 */
export function readFlag(memDir, name) {
  try {
    return fs.readFileSync(path.join(maintDirOf(memDir), name), 'utf8').trim().slice(0, 200);
  } catch {
    return '';
  }
}

/**
 * 解析 LAST-ACTION 四行。读不到/坏了都返回 null —— 调用方据此说「没有回执」，
 * 不要伪造一个 {action:'none'} 让上层以为「设备说没事」。
 */
export function readLastAction(memDir) {
  const p = path.join(maintDirOf(memDir), MAINT_ACTION_LOG);
  let raw, st;
  try {
    raw = fs.readFileSync(p, 'utf8');
    st = fs.statSync(p);
  } catch {
    return null;
  }
  const pick = (k) => {
    const m = raw.match(new RegExp('^' + k + '=(.*)\u0024', 'm'));
    return m ? m[1].trim() : '';
  };
  return {
    at: pick('AT'),
    action: pick('ACTION'),
    reason: pick('REASON'),
    result: pick('RESULT'),
    mtimeMs: st.mtimeMs,
    path: p
  };
}

/** 当前标记态（只读）。 */
export function maintStatus(memDir) {
  const dir = maintDirOf(memDir);
  const flags = {};
  for (const a of MAINT_ACTIONS) {
    const name = MAINT_FLAG_FILE[a];
    flags[a] = fs.existsSync(path.join(dir, name));
  }
  const stoppedPath = path.join(dir, MAINT_STOPPED_FILE);
  let stoppedSinceMs = null;
  try { stoppedSinceMs = fs.statSync(stoppedPath).mtimeMs; } catch { /* 没停 */ }
  return {
    dir,
    exists: fs.existsSync(dir),
    flags,
    stopped: stoppedSinceMs !== null,
    stoppedSinceMs,
    reason: readFlag(memDir, 'REASON'),
    lastAction: readLastAction(memDir)
  };
}

function writeIfChanged(file, text) {
  try {
    const cur = fs.readFileSync(file, 'utf8');
    if (cur === text) return false;
  } catch { /* 不存在就写 */ }
  fs.writeFileSync(file, text, 'utf8');
  return true;
}

/**
 * 写标记。**不做任何「应该成功了」的推断** —— 只保证文件落盘，成败由 waitForReceipt 判。
 *
 * @returns {{ok:boolean, dir:string, wrote:string[], reason?:string}}
 */
export function writeMarker(memDir, action, { reason = '', now = Date.now() } = {}) {
  const name = MAINT_FLAG_FILE[action];
  if (!name) return { ok: false, dir: maintDirOf(memDir), wrote: [], reason: 'unknown-action' };
  const dir = maintDirOf(memDir);
  try {
    fs.mkdirSync(dir, { recursive: true });
    // REASON 先写：设备侧消费 STOP 时会立刻把 REASON 抄进 LAST-ACTION，
    // 后写就会出现「动作记了但原因是空的」。
    if (reason) writeIfChanged(path.join(dir, 'REASON'), reason + '\n');
    fs.writeFileSync(path.join(dir, name), new Date(now).toISOString() + '\n', 'utf8');
    return { ok: true, dir, wrote: [name] };
  } catch (e) {
    return { ok: false, dir, wrote: [], reason: (e && e.message) || 'write-failed' };
  }
}

/** 清掉某个动作标记（设备侧消费后本来也会删，这里给「还没被消费就反悔」用）。 */
export function clearMarker(memDir, action) {
  const name = MAINT_FLAG_FILE[action];
  if (!name) return false;
  try { fs.unlinkSync(path.join(maintDirOf(memDir), name)); return true; } catch { return false; }
}

const sleepMs = (ms) => {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* 不支持就不睡 */ }
};

/**
 * 等设备侧回执：LAST-ACTION 的 mtime 晚于 since 且 ACTION 对得上。
 *
 * 判据故意用 **mtime** 而不是 AT 字符串：AT 是设备本地时区的
 * 'YYYY-MM-DD HH:MM:SS'，跨时区/夏令时/时钟漂移都能比错，mtime 没这个问题。
 *
 * @returns {{ok:boolean, receipt:object|null, waitedMs:number, reason?:string}}
 */
export function waitForReceipt(memDir, action, { since = Date.now(), timeoutMs = 60_000, pollMs = 1000 } = {}) {
  const wantAction = action === 'stop' ? 'STOP' : action === 'resume' ? 'RESUME' : 'RESTART';
  const budget = Math.max(0, timeoutMs);
  const start = Date.now();
  for (;;) {
    const la = readLastAction(memDir);
    // mtime 比 since 晚（留 1ms 容差：写标记与读回执可能同一毫秒）
    if (la && la.mtimeMs >= since - 1 && la.action === wantAction) {
      return { ok: true, receipt: la, waitedMs: Date.now() - start };
    }
    const elapsed = Date.now() - start;
    if (elapsed >= budget) {
      return {
        ok: false,
        receipt: la,
        waitedMs: elapsed,
        reason: la
          ? '设备侧最后一次动作是 ' + (la.action || '（空）') + '（不是 ' + wantAction + '）'
          : '还没有任何 LAST-ACTION（设备侧模块没跑过维护后门？）'
      };
    }
    sleepMs(Math.min(pollMs, Math.max(50, budget - elapsed)));
  }
}

/**
 * 一步到位：写标记 → 等回执 → 复查状态。
 *
 * 三种结局，**不要互相冒充**：
 *   · delivered=true  → 设备侧真的做了（收据上有 ACTION/RESULT）
 *   · delivered=false → 标记写进去了但没人回执（模块没跑 / 盘不对 / loop 停了）
 *   两种都不会抛异常：这是运维通道，抛异常会把「没停成」变成「命令挂了」，更难查。
 */
export function requestMaint(memDir, action, { reason = '', timeoutMs = 60_000, pollMs = 1000, now = Date.now() } = {}) {
  const marker = writeMarker(memDir, action, { reason, now });
  if (!marker.ok) {
    return {
      ok: false, action, delivered: false, marker, receipt: null,
      status: maintStatus(memDir), waitedMs: 0,
      note: '标记没写进去（' + (marker.reason || '未知原因') + '）—— 一个字节都没动'
    };
  }
  const w = waitForReceipt(memDir, action, { since: now, timeoutMs, pollMs });
  const status = maintStatus(memDir);
  const label = action === 'stop' ? '停进程' : action === 'resume' ? '恢复' : '重启';
  return {
    ok: w.ok,
    action,
    delivered: w.ok,
    marker,
    receipt: w.receipt,
    status,
    waitedMs: w.waitedMs,
    note: w.ok
      ? '设备侧已执行' + label + '：' + (w.receipt.result || '（无 RESULT 正文）')
      : '标记已写（' + marker.dir + '），但设备侧 ' + Math.round(w.waitedMs / 1000) + 's 内没有回执：' + w.reason
        + '。这不代表停成功 —— 也可能是模块没跑 / rootfs 探测到旧树 / loop 已退出。'
  };
}

/** 便捷包装：停 / 恢复 / 重启。 */
export const stopProcesses = (memDir, opts = {}) => requestMaint(memDir, 'stop', opts);
export const resumeProcesses = (memDir, opts = {}) => requestMaint(memDir, 'resume', opts);
export const restartProcesses = (memDir, opts = {}) => requestMaint(memDir, 'restart', opts);

/** 给人看的一句话摘要（cm maint status 用）。 */
export function describeStatus(st) {
  const flags = MAINT_ACTIONS.filter((a) => st.flags[a]).map((a) => MAINT_FLAG_FILE[a]);
  const parts = [];
  parts.push(st.stopped ? '当前：已停（STOPPED 持续态）' : '当前：正常（无 STOPPED）');
  parts.push(flags.length ? '待消费标记：' + flags.join(' / ') : '待消费标记：无');
  if (st.reason) parts.push('原因：' + st.reason);
  if (st.lastAction) {
    parts.push('设备侧最后一次：' + (st.lastAction.action || '（空）') + ' @ ' + (st.lastAction.at || '（无时间）')
      + (st.lastAction.result ? ' — ' + st.lastAction.result : ''));
  } else {
    parts.push('设备侧回执：无（还没有任何 LAST-ACTION）');
  }
  return parts.join('；');
}
