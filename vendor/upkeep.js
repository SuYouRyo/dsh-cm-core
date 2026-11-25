// 维护进程开关 —— K6，2026-11-10。
//
// 苏尤令：「当 root 后可以停止那些进程用户维护记忆库。之前我们撞过这个问题」。
//
// ⚠️ 当年撞的坑（必须防住，本模块的三条硬约束都来自它）：
//   1. **pidfile 可能是 stale 死值** → 判「没在跑」→ 再起一份 → 双实例叠加灌库
//      （cm-watch-start.sh:28-29 明确写过「进程名是权威判断，pidfile 只是兜底」）。
//   2. **只 pkill node 漏杀 guard** → guard 看子进程没了会重新拉起（F-03 旧漏杀）。
//   3. **停的时候撞上正在写的文件** → 拉取 merge 冲突（151 次那批）。
//      所以「停」必须先停 guard（不再重启），再停 node（不再写），而不是反过来。
//
// 本模块只做两件事：**停**（有序、幂等、可验）与**起**（复用既有 start 脚本，不自造）。
// 不 kill -9、不动 .singleton、不改 pidfile、不绕过设备策略。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * 受管的进程族。`guard` 先停（断掉重启源），`worker` 后停（停止写入）。
 *
 * ⚠️ `leaseStaleMs` 必须**逐进程**给，不能共用一个数（2026-11-10 电脑端实测踩到）：
 *   两个进程的心跳节拍根本不同 ——
 *     · `cm-watch` 每轮都 beat，`--interval 5` → 心跳 5s 级，30s 阈值够宽；
 *     · `cm-reflect` **只在每轮起止各 beat 一次**，`guard.ps1` 的 `$ReflectSec = 120`
 *       → 心跳间隔 **120s**，用 30s 判活必然把「正常等待下一轮」误判成「已停止」。
 *   实测证据：120s 周期里约 90s 被报 `running=false evidence=none`，
 *   而同一时刻 `Get-CimInstance Win32_Process` 明明看得见 `node …cm-reflect.js`。
 *   手机端 `deploy/dsha-mem-keepalive/common.sh:170-174` 的 `lease_alive` 默认 90s
 *   是用来判「死了没有」的**下限**（比 30s 宽就够用），但拿它当判据仍会在
 *   每个 120s 周期里留下约 30s 的空窗 —— 2026-11-10 二次实测后取 **180s**
 *   （1.5 个心跳周期）：容忍一轮晚到，又不至于把真死判成活。
 *   注意这个数是「判活阈值」，与 `bin/cm-reflect.js` 抢租约用的 `staleMs=360s`
 *   是两回事：前者只影响 status 显示，后者决定谁能接管，口径故意不同。
 */
export const MANAGED = [
  {
    id: 'cm-watch',
    label: '灌库 / 向量 watcher',
    guard: 'cm-watch-guard.sh',
    worker: 'bin/cm-watch.js',
    startScript: 'deploy/cm-watch-start.sh',
    log: '/tmp/cm-watch-phone.log',
    lease: 'cm-watch',
    leaseStaleMs: 30_000
  },
  {
    id: 'cm-reflect',
    label: '反思循环',
    guard: 'cm-reflect-guard.sh',
    worker: 'bin/cm-reflect.js',
    startScript: 'deploy/cm-reflect-start.sh',
    log: '/tmp/cm-reflect-phone.log',
    lease: 'cm-reflect',
    // 心跳 120s（每轮起止各 beat 一次）→ 判活阈值取 1.5 个周期 = 180s。
    // ⚠️ 与抢租约的 staleMs=360s（bin/cm-reflect.js）不是同一个数，别改成一样。
    leaseStaleMs: 180_000
  }
];

/**
 * 用 pgrep 按**进程名**查（权威判据，不信 pidfile）。返回 PID 数组。
 *
 * ⚠️ 两个必须排除的自匹配坑（2026-11-10 实测踩到，都真实发生过）：
 *   ① **把自己也匹配进去**：`pgrep -f "bin/cm-watch.js"` 会命中「命令行里含这个字符串」
 *      的任何进程 —— 包括正在执行这条命令的 shell（实测 pid=16052 就是调用者自己）。
 *      若后续对它发 SIGTERM，就是**把调用者杀掉**（早先用 pkill 时真发生过）。
 *      修法：排除 process.pid 与 process.ppid。
 *   ② **把编辑器/日志查看器匹配进去**：人在 tail/grep 那个名字时也算。
 *      修法：要求 argv 里真的是 node/bash 在跑它，即 cmdline 含 `bin/cm-watch.js` 且
 *      不含 `grep`/`tail`/`vim`/`nano`/`less`/`pgrep` 这类旁观者。
 */
export function findPids(pattern) {
  const r = spawnSync('pgrep', ['-af', pattern], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return [];
  const selfPids = new Set([process.pid, process.ppid]);
  const spectators = /(^|[\s/])(pgrep|grep|egrep|tail|head|less|more|vim|vi|nano|emacs|cat|watch)([\s]|$)/;
  return r.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = /^(\d+)\s+(.*)$/.exec(line);
      return m ? { pid: Number(m[1]), cmdline: m[2] } : null;
    })
    .filter(Boolean)
    .filter((x) => !selfPids.has(x.pid))          // ① 不杀自己/父进程
    .filter((x) => !spectators.test(x.cmdline))   // ② 不杀旁观者
    .map((x) => x.pid);
}

/**
 * 当前受管进程状态（只读）。
 *
 * ⚠️ **不能用 ps 当唯一判据**（2026-11-10 实测踩到，这条很重要）：
 *   容器内 `ps` 只能看到本 PID 命名空间的进程。实测：`ps` 报 0 个 watcher，
 *   但 `.singleton/cm-watch/` 的目录 mtime **每 5 秒稳定跳一次**（正是
 *   `cm-watch --interval 5` 的心跳节拍）——进程确实活着，只是在别的命名空间里。
 *   若只用 ps 判断，`upkeep stop` 会以为「已经停了」而不去停，
 *   `upkeep status` 会告诉你「已停止」而实际还在灌库。**这比不报还危险。**
 *
 * 所以判据改成「ps 或 租约心跳」二选一，任一为真即视为运行中：
 *   · ps 看得到 → 直接信（最精确）
 *   · ps 看不到但心跳新鲜（< leaseStaleMs）→ 视为运行中（跨命名空间）
 * @param {object} [opts]
 * @param {string} [opts.dir]         记忆库目录（用来找 .singleton/）
 * @param {number} [opts.leaseStaleMs] 强制所有进程用同一个心跳阈值（默认按 MANAGED 逐项分档：
 *                                     cm-watch 30s / cm-reflect 180s）。只在测试或排障时显式传。
 * @param {boolean} [opts.leaseOnly]   只信租约、不看 ps。**只给用例用**：分档逻辑要断的是
 *                                     「租约多旧算死」，而 ps 那条路读到的是宿主的真进程 ——
 *                                     watcher 一跑起来，用例里造的假租约就被真实进程盖掉，
 *                                     于是断言 `running=false` 变成靠环境碰运气（2026-11-13 实测
 *                                     474 通过 / 1 失败，就是这条）。生产路径不传它，行为不变。
 */
export function statusOf({ dir = null, leaseStaleMs = null, leaseOnly = false } = {}) {
  return MANAGED.map((m) => {
    // 阈值：显式参数 > 该进程自己的分档 > 兜底 30s。**不再全局共用 30s**（见 MANAGED 注释）
    const staleMs = Number.isFinite(leaseStaleMs) ? leaseStaleMs : (m.leaseStaleMs || 30_000);
    const guards = leaseOnly ? [] : findPids(m.guard);
    const workers = leaseOnly ? [] : findPids(m.worker);
    const psRunning = guards.length + workers.length > 0;

    // 租约心跳兜底（跨 PID 命名空间唯一可靠的「它还活着」证据）
    let lease = null;
    if (dir && m.lease) {
      try {
        const lp = path.join(dir, '.singleton', m.lease);
        const st = fs.statSync(lp);
        const ageMs = Date.now() - st.mtimeMs;
        let holder = null;
        try {
          const [pid, host, since] = fs.readFileSync(path.join(lp, 'owner'), 'utf8').trim().split('\t');
          holder = { pid: Number(pid), host, since: Number(since) };
        } catch { /* owner 坏了只看心跳 */ }
        lease = { held: true, ageMs, fresh: ageMs < staleMs, staleMs, holder };
      } catch {
        lease = { held: false, ageMs: Infinity, fresh: false, staleMs, holder: null };
      }
    }

    const leaseRunning = !!(lease && lease.held && lease.fresh);
    return {
      id: m.id,
      label: m.label,
      guards,
      workers,
      running: psRunning || leaseRunning,
      // 说明这个「运行中」是从哪看出来的，避免以后又被误读
      evidence: psRunning ? 'ps' : (leaseRunning ? 'lease-heartbeat' : 'none'),
      lease,
      // 双实例告警：超过 1 个 worker 就是当年那个坑又回来了
      duplicated: workers.length > 1
    };
  });
}

/**
 * 有序停止：先 guard（断重启源）→ 等它退 → 再 worker（停写入）。
 * 用 SIGTERM，不用 -9；给每步留时间；最后**复查**，避免「以为停了其实还在」。
 *
 * @returns {{ok:boolean, stopped:object[], remaining:object[], reason?:string}}
 */
export function stopUpkeep({ ids = null, waitMs = 3000, escalateAfterMs = 8000, dir = null } = {}) {
  const targets = MANAGED.filter((m) => !ids || ids.includes(m.id));
  const stopped = [];
  const escalated = [];

  // 杀一个 PID 并等它真退；返回 true=已退
  const killAndWait = (pid, ms) => {
    try { process.kill(pid, 'SIGTERM'); } catch { return true; }   // 已经没了
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      sleep(150);
      try { process.kill(pid, 0); } catch { return true; }         // 已退
    }
    return false;
  };

  for (const m of targets) {
    // ① guard 先停：它是重启源，先杀它才不会「停了又被拉起来」
    for (const pid of findPids(m.guard)) {
      const gone = killAndWait(pid, waitMs);
      stopped.push({ id: m.id, role: 'guard', pid, exited: gone });
      // TERM 不管用才升级 KILL（不无脑 -9，先给机会优雅退出）
      if (!gone) {
        try { process.kill(pid, 'SIGKILL'); escalated.push({ id: m.id, role: 'guard', pid }); } catch { /* 已退 */ }
        sleep(300);
      }
    }
    // ② worker 后停：它才是正在写文件的那个
    for (const pid of findPids(m.worker)) {
      const gone = killAndWait(pid, waitMs);
      stopped.push({ id: m.id, role: 'worker', pid, exited: gone });
      if (!gone) {
        try { process.kill(pid, 'SIGKILL'); escalated.push({ id: m.id, role: 'worker', pid }); } catch { /* 已退 */ }
        sleep(300);
      }
    }
  }

  // ③ 复查：**以实际进程为准**，不看我们以为发了什么信号
  const remaining = statusOf({ dir }).filter((s) => s.running);
  return { ok: remaining.length === 0, stopped, escalated, remaining };
}

/** 起：复用既有 start 脚本（不自造第二套启动逻辑）。 */
export function startUpkeep({ ids = null, projectRoot, dir = null }) {
  const targets = MANAGED.filter((m) => !ids || ids.includes(m.id));
  const results = [];
  for (const m of targets) {
    const script = path.join(projectRoot, m.startScript);
    if (!fs.existsSync(script)) { results.push({ id: m.id, ok: false, reason: '缺启动脚本' }); continue; }
    const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 60_000 });
    results.push({ id: m.id, ok: r.status === 0, output: (r.stdout || '').trim().slice(-200), reason: r.status === 0 ? null : `exit ${r.status}` });
  }
  // 起完复查，报真实状态
  const after = statusOf({ dir });
  return { ok: results.every((x) => x.ok), results, after };
}

/** 停/起期间建议的「锁」提示：让别的入口知道现在别写（只是一行提示，不真加锁）。 */
export function upkeepLockMarker(projectRoot) {
  return path.join(projectRoot, '.upkeep-paused');
}

const sleep = (ms) => {
  // 同步小睡：本模块被 CLI 直接调用，用 Atomics 避免忙等
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* 环境不支持就跳过 */ }
};
