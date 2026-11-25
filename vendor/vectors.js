// 向量索引：把原文层的每条记录嵌成向量，落盘复用。
//
// 为什么单独一个文件：
//   search.js 是纯同步的 bigram 倒排（毫秒级、离线可用）。向量通道要走网络，
//   天生是异步的，硬塞进同一个函数只会让所有调用点变成 async。
//   所以这里做成「同步通道 + 可选异步通道」，由 selectFused 融合。
//
// 落盘格式（照 embed-bench 的实测结论）：
//   Float32Array 二进制，不存 JSON。747 条实测 2.9 MB vs 15.5 MB，差 5 倍。
//   文件：<dir>/vectors/<模型名>.<可见范围>.ids.jsonl / .f32
//   可见范围进文件名是故意的：工作侧的向量文件里不该有生活侧的向量，
//   否则单向门在「向量」这一层就被绕过了。

import fs from 'node:fs';
import path from 'node:path';
import { frozenNow } from './freeze-guard.mjs';
import { embedAll, dimOf, DEFAULT_EMBED_MODEL, cosine } from './embed.js';

const SAFE = (s) => String(s).replace(/[^A-Za-z0-9_.-]+/g, '_');

export function vectorsDir(storeDir) {
  return path.join(storeDir, 'vectors');
}

const LOCK_STALE_MS = 5 * 60 * 1000;   // 向量锁陈旧阈值：一次全量嵌入可能 30s，别让它被误判成死锁
const LOCK_TIMEOUT_MS = 5 * 60 * 1000;

/** 向量专用的异步目录锁（mkdir 原子，拿不到就等）。
 *  不复用 shared.js 的 withLock：那是同步的，等不了 async 的 embedAll。
 *
 *  2026-11-05 加 signal：等锁必须能被中断。
 *  事故：开场跑 cm-boot 时上一个进程被 kill 掉留下了 .lock，这里会一直等到
 *  LOCK_TIMEOUT_MS（5 分钟）。表现是「记忆库开场卡死」，而 cm-boot 外面那个
 *  8 秒预算根本管不到这里——它等的不是网络，是锁。
 *  传了 signal 就每轮检查一次，aborted 立刻放弃等锁。 */
function acquireDirLock(lockPath, signal) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const release = () => { try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch {} };
    const attempt = () => {
      if (signal?.aborted) return reject(new Error('等向量锁时被取消'));
      fs.mkdir(lockPath, { recursive: false }, (err) => {
        if (!err) return resolve(release);
        if (err.code !== 'EEXIST') return reject(err);
        fs.stat(lockPath, (e2, st) => {
          if (signal?.aborted) return reject(new Error('等向量锁时被取消'));
          if (!e2 && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
            fs.rm(lockPath, { recursive: true, force: true }, () => attempt());
          } else if (Date.now() - start > LOCK_TIMEOUT_MS) {
            reject(new Error(`拿不到向量写锁（${lockPath}），等了 ${LOCK_TIMEOUT_MS}ms`));
          } else {
            setTimeout(attempt, 20 + Math.floor(Math.random() * 40));
          }
        });
      });
    };
    attempt();
  });
}

/** embedFn 默认真联网；测试可注入假实现，避免用例把网络拖进来。
 *  只在这里留一个注入点，别让它渗到检索路径以外。 */
export function createVectorStore({ storeDir, model = DEFAULT_EMBED_MODEL, scopeKey = 'shared,work', key, enabled = true, embedFn = embedAll } = {}) {
  const dir = vectorsDir(storeDir);
  const tag = `${SAFE(model)}.${SAFE(scopeKey)}`;
  const idsPath = path.join(dir, `${tag}.ids.jsonl`);
  const vecPath = path.join(dir, `${tag}.f32`);
  const lockPath = path.join(dir, '.lock');
  const dim = dimOf(model);

  /** id → 行号。 */
  let rows = null;   // Map<string, number>
  let flat = null;   // Float32Array, n*dim

  function loadFromDisk() {
    if (rows) return;
    rows = new Map();
    flat = new Float32Array(0);
    try {
      const ids = fs.readFileSync(idsPath, 'utf8').split('\n').filter(Boolean);
      const buf = fs.readFileSync(vecPath);
      const n = Math.floor(buf.byteLength / (dim * 4));
      const use = Math.min(n, ids.length);
      flat = new Float32Array(use * dim);
      // Float32Array 不能直接拷自 Buffer 切片，得按字节偏移建视图。
      for (let i = 0; i < use; i++) {
        const slice = buf.subarray(i * dim * 4, (i + 1) * dim * 4);
        flat.set(new Float32Array(slice.buffer.slice(slice.byteOffset, slice.byteOffset + dim * 4)), i * dim);
      }
      for (let i = 0; i < use; i++) rows.set(ids[i], i);
      // 文件自愈：ids 和向量条数对不上时，以少的为准，下次写会重建尾部。
      if (n !== ids.length) {
        fs.writeFileSync(idsPath, ids.slice(0, use).map((s) => s + '\n').join(''), 'utf8');
      }
    } catch {}
  }

  function size() {
    loadFromDisk();
    return rows.size;
  }

  /** ids 文件里有没有重复 id。
   *
   *  2026-11-15 订正（文案与判断都在这一条里）：
   *   老版注释与提示语写的是「有就必须 --rebuild」，**这是错的，会教人犯罪**。
   *   实测：真库两组 ids 任何时候去查都没有重复，f32 与 ids 也一直对齐；
   *   这个函数在「拿到锁后当场重读磁盘」的瞬间命中，命中的是**另一个进程正在
   *   写到一半**的中间态——ids 写了一部分、还没写完而已，下一次 tick 自己就好。
   *
   *   而 `--rebuild` 是「丢掉旧文件全部重烧」：真库里那是两万条网络嵌入。
   *   为了一次几十毫秒的中间态去重烧两万条，代价完全不成比例。
   *
   *   所以这里的行为是「本轮跳过、下一轮自动重试」，绝不会让调用方去重建。
   *   唯一真正需要重建的场景是**持久**重复（连查几次都在），那种情况由人判断，
   *   不由这个函数喊。 */
  function idsDirty() {
    try {
      const ids = fs.readFileSync(idsPath, 'utf8').split('\n').filter(Boolean);
      return new Set(ids).size !== ids.length;
    } catch { return false; }
  }

  function appendToDisk(ids, vecs) {
    fs.mkdirSync(dir, { recursive: true });
    const buf = Buffer.alloc(ids.length * dim * 4);
    for (let i = 0; i < vecs.length; i++) {
      Buffer.from(vecs[i].buffer, vecs[i].byteOffset, dim * 4).copy(buf, i * dim * 4);
    }
    fs.appendFileSync(vecPath, buf);
    fs.appendFileSync(idsPath, ids.map((s) => s + '\n').join(''), 'utf8');
    // 内存里也追加
    const merged = new Float32Array(flat.length + vecs.length * dim);
    merged.set(flat, 0);
    for (let i = 0; i < vecs.length; i++) merged.set(vecs[i], flat.length + i * dim);
    flat = merged;
    const base = rows.size;
    ids.forEach((id, i) => rows.set(id, base + i));
  }

  /**
   * 从「同一模型的其它分组」里借现成向量。
   *
   * 为什么需要（2026-11-15，真事故）：
   *   文件名里带可见范围，所以 work 角色写 *.shared_work.*、灌库进程（scopeKey 全量）
   *   写 *.shared_work_life.*。而 cm-watch 全程以灌库身份跑，**只有全量那组在长**；
   *   工作侧那组从 2026-11-11 就停在自己 9798 条，到 11-15 时工作侧近一半检索
   *   只走词面，而唯一的外显只是一句「向量索引有重复 id」的误报。
   *   根因不是「谁忘了跑命令」，是**同一个 id 的向量被按角色重复计算**：
   *   一条记录在 work 组和全量组里是同一个模型、同一个 dim、同一个 embedding，
   *   完全没必要联网再烧一遍。
   *
   * 安全性（单向门）：只有 `docs`（= 当前角色 allDocs() 出来的可见集合）里的 id 会被
   * 借，所以借来的向量不可能把看不见的东西带进来。分组名只用来找**源**，不用来放行。
   *
   * 失败一律降级：读不到邻居、维度不符、行号越界，就返回空表，让上层照常联网嵌。
   */
  function borrowFromSiblings(needIds) {
    const out = new Map();  // id -> Float32Array
    if (!needIds.length) return out;
    const want = new Set(needIds);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return out; }
    const selfTag = `${SAFE(model)}.${SAFE(scopeKey)}`;
    for (const name of names) {
      if (!name.endsWith('.ids.jsonl')) continue;
      const tag = name.slice(0, -'.ids.jsonl'.length);
      if (tag === selfTag) continue;
      // 只借同一模型的（同 tag 前缀），否则维度/语义都不对。
      if (!tag.startsWith(`${SAFE(model)}.`)) continue;
      const otherIdsPath = path.join(dir, name);
      const otherVecPath = path.join(dir, `${tag}.f32`);
      let otherIds = [];
      let otherBuf;
      try {
        otherIds = fs.readFileSync(otherIdsPath, 'utf8').split('\n').filter(Boolean);
        otherBuf = fs.readFileSync(otherVecPath);
      } catch { continue; }
      const otherRows = Math.floor(otherBuf.byteLength / (dim * 4));
      const usable = Math.min(otherRows, otherIds.length);
      if (!usable) continue;
      // 与 loadFromDisk 同义：重复 id 认最后一行。
      const pos = new Map();
      for (let i = 0; i < usable; i++) pos.set(otherIds[i], i);
      for (const id of want) {
        if (out.has(id)) continue;
        const row = pos.get(id);
        if (row === undefined) continue;
        const off = row * dim * 4;
        const v = new Float32Array(dim);
        const slice = otherBuf.subarray(off, off + dim * 4);
        v.set(new Float32Array(slice.buffer.slice(slice.byteOffset, slice.byteOffset + dim * 4)));
        out.set(id, v);
      }
      // 全借到了就不用再翻别的分组。
      if (out.size === want.size) break;
    }
    return out;
  }

  /**
   * 确保这些 docs 都有向量。只嵌还没嵌过的，所以日常追加是增量、几乎零成本。
   * 失败不抛：向量通道是增强项，挂了就该退回词面检索，而不是让整个记忆库不可用。
   *
   * 并发安全：embedAll 要 30s，这段时间别的进程（cm-watch / cm-web / 命令行）可能也
   * 在补向量。旧实现先算 need 再异步嵌入、最后 appendToDisk，两个进程会各自算出
   * 同一批 need、各自 append，导致 ids 文件里同一个 id 出现两次 → 后续追加按
   * rows.size 定位会整体错位。所以这里改两件事：
   *   1. 拿一把异步目录锁，整段「读盘 → 算 need → 嵌入 → 写盘」互斥；
   *   2. 锁内重新从磁盘读 rows（不是用可能过期的内存 rows）再算 need。
   *
   * 2026-11-15 加：算完 need 之后先向同模型的其它分组借现成向量（borrowFromSiblings），
   * 借到的不联网。这一步让「工作侧那组永远落后」这件事自己长好，不依赖谁记得跑命令。
   */
  async function ensure(docs, { onProgress, signal } = {}) {
    if (!enabled) return { ok: false, reason: '向量通道未启用' };
    // 冻结闸（N-01 接线）：向量文件是本地专属、不进 git，但它仍是往库里写字节。
    // 契约「失败不抛」照旧 —— 返回 ok:false，检索退回词面通道，不拦任何主流程。
    if (frozenNow(storeDir, '补向量索引')) {
      return { ok: false, reason: '已冻结，本轮不补向量（检索退回词面）', added: 0, total: 0 };
    }
    fs.mkdirSync(dir, { recursive: true });
    // 等锁失败（被取消 / 等超时）也要按「增强项失败」处理：返回 ok:false 让调用方
    // 退回词面通道，而不是把异常抛到开场流程里去。契约见文件头：失败不抛。
    let release;
    try {
      release = await acquireDirLock(lockPath, signal);
    } catch (e) {
      return { ok: false, reason: e.message, added: 0, total: 0 };
    }
    try {
      // 锁内重读磁盘，别用外层可能过期的 rows 缓存。
      rows = null;
      flat = null;
      loadFromDisk();
      if (idsDirty()) return { ok: false, reason: '向量索引读到并发写入中间态，本轮跳过、下一轮自动重试（切勿 --rebuild）', added: 0, total: rows.size };
      const need = [];
      for (const d of docs) {
        const id = d.id;
        if (!id) continue;
        if (!rows.has(id)) need.push(d);
      }
      if (!need.length) return { ok: true, added: 0, total: rows.size };

      // 先试着借。借到多少就少烧多少次网络嵌入。
      const borrowed = borrowFromSiblings(need.map((d) => d.id));
      let borrowedCount = 0;
      if (borrowed.size) {
        const bIds = [...borrowed.keys()];
        const bVecs = bIds.map((id) => borrowed.get(id));
        appendToDisk(bIds, bVecs);
        borrowedCount = bIds.length;
      }
      const rest = need.filter((d) => !borrowed.has(d.id));
      if (!rest.length) return { ok: true, added: borrowedCount, borrowed: borrowedCount, total: rows.size };

      const vecs = await embedFn(rest.map((d) => String(d.text).slice(0, 2000)), { model, key, onProgress, signal });
      appendToDisk(rest.map((d) => d.id), vecs);
      return { ok: true, added: borrowedCount + rest.length, borrowed: borrowedCount, embedded: rest.length, total: rows.size };
    } catch (e) {
      return { ok: false, reason: e.message, added: 0, total: rows.size };
    } finally {
      release();
    }
  }

  /** 查询文本的向量 → 与之最像的 doc id 与余弦。 */
  async function querySim(text, { key: k2 } = {}) {
    if (!enabled) return new Map();
    loadFromDisk();
    if (!rows.size) return new Map();
    let qv;
    try {
      const v = await embedFn([String(text).slice(0, 2000)], { model, key: k2 ?? key });
      qv = v[0];
    } catch {
      return new Map();
    }
    const out = new Map();
    for (const [id, r] of rows) {
      const off = r * dim;
      let dot = 0;
      let na = 0;
      let nb = 0;
      for (let i = 0; i < dim; i++) {
        const a = qv[i];
        const b = flat[off + i];
        dot += a * b;
        na += a * a;
        nb += b * b;
      }
      const sim = na && nb ? dot / Math.sqrt(na * nb) : 0;
      out.set(id, sim);
    }
    return out;
  }

  function stats() {
    loadFromDisk();
    return { model, dim, scopeKey, count: rows.size, enabled };
  }

  return { ensure, querySim, size, stats, paths: { idsPath, vecPath }, model, dim, scopeKey };
}

export { cosine };
