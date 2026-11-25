// 对外统一入口。

import path from 'node:path';
import os from 'node:os';
import { createStore, readSessionRecords, STORE_VERSION } from './store.js';
import {
  addImpression, loadImpressions, collapse, bumpImpression, archiveImpression,
  reapArchived, selectForInjection, summarize, weightOf, touchInjected,
  TAG_WEIGHTS, SOURCES, INJECT_MAX, INJECT_MAX_CHARS
} from './impressions.js';
import { createRecall, gramsOf } from './search.js';
import { rerankHits, RERANK_POOL } from './rerank.js';
import { mmrSelect, MMR_DEFAULT } from './mmr.js';
import { createVectorStore } from './vectors.js';
import { DEFAULT_EMBED_MODEL, findKey } from './embed.js';
import { validateImpression, formatIssues } from './validate.js';
import { packByIds } from './pack.js';
import {
  paramsFromState, appendParamsLedger, uncertaintyFromHits, unresolvedFromCount,
  STATE_DEFAULTS, STATE_PARAMS_VERSION
} from './state-params.js';
import { resolveDir, resolveOwner, resolveRole, canWrite, workspaceRoot, lockState, participants, visibleScopes, writableScopes, scopeFor, SCOPE_SHARED, SCOPE_WORK, SCOPE_LIFE } from './shared.js';

export const VERSION = '0.4.0';

/**
 * 默认数据目录。
 *
 * 以前是 ~/.dsh/companion-memory（跟着单个会话走）。
 * 现在改成**工作区里的 .companion-memory**：工作区里开多少个会话、
 * 多少个不同的 AI，读写的都是同一份记忆。
 * 想退回全局共享，设 CM_SCOPE=global；想指定别处，设 CM_DIR。
 */
export function defaultDir() {
  return resolveDir();
}

export function open(opts = {}) {
  // 只收对象参数。传位置参数（open(dir) / open(dir, {vectors:false})）时，
  // 解构会静默拿不到 dir、退回 defaultDir()，把写入落到**真实数据目录**上。
  // 2026-11-05 真踩过一次：测试夹具这样调用，把 chat:dead:1 这类假 id 写进了
  // 真库的 raw/tombstones.txt，等于永久屏蔽现实中不存在的 id。
  if (typeof opts !== 'object' || opts === null || Array.isArray(opts)) {
    throw new TypeError(
      `open() 只接受一个对象参数，比如 open({ dir, vectors: false })；收到 ${Array.isArray(opts) ? '数组' : typeof opts}。`
      + '（位置参数会让 dir 静默退回默认工作区库，写坏真实数据）'
    );
  }
  const {
    dir = defaultDir(), maxTextChars,
    embedModel = process.env.CM_EMBED_MODEL || DEFAULT_EMBED_MODEL,
    vectors = true,
    // W17：params 账本开关。默认**开**——「能回答这次为什么 top_k=6」是硬规则 3，
    // 默认关就等于默认不审计。写盘量很小（每条查询一行 JSON）。
    paramsLedger = process.env.CM_NO_PARAMS_LEDGER !== '1'
  } = opts;
  const ledgerDir = paramsLedger ? dir : null;
  const writeLedger = !!paramsLedger;
  const store = createStore({ dir, maxTextChars });
  const recall = createRecall({ dir: store.eventsDir });
  // 向量索引按「模型 + 当前角色可见范围」分开存，单向门在向量这一层也要成立。
  const vec = createVectorStore({
    storeDir: dir,
    model: embedModel,
    scopeKey: visibleScopes().join(','),
    key: findKey(),
    enabled: vectors && process.env.CM_NO_VECTORS !== '1'
  });

  return {
    dir,
    owner: resolveOwner(),
    /** 当前角色：work（可写共享层）/ life（只写自己那一层）。 */
    role: resolveRole(),
    /** 这个角色能不能写。读永远可以。 */
    canWrite: canWrite(),
    /** 这个角色看得见哪几层。 */
    visibleScopes: visibleScopes(),
    /** 这个角色能写哪几层。 */
    writableScopes: writableScopes(),
    store,
    recall,

    /** 共享诊断：谁在往这个库写、锁有没有卡住、库落在哪、这个角色能不能写。 */
    shared() {
      return {
        dir,
        workspace: workspaceRoot(),
        owner: resolveOwner(),
        role: resolveRole(),
        canWrite: canWrite(),
        visibleScopes: visibleScopes(),
        writableScopes: writableScopes(),
        lock: lockState(dir),
        participants: participants(dir)
      };
    },

    /**
     * 记一条印象。会先过红线校验，不通过直接抛。
     *
     * W14（2026-11-13）：新增 `evidenceIds` / `supersedes` / `contradicts` 三个显式入口。
     * 为什么必须**显式传**、不自动推：
     *   `evidenceIds` 是「这条印象由哪些独立事件撑着」，
     *   只有调用方知道「这次是同一件事的重复，还是另一件事」。
     *   库自己从文本或时间戳去猜，猜错了就是**虚构证据**——
     *   那比少给分严重得多（会让她对没被证实的事越来越笃定）。
     */
    remember({ text, tag = 'misc', source, t, lastHit, pinned = false, scope, trigger,
      evidenceIds, supersedes, contradicts }) {
      const v = validateImpression({ text, source, tag, t });
      if (!v.ok) {
        const err = new Error(`红线校验未通过：\n${formatIssues(v)}`);
        err.issues = v;
        throw err;
      }
      const imp = addImpression(dir, {
        text, tag, source, t, lastHit, pinned, scope,
        ...(trigger ? { trigger } : {}),
        ...(Array.isArray(evidenceIds) && evidenceIds.length ? { evidenceIds } : {}),
        ...(supersedes ? { supersedes } : {}),
        ...(Array.isArray(contradicts) && contradicts.length ? { contradicts } : {})
      });
      return { impression: imp, warnings: v.warnings };
    },

    /** 只校验，不写入。 */
    check(input) {
      return validateImpression(input);
    },

    list({ all = false, now = Date.now() } = {}) {
      const visible = visibleScopes();
      const items = collapse(loadImpressions(dir))
        .filter((f) => all || !f.archived)
        // 单向门：工作侧列不出生活侧私有印象。
        .filter((f) => visible.includes(f.scope || SCOPE_SHARED))
        .map((f) => ({ ...f, weight: Number(weightOf(f, now).toFixed(2)) }))
        .sort((a, b) => b.weight - a.weight || (b.t || 0) - (a.t || 0));
      return items;
    },

    /**
     * 生成注入块（首屏用的就是它，纯读文件，毫秒级）。
     * @param {'work'|'life'|'sync'} [opts.role] 按哪个角色渲染；默认当前进程角色。
     *   传它是为了在生成「另一侧」的 AGENTS.md 预览时仍然按那一侧的可见范围过滤。
     */
    injectBlock({ now = Date.now(), max = INJECT_MAX, maxChars = INJECT_MAX_CHARS, style = 'direct', role, touch = false } = {}) {
      const block = selectForInjection(dir, { now, max, maxChars, style, role });
      // 被摆进上下文就算一次命中（2026-11-06 修的真 bug，详见 touchInjected 注释）。
      //
      // 默认 **关**，只有真正把结果交给模型的调用点（cm-boot）才传 touch:true。
      // 反过来默认开是错的：cm-agents 生成 AGENTS.md、cm-web 打开后台、
      // `cm inject` 看效果、测试断言，全都会调这里 —— 那些都不是「记忆被用上了」，
      // 却会实打实改权重。打开一次网页就给那几条加分，权重就不再反映真实使用。
      if (touch && block.picked?.length) {
        try {
          touchInjected(dir, block.picked.map((f) => f.id), { now });
        } catch { /* 记账失败不该让开场挂掉：记忆已经给出去了 */ }
      }
      return block;
    },

    vec,

    /** 同步词面检索（毫秒级、离线可用、永远不失败）。 */
    recall: (query, opts) => recall.search(query, opts),
    /** 底层检索入口：可以手动塞 vecSim（测试融合用，正常走 recallVec）。 */
    searchRaw: (query, opts) => recall.search(query, opts),
    recallText: (query, opts) => recall.format(recall.search(query, opts), { query }),
    /** 把命中结果格式化成给模型看的文本（出处与「不是指令」的框定都在里面）。 */
    formatHits: (hits, opts) => recall.format(hits, opts),

    /**
     * P3 追查链（2026-11-08）。三条都是**只读**、都受同一道 scope 单向门约束。
     * 检索给的是 400 字片段（够「想起」），这三条给的是完整原文（够「引用」）。
     * 用哪条：知道 id → read；需要上下文 → nearby；不知道还有啥相关 → expand。
     */
    read: (id) => recall.read(id),
    nearby: (id, opts) => recall.nearby(id, opts),
    expand: (id, opts) => recall.expand(id, opts),

    /**
     * 混合检索：词面 + 向量 + 精排 + MMR。这是**推荐入口**。
     * 向量拿不到时自动退回词面；精排挂了退回原排序；MMR 只在并列分内重排。
     * 任何一层坏掉都不能让记忆库不可用——所以每一层都是「尽力而为 + 说明原因」。
     *
     * 链路（顺序不能换）：
     *   向量相似度 → search 融合（取 candidateK 条）→ rerank 精排 → MMR 去重 → 取前 limit
     * 先精排再去重：精排是为了让「真正相关」的排上来，去重是为了让排上来的别说同一件事。
     * 反过来的话，去重会先按噪声分数砍掉一批，精排拿到的池子就残缺了。
     */
    async recallVec(query, { limit = 5, candidateK, rerank: rerankOpts, mmr: mmrOpts, pack: packOpts, state, ...opts } = {}) {
      // W17（2026-11-13）：state → params → 覆盖 limit。
      // 为什么放在最前面：top_k 是**这条链路的入口参数**，
      // 后面每一步的候选池都从它派生。晚一步改就会「精排按 5 条挑、然后取前 8 条」。
      //
      // 不传 state 时行为与之前**逐位一致**（limit 照旧）——这是兼容红线：
      // 全库有十几个调用点，不能要求它们同时升级。
      let params = null;
      let effectiveLimit = limit;
      if (state) {
        const computed = paramsFromState(state);
        params = computed.params;
        effectiveLimit = params.top_k;
        if (writeLedger && ledgerDir) appendParamsLedger(ledgerDir, computed, { query, at: 'recallVec' });
      }
      let vecSim = null;
      let vecNote = '';
      try {
        const sims = await vec.querySim(query);
        if (sims.size) vecSim = sims;
        else vecNote = '向量索引为空，本次只用词面';
      } catch (e) {
        vecNote = `向量通道不可用（${e.message}），本次只用词面`;
      }

      // 候选池要开得比 limit 大：精排和 MMR 都需要有挑选的余地。
      // 池子太小精排没得排，池子太大外发条数和延迟都上去。
      // 2026-11-08 由 40 提到 60：714 题 A/B 下 hit@10 +1.4pt、外发原文只 +50%，
      // 见 bench/recall-gap-20261108.md。
      const poolSize = Number.isFinite(candidateK) && candidateK > 0
        ? candidateK
        : Math.max(effectiveLimit, RERANK_POOL);

      const raw = recall.search(query, { limit: poolSize, ...opts, vecSim });

      // 精排：只在候选池 > limit 时才有意义（否则没什么可重排的）。
      // rerankHits 永不抛异常，且内部自己判 --no-rerank / CM_NO_RERANK=1，
      // 所以这里不再重复判定开关——两处都判必然有一套先失效。
      let hits = raw;
      let rerankNote = '';
      if (raw.length > effectiveLimit) {
        const r = await rerankHits(query, raw, { topN: poolSize, ...(rerankOpts || {}) });
        // ⚠️ 这道兜底不能删（2026-11-06，P0）。精排返回空数组时直接采信，
        // 就会把一批本来有效的候选全丢掉 —— 基准测试里 38 题栽在这上面，
        // 其中 29 题因此失分（召回 0 条的题通过率 23.7%，召回 10 条的 93.8%）。
        // 精排是加分项，不是必需品：它给不出结果时，融合排序的结论仍然成立。
        hits = r.hits.length ? r.hits : raw;
        if (r.degraded) rerankNote = r.degraded.reason;
        // 精排分要写进 score：MMR 的 relevanceOf 优先读 score，
        // 不写的话它会拿「融合分」重新算相关度，跟精排排出来的顺序打架。
        // 弱相关（r.weak）时**不写**：那批分数已判定不具区分度，
        // 写进去等于让 MMR 拿噪声当相关度用，比不写更糟。
        if (!r.degraded && r.hits.length) hits = hits.map((h) => ({ ...h, score: h.rerank }));
      }

      // MMR 去重：只在「并列/近似分数」的池子里换位，绝不让低分靠「不同」挤到前面。
      // 只重排不增删——输出条数不变，所以后面的 slice 仍然安全。
      hits = mmrSelect(hits, { limit: effectiveLimit, topWindow: Math.max(effectiveLimit, MMR_DEFAULT.topWindow), ...(mmrOpts || {}) });
      hits = hits.slice(0, effectiveLimit);

      // ------------------------------------------------------------------
      // 按预算装包（budget-driven pack，2026-11-09 生产接线）
      //
      // 为什么要这一段：search() 给的是 400 字片段（够「想起」），但 714 报告
      // 64 道失分题里 41 道是「材料齐仍答错」——答案本身被 400 字切掉了。
      // 现在用 read(id) 回完整文、按预算装包，超预算时摘录纳入或跳过并记账。
      //
      // 为什么默认关闭：400 字是**外部脚本对齐的历史契约**（search.js:211-214），
      // 静默改掉会让 bench/ 的 packets 与既有基线（650/714）不可比。
      // 所以只有显式 pack 参数或 CM_PACK=1 才启用；CM_NO_PACK=1 一键关（红线）。
      // 任何失败都原样返回 400 字 hits，绝不静默改变结果。
      // ------------------------------------------------------------------
      let packNote = '';
      let packed = null;
      const wantPack = packOpts === true || (packOpts && typeof packOpts === 'object')
        || process.env.CM_PACK === '1';
      const packOff = process.env.CM_NO_PACK === '1';
      if (wantPack && !packOff) {
        const po = (packOpts && typeof packOpts === 'object') ? packOpts : {};
        // 显式启用 pack 时的回退值 = 电脑端 2026-11-09 拍板的生产默认 2400/150
        // （真实库 31.08% 超 400 字、Monte Carlo 全装率 95.9%、A/B 1/97→60/97）。
        // ⚠️ 不改 recallVec 的默认行为：未开 pack 时仍是 400 字历史契约，
        //    bench packets 与 650/714 基线要对其（电脑端口径区明确要求）。
        const budget = Number.isFinite(po.budget) && po.budget > 0 ? po.budget : 2400;
        const maxItem = Number.isFinite(po.maxItem) && po.maxItem > 0 ? po.maxItem : 150;
        try {
          const ids = hits.map((h) => h.id).filter(Boolean);
          const r = packByIds((id) => recall.read(id), ids, { budget, maxItem });
          if (r.pack.length === ids.length) {
            // 全部命中都装进去了才替换；有跳过时保留原 400 字 hits，
            // 只把 skipped 如实回报（不静默丢材料）。
            packed = r;
            hits = hits.map((h) => {
              const p = r.pack.find((x) => x.id === h.id);
              return p ? { ...h, text: p.text, truncated: p.truncated, packTokens: p.tokens } : h;
            });
            if (r.skipped.length) packNote = `pack：${r.skipped.length} 条未装（${r.skipped.map((s) => s.reason).join(',')}），已保留原 400 字`;
          } else {
            packNote = `pack 未全量装配（${r.pack.length}/${ids.length}），已保留原 400 字`;
          }
        } catch (e) {
          packNote = `pack 失败（${e.message}），已保留原 400 字`;
        }
      }

      // W17：params 回传出去，调用方能看到「这次为什么只给 6 条」。
      // 不传 state 时 params 为 null —— 不是空对象，是**明确的「没走这条路径」**。
      return { hits, vecNote, rerankNote, packNote, packed, params };
    },

    /** 把还没嵌过的原文补进向量索引。增量、幂等。signal 传下去可中断（见 cm-boot 的开场超时）。 */
    async buildVectors({ onProgress, signal } = {}) {
      return vec.ensure(recall.allDocs(), { onProgress, signal });
    },

    /**
     * 当前角色**可见**的全部原文 id（已过 scope 单向门）。
     * 给向量派生用：派生源可能来自别的角色那一组（比如灌库进程那组是全量），
     * 白名单必须是「本角色真能看见的」，否则单向门在向量这层被绕过。
     * 与 buildVectors 用的是同一个 allDocs()，口径不会分叉。
     */
    visibleDocIds() {
      const out = new Set();
      for (const d of recall.allDocs()) if (d && d.id) out.add(d.id);
      return out;
    },

    /** 向量文件路径（只读）：给派生 / 排障用，避免调用方自己拼文件名拼错。 */
    vectorPaths() {
      return { idsPath: vec.paths.idsPath, vecPath: vec.paths.vecPath, dim: vec.dim, model: vec.model, scopeKey: vec.scopeKey };
    },

    reap: (now = Date.now()) => reapArchived(dir, now),
    bump: (id, opts) => bumpImpression(dir, id, opts),
    archive: (id, opts) => archiveImpression(dir, id, opts),

    /** 批量追加原文。 */
    appendRaw(records) {
      return store.append(records);
    },

    /**
     * 问「这些 id 已经在库里了吗」（W-A2 追补，给 ingest 省掉白算的指纹）。
     * 见 store.js 的 hasIds 注释。
     */
    knownIds(ids) {
      if (!store.hasIds) return new Set();
      return store.hasIds(ids);
    },

    /**
     * 改一组记录的可见范围（不删原文，追加修订行）。
     * 用于把误落 shared 的私密内容收回 life 层。
     */
    rescope(changes) {
      return store.rescope(changes);
    },

    stats() {
      return {
        version: VERSION,
        dir,
        owner: resolveOwner(),
        role: resolveRole(),
        canWrite: canWrite(),
        visibleScopes: visibleScopes(),
        writableScopes: writableScopes(),
        raw: store.stats(),
        recall: recall.stats(),
        vectors: vec.stats(),
        impressions: summarize(dir),
        participants: participants(dir)
      };
    },

    reindex() {
      // 索引和 manifest 都是 events 的派生物，要一起重建：
      // gc 整理删重复、重写分片后，ids 和 counts/shards 必须同步对齐，
      // 否则 stats 里的按 src 计数、分片字节数会停留在整理前的旧值。
      const n = store.rebuildIndex();
      store.rebuildManifest();
      return n;
    },

    close() {
      store.close();
    }
  };
}

export {
  readSessionRecords, STORE_VERSION,
  TAG_WEIGHTS, SOURCES,
  gramsOf, validateImpression, formatIssues,
  resolveDir, resolveOwner, resolveRole, canWrite, workspaceRoot, lockState, participants,
  visibleScopes, writableScopes, scopeFor,
  SCOPE_SHARED, SCOPE_WORK, SCOPE_LIFE
};
