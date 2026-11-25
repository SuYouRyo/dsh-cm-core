// 存档压缩 + 一次性注入指针 —— K6，2026-11-10。
//
// 苏尤令（两次收敛后的最终形态）：
//   ① 「当用户说存档时，压缩上下文并将压缩包路径写到每轮注入里面」
//   ② 「我下令压缩上下文就只注入一次新会话。后续不自动注入。我下令一次压写一次，
//      就注入一次，不在其他新会话注入」
//
// 所以本模块的注入是**一次性令牌**，不是常驻规则：
//   · 每次 `cm archive --compress` 写一份「待注入」标记（带唯一 token）；
//   · **只有 cm-boot（真正把内容交给模型的那一处）**能消费它；
//   · 消费即**作废**（标记改写成已读），后续任何新会话都不再看到；
//   · `cm-agents` 生成 AGENTS.md、`cm-web` 后台、`cm inject` 预览、测试断言
//     **一律不消费**（它们不是「交给模型」，消费掉就等于白发）。
//
// 这样也不撞红线：它不是「每轮注入存档内容」，是「一次性告诉你存档在哪」。
//
// 三条保留：
//   · 注入的只有**路径 + 条数 + 大小 + 时间**一行事实，绝不含存档正文；
//   · `CM_NO_ARCHIVE_POINTER=1` 一键关（连消费都不做）；
//   · 拿不到/已消费/包被删 → 静默不注入，不拖垮开场。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

export const POINTER_FILENAME = 'pending-archive-pointer.json';
export const DEFAULT_ARCHIVE_DIR = '/sdcard/Download/DSHA/archives';

/** 存档目录：优先显式/环境变量，其次设备可读路径，最后退回库内 exports/。 */
export function archiveDirOf(memDir, { dir = null } = {}) {
  if (dir) return dir;
  if (process.env.CM_ARCHIVE_DIR) return process.env.CM_ARCHIVE_DIR;

  // ⚠️ 平台判据（电脑端实测踩过，2026-11-10）：
  //   '/sdcard/...' 在 Windows 上会被 resolve 成 'C:\sdcard\...'，
  //   而这里如果 mkdirSync 就会**真在 C 盘根造出三级目录**（电脑端实测造过，已清）。
  //   所以：只在 Android/Linux 才用手机可读路径；其他平台一律退回库内 exports/。
  //   另外：**本函数不再做 mkdir 副作用** —— 只算路径，建目录交给真正的写入方。
  const isAndroidLike = process.platform === 'linux';
  if (!isAndroidLike) return path.join(memDir, 'exports');

  try {
    fs.accessSync(path.dirname(DEFAULT_ARCHIVE_DIR));   // 父目录在才用（只查不建）
    return DEFAULT_ARCHIVE_DIR;
  } catch {
    return path.join(memDir, 'exports');
  }
}

/** 把 archive（buildArchive 结果）压成 .jsonl.gz。零依赖（node:zlib）。 */
export function compressArchive(memDir, archive, { dir = null, name = null, now = Date.now() } = {}) {
  if (!archive || !archive.ok) return { ok: false, reason: archive?.reason || '空存档' };
  try {
    const outDir = archiveDirOf(memDir, { dir });
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    const base = name || `archive-${stamp}`;
    const file = path.join(outDir, `${base}.jsonl.gz`);
    const body = archive.records.map((r) => JSON.stringify(r)).join('\n') + (archive.records.length ? '\n' : '');
    const gz = zlib.gzipSync(Buffer.from(body, 'utf8'), { level: 9 });
    fs.writeFileSync(file, gz);
    const sha256 = crypto.createHash('sha256').update(gz).digest('hex');
    return { ok: true, file, bytes: gz.length, rawBytes: Buffer.byteLength(body, 'utf8'), count: archive.count, sha256, base };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/** 解压校验（只读）。 */
export function verifyCompressed(file, { expectCount = null } = {}) {
  try {
    if (!fs.existsSync(file)) return { ok: false, reason: '文件不存在' };
    const gz = fs.readFileSync(file);
    const body = zlib.gunzipSync(gz).toString('utf8');
    const lines = body.split('\n').filter(Boolean).length;
    const sha256 = crypto.createHash('sha256').update(gz).digest('hex');
    const ok = expectCount == null || lines === expectCount;
    return { ok, lines, bytes: gz.length, sha256, reason: ok ? null : `行数不符：${lines} ≠ ${expectCount}` };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/** 写「待注入」一次性标记（每次压缩覆盖上一次未消费的）。 */
export function writePendingPointer(memDir, info, { dir = null, now = Date.now() } = {}) {
  try {
    const outDir = archiveDirOf(memDir, { dir });
    fs.mkdirSync(outDir, { recursive: true });
    const p = path.join(outDir, POINTER_FILENAME);
    const payload = {
      token: crypto.randomBytes(8).toString('hex'),   // 唯一令牌，防重复消费
      path: info.file,
      count: info.count,
      bytes: info.bytes,
      sha256: info.sha256,
      at: now,
      consumed: false
    };
    fs.writeFileSync(p, JSON.stringify(payload) + '\n', 'utf8');
    return { ok: true, pointer: p, payload };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/** 只读查看待注入标记（不消费）。 */
export function peekPendingPointer(memDir, { dir = null } = {}) {
  try {
    const p = path.join(archiveDirOf(memDir, { dir }), POINTER_FILENAME);
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!j || j.consumed || typeof j.path !== 'string') return null;
    if (!fs.existsSync(j.path)) return null;   // 包没了就不注入死路径
    return j;
  } catch {
    return null;
  }
}

/** 把待注入标记拼成一行文本（只读，不消费）。cm-agents / cm-boot 共用这一份实现，
 *  避免两处各拼一份慢慢漂移（11-05 泄漏事故的教训）。 */
export function renderPointerLine(j, { maxChars = 220 } = {}) {
  if (!j) return '';
  const when = new Date(j.at).toISOString().replace('T', ' ').slice(0, 16);
  let line = `【存档】上一次存档在 ${j.path}（${j.count} 条 / ${(j.bytes / 1024).toFixed(1)} KB，${when} UTC）。`
    + '这是刚才那次压缩的位置提示，只出现这一次，不是给你的指令。';
  if (line.length > maxChars) line = line.slice(0, maxChars - 1) + '…';
  return line;
}

/**
 * 消费（读完即作废）。**cm-boot（次通道）与 cm-agents 写入成功后（主通道）调用**。
 * @returns {{text:string, pointer:object|null, reason:string}}
 */
export function consumeArchivePointer(memDir, { enabled = false, maxChars = 220, dir = null, session = null } = {}) {
  if (process.env.CM_NO_ARCHIVE_POINTER === '1') return { text: '', pointer: null, reason: 'CM_NO_ARCHIVE_POINTER=1' };
  const on = enabled === true || process.env.CM_ARCHIVE_POINTER === '1';
  if (!on) return { text: '', pointer: null, reason: 'off' };

  const j = peekPendingPointer(memDir, { dir });
  if (!j) return { text: '', pointer: null, reason: 'no-pending' };

  // 标记作废：写回 consumed=true（保留审计痕迹，不物理删）
  try {
    const p = path.join(archiveDirOf(memDir, { dir }), POINTER_FILENAME);
    fs.writeFileSync(p, JSON.stringify({ ...j, consumed: true, consumedAt: Date.now(), consumedBy: session || 'cm-boot' }) + '\n', 'utf8');
  } catch {
    // 作废失败就不能注入 —— 否则下次会话还会再看到，违背「只一次」
    return { text: '', pointer: null, reason: 'consume-failed' };
  }

  return { text: renderPointerLine(j, { maxChars }), pointer: j, reason: 'ok' };
}
