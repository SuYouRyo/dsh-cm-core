// 原文层「归档」——让某条记忆不再被召回。
//
// 为什么要单独一个文件，不复用 raw/tombstones.txt：
//   墓碑是「这条是污染副本，物理清理掉了」的语义（cm-decontaminate / cm-gc 写），
//   store.append 见到墓碑会**跳过重灌**。归档是相反的语义：原文还在、还要能
//   被点名读到（cm read <id>），只是**不被检索/注入捞出来**。混用会让「归档」
//   变成「删除」的副作用，一次手滑就不可逆。
//
// 为什么是 append-only 的 jsonl 而不是一行一个 id 的 txt：
//   归档要知道是谁、什么时候、为什么（红线：只追加、不物理删除、可回溯）。
//   取消归档也写成一条新记录（kind='unarchive'），同一个 id **后写的覆盖先写的**。
//   这样「这条为什么曾经被藏起来」永久留痕，而当前状态由最后一条决定。
//
// 落盘位置：<dir>/raw/recall-archive.jsonl（跟 raw/events 一起同步，跟着库走）。

import fs from 'node:fs';
import path from 'node:path';
import { fileStamp } from './shared.js';

export const ARCHIVE_FILENAME = 'recall-archive.jsonl';

export function archivePathOf(dir) {
  // 三种入参都要认：
  //   库根 <库>        → <库>/raw/recall-archive.jsonl
  //   raw 目录 <库>/raw → <库>/raw/recall-archive.jsonl
  //   events 目录（search.js 的 createRecall 拿到的就是这个）
  //                    → <库>/raw/recall-archive.jsonl，绝不放回 events/ 里。
  // 为什么最后这条重要：search 的 shardFiles() 会把 dir 下所有 *.jsonl 当分片读，
  // 归档表要是落进 events/，它自己就会被当成一条事件记录读进来。
  const d = String(dir || '');
  if (path.basename(d) === 'events') return path.join(path.dirname(d), ARCHIVE_FILENAME);
  const rawGuess = path.join(d, 'raw');
  try {
    if (fs.statSync(rawGuess).isDirectory()) return path.join(rawGuess, ARCHIVE_FILENAME);
  } catch { /* 没有 raw/ 子目录，说明给的已经是 raw 或别的什么 */ }
  return path.join(d, ARCHIVE_FILENAME);
}

/**
 * 读归档表，返回 Map<id, entry>。同 id 后写覆盖先写。
 * 坏行跳过、不当成错误：归档表坏一行不能连累整个记忆库不可用。
 */
export function readArchive(dir) {
  const file = archivePathOf(dir);
  const out = new Map();
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return out; // 没有归档文件 = 还没归档过任何东西
  }
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    let e;
    try { e = JSON.parse(s); } catch { continue; }
    if (!e || !e.id) continue;
    if (e.kind === 'unarchive') out.delete(String(e.id));
    else out.set(String(e.id), e);
  }
  return out;
}

export function archivedIdSet(dir) {
  return new Set(readArchive(dir).keys());
}

function appendLines(dir, entries) {
  const file = archivePathOf(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.appendFileSync(file, body, 'utf8');
  return entries;
}

/**
 * 归档若干条：之后它们不再被检索/注入捞到，但 cm read <id> 仍能点名读到。
 * 返回真正新写入的条数（已经在归档表里的不重复写）。
 */
export function archiveRecall(dir, ids, { why = '', by = { actor: 'cm', source: 'cli' }, at = Date.now(), now, replacedBy = null } = {}) {
  const list = (Array.isArray(ids) ? ids : [ids]).map((x) => String(x || '').trim()).filter(Boolean);
  if (!list.length) return { ok: false, reason: '没给 id' };
  const cur = readArchive(dir);
  const t = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const entries = [];
  const skipped = [];
  for (const id of list) {
    const prev = cur.get(id);
    if (prev) { skipped.push({ id, reason: '已经归档过了' }); continue; }
    // W8（K4 定性版）：抽「旧说法不该再进结果」这一思路，但**不建事件级 revise 边**——
    // 只在归档记录里加一个可选 `replacedBy` 指向新 id。检索到旧记录时据此给出「已改为 X」，
    // 而不是只回「查不到」。不动原文层结构、不加同步文件、不改检索主分。
    const entry = { id, kind: 'archive', at: Number.isFinite(at) ? at : t, by, why: String(why || '') };
    if (replacedBy) entry.replacedBy = String(replacedBy);
    entries.push(entry);
  }
  if (entries.length) appendLines(dir, entries);
  return { ok: true, archived: entries.map((e) => e.id), skipped };
}

/** 取某条归档记录指向的「新说法」id（没有就是 null）。只读。 */
export function successorOf(dir, id) {
  const cur = readArchive(dir);
  const e = cur.get(String(id || '').trim());
  if (!e || e.kind !== 'archive') return null;
  return e.replacedBy || null;
}

/** 取消归档：写一条 unarchive，当前状态由最后一条决定。 */
export function unarchiveRecall(dir, ids, { why = '', by = { actor: 'cm', source: 'cli' }, at = Date.now() } = {}) {
  const list = (Array.isArray(ids) ? ids : [ids]).map((x) => String(x || '').trim()).filter(Boolean);
  if (!list.length) return { ok: false, reason: '没给 id' };
  const cur = readArchive(dir);
  const entries = [];
  const skipped = [];
  for (const id of list) {
    if (!cur.has(id)) { skipped.push({ id, reason: '本来就没归档' }); continue; }
    entries.push({ id, kind: 'unarchive', at, by, why: String(why || '') });
  }
  if (entries.length) appendLines(dir, entries);
  return { ok: true, unarchived: entries.map((e) => e.id), skipped };
}

/**
 * 给 store / search 用的「热加载归档表」。
 * 多进程共享一个库：另一台设备同步过来、或另一个会话刚归档了东西，
 * 本进程必须**下一次读就能看见**，否则「归档了却还在被召回」。
 * 用 fileStamp 比指纹，变了就重读——和 store.loadTombstones() 同一套路。
 */
export function createArchiveWatcher(dir) {
  const file = archivePathOf(dir);
  let stamp = null;
  let set = new Set();
  const reload = () => {
    stamp = fileStamp(file);
    set = archivedIdSet(dir);
    return set;
  };
  reload();
  return {
    path: file,
    has(id) {
      if (fileStamp(file) !== stamp) reload();
      return set.has(String(id));
    },
    current() {
      if (fileStamp(file) !== stamp) reload();
      return set;
    },
    /** 归档文件的指纹；变了说明别处动过，缓存必须失效。 */
    stamp() {
      if (fileStamp(file) !== stamp) reload();
      return stamp;
    },
    reload
  };
}

/** 把归档状态渲染成人看的一段（cm archive-recall --list 用）。 */
export function renderArchive(map, { max = 50 } = {}) {
  const rows = [...map.values()].sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
  if (!rows.length) return '（没有归档的记忆）';
  const lines = [`【已归档】共 ${rows.length} 条（不再被召回；cm read <id> 仍可点名读到）`];
  for (const r of rows.slice(0, max)) {
    const when = Number.isFinite(Number(r.at)) ? new Date(Number(r.at) + 8 * 3600_000).toISOString().replace('T', ' ').slice(0, 19) : '—';
    lines.push(`  ${r.id}  ${when}  ${r.why || '（没写原因）'}`);
  }
  if (rows.length > max) lines.push(`  …还有 ${rows.length - max} 条`);
  return lines.join('\n');
}
