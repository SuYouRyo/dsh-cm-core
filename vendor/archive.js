// 只读存档导出 —— W12，2026-11-09 夜。
//
// 社区有人建议「再装个日记功能和存档功能」（苏尤回「对」）。按总档案 §十一 的边界判定：
//   · **不做日记**：撞 W5「情绪存档式收到指令就提炼」不做、念自主决定写不写 L4。
//     （情绪层本身于 2026-11-09 K5 移入「工单区 W13」——不是不做区、也不再挂「未做的」；
//      总档案 §十二 口径区为准，2026-11-10 电脑端复核订正；但「按天硬编日记」这个形式仍不做）
//   · **不做「写进记忆库的存档」**：撞 isAgentsSnapshot 红线（派生物不进原文层）、11/4 事故根子。
//   · **做只读导出**：从原文层生成一份给人看/换机/复核用的 JSONL 快照，不写库、不调模型。
//
// 三条硬边界：
//   ① 纯读：只用 store.query(limit:0)，不 append、不改任何记录。
//   ② 单向门：scope 受 visibleScopes() 约束，工作侧导不出 life。
//   ③ 输出落 exports/（gitignored），附 SHA256 与 manifest，可复算；--dry-run 先看后写。
//
// 与 W1 图纸 / relay 中转包同属「导出面」，不算新记忆层。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 导出目录名（相对记忆库根）。在 .gitignore 里，不进版本库。 */
export const EXPORT_DIR = 'exports';

/**
 * 生成一份存档快照（**不写文件**，由调用方决定落盘）。
 *
 * @param {object} mem
 * @param {object} [opts]
 * @param {'work'|'life'|'sync'} [opts.role]   按哪个角色的可见范围（默认进程角色）
 * @param {string} [opts.scope]                显式限定单个 scope（仍受单向门约束）
 * @param {number} [opts.from] / [opts.to]     时间窗
 * @returns {{ok:boolean, records:object[], count:number, sha256:string, meta:object, reason?:string}}
 */
export function buildArchive(mem, { role = null, scope = null, from = 0, to = Date.now(), now = Date.now() } = {}) {
  try {
    const store = mem && mem.store;
    if (!store || typeof store.query !== 'function') throw new Error('缺少 mem.store.query');
    const recs = store.query({ from, to, limit: 0, role, scope });
    // 只导「记录本身」，不含任何进程内状态；按 id 升序保证跨次复算稳定
    const ordered = [...recs].sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));
    const body = ordered.map((r) => JSON.stringify(r)).join('\n') + (ordered.length ? '\n' : '');
    const sha256 = crypto.createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex');
    return {
      ok: true,
      records: ordered,
      count: ordered.length,
      sha256,
      meta: {
        generatedAt: now,
        from,
        to,
        role: role || 'process-default',
        scope: scope || 'visible',
        format: 'companion-memory-archive-v1',
        note: '只读原文层快照；不含印象层/向量/索引；不是记忆层的一部分'
      }
    };
  } catch (e) {
    return { ok: false, records: [], count: 0, sha256: '', meta: {}, reason: e.message };
  }
}

/**
 * 落盘（唯一写操作，只写 exports/ 下新文件）。
 * @returns {{ok:boolean, file?:string, manifest?:string, reason?:string}}
 */
export function writeArchive(dir, archive, { fileName = null } = {}) {
  if (!archive || !archive.ok) return { ok: false, reason: archive?.reason || '空存档' };
  try {
    const outDir = path.join(dir, EXPORT_DIR);
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date(archive.meta.generatedAt).toISOString().replace(/[:.]/g, '-');
    const base = fileName || `archive-${stamp}`;
    const dataFile = path.join(outDir, `${base}.jsonl`);
    const manifestFile = path.join(outDir, `${base}.manifest.json`);
    const body = archive.records.map((r) => JSON.stringify(r)).join('\n') + (archive.records.length ? '\n' : '');
    fs.writeFileSync(dataFile, body, 'utf8');
    const manifest = {
      ...archive.meta,
      dataFile: path.basename(dataFile),
      count: archive.count,
      sha256: archive.sha256,
      bytes: Buffer.byteLength(body, 'utf8'),
      verify: `node bin/cm.js archive --verify ${path.basename(dataFile)}`
    };
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    return { ok: true, file: dataFile, manifest: manifestFile };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/** 校验一份已落盘的存档：重算 SHA256 与 manifest 比对。纯读。 */
export function verifyArchive(dir, base) {
  try {
    const dataFile = path.join(dir, EXPORT_DIR, `${base}.jsonl`);
    const manifestFile = path.join(dir, EXPORT_DIR, `${base}.manifest.json`);
    if (!fs.existsSync(dataFile) || !fs.existsSync(manifestFile)) {
      return { ok: false, reason: '缺 .jsonl 或 .manifest.json' };
    }
    const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const sha = crypto.createHash('sha256').update(fs.readFileSync(dataFile)).digest('hex');
    const bytes = fs.statSync(dataFile).size;
    const lines = fs.readFileSync(dataFile, 'utf8').split('\n').filter(Boolean).length;
    const ok = sha === m.sha256 && bytes === m.bytes && lines === m.count;
    return { ok, sha256: sha, expected: m.sha256, lines, count: m.count, bytes, reason: ok ? null : 'sha/行数/字节数不一致' };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}
