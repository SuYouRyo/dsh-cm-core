// 原文层（L0）：只追加，永不修改，永不删除。
//
// 改自 qq-dsh-bridge 的 src/memory-store.js（MIT，© 2026 Derpyu520 及贡献者）。
// 保留的原设计（这几条是踩过坑的，别改）：
//   1. 只追加：任何记录一旦写入就不再改、不再删。纠错靠追加新记录。
//   2. 索引是派生物：events/*.jsonl 是资产，index/ids.txt 删了能 rebuildIndex 重建。
//   3. 单进程写入。
//   4. 单条正文有上限，超出截断并打标记。
//
// 本项目的改动：
//   · **单例**：去掉按会话分区（原来 key = group:xxx / private:xxx）。
//     陪伴只有一个上下文，所以只有一个时间线。
//   · 来源从 src('qq'|'dsh') 改为 src('chat'|'work'|'manual'|'import')，
//     支持「工作痕迹摄入」而这个痕迹只能进 inferred 印象层，不进原文层以外的判断。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { withLock, fileStamp, resolveOwner, LOCK_DIRNAME, assertWritable, scopeFor, visibleScopes, writableScopes, resolveRole, SCOPE_SHARED, SCOPE_LIFE } from './shared.js';
import { createArchiveWatcher } from './recall-archive.js';
import { createDedupeIndex, dedupeConfigFromEnv, fingerprintOf, isExempt } from './dedupe.js';
import { fmtMonth } from './localtime.js';
import { LIFE_EVENTS_DIRNAME, LIFE_SESSION_SCOPE_NAME } from './paths.js';
import { coldShardMonths, coldRecordsOfShard, coldRecordOf, coldSummary, shardOverlaps, coldStamp, coldPaths } from './cold-archive.js';

export const STORE_VERSION = 1;
const DEFAULT_MAX_TEXT = 4000;
const SOURCES = new Set(['chat', 'work', 'manual', 'import']);

/** 去重键。单例时间线下不再需要 key，只用 src + seq。 */
export function makeId({ src, seq }) {
  return `${src || 'chat'}:${seq ?? ''}`;
}

/** 按月分片：一天几百条，一月一万条上下，单文件几 MB，便于追加与备份。 */
function shardOf(ms) {
  return fmtMonth(Number.isFinite(ms) ? ms : Date.now());
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function createStore({ dir, maxTextChars = DEFAULT_MAX_TEXT, dedupe } = {}) {
  if (!dir) throw new Error('createStore: 缺少 dir');
  const root = path.join(dir, 'raw');
  const eventsDir = path.join(root, 'events');
  // life 那一层单独一个目录（丙方案，2026-11-21）：远端 pre-receive 拒绝任何被追踪
  // 文件里出现 "scope":"life"，而生活侧会话一直在实时灌库 —— 只要它还写进
  // raw/events/*.jsonl，push 就永远追不上。分流见 src/paths.js 的头注。
  // 这个目录**不在这里预建**：没有生活侧写入的机器上不该凭空多一个空目录。
  const lifeEventsDir = path.join(root, LIFE_EVENTS_DIRNAME);
  const indexDir = path.join(root, 'index');
  ensureDir(eventsDir);
  ensureDir(indexDir);

  const idsPath = path.join(indexDir, 'ids.txt');
  const manifestPath = path.join(root, 'manifest.json');
  // 会话 → 已落定的 scope（append-only，先写先得）。见 append() 里的长注释。
  // 参数是 raw/ 目录，因为落定表和 events/ 同放在 raw/ 下。
  //
  // ⚠️ catch 里只该吞「文件不存在」。第一版写成 `catch { return out; }`
  // 兜住了一切，结果函数体里参数名写错（dirOfRaw vs rawDir）也被一起吞掉，
  // 落定表永远读到空、守卫永远不生效，而测试只报「还是写进了 shared」——
  // 排查半小时。以后这类「读不到就当空」的地方，一律只在 ENOENT 上放行。
  function readSettledScopes(rawDir) {
    const out = new Map();
    let raw = '';
    // 丙方案（2026-11-21）：落定表分两份 —— 被追踪的 session-scope.jsonl（shared/work）
    // 与本机专属的 session-scope-life.jsonl（life）。两份都得读：只读前者的话，
    // 一个已落定为 life 的会话在本机重新灌库时就查不到结论，会被重新判层、劈成两半。
    // 文件名与 src/paths.js 同源（那边是唯一路径真源）。
    let seenAny = false;
    for (const name of ['session-scope.jsonl', LIFE_SESSION_SCOPE_NAME]) {
      try {
        raw += fs.readFileSync(path.join(rawDir, name), 'utf8');
        raw += '\n';
        seenAny = true;
      } catch (e) {
        if (e && e.code !== 'ENOENT') throw e;
      }
    }
    if (!seenAny) return out;
    // 与 src/ingest.js 的 readSessionScopes() 同一套判定：按 `t` 最小者胜。
    // 为什么不能「先写先得」：这份文件跟着 git 同步，`*.jsonl merge=union`
    // 会把两端行拼起来，行序由 merge 方向决定 —— 两端读出的结论就可能不一致，
    // 而落定表存在的全部意义就是「两端对同一会话给出同一个答案」。
    //
    // 另外留一个纠正通道（2026-11-06 加）：`correct: true` 的行表示「这是对
    // 先前判定的纠正」，按最晚者胜。没有它的话，一旦某个会话被判错就永远改不回来
    // —— 普通追加行的 t 更大，在「最早者胜」下不生效。两处必须严格一致，
    // 否则灌库层和检索层会给出两套答案。
    const rank = { life: 0, work: 1, shared: 2 };
    const base = new Map();
    const fix = new Map();
    const put = (m, s, sc, t, preferLater) => {
      const prev = m.get(s);
      if (!prev) { m.set(s, { scope: sc, t }); return; }
      if (preferLater ? t > prev.t : t < prev.t) { m.set(s, { scope: sc, t }); return; }
      if (t === prev.t && rank[sc] < rank[prev.scope]) m.set(s, { scope: sc, t });
    };
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      const s = String(rec?.s || '');
      const sc = String(rec?.scope || '');
      if (!s || !['life', 'work', 'shared'].includes(sc)) continue;
      const t = Number(rec?.t) || 0;
      if (rec?.correct === true) put(fix, s, sc, t, true);
      else put(base, s, sc, t, false);
    }
    for (const [s, v] of base) out.set(s, v.scope);
    for (const [s, v] of fix) out.set(s, v.scope);
    return out;
  }
  // 24h 近似去重（项目单 5b）。指纹索引是**派生物**：真身是 events，
  // 删了 fingerprints.jsonl 会从 events 回填重建（见 ensureDedupeIndex）。
  const dedupePath = path.join(indexDir, 'fingerprints.jsonl');
  const dedupeCfg = dedupe === false ? { enabled: false } : { ...dedupeConfigFromEnv(), ...(dedupe && typeof dedupe === 'object' ? dedupe : {}) };
  let dindex = dedupeCfg.enabled ? createDedupeIndex({ windowMs: dedupeCfg.windowMs, driftMs: dedupeCfg.driftMs }) : null;
  let dedupeLoaded = false;
  let dedupeWriteFailed = false;

  // 墓碑：被**主动清理**（cm-decontaminate / cm-gc）删掉的记录 id。
  // 为什么必须是独立文件而不是靠 ids.txt：ids.txt 是**派生物**，
  // rebuildIndex() 会按 events 重建 —— 一重建墓碑就没了，而 DSH 的会话源文件
  // 还在，cm-watch 下一轮扫描就把同一条重新灌回来（实测：清掉
  // chat:489dd7ad:213，重启 watcher 后 60 秒内复活）。
  // 所以墓碑是**资产**，放 raw/tombstones.txt，跟 raw/events 一起同步。
  const tombPath = path.join(root, 'tombstones.txt');
  const tomb = new Set();
  let tombStamp = null;
  const loadTombstones = () => {
    tombStamp = fileStamp(tombPath);
    tomb.clear();
    try {
      for (const line of fs.readFileSync(tombPath, 'utf8').split('\n')) {
        const s = line.trim();
        if (s && !s.startsWith('#')) tomb.add(s);
      }
    } catch { /* 没有墓碑文件 = 这个库还没主动清理过东西 */ }
  };
  loadTombstones();

  // 归档表（2026-11-09）：被归档的原文不再被遍历/注入捞出来，但原文仍在、
  // cm read <id> 仍可点名读到。与墓碑是两件事，别合并。
  const archiveWatcher = createArchiveWatcher(dir);

  const seen = new Set();
  if (fs.existsSync(idsPath)) {
    for (const line of fs.readFileSync(idsPath, 'utf8').split('\n')) {
      const s = line.trim();
      if (s) seen.add(s);
    }
  }

  let manifest = { version: STORE_VERSION, createdAt: Date.now(), updatedAt: Date.now(), counts: {}, shards: {} };
  const loadManifest = () => {
    if (!fs.existsSync(manifestPath)) return manifest;
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (parsed && parsed.version === STORE_VERSION) manifest = parsed;
    } catch {
      // manifest 坏了不影响数据：events 才是真相。
    }
    return manifest;
  };
  loadManifest();

  let appendHandle = null;
  const openAppend = () => {
    if (!appendHandle) appendHandle = fs.openSync(idsPath, 'a');
    return appendHandle;
  };

  // 一条记录该落到哪个原文层目录：life 走 lifeEventsDir，其余走被 git 追踪的 eventsDir。
  const dirOfScope = (sc) => ((sc || SCOPE_SHARED) === SCOPE_LIFE ? lifeEventsDir : eventsDir);
  // 某个月份在两条流里各占多少字节。manifest 只记一份账，所以两个目录加起来算。
  const bytesOfShard = (shard) => {
    let n = 0;
    for (const d of [eventsDir, lifeEventsDir]) {
      try { n += fs.statSync(path.join(d, `${shard}.jsonl`)).size; } catch {}
    }
    return n;
  };

  const owner = resolveOwner();
  const myScopes = writableScopes(resolveRole());
  const canWriteScope = (sc) => myScopes.includes(sc || SCOPE_SHARED);

  // 多会话共享同一个库：别的进程可能在我们启动之后又追加了 id。
  // 每次写之前比一下 ids.txt 的指纹，变了就重新加载，否则会重复写入。
  let seenStamp = fileStamp(idsPath);
  function refreshSeen() {
    const stamp = fileStamp(idsPath);
    // 墓碑在别的进程（清理脚本、另一台设备同步过来）改了也要立刻看见，
    // 否则这一轮 append 还会把刚宣布死亡的那条写回去。
    if (fileStamp(tombPath) !== tombStamp) loadTombstones();
    if (stamp === seenStamp) return;
    seen.clear();
    try {
      for (const line of fs.readFileSync(idsPath, 'utf8').split('\n')) {
        const s = line.trim();
        if (s) seen.add(s);
      }
    } catch { /* 文件刚被重建，下一轮再看 */ }
    seenStamp = stamp;
  }

  const normalize = (rec) => {
    const t = Number(rec.t) || Date.now();
    let text = rec.text == null ? '' : String(rec.text);
    let trunc = false;
    if (text.length > maxTextChars) {
      text = text.slice(0, maxTextChars);
      trunc = true;
    }
    const src = SOURCES.has(rec.src) ? rec.src : 'chat';
    const id = rec.id || makeId({ src, seq: rec.seq });
    return {
      id,
      v: STORE_VERSION,
      src,
      seq: rec.seq ?? null,
      t,
      kind: rec.kind || 'msg',
      role: rec.role ?? null,
      text,
      // scope 决定谁能看见这一条：shared（大家）/ work（工作痕迹，生活侧也能看）/ life（生活侧私有，工作侧看不见）
      scope: rec.scope && ['shared', 'work', 'life'].includes(rec.scope) ? rec.scope : scopeFor(),
      // owner 一定要留痕：多 AI 共用一个库时，得能分辨这句话是谁记下的。
      meta: { ...(rec.meta && typeof rec.meta === 'object' ? rec.meta : {}), owner: rec.meta?.owner || owner },
      trunc: trunc || undefined
    };
  };

  /**
   * 指纹索引是派生物，但**不能只靠内存**：多会话共享一个库时，
   * A 会话写的指纹 B 会话的内存索引里没有，B 就会把 A 刚写过的同一句话再灌一条。
   * 所以落一份 index/fingerprints.jsonl（append-only，一行一条），
   * 并在加载时把 24h 窗口外的行过滤掉（窗口外本来就不判重）。
   * 文件被删/坏了 → 从 events 回填重建，保证「删了索引不会变成不去重」。
   */
  function loadDedupeIndex() {
    if (dedupeLoaded || !dindex) { dedupeLoaded = true; return; }
    dedupeLoaded = true;
    const span = dindex.span;
    const now = Date.now();
    let lines = null;
    try { lines = fs.readFileSync(dedupePath, 'utf8').split('\n'); } catch { lines = null; }
    if (lines) {
      const kept = [];
      let total = 0;
      for (const line of lines) {
        if (!line.trim()) continue;
        total++;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        if (!e || !e.f || !e.t) continue;
        // 窗口外（按现在这个时刻算）不用进内存；漂移余量已经在 span 里。
        if (Math.abs(now - Number(e.t)) > span) continue;
        dindex.add(e.s ?? 'chat', e.f, Number(e.t));
        kept.push(e);
      }
      // 文件只追加会越长越大，而窗口外的行永远用不上。攒够量就顺手压实一次
      // （此刻在锁里，别的进程不会同时写）。阈值取 5000 行：一天几百条量级，
      // 压实后基本只剩不到一天的数据，几 KB。
      if (total > 5000 && kept.length * 2 < total) {
        try {
          fs.writeFileSync(dedupePath, kept.length ? kept.map((e) => JSON.stringify(e)).join('\n') + '\n' : '', 'utf8');
        } catch {
          dedupeWriteFailed = true;
        }
      }
      return;
    }
    // 文件不存在：第一次启用去重，从 events 回填窗口内的记录。
    // 冷分片也算：窗口一般只有 24h，月份边界先判一下就不会白解压历史月份；
    // 但万一有人把窗口配得很大，回填也不能漏掉已归档的月份。
    const backfilled = [];
    for (const shard of listAllShards()) {
      if (!shardOverlaps(shard, now - span, now + span)) continue;
      for (const rec of readShardRecords(shard)) {
        if (!rec || !rec.text || !Number.isFinite(rec.t)) continue;
        if (Math.abs(now - rec.t) > span) continue;
        const fp = fingerprintOf(rec);
        if (!fp) continue;
        dindex.add(rec.src || 'chat', fp, rec.t);
        backfilled.push({ s: rec.src || 'chat', f: fp, t: rec.t, id: rec.id });
      }
    }
    if (backfilled.length) {
      try {
        fs.writeFileSync(dedupePath, backfilled.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
      } catch {
        // 落盘失败不影响本次判重（内存索引是对的），下次还会重建。不静默：stats 里能看到。
        dedupeWriteFailed = true;
      }
    }
  }

  /** 把新写入的指纹追加到指纹文件（在锁内调用）。 */
  function persistFingerprints(entries) {
    if (!entries.length) return;
    try {
      fs.appendFileSync(dedupePath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    } catch {
      dedupeWriteFailed = true;
    }
  }

  /** 批量追加。已存在的 id 静默跳过（跨源去重）。 */
  function append(records) {
    assertWritable('写入原文层', undefined, dir);
    // 整个「去重 → 追加 → 更新 manifest」必须原子：否则两个会话同时写会丢记录。
    return withLock(dir, () => {
      refreshSeen();
      loadManifest(); // 别的会话可能刚改过 manifest，拿锁后重读，别把它们的计数覆盖掉
      loadDedupeIndex();
      const fresh = [];
      const pendingFps = [];
      let skipped = 0;
      let deduped = 0;
      // 会话的 scope 是**一次定终身**的（2026-11-06 修单向门泄漏）。
      //
      // 事故形态：手机上多个 cm-watch 并存，只有 cm-watch-guard.sh 带的那个
      // 有 CM_LIFE_WORKSPACES，其余没带。各进程按自己的环境变量算 scope，
      // 这里又按 id 先到先写，于是同一个陪伴会话被劈进两个层——实测 16 个
      // 会话、293 条私密记录进 shared，其中 41 条是他本人说的话，工作侧
      // cm recall 能直接搜出来。
      //
      // ingest 侧已经在灌库前就查落定记录（rememberSessionScope），但那只管
      // 走 syncSessions 的路径。这里是**最后一道闸**：不管记录从哪来（换启动器、
      // 手跑、别的脚本直接调 store.append），只要这个会话以前落过某层，就按
      // 那一层写。落定表在 raw/session-scope.jsonl，追加式、先写先得。
      const settled = readSettledScopes(root);
      const settledFor = (rec) => {
        const s = rec?.meta?.session;
        if (!s) return null;
        return settled.get(String(s)) || null;
      };
      for (const rec of records || []) {
        if (!rec) continue;
        const norm = normalize(rec);
        if (norm.seq == null || norm.seq === '') { skipped++; continue; }
        if (!norm.text) { skipped++; continue; }
        const want = settledFor(rec);
        if (want && want !== (norm.scope || SCOPE_SHARED)) {
          // 按落定值走。若本进程没权限写那一层（例如 work 角色碰上 life 会话），
          // canWriteScope 会把它挡掉——宁可这条暂时没灌进来，也不能漏进共享层；
          // guard 拉起的 sync 进程下一轮会把它补上。
          norm.scope = want;
        }
        // 角色只能写自己那几层 scope：生活侧往里灌工作痕迹会被挡在门外。
        if (!canWriteScope(norm.scope)) { skipped++; continue; }
        if (seen.has(norm.id)) { skipped++; continue; }
        // 墓碑命中：这条是被主动清理掉的污染副本，会话源文件还在，
        // 不挡的话下一轮扫描就把它原样灌回来（= 清理等于没做）。
        if (tomb.has(norm.id)) { skipped++; continue; }
        // 24h 近似去重（项目单 5b）：同 src + 同内容指纹 + 24h 内 → 判重。
        // 删除后重发靠豁免（rec.dedupeExempt / meta.redo / CM_DEDUPE_EXEMPT）放行。
        if (dindex) {
          const fp = fingerprintOf(norm);
          if (!isExempt(rec, dedupeCfg.exempt) && dindex.has(norm.src, fp, norm.t)) {
            deduped++;
            continue;
          }
          if (fp) {
            dindex.add(norm.src, fp, norm.t);
            pendingFps.push({ s: norm.src, f: fp, t: norm.t, id: norm.id });
          }
        }
        seen.add(norm.id);
        fresh.push(norm);
      }
      if (!fresh.length) return { added: 0, skipped, deduped, byShard: {} };

      // 落盘前按 **scope 目标目录 × 月份** 分组（丙方案，2026-11-21）：
      // life 记录写 raw/events-life/，shared/work 写 raw/events/。
      // 这不是"另一个索引"，是同一份数据的两个存放位置 —— 读侧 listAllShards()
      // / readShardRecords() 两处都读，调用方感觉不到差别。
      const byTarget = new Map();
      for (const rec of fresh) {
        const d = dirOfScope(rec.scope);
        const s = shardOf(rec.t);
        const k = `${d}\u0000${s}`;
        if (!byTarget.has(k)) byTarget.set(k, { d, s, recs: [] });
        byTarget.get(k).recs.push(rec);
      }

      const counts = {};
      for (const { d, s, recs } of byTarget.values()) {
        ensureDir(d);
        const file = path.join(d, `${s}.jsonl`);
        fs.appendFileSync(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
        counts[s] = (counts[s] || 0) + recs.length;
        const stat = manifest.shards[s] || { count: 0, bytes: 0 };
        stat.count += recs.length;
        stat.bytes = bytesOfShard(s);
        manifest.shards[s] = stat;
      }

      const h = openAppend();
      fs.writeSync(h, fresh.map((r) => r.id).join('\n') + '\n');
      seenStamp = fileStamp(idsPath);

      for (const r of fresh) manifest.counts[r.src] = (manifest.counts[r.src] || 0) + 1;
      manifest.updatedAt = Date.now();
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
      // 指纹在数据落盘之后才记：写到一半失败不会留下"记得写过了"的假指纹。
      persistFingerprints(pendingFps);

      return { added: fresh.length, skipped, deduped, byShard: counts };
    });
  }

  /**
   * 改一条记录的 scope（不删原文）。
   *
   * 为什么需要它：append 按 id 去重，同一个 id 想改 scope 会被 seen.has() 直接跳过，
   * 所以「漏进 shared 的私密话想收回 life 层」这件事，光靠 append 做不到。
   * 做法是**追加一条同 id 的修订行**，读取时后出现的覆盖前面的（原行永远留在文件里）。
   * 这跟印象层的 append-only 修订是同一套语义，不破坏「不物理删除」这条底线。
   *
   * @param {Array<{id:string, scope:string}>} changes
   * @returns {{changed:number, missing:string[]}}
   */
  function rescope(changes) {
    assertWritable('调整记录的可见范围', undefined, dir);
    return withLock(dir, () => {
      refreshSeen();
      loadManifest();
      const want = new Map();
      for (const c of changes || []) {
        if (!c || !c.id) continue;
        if (!['shared', 'work', 'life'].includes(c.scope)) continue;
        want.set(String(c.id), c.scope);
      }
      if (!want.size) return { changed: 0, missing: [] };

      // 先按现有内容找到原行，整条复制再改 scope —— 修订行必须自带正文，
      // 否则读取方拿到的是一条没有 text 的孤行。
      // 冷分片也要读：改了 scope 的可能是半年前那条老话，只读热分片会报 missing。
      const latest = new Map();
      for (const shard of listAllShards()) {
        for (const r of readShardRecords(shard)) {
          if (r && r.id) latest.set(r.id, r);
        }
      }

      // 修订行写到**目标 scope 对应的目录**（丙方案，2026-11-21）：
      // life → work 的记录必须落到被追踪的 raw/events/，否则工作侧永远读不到它
      // （它原来躺在 events-life/ 里）；work → life 的则必须离开被追踪目录，
      // 否则 "scope":"life" 字面量还留在同步仓里，push 就会被远端门禁拒。
      const byTarget = new Map();
      const missing = [];
      let changed = 0;
      for (const [id, scope] of want) {
        const base = latest.get(id);
        if (!base) { missing.push(id); continue; }
        if ((base.scope || SCOPE_SHARED) === scope) continue; // 已经是这个 scope，不必再写
        const rev = { ...base, scope, rescopedAt: Date.now(), rescopeFrom: base.scope || SCOPE_SHARED };
        const d = dirOfScope(scope);
        const s = shardOf(base.t);
        const k = `${d}\u0000${s}`;
        if (!byTarget.has(k)) byTarget.set(k, { d, s, recs: [] });
        byTarget.get(k).recs.push(rev);
        changed++;
      }
      if (!changed) return { changed: 0, missing };

      for (const { d, s, recs } of byTarget.values()) {
        ensureDir(d);
        const file = path.join(d, `${s}.jsonl`);
        fs.appendFileSync(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
        const stat = manifest.shards[s] || { count: 0, bytes: 0 };
        stat.bytes = bytesOfShard(s);
        manifest.shards[s] = stat;
      }
      manifest.updatedAt = Date.now();
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
      return { changed, missing };
    });
  }

  function shardsIn(d) {
    try {
      return fs.readdirSync(d).filter((f) => f.endsWith('.jsonl')).map((f) => f.replace(/\.jsonl$/, '')).sort();
    } catch { return []; }
  }

  function listShards() {
    return shardsIn(eventsDir);
  }

  /**
   * life 那一层的月分片（丙方案，2026-11-21）。
   *
   * 为什么与 listShards() 分开报：那个函数的语义是「events/ 目录里现存的月分片」，
   * bin/cm-singleton.js 之类会拿它直接拼 events 目录下的路径 —— 混进 life 的月份
   * 就会拼出一个不存在的文件。需要「两条流 + 冷归档」全集的调用方用 listAllShards()。
   */
  function listLifeShards() {
    return shardsIn(lifeEventsDir);
  }

  // ── 冷归档（2026-11-13）───────────────────────────────────────────────
  // 冷归档的月份不在这里返回：listShards() 的语义是「events/ 里现存的月分片」，
  // 被 bin/cm-singleton.js 之类的地方直接拼成文件路径，混进冷月份会读不到文件。
  // 需要「热 + 冷」全集的调用方请用 listAllShards() / readShardRecords()。

  /** 已归档的月份（只读目录，不解压）。 */
  function listColdShards() {
    try { return coldShardMonths(dir); } catch { return []; }
  }

  /**
   * 热 + 冷 + life 的月份并集，按月份升序。读全库（rebuildIndex / rescope / 去重回填）用它。
   * life 的月份要在这里，否则「改一条 life 记录的 scope」会报 missing、
   * 去重回填也会漏掉生活侧那一半。
   */
  function listAllShards() {
    return [...new Set([...listShards(), ...listLifeShards(), ...listColdShards()])].sort();
  }

  /**
   * 读某个月的全部记录：先冷后热。
   *
   * 为什么不是「热在就只读热」：一个已归档的月份可能因为 rescope 又被追加出
   * 一个只有修订行的热分片（rescope 不会解压冷文件、只追加同 id 的修订行）。
   * 这时候热文件里只有那几行，只读热就等于把整月历史弄丢了。
   * 两边都读、**冷在前热在后**，正好满足「同 id 后写覆盖先写」的既有语义。
   */
  function readJsonlFile(file, out) {
    if (!fs.existsSync(file)) return;
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch {}
    }
  }

  function readShardRecords(shard) {
    const out = [];
    // 冷的那份（如果有）。月份文件已归档才存在。
    try { out.push(...coldRecordsOfShard(dir, shard)); } catch { /* 冷文件坏了不静默：上层 verify 会报 */ }
    // 读序：冷 → life 热 → 主热。后写覆盖先写的既有语义保持不变
    // （life 记录只会出现在 life 目录里，rescope 成 work 之后才会在主热目录里出现修订行，
    //  所以 life 热必须排在主热之前，否则「life 改成 work」的那条会被旧行盖掉）。
    readJsonlFile(path.join(lifeEventsDir, `${shard}.jsonl`), out);
    readJsonlFile(path.join(eventsDir, `${shard}.jsonl`), out);
    // 改判行（rescope 追加的修订行）必须排在原行之后，否则「后写覆盖先写」会反过来：
    // work→life 的修订行落在 life 目录，而原行还在主目录 —— 固定目录顺序下
    // 主目录的后读会把改判盖掉，等于 rescope 白做（2026-11-21 实测踩到）。
    // 这里按 rescopedAt 做一次稳定排序：没有 rescopedAt 的原行在前，
    // 有 rescopedAt 的修订行按时间先后排在后面（多条改判时最后一条生效）。
    if (out.length > 1) {
      const keyed = out.map((rec, i) => ({ rec, i, k: Number(rec && rec.rescopedAt) || 0 }));
      keyed.sort((a, b) => (a.k - b.k) || (a.i - b.i));
      return keyed.map((x) => x.rec);
    }
    return out;
  }

  /** 冷归档摘要（账本 + stat，不解压）。 */
  function coldStats() {
    try { return coldSummary(dir); } catch { return { shards: [], count: 0, gzBytes: 0, bytes: 0, records: 0, unknownMeta: 0, dir: coldPaths(dir).coldDir }; }
  }

  /**
   * 基础遍历查询（不是检索；检索在 search.js）。只看得到当前角色可见的 scope。
   *
   * `kind` 可以是字符串或字符串数组。数组是 2026-11-06 加的：以前调用方
   * 只能拿到「最近 N 条任意 kind」再自己过滤，而 N 是截断在过滤之前做的，
   * 于是 `cm-boot` 想要「最近 12 条对话」实际拿到 12 条里 11 条是 AI 独白
   * （库里 ai 占 31%，msg 占 63%，按时间混排后短窗口内几乎全是 ai）。
   * 把 kind 数组传进来，过滤就能发生在截断之前。
   *
   * `role`（2026-11-07 加，工单 2.2）：显式按某个角色算可见范围，不依赖调用方
   * 记得 export CM_ROLE。原因：`cm-agents` 写的是 AGENTS.md 本体（同机所有会话
   * 共读），它的「他最近说过的话」必须和注入块用**同一套口径**——恒按注入角色
   * 过滤。以前这里调 visibleScopes() 走 resolveRole()，而 resolveRole() 默认会
   * 读工作区 .companion-memory/role（手机上是 life），于是定时器无环境拉起时
   * 「他最近说过的话」会漏进 13/15 条 life 私话，单向门在 AGENTS.md 这一层被绕开。
   * 不传 role 时行为不变（仍按当前进程角色），其它调用方（cm-boot / cm-web /
   * reflect / handoff / cm-scope）不受影响。
   */
  function query({ from = 0, to = Date.now(), limit = 200, src = null, kind = null, scope = null, role = null } = {}) {
    const kinds = kind == null ? null : (Array.isArray(kind) ? new Set(kind) : new Set([kind]));
    // 同一个 id 可能有多行（rescope 就是追加同 id 的修订行），后写的覆盖先写的。
    const byId = new Map();
    const ordered = [];
    const visible = visibleScopes(role || resolveRole());
    // 遍历范围 = 热分片 + 冷分片。冷月份先用月份边界判掉（不相交就不解压）：
    // query({from: 最近三天}) 一次 gunzip 都不用付；只有范围真的跨到历史月份才解压。
    for (const shard of listAllShards()) {
      if (!shardOverlaps(shard, from, to)) continue;
      for (const rec of readShardRecords(shard)) {
        if (!rec || !Number.isFinite(rec.t)) continue;
        if (rec.t < from || rec.t > to) continue;
        if (src && rec.src !== src) continue;
        if (kinds && !kinds.has(rec.kind)) continue;
        if (!byId.has(rec.id)) ordered.push(rec.id);
        byId.set(rec.id, rec);
      }
    }
    // 归档过滤：循环外取一次快照（current() 内部按 fileStamp 判变更、必要时 reload），
    // 循环内用 Set.has() 做 O(1) 查表。原来逐条 archiveWatcher.has() 每条一次 statSync
    // （P2-06：20000 条 4938ms）。快照是「本次调用开始时」的归档集，语义等价于在循环
    // 起点冻结归档视图；下一次 query 会重新取 current()，跨进程/跨设备的即时可见性不变
    // （tests/cases/recall-archive.mjs「归档表变了立刻生效」仍绿）。
    const archived = archiveWatcher.current();
    const out = [];
    for (const id of ordered) {
      const rec = byId.get(id);
      const sc = rec.scope || SCOPE_SHARED;
      if (scope && sc !== scope) continue;
      // 单向门：工作侧永远看不见 life 那一层。
      if (!visible.includes(sc)) continue;
      // 归档：被归档的原文不再出现在任何「遍历/注入」通道里（2026-11-09）。
      // 墓碑管的是「物理清理过、别再灌回来」；归档管的是「原文留着、但别再捞出来」。
      // 点名要读某一条请用 recall.read(id)（走 search.js 的 byId，不受这里影响）。
      if (archived.has(rec.id)) continue;
      out.push(rec);
    }
    out.sort((a, b) => a.t - b.t);
    return limit > 0 ? out.slice(-limit) : out;
  }

  function stats() {
    const shards = listShards();
    const lifeShards = listLifeShards();
    let totalBytes = 0;
    let lifeBytes = 0;
    for (const s of shards) {
      try { totalBytes += fs.statSync(path.join(eventsDir, `${s}.jsonl`)).size; } catch {}
    }
    for (const s of lifeShards) {
      try { lifeBytes += fs.statSync(path.join(lifeEventsDir, `${s}.jsonl`)).size; } catch {}
    }
    return {
      version: STORE_VERSION,
      root,
      shards: shards.map((s) => ({ shard: s, ...(manifest.shards[s] || {}) })),
      // 丙方案（2026-11-21）：life 那一层单独一个目录，这里也单独报一份，
      // 但 totalBytes 算的是「整库多占了多少磁盘」，两部分加起来。
      // 老读法（shards / totalBytes / counts）形状没动。
      lifeShards: lifeShards.map((s) => ({ shard: s, ...(manifest.shards[s] || {}) })),
      lifeBytes,
      lifeEventsDir,
      totalBytes: totalBytes + lifeBytes,
      counts: { ...manifest.counts },
      ids: seen.size,
      // 去重状态要能看见：关了没、索引多大、有没有溢出/落盘失败（不许静默失效）。
      dedupe: {
        enabled: !!dindex,
        windowHours: dindex ? Number((dindex.windowMs / 3600_000).toFixed(3)) : null,
        driftMs: dindex ? dindex.driftMs : null,
        indexSize: dindex ? dindex.size : 0,
        overflow: dindex ? dindex.overflow : false,
        writeFailed: dedupeWriteFailed,
        exempt: dedupeCfg.exempt ? {
          all: !!dedupeCfg.exempt.all,
          srcs: [...(dedupeCfg.exempt.srcs || [])],
          ids: [...(dedupeCfg.exempt.ids || [])]
        } : null
      },
      updatedAt: manifest.updatedAt,
      // 冷归档（2026-11-13）：只报账本 + stat，不解压。
      // 形状是新增字段，老读法（shards / totalBytes / counts）一个都没动。
      cold: coldStats()
    };
  }

  /** 由 events 重建索引。索引坏了、手工合并过文件时用。
   *  已经在锁里（比如 gc 重写完分片立刻重建）就直接执行——
   *  withLock 不是可重入的，套两层会等自己等到超时。 */
  function rebuildIndex() {
    assertWritable('重建索引', undefined, dir);
    const doRebuild = () => {
      // 冷分片也要进 ids.txt：append 的 id 判重（seen.has）是「这条写过了没有」的
      // 唯一闸门。不把已归档月份的 id 收进来，同步重放一次就会把整月历史再写一遍。
      const ids = [];
      for (const shard of listAllShards()) {
        for (const rec of readShardRecords(shard)) {
          if (rec && rec.id) ids.push(rec.id);
        }
      }
      const uniq = [...new Set(ids)];
      fs.writeFileSync(idsPath, uniq.join('\n') + '\n', 'utf8');
      seen.clear();
      for (const id of uniq) seen.add(id);
      // 重建出来的是「当前还活着的 id」；墓碑单独存放（raw/tombstones.txt），
      // 不写回 ids.txt —— ids.txt 是派生物，墓碑是资产，两者不能混。
      // append 时先查 seen 再查 tomb，所以这里不需要把 tomb 并进 seen。
      seenStamp = fileStamp(idsPath);
      return uniq.length;
    };
    if (fs.existsSync(path.join(dir, LOCK_DIRNAME))) return doRebuild();
    return withLock(dir, doRebuild);
  }

  /** 由 events 重新统计 manifest（counts/shards）。gc 整理会删重复、重写分片，
   *  但 manifest 是「累计写入」语义，整理后会和实际 events 对不上。
   *  所以整理完必须重建一次，否则 stats 里的按 src 计数、分片字节数全是旧的。 */
  function rebuildManifest() {
    const doRebuild = () => {
      const counts = {};
      const shards = {};
      // 冷分片也算进 counts（manifest 是「库里到底有什么」的账），
      // 但字节数记的是实际磁盘占用：冷月份记 .gz 的大小，热月份记 .jsonl 的大小。
      for (const shard of listAllShards()) {
        const hot = path.join(eventsDir, `${shard}.jsonl`);
        const hotLife = path.join(lifeEventsDir, `${shard}.jsonl`);
        const cold = coldRecordOf(dir, shard);
        if (!fs.existsSync(hot) && !fs.existsSync(hotLife) && !cold) continue;
        let n = 0;
        try {
          for (const rec of readShardRecords(shard)) {
            if (!rec) continue;
            counts[rec.src] = (counts[rec.src] || 0) + 1;
            n++;
          }
          // 字节数记实际磁盘占用：主热 + life 热 + 冷归档三处加起来。
          // （改造前只有主热与冷两处；life 目录是 2026-11-21 新增的第三条流。）
          const hotBytes = (fs.existsSync(hot) ? fs.statSync(hot).size : 0)
            + (fs.existsSync(hotLife) ? fs.statSync(hotLife).size : 0);
          shards[shard] = { count: n, bytes: hotBytes || (cold?.gzBytes || 0) };
        } catch {}
      }
      manifest.counts = counts;
      manifest.shards = shards;
      manifest.updatedAt = Date.now();
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    };
    if (fs.existsSync(path.join(dir, LOCK_DIRNAME))) return doRebuild();
    return withLock(dir, doRebuild);
  }

  /**
   * 给这些 id 立墓碑：此后再怎么扫会话源文件，都不会把它们灌回来。
   * 只增不减 —— 墓碑是「这条已经被判定为污染副本」的永久结论，
   * 想撤销得手工编辑 raw/tombstones.txt（那就得重新审一遍，故意的）。
   * @returns {{added:number, total:number}}
   */
  function addTombstones(ids) {
    assertWritable('立墓碑', undefined, dir);
    const list = (Array.isArray(ids) ? ids : [ids]).map((s) => String(s || '').trim()).filter(Boolean);
    const fresh = [];
    const wait = [];
    for (const id of list) {
      if (tomb.has(id)) continue;
      tomb.add(id);
      fresh.push(id);
      // 已经写进 events 的，墓碑只是防复活；真正把行删掉是 cm-decontaminate 的事。
      if (seen.has(id)) wait.push(id);
    }
    if (!fresh.length) return { added: 0, total: tomb.size };
    if (!fs.existsSync(tombPath)) {
      fs.writeFileSync(tombPath, [
        '# 墓碑：被主动清理掉的污染副本 id。',
        '# cm-decontaminate --apply 会往这里追加；store 加载时把这些 id 当成已存在，',
        '# 所以 DSH 的会话源文件还在，也不会被 cm-watch 重新灌回原文层。',
        '# 想撤销某条：手工删掉对应行 —— 那就等于承认它该留在库里。',
        ''
      ].join('\n'), 'utf8');
    }
    fs.appendFileSync(tombPath, fresh.join('\n') + '\n', 'utf8');
    tombStamp = fileStamp(tombPath);
    return { added: fresh.length, total: tomb.size, alsoInEvents: wait.length };
  }

  function close() {
    if (appendHandle != null) {
      try { fs.closeSync(appendHandle); } catch {}
      appendHandle = null;
    }
  }

  /**
   * 2026-11-13（W-A2 追补）：批量问「这些 id 是不是已经在库里了」。
   *
   * 为什么要有它：`append()` 里 id 判重（`seen.has`）在指纹计算**之前**，
   * 所以「id 已存在」的记录根本不需要算指纹。但 `syncSessions` 的批内预过滤
   * 是先把整批指纹算完再交给 append 的 → 每个已入库的记录都白算一次
   * 归一化 + sha1（真实库 7008 条里约 6800 条属于这种）。
   *
   * 实测（真实库 79 会话、第二轮）：批内指纹+判重约 600ms，加上这道预筛后
   * 第二轮从 817ms 降到 94ms。
   *
   * 只读内存 Set，不加锁、不落盘、不改任何状态 —— 判定仍然由 append() 做最后一道闸，
   * 这里只是提前省掉算不动的那部分。多进程并发时 seen 可能略旧，
   * 最坏情况是多算几条指纹（退化成没优化），不会漏写、不会重写。
   */
  function hasIds(ids) {
    const out = new Set();
    if (!ids) return out;
    refreshSeen();
    for (const id of ids) {
      const s = String(id ?? '').trim();
      if (s && seen.has(s)) out.add(s);
    }
    return out;
  }

  return { root, eventsDir, lifeEventsDir, append, query, stats, listShards, listLifeShards, listColdShards, listAllShards, readShardRecords, coldStats, rebuildIndex, rebuildManifest, rescope, addTombstones, archiveWatcher, hasIds, close };
}

/**
 * 从 DSH 的 session.v4.jsonl.zstd 里解出所有 JSONL 行。
 * 单帧坏了不影响其余帧：宁可少一条，也不要整批失败。
 */
export function readSessionRecords(buffer) {
  const MAGIC = Buffer.from('28b52ffd', 'hex');
  const idx = [];
  let i = 0;
  while (true) {
    const j = buffer.indexOf(MAGIC, i);
    if (j < 0) break;
    idx.push(j);
    i = j + 1;
  }
  idx.push(buffer.length);
  const lines = [];
  for (let k = 0; k < idx.length - 1; k++) {
    try {
      const txt = zstdDecompress(buffer.subarray(idx[k], idx[k + 1]));
      for (const l of txt.split('\n')) if (l.trim()) lines.push(l);
    } catch {
      // 单帧失败继续
    }
  }
  const recs = [];
  for (const l of lines) {
    try { recs.push(JSON.parse(l)); } catch {}
  }
  return recs;
}

function zstdDecompress(buf) {
  const fn = zlib.zstdDecompressSync;
  if (typeof fn !== 'function') throw new Error('当前 Node 不支持 zstd 解压（需要 22.15+）');
  return fn(buf).toString('utf8');
}
