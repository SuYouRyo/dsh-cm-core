// 冷归档（cold archive）：把「上个月及更早」的月度原文分片 gzip 收进 raw/cold_archive/。
//
// 与「召回归档」（recall-archive.js）不是一回事，别合并：
//   · 召回归档：原文留在热分片里，只是不再被检索/注入捞出来（可随时撤销）。
//   · 冷归档：原文从热目录移走，改成 .jsonl.gz 存着，**仍然可以被检索到**，
//     只是读取时要先解压。目的是让 events/ 的月分片不再无限增长（2026-11 已 24MB）。
//
// 三条硬规矩（违反任何一条就是数据事故）：
//   1. **不物理删除**：归档 = 换一种存储形态，原文的字节必须一字不差地留在 .gz 里。
//      所以压缩后必须解压回来做 sha256 + 行数比对，不一致就回滚（源文件不动）。
//   2. **默认不动手**：bin/cm-archive.js 不带 --now 时只报告。
//   3. **当月永不归档**：当月分片还在被 append 写，压走会立刻被重建出半个文件。
//
// ── 为什么是「按需解压」而不是「启动时建索引」──────────────────────────
// 实测（真实库，2026-10 分片 1099332 字节 / 1140 行）：gunzip 约 16ms；
// 2026-11 分片 24082366 字节 / 22115 行：gunzip 约 210ms。
// 启动建索引意味着每次 `cm --help`、每条 `cm append` 都要付这几百毫秒，
// 而绝大多数调用（写入、boot 取最近 20 条）根本不碰历史月份。
// 按需解压只在「查询范围真的覆盖到那个月」时才付解压成本：
// query({from: 最近三天}) 用月份边界直接跳过冷分片，一次都不解压；
// query({from: 0}) 才解压，解压结果按 (size:mtime) 缓存，同一进程内只付一次。
// 代价是内存里可能驻留一份解压后的文本 —— 用 MAX_CACHE_BYTES 兜住（默认 64MB，
// 超了按最久未用淘汰），比「启动就把全库建成对象树」可控得多。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fmtMonth, TZ_OFFSET_MINUTES } from './localtime.js';

/** 冷归档目录名（在 raw/ 下面，与 events/ 并列）。 */
export const COLD_DIRNAME = 'cold_archive';
/** 冷文件后缀。命名约定：`raw/cold_archive/YYYY-MM.jsonl.gz`，与热分片同名加 .gz。 */
export const COLD_SUFFIX = '.jsonl.gz';
/** 归档/恢复/失败都要留痕的审计账本（只追加）。 */
export const COLD_MANIFEST_NAME = 'manifest.jsonl';
/** 恢复出来的冷文件挪到这里（留作备份，不再参与读取）。 */
export const COLD_RESTORED_DIRNAME = 'restored';
/** 账本格式版本。 */
export const COLD_FORMAT = 1;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 数「非空行」，与 store/query 的读法保持一致（空行不算记录）。 */
export function countNonEmpty(text) {
  let n = 0;
  for (const line of String(text || '').split('\n')) if (line.trim()) n++;
  return n;
}

/**
 * 把各种入参（库根 / raw 目录 / events 目录）统一成库根。
 * 三个入口都能用是有原因的：createStore 拿到的是库根，search.js 拿到的是 events 目录，
 * 而调用方常常手里只有一个 —— 到处拼 '../..' 迟早拼错。
 */
export function coldRootOf(dir) {
  const abs = path.resolve(String(dir || '.'));
  if (path.basename(abs) === 'events' && path.basename(path.dirname(abs)) === 'raw') {
    return path.dirname(path.dirname(abs));
  }
  if (path.basename(abs) === 'raw') return path.dirname(abs);
  return abs;
}

export function coldPaths(dir) {
  const root = coldRootOf(dir);
  const coldDir = path.join(root, 'raw', COLD_DIRNAME);
  return {
    root,
    eventsDir: path.join(root, 'raw', 'events'),
    coldDir,
    manifestPath: path.join(coldDir, COLD_MANIFEST_NAME),
    restoredDir: path.join(coldDir, COLD_RESTORED_DIRNAME)
  };
}

/** `2026-10.jsonl.gz` → `2026-10`；不是冷文件名返回 null。 */
export function shardOfColdName(name) {
  const s = String(name || '');
  return s.endsWith(COLD_SUFFIX) ? s.slice(0, -COLD_SUFFIX.length) : null;
}

/** 冷目录里现存的冷分片，按月份升序。 */
export function listColdShards(dir) {
  const { coldDir } = coldPaths(dir);
  let names = [];
  try { names = fs.readdirSync(coldDir); } catch { return []; }
  const out = [];
  for (const name of names) {
    const shard = shardOfColdName(name);
    if (!shard) continue;
    const file = path.join(coldDir, name);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (!st.isFile()) continue;
    out.push({ shard, name, file, bytes: st.size, mtimeMs: st.mtimeMs });
  }
  out.sort((a, b) => (a.shard < b.shard ? -1 : a.shard > b.shard ? 1 : 0));
  return out;
}

/** 冷分片月份列表。 */
export function coldShardMonths(dir) {
  return listColdShards(dir).map((s) => s.shard);
}

/** 读账本：原件 + 每个 shard 的当前状态（cold=已归档 / hot=已恢复）。 */
export function readColdManifest(dir) {
  const { manifestPath } = coldPaths(dir);
  const records = [];
  let raw = '';
  try { raw = fs.readFileSync(manifestPath, 'utf8'); } catch { /* 还没归档过，正常 */ }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { /* 半行/脏行跳过，不因为一条坏账本读不出全库 */ }
  }
  const state = new Map();
  for (const r of records) {
    if (!r || !r.shard) continue;
    if (r.kind === 'archive') state.set(r.shard, { ...r, state: 'cold' });
    else if (r.kind === 'restore') state.set(r.shard, { ...r, state: 'hot' });
  }
  return { records, state, path: manifestPath };
}

/** 某个月最后一次成功归档的账本记录（给恢复/校验对 sha 用）。 */
export function coldRecordOf(dir, shard) {
  const { state } = readColdManifest(dir);
  const r = state.get(shard);
  return r && r.state === 'cold' ? r : null;
}

/** 冷归档指纹：文件列表 + 大小 + mtime + 账本，用作各类缓存的键。 */
export function coldStamp(dir) {
  const parts = [];
  for (const s of listColdShards(dir)) parts.push(`${s.shard}:${s.bytes}:${Math.round(s.mtimeMs)}`);
  const { manifestPath } = coldPaths(dir);
  try {
    const st = fs.statSync(manifestPath);
    parts.push(`m:${st.size}:${Math.round(st.mtimeMs)}`);
  } catch {
    parts.push('m:missing');
  }
  return parts.join('|') || ':none';
}

// ── 解压缓存 ────────────────────────────────────────────────────────────────
// 同一进程里反复 query 不该反复解压。键是绝对路径，值是解压后的文本。
// 只按「大小 + mtime」判新鲜：冷文件写完就不再变，这个判据足够。
const MAX_CACHE_BYTES = Number(process.env.CM_COLD_CACHE_BYTES) > 0
  ? Number(process.env.CM_COLD_CACHE_BYTES)
  : 64 * 1024 * 1024;
const textCache = new Map(); // file -> { stamp, text, size, used }
let cachedBytes = 0;

export function clearColdCache() {
  textCache.clear();
  cachedBytes = 0;
}

function evictIfNeeded() {
  while (cachedBytes > MAX_CACHE_BYTES && textCache.size > 1) {
    let oldestKey = null;
    let oldest = Infinity;
    for (const [k, v] of textCache) if (v.used < oldest) { oldest = v.used; oldestKey = k; }
    if (oldestKey == null) break;
    const v = textCache.get(oldestKey);
    cachedBytes -= v.size;
    textCache.delete(oldestKey);
  }
}

/**
 * 解压一个冷分片并返回文本（带缓存）。
 * 解压失败**必须抛**：静悄悄返回空字符串等于「历史没了还装作没事」。
 */
export function coldText(dir, shard) {
  const { coldDir } = coldPaths(dir);
  const file = path.join(coldDir, `${shard}${COLD_SUFFIX}`);
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const stamp = `${st.size}:${Math.round(st.mtimeMs)}`;
  const hit = textCache.get(file);
  if (hit && hit.stamp === stamp) { hit.used = Date.now(); return hit.text; }
  const buf = fs.readFileSync(file);
  let text;
  try {
    text = zlib.gunzipSync(buf).toString('utf8');
  } catch (e) {
    throw new Error(`冷归档解压失败：${file} — ${e && e.message ? e.message : e}`);
  }
  const size = Buffer.byteLength(text, 'utf8');
  if (hit) cachedBytes -= hit.size;
  textCache.set(file, { stamp, text, size, used: Date.now() });
  cachedBytes += size;
  evictIfNeeded();
  return text;
}

/** 冷分片的非空行（不解析）。 */
export function coldLines(dir, shard) {
  const text = coldText(dir, shard);
  if (text == null) return [];
  return text.split('\n').filter((l) => l.trim());
}

/** 冷分片里解析出来的记录。坏行跳过（与热分片的读法一致）。 */
export function coldRecordsOfShard(dir, shard) {
  const out = [];
  for (const line of coldLines(dir, shard)) {
    try { out.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
  }
  return out;
}

/** 月份边界（本地时区口径，与 fmtMonth 一致）。 */
export function monthBoundsOf(shard) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(shard || ''));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (!(mo >= 1 && mo <= 12)) return null;
  const offsetMs = TZ_OFFSET_MINUTES * 60_000;
  const start = Date.UTC(y, mo - 1, 1) - offsetMs;
  const end = Date.UTC(y, mo, 1) - offsetMs - 1;
  return { start, end };
}

/** 这个月有没有跟 [from,to] 相交 —— 不相交就根本不用解压。 */
export function shardOverlaps(shard, from, to) {
  const b = monthBoundsOf(shard);
  if (!b) return true; // 认不出月份就保守地读，宁可慢不可漏
  return b.end >= from && b.start <= to;
}

/**
 * 按范围读冷归档里的记录（只读，不做 scope 过滤——过滤是调用方的事）。
 * 这是 store.query / search.load / reflect 共用的唯一入口。
 */
export function coldRecords(dir, { from = 0, to = Date.now(), shards = null } = {}) {
  const list = shards ? shards.map((s) => ({ shard: s })) : listColdShards(dir);
  const out = [];
  for (const { shard } of list) {
    if (!shardOverlaps(shard, from, to)) continue;
    for (const rec of coldRecordsOfShard(dir, shard)) {
      const t = Number(rec && rec.t);
      if (Number.isFinite(t) && (t < from || t > to)) continue;
      out.push(rec);
    }
  }
  return out;
}

/** 冷归档的统计摘要（不解压，全部来自账本 + stat）。 */
export function coldSummary(dir) {
  const shards = listColdShards(dir);
  const { state } = readColdManifest(dir);
  let gzBytes = 0;
  let rawBytes = 0;
  let records = 0;
  let unknown = 0;
  const rows = [];
  for (const s of shards) {
    gzBytes += s.bytes;
    const rec = state.get(s.shard);
    const hasMeta = !!(rec && rec.state === 'cold');
    if (hasMeta) {
      rawBytes += Number(rec.bytes) || 0;
      records += Number(rec.lines) || 0;
    } else {
      unknown++;
    }
    rows.push({
      shard: s.shard,
      gzBytes: s.bytes,
      bytes: hasMeta ? Number(rec.bytes) || 0 : null,
      lines: hasMeta ? Number(rec.lines) || 0 : null,
      sha256: hasMeta ? rec.sha256 || null : null,
      at: hasMeta ? rec.at || null : null
    });
  }
  return { dir: coldPaths(dir).coldDir, shards: rows, count: rows.length, gzBytes, bytes: rawBytes, records, unknownMeta: unknown };
}

// ── 计划 / 归档 / 恢复 / 校验 ────────────────────────────────────────────────

function monthShift(shard, delta) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(shard || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * 算出这次该归档哪些分片（只读，不动盘）。
 *
 * 规则：
 *   · 只认 `YYYY-MM.jsonl` 这种月度分片（别的分片名可能是人工产物，不碰）；
 *   · 当月不归档（还在被 append 写）；
 *   · 保留最近 keepMonths 个月（含当月）：keepMonths=1 就是「上个月及更早都收走」；
 *   · 已有同名冷文件的跳过（**不覆盖**）——热分片里可能只有一条 rescope 修订行，
 *     覆盖会把冷文件里的整月历史冲掉。要重归档先 --restore。
 */
export function planColdArchive(dir, { now = Date.now(), keepMonths = 1 } = {}) {
  const { eventsDir } = coldPaths(dir);
  let names = [];
  try { names = fs.readdirSync(eventsDir); } catch { return []; }
  const current = fmtMonth(now);
  const keep = Number.isFinite(Number(keepMonths)) ? Math.max(1, Number(keepMonths)) : 1;
  const cutoff = monthShift(current, -(keep - 1)); // 早于这个月份的一律归档
  const cold = new Set(listColdShards(dir).map((s) => s.shard));
  const out = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.jsonl')) continue;
    const shard = name.slice(0, -'.jsonl'.length);
    if (!/^\d{4}-\d{2}$/.test(shard)) continue;
    if (shard >= current) continue;
    if (cutoff && shard >= cutoff) continue;
    const file = path.join(eventsDir, name);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (!st.isFile()) continue;
    out.push({ shard, file, bytes: st.size, mtimeMs: st.mtimeMs, coldExists: cold.has(shard) });
  }
  return out;
}

function writeDurable(file, buf) {
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeSync(fd, buf, 0, buf.length, 0);
    try { fs.fsyncSync(fd); } catch { /* 有的容器/文件系统不支持，落盘靠 close */ }
  } finally {
    fs.closeSync(fd);
  }
}

function appendManifest(manifestPath, rec) {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.appendFileSync(manifestPath, JSON.stringify({ v: COLD_FORMAT, ...rec }) + '\n', 'utf8');
}

const defaultGzip = (buf) => zlib.gzipSync(buf, { level: 9 });

/**
 * 归档一个分片：压缩 → 回读校验 → 落盘 → 再校验 → 记账 → 才删源。
 *
 * 顺序是刻意的：**校验在删源之前**，而且删源在记账之后。
 * 任何一步抛错都在 catch 里清掉半成品（tmp / 已 rename 的 .gz），源文件一个字节都不动。
 *
 * @param {string} dir 库根（或 raw / events 目录，自动归一）
 * @param {string} shard 月份，如 '2026-10'
 * @param {object} [opts]
 * @param {Function} [opts.gzip] 仅供测试注入「故意压坏」的压缩器，生产别传
 * @param {boolean} [opts.verify=true] 回读校验
 */
export function archiveShard(dir, shard, { now = Date.now(), by = '', gzip = defaultGzip, verify = true, dryRun = false } = {}) {
  const { eventsDir, coldDir, manifestPath } = coldPaths(dir);
  const src = path.join(eventsDir, `${shard}.jsonl`);
  const gzPath = path.join(coldDir, `${shard}${COLD_SUFFIX}`);
  const base = { shard, ok: true, archived: false, gzPath };

  if (!fs.existsSync(src)) return { ...base, skipped: 'no-hot-shard', archived: false };
  if (fs.existsSync(gzPath)) {
    let gzBytes = 0;
    try { gzBytes = fs.statSync(gzPath).size; } catch {}
    return { ...base, skipped: 'already-cold', gzBytes };
  }

  let srcBuf;
  try { srcBuf = fs.readFileSync(src); } catch (e) {
    return { ...base, ok: false, error: `读不到热分片：${e.message}` };
  }
  if (!srcBuf.length) return { ...base, skipped: 'empty-shard' };

  const srcText = srcBuf.toString('utf8');
  const sha = sha256(srcBuf);
  const lines = countNonEmpty(srcText);
  const bytes = srcBuf.length;

  if (dryRun) {
    return { ...base, wouldArchive: true, bytes, lines, sha256: sha, archived: false };
  }

  fs.mkdirSync(coldDir, { recursive: true });
  const tmp = path.join(coldDir, `${shard}${COLD_SUFFIX}.tmp-${process.pid}-${now}`);
  let renamed = false;
  try {
    const gzBuf = gzip(srcBuf);
    if (!Buffer.isBuffer(gzBuf) || !gzBuf.length) throw new Error('压缩器没有返回有效 Buffer');
    writeDurable(tmp, gzBuf);
    if (verify) {
      const back = zlib.gunzipSync(fs.readFileSync(tmp));
      const backSha = sha256(back);
      if (backSha !== sha) throw new Error(`回读 sha256 不一致（源 ${sha}，回读 ${backSha}）`);
      const backLines = countNonEmpty(back.toString('utf8'));
      if (backLines !== lines) throw new Error(`回读行数不一致（源 ${lines}，回读 ${backLines}）`);
    }
    fs.renameSync(tmp, gzPath);
    renamed = true;
    if (verify) {
      const again = sha256(zlib.gunzipSync(fs.readFileSync(gzPath)));
      if (again !== sha) throw new Error('落盘后二次校验失败');
    }
    const gzBytes = fs.statSync(gzPath).size;
    const gzSha = sha256(fs.readFileSync(gzPath));
    appendManifest(manifestPath, {
      kind: 'archive',
      shard,
      gz: `${shard}${COLD_SUFFIX}`,
      bytes,
      lines,
      sha256: sha,
      gzBytes,
      gzSha256: gzSha,
      at: now,
      by: by || 'cm-archive'
    });
    let unlinkFailed = null;
    try { fs.unlinkSync(src); } catch (e) { unlinkFailed = e.message; }
    // 清缓存：这个月的冷文件刚出现，之前缓存的是别的状态。
    clearColdCache();
    return { ...base, archived: true, bytes, lines, sha256: sha, gzBytes, gzSha256: gzSha, ratio: gzBytes / bytes, unlinkFailed };
  } catch (e) {
    // 回滚：清掉半成品，源文件不动。
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    if (renamed) { try { if (fs.existsSync(gzPath)) fs.unlinkSync(gzPath); } catch {} }
    try {
      appendManifest(manifestPath, { kind: 'error', shard, at: now, by: by || 'cm-archive', error: String(e && e.message ? e.message : e) });
    } catch {}
    return { ...base, ok: false, archived: false, rolledBack: true, error: String(e && e.message ? e.message : e), bytes, lines, sha256: sha };
  }
}

/** 从冷归档恢复一个月（默认拒绝覆盖现存的同月热分片）。 */
export function restoreShard(dir, shard, { now = Date.now(), by = '', verify = true } = {}) {
  const { eventsDir, coldDir, manifestPath, restoredDir } = coldPaths(dir);
  const gzPath = path.join(coldDir, `${shard}${COLD_SUFFIX}`);
  const dst = path.join(eventsDir, `${shard}.jsonl`);
  const base = { shard, ok: true, restored: false, hotPath: dst };
  if (!fs.existsSync(gzPath)) return { ...base, ok: false, error: '冷文件不存在' };
  if (fs.existsSync(dst)) return { ...base, ok: false, error: '同月热分片已存在，拒绝覆盖（先手工确认）' };

  const gzBuf = fs.readFileSync(gzPath);
  let buf;
  try { buf = zlib.gunzipSync(gzBuf); } catch (e) {
    return { ...base, ok: false, error: `解压失败：${e.message}` };
  }
  const sha = sha256(buf);
  const rec = coldRecordOf(dir, shard);
  if (verify && rec && rec.sha256 && rec.sha256 !== sha) {
    return { ...base, ok: false, error: `解压结果与账本 sha256 不符（账本 ${rec.sha256}，实得 ${sha}）` };
  }
  const tmp = path.join(eventsDir, `${shard}.jsonl.tmp-${process.pid}-${now}`);
  try {
    fs.mkdirSync(eventsDir, { recursive: true });
    writeDurable(tmp, buf);
    if (verify) {
      const back = fs.readFileSync(tmp);
      if (sha256(back) !== sha) throw new Error('回读 sha256 不一致');
    }
    fs.renameSync(tmp, dst);
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    return { ...base, ok: false, error: String(e && e.message ? e.message : e) };
  }
  // 冷文件挪进 restored/ 留作备份：不删（不物理删除），但也不再参与读取，
  // 否则下次归档会「已经存在」直接跳过，热分片就再也压不进去了。
  const lines = countNonEmpty(buf.toString('utf8'));
  let backup = null;
  try {
    fs.mkdirSync(restoredDir, { recursive: true });
    backup = path.join(restoredDir, `${shard}.jsonl.gz`);
    fs.renameSync(gzPath, backup);
  } catch { backup = null; }
  appendManifest(manifestPath, {
    kind: 'restore',
    shard,
    bytes: buf.length,
    lines,
    sha256: sha,
    gzSha256: sha256(gzBuf),
    backup,
    at: now,
    by: by || 'cm-archive'
  });
  clearColdCache();
  return { ...base, restored: true, bytes: buf.length, lines, sha256: sha, backup };
}

/** 校验所有冷分片：能不能解压、sha256 和行数对不对得上账本。 */
export function verifyCold(dir) {
  const { state } = readColdManifest(dir);
  const rows = [];
  for (const s of listColdShards(dir)) {
    const rec = state.get(s.shard);
    const row = { shard: s.shard, ok: true, reason: '', gzBytes: s.bytes, bytes: 0, lines: 0, sha256: null, orphan: !rec };
    let text = '';
    try {
      text = zlib.gunzipSync(fs.readFileSync(s.file)).toString('utf8');
    } catch (e) {
      rows.push({ ...row, ok: false, reason: `解压失败：${e.message}` });
      continue;
    }
    const buf = Buffer.from(text, 'utf8');
    row.bytes = buf.length;
    row.lines = countNonEmpty(text);
    row.sha256 = sha256(buf);
    if (!rec) row.reason = '孤儿冷文件：账本里没有归档记录（可能是归档中途被打断）';
    else if (rec.sha256 && rec.sha256 !== row.sha256) {
      row.ok = false;
      row.reason = `sha256 与账本不符（账本 ${rec.sha256}，实得 ${row.sha256}）`;
    } else if (Number.isFinite(rec.lines) && rec.lines !== row.lines) {
      row.ok = false;
      row.reason = `行数与账本不符（账本 ${rec.lines}，实得 ${row.lines}）`;
    }
    rows.push(row);
  }
  return rows;
}

/** 渲染一行给人看。 */
export function renderColdSummary(summary) {
  if (!summary.count) return '冷归档：空（还没归档过任何月份）';
  const lines = [`冷归档：${summary.count} 个月 / 压缩后 ${fmtBytes(summary.gzBytes)} / 原始 ${fmtBytes(summary.bytes)} / ${summary.records} 条`];
  for (const r of summary.shards) {
    const ratio = r.bytes ? ` ${(r.gzBytes / r.bytes * 100).toFixed(1)}%` : '';
    lines.push(`  ${r.shard}  ${fmtBytes(r.gzBytes)}${ratio}  ${r.lines == null ? '（账本缺元数据）' : `${r.lines} 条`}`);
  }
  return lines.join('\n');
}

export function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v}B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)}KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)}MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)}GB`;
}
