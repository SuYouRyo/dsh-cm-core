// 向量组的纯本地派生：从「可见范围更大」的一组切出「更小」的一组。
//
// 背景（2026-11-15 查实）：
//   `src/index.js` 的 scopeKey 是 `visibleScopes().join(',')`，所以同一个库在不同
//   角色下会产出**不同的向量文件**：
//     work 角色 → BAAI_bge-m3.shared_work.*      （只该有 shared+work）
//     life 角色 → BAAI_bge-m3.shared_work_life.* （全量）
//   `bin/cm-vectors.js` 文件头 2026-11-11 就写了「life 组健康时 work 组可纯本地派生」，
//   但那句话只有注释、没有实现 —— 实际结果是：cm-watch 全程以灌库身份跑（scopeKey
//   是全量），只有 life 组在长；work 组从 2026-11-11 17:58 就冻住了。到 2026-11-15
//   实测：work 可见 19188 条、work 组只有 9798 条，缺 9390 条 = 48.9%。
//   工作侧检索有一半只走词面，而唯一的外显只是一句「向量索引有重复 id」的误报。
//
// 为什么值得单独一个模块而不是塞进 cm-vectors.js：
//   这段是「按 id 白名单切二进制行」，错一位就是整组向量错位、检索悄悄给出错答案，
//   而且不会报错（余弦相似度永远算得出一个有值的数）。所以它必须可被单测钉住。
//
// 为什么是「并集」而不是「用 life 组覆盖 work 组」：
//   work 组现有的行未必都在 life 组里（life 组也可能落后于 work 组，2026-11-15 实测
//   就有约 1699 条只在 work 组）。照 life 组覆盖 = 把这批现成向量丢掉、之后再联网重烧，
//   修一个缺口又造一个缺口。所以源是一个**列表**，按顺序取：先到先得，后来的只补空位。
//
// 红线（单向门）：
//   派生只做**子集**。写出去的每条 id 必须同时满足「在某个源里有向量」和「在 keepIds
//   白名单里」。绝不反向补、绝不放宽。keepIds 由调用方用当前角色的 allDocs() 算，
//   那是已经过 scope 过滤的可见集合。

import fs from 'node:fs';
import path from 'node:path';

/** 读一组 ids（每行一个），按 Map 语义去重：后出现的行号覆盖前面的。
 *  与 src/vectors.js 的 loadFromDisk 完全一致 —— 历史重复 id 只认最后一条，
 *  这样我们解释出来的行号与「正常加载该文件」时是同一个。 */
function readIdsMap(idsPath) {
  const out = new Map();
  let lines = 0;
  try {
    const raw = fs.readFileSync(idsPath, 'utf8').split('\n').filter(Boolean);
    lines = raw.length;
    for (let i = 0; i < lines; i++) out.set(raw[i], i);
  } catch {
    return { map: out, lines: 0 };
  }
  return { map: out, lines };
}

/** 把 sources 归一成 [{idsPath, vecPath, map, usable, buf}]，跳过读不到的源。 */
function openSources(sources, dim) {
  const out = [];
  for (const s of sources || []) {
    if (!s || !s.idsPath || !s.vecPath) continue;
    const { map, lines } = readIdsMap(s.idsPath);
    if (!map.size) continue;
    let buf;
    try { buf = fs.readFileSync(s.vecPath); } catch { continue; }
    const srcRows = Math.floor(buf.byteLength / (dim * 4));
    if (!srcRows) continue;
    // 只认「ids 与 f32 都真实存在」的行号：f32 短了就以它为准。
    // 与 vectors.js 的自愈规则一致（use = min(f32 行数, ids 行数)）。
    out.push({ ...s, map, usable: Math.min(srcRows, lines), buf });
  }
  return out;
}

/**
 * 从若干源派生目标组：目标里只出现 keepIds 中的 id，向量来自「按 sources 顺序第一个
 * 有这条向量的源」。
 *
 * @param {object} o
 * @param {Array<{idsPath:string, vecPath:string}>} o.sources 源组，按优先级排
 * @param {string} o.dstIdsPath   目标组 ids（整体重写）
 * @param {string} o.dstVecPath   目标组 f32（整体重写）
 * @param {Set<string>} o.keepIds 白名单：只有这些 id 能进目标组
 * @param {number} o.dim          维度（dimOf(model)）
 * @returns {{ok:boolean, reason?:string, kept?:number, fromSource?:number[], droppedByWhitelist?:number, droppedNotInKeep?:number}}
 */
export function deriveUnion({ sources, dstIdsPath, dstVecPath, keepIds, dim }) {
  if (!Number.isFinite(dim) || dim <= 0) return { ok: false, reason: `维度非法：${dim}` };
  if (!(keepIds instanceof Set)) return { ok: false, reason: 'keepIds 必须是 Set' };
  const srcs = openSources(sources, dim);
  if (!srcs.length) return { ok: false, reason: '没有可用的源组（ids 或 f32 读不到）' };

  // id → { src: 源下标, row: 行号 }。先到先得：已经有的不再被后来的覆盖。
  const chosen = new Map();
  const fromSource = new Array(srcs.length).fill(0);
  for (let si = 0; si < srcs.length; si++) {
    const s = srcs[si];
    for (const [id, row] of s.map) {
      if (row >= s.usable) continue;
      if (!keepIds.has(id)) continue;
      if (chosen.has(id)) continue;
      chosen.set(id, { src: si, row });
      fromSource[si]++;
    }
  }
  if (!chosen.size) return { ok: false, reason: '源组里没有一条落在 keepIds 里' };

  // 按「第一个源的行号、再按源序、再按 id」排，保证同一批数据每次跑出同样的文件。
  const picked = [...chosen.entries()].map(([id, v]) => ({ id, ...v }));
  picked.sort((a, b) => (a.src - b.src) || (a.row - b.row) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const kept = picked.length;
  const outIds = picked.map((p) => p.id + '\n').join('');
  const outVec = Buffer.allocUnsafe(kept * dim * 4);
  for (let i = 0; i < kept; i++) {
    const { src, row } = picked[i];
    const off = row * dim * 4;
    srcs[src].buf.copy(outVec, i * dim * 4, off, off + dim * 4);
  }

  // 先写临时文件再 rename：中途被打断不会留下半截文件。
  const tmpIds = dstIdsPath + '.derive-tmp';
  const tmpVec = dstVecPath + '.derive-tmp';
  try {
    fs.mkdirSync(path.dirname(dstIdsPath), { recursive: true });
    fs.writeFileSync(tmpIds, outIds, 'utf8');
    fs.writeFileSync(tmpVec, outVec);
    fs.renameSync(tmpIds, dstIdsPath);
    fs.renameSync(tmpVec, dstVecPath);
  } catch (e) {
    for (const p of [tmpIds, tmpVec]) { try { fs.unlinkSync(p); } catch {} }
    return { ok: false, reason: `写目标组失败：${e.message}` };
  }

  const totalInSources = new Set();
  for (const s of srcs) for (const [id, row] of s.map) if (row < s.usable) totalInSources.add(id);
  return {
    ok: true,
    kept,
    fromSource,
    droppedByWhitelist: Math.max(0, totalInSources.size - kept),
    droppedNotInKeep: 0
  };
}

/**
 * 只读：算「如果现在派生，目标组能盖住多少、还差多少必须联网」。
 * 不改任何文件，给 --stats 报缺口、给 --derive 动手之前先看清账。
 */
export function planUnion({ sources, keepIds, dim }) {
  if (!Number.isFinite(dim) || dim <= 0) return { ok: false, reason: `维度非法：${dim}` };
  if (!(keepIds instanceof Set)) return { ok: false, reason: 'keepIds 必须是 Set' };
  const srcs = openSources(sources, dim);

  const covered = new Set();
  const perSource = new Array(srcs.length).fill(0);
  for (let si = 0; si < srcs.length; si++) {
    const s = srcs[si];
    for (const [id, row] of s.map) {
      if (row >= s.usable) continue;
      if (!keepIds.has(id)) continue;
      if (covered.has(id)) continue;
      covered.add(id);
      perSource[si]++;
    }
  }
  const needOnline = [];
  for (const id of keepIds) if (!covered.has(id)) needOnline.push(id);
  return {
    ok: true,
    keepTotal: keepIds.size,
    coverable: covered.size,
    perSource,
    needOnline: needOnline.length,
    needOnlineIds: needOnline
  };
}
