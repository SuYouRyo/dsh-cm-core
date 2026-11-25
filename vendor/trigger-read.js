// 开场「自主写入读数」的现算逻辑（施工单 ① / 2026-11-07 D1 拍板）。
//
// 为什么单独一个文件：cm-boot（给模型看的中性读数）与 cm-status（给运维看的待办提醒）
// 都要这份读数，施工单明确要求「两处共用同一段现算逻辑，别各自复制一遍」。
//
// 三个硬约束（写歪了就白做）：
//   1. **零新增状态文件**。全部从现有资产现算：原文层走 mem.store.query 折叠结果，
//      自主写入时间从 impressions.jsonl 现取。绝不碰 reflect-state.json
//      （那是债务 #9 的坑：跨端同步会互相覆盖），也不新造任何 .json/.jsonl。
//   2. **不依赖宿主 token / 窗口百分比**。判据是库级事实：自上次自主写入以来
//      新增了多少条用户消息、过了几个自然日。换会话不清零，天然跨会话。
//   3. **只提醒、不代写**。这里只产出一个中性读数 + 一个 due 布尔，
//      真正的写入仍由念跑 `cm selfnote` / `cm add`。读数里绝不写生活侧私密原话。
//
// 口径修正（相对施工单 §① 的草图）：草图写的是从 store.query 结果里按
// `['inferred','imagined'].includes(r.source) || r.category === 'selfNote'` 找 lastWrite，
// 但原文层记录根本没有 source/category 字段（它用 src，且只有 kind/role/scope/t/text）。
// 「我上次自己写东西」是**印象层**的事：impressions.jsonl 才有 source（4 态）
// 和 category（impression/selfNote）。所以两处数据来源必须分开，不能混在一条链里。

import { loadImpressions, collapse, CATEGORY_SELF_NOTE } from './impressions.js';

/**
 * D1 拍板的阈值：**累计 N 条用户消息 或 跨自然日**即认为「该被提醒了」。
 * 写成文件顶部常量，别散在逻辑里。
 *   - 不用「对话条数」：工作侧 AI 长输出会把数字顶上去，陪伴会话永远够不着。
 *   - 不用「窗口 60% / 80 轮」：拿不到宿主 token 用量，且实测 127 个真会话里
 *     用户消息 median 只有 1 条、≥80 条仅 13% 几乎全是工作侧施工会话，
 *     阈值型触发结构上够不着（见《审计-L4与印象层触发条件》）。
 */
export const TRIGGER_THRESHOLD_USER_MSGS = 10;
export const TRIGGER_THRESHOLD_DAYS = 1;

const DAY_MS = 86_400_000;

/**
 * 现算一次「自主写入读数」。
 * @param {object} mem  open() 的返回对象（要有 .dir / .store）
 * @param {object} [opts]
 * @param {number} [opts.now]  便于测试注入固定时刻
 * @returns {{
 *   lastWriteAt: number|null,   // 上次自主写入的毫秒时间；null = 从没自己写过
 *   daysSince: number|null,     // 距今几个自然日；null = 从没自己写过
 *   newUserMsgs: number,        // 自上次自主写入以来的用户消息条数
 *   threshold: { userMsgs:number, days:number },
 *   due: boolean                // 是否达到提醒阈值
 * }}
 */
export function computeTriggerRead(mem, { now = Date.now() } = {}) {
  const dir = mem && mem.dir;

  // —— 1) 上次自主写入时间：从印象层现取 ——
  // 「自主写入」= source 为 inferred / imagined（我自己推的/我自己想的），
  // 或 category=selfNote（L4 自我叙述，无论 source）。user_said 是他说的，不算；
  // told 是听说，也不算。这些是「念自己动笔」的唯一可查痕迹。
  let lastWrite = 0;
  try {
    const imps = collapse(loadImpressions(dir));
    for (const f of imps) {
      if (!f || f.archived || f.voided) continue;
      const autonomous = ['inferred', 'imagined'].includes(f.source)
        || (f.category || '') === CATEGORY_SELF_NOTE;
      if (!autonomous) continue;
      // revisedAt（bump 追加的修订时间）优先，其次 createdAt（写入时刻），再次 t（事件时刻）。
      const t = Number(f.revisedAt || f.createdAt || f.t || 0) || 0;
      if (t > lastWrite) lastWrite = t;
    }
  } catch { /* 印象层读不到就当从没写过，不影响其余读数 */ }

  // —— 2) 自上次自主写入以来的用户消息条数：从原文层现算 ——
  // role:'life' 是**最宽可见范围**（shared+work+life），因为这是「库级计数」：
  // 无论当前进程是哪一侧，数出来的都应是同一个全库事实。这里只往外出**一个整数**，
  // 不返回任何正文，所以放宽镜头不会泄漏 life 内容。
  let all = [];
  try {
    all = (mem && mem.store) ? mem.store.query({ limit: 0, role: 'life' }) : [];
  } catch { all = []; }
  const newUserMsgs = all.filter((r) =>
    ['msg', 'user'].includes(r.kind) && (Number(r.t) || 0) > lastWrite
  ).length;

  const daysSince = lastWrite ? Math.floor((now - lastWrite) / DAY_MS) : null;
  const due = newUserMsgs >= TRIGGER_THRESHOLD_USER_MSGS
    || (daysSince !== null && daysSince >= TRIGGER_THRESHOLD_DAYS);

  return {
    lastWriteAt: lastWrite || null,
    daysSince,
    newUserMsgs,
    threshold: { userMsgs: TRIGGER_THRESHOLD_USER_MSGS, days: TRIGGER_THRESHOLD_DAYS },
    due
  };
}

/** 天数的人话写法。null（从没自己写过）单列，别显示成 NaN 天。 */
export function triggerDaysText(read) {
  return read.daysSince === null ? '从未自己写过' : `${read.daysSince} 天`;
}

/**
 * cm-boot 用的**中性读数**行（D1：boot 只给中性读数，不放「有变化就写一句」的提醒）。
 * 独立一段，绝不塞进 block.text / selfNote / L4 / 印象注入块。
 */
export function triggerReadLine(read) {
  return `【自主写入读数】距上次自己写东西：${triggerDaysText(read)} / 其间你说了 ${read.newUserMsgs} 句话。`
    + '（这是中性读数，不是指令；要不要写、写什么，你自己判断。）';
}

/**
 * cm-status 用的**待办提醒**行（D1：提醒落 status 健康段）。
 * 只在 due=true 时显示；只提醒、不代写、不强制。
 */
export function triggerTodoLine(read) {
  return `  自主写入  距上次自己写东西 ${triggerDaysText(read)} / 新增 ${read.newUserMsgs} 句`
    + ' —— 想想有没有变化要写；有就写一句，没有就不凑数。（只提醒，不代写）';
}
