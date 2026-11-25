// 本地时间格式化（固定偏移，不依赖系统 tzdata）。
//
// 起因（2026-11-04，他第二次抓到）：容器/手机 proot 里常常**没有装 tzdata**，
// `toLocaleString('zh-CN')` 和 `getHours()` 会静悄悄按 UTC 走，不报错。
// 于是开场注入里「最近说过的话」的时间戳全是 UTC 冒充北京时间，
// AI 拿着 07:29 去推「早上七点、熬夜、今晚歇」，连着两天判断错。
// 11-03 已经犯过一次同类错（只取时分秒、没做 UTC→北京换算），别再犯第三次。
//
// 做法：一律把毫秒先平移 offset 分钟，再用 getUTC*() 取字段。
// 这样无论宿主时区是什么、有没有 tzdata，结果都一致。
// 默认 UTC+8（北京时间）。别的环境用 CM_TZ_OFFSET_MINUTES 覆盖，例如 0 = UTC。
//
// 注意：这里只处理「显示」与「按天分桶」。存进库的一律还是 Unix 毫秒（UTC 无关），
// 不要改存储格式，否则历史数据全乱。

const OFFSET_MINUTES = Number.isFinite(Number(process.env.CM_TZ_OFFSET_MINUTES))
  ? Number(process.env.CM_TZ_OFFSET_MINUTES)
  : 480;

const p = (n) => String(n).padStart(2, '0');

/** 把毫秒平移到本地偏移后的 UTC 字段。 */
export function localParts(ms) {
  const d = new Date(Number(ms) + OFFSET_MINUTES * 60000);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    s: d.getUTCSeconds(),
    wd: d.getUTCDay(),
  };
}

/** 'YYYY/MM/DD HH:mm:ss' —— 替代 toLocaleString('zh-CN', { hour12: false }) */
export function fmtLocal(ms) {
  const t = localParts(ms);
  return `${t.y}/${p(t.mo)}/${p(t.d)} ${p(t.h)}:${p(t.mi)}:${p(t.s)}`;
}

/** 'YYYY-MM-DD HH:mm' —— 横杠版，给原本自己拼 - 分隔的两处用 */
export function fmtLocalMinute(ms) {
  const t = localParts(ms);
  return `${t.y}-${p(t.mo)}-${p(t.d)} ${p(t.h)}:${p(t.mi)}`;
}

/** 'YYYY-MM-DD' */
export function fmtDate(ms) {
  const t = localParts(ms);
  return `${t.y}-${p(t.mo)}-${p(t.d)}`;
}

/** 'YYYY-MM' —— 月份分桶 */
export function fmtMonth(ms) {
  const t = localParts(ms);
  return `${t.y}-${p(t.mo)}`;
}

/** 'YYYY-M-D' —— 不补零，给按天分桶的 key 用（与旧 getMonth()+1 口径一致） */
export function fmtDayKey(ms) {
  const t = localParts(ms);
  return `${t.y}-${t.mo}-${t.d}`;
}

/** 'HH:mm' */
export function fmtClock(ms) {
  const t = localParts(ms);
  return `${p(t.h)}:${p(t.mi)}`;
}

export const TZ_OFFSET_MINUTES = OFFSET_MINUTES;
