// 嵌入通道（向量）。只做一件事：把文字变成向量，不碰存储。
//
// 为什么用硅基流动的 BAAI/bge-m3：
//   基准实测（tmp-probe/REPORT.md）它把三类必崩的题从 1/4 提到 4/4，
//   整体召回 91.3% → 100%，而且它是**免费**的（1024 维）。
//   两个 ¥0.7/M 的 4096 维付费模型反而更差（94.2% / 95.2%）。
//
// ⚠️ 必须校验 index 连续性：
//   硅基流动的 Qwen/Qwen3-VL-Embedding-8B 在 batch>8 时把 index 返回成 index%8，
//   按 index 回填会静默错位、不报错，召回率莫名掉到 62%（747 条只存下 192 条）。
//   bge-m3 没有这个问题，但我们照样逐条校验——这个坑踩一次就够了。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_EMBED_MODEL = 'BAAI/bge-m3';
export const EMBED_BASE = 'https://api.siliconflow.cn/v1';
export const MODEL_DIMS = {
  'BAAI/bge-m3': 1024,
  'BAAI/bge-large-zh-v1.5': 1024,
  'Qwen/Qwen3-Embedding-0.6B': 1024,
  'Qwen/Qwen3-Embedding-4B': 2560,
  'Qwen/Qwen3-Embedding-8B': 4096,
  'Qwen/Qwen3-VL-Embedding-8B': 4096
};

/** 找 key：环境变量 → 工作区里 qwen-rag 留下的那个 → 家目录。凭据不进代码、不进聊天。 */
export function findKey() {
  if (process.env.SILICONFLOW_API_KEY) return process.env.SILICONFLOW_API_KEY.trim();
  const roots = [process.cwd(), path.join(os.homedir(), 'Documents', 'deepseek-harness', 'default-workspace'), os.homedir()];
  const rels = [
    path.join('work', 'qwen-rag', '.secrets', 'siliconflow.key'),
    path.join('.secrets', 'siliconflow.key')
  ];
  for (const r of roots) {
    for (const rel of rels) {
      const p = path.join(r, rel);
      try {
        const s = fs.readFileSync(p, 'utf8').trim();
        if (s) return s;
      } catch {}
    }
  }
  return '';
}

export function dimOf(model = DEFAULT_EMBED_MODEL) {
  return MODEL_DIMS[model] || 1024;
}

/**
 * 调一次嵌入接口。默认批 8：
 * 批太大既会踩 VL 的 index 坑，失败一次损失的 token 也多。
 *
 * 2026-11-05 修：每次请求必须带硬超时（AbortSignal.timeout）。
 * 事故：cm-boot 里用 `Promise.race([mem.buildVectors(), 8 秒])` 给向量通道兜底，
 * 超时后打印「向量增量跳过」并把控制权还给调用方——但底层 fetch 没有超时，
 * 网络 stalled 时它挂在事件循环上永不回来，进程也就永不退出。表现为
 * `CM_ROLE=life cm-boot.js` 卡死两分钟以上（实测 60 秒 timeout 都被吃满）。
 * 生活侧开场要跑 cm-boot，这个 bug 直接等于「记忆库不能用」。
 */
export async function embedBatch(texts, { model = DEFAULT_EMBED_MODEL, key = findKey(), base = EMBED_BASE, retries = 3, timeoutMs = 15_000, signal } = {}) {
  if (!texts.length) return [];
  if (!key) throw new Error('没有硅基流动 API Key：设 SILICONFLOW_API_KEY，或把 key 放到 work/qwen-rag/.secrets/siliconflow.key');

  const body = JSON.stringify({ model, input: texts, encoding_format: 'float' });
  let lastErr = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      // 外层传进来的 signal（cm-boot 的 8 秒开场预算）优先合并：
      // 任一信号触发都立刻断开请求，不让它挂在事件循环上。
      const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      const res = await fetch(`${base}/embeddings`, {
        method: 'POST',
        signal: sig,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`嵌入接口 ${res.status}`);
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`嵌入接口 ${res.status}：${(await res.text()).slice(0, 300)}`);
      const json = await res.json();
      const data = json?.data;
      if (!Array.isArray(data) || data.length !== texts.length) {
        throw new Error(`返回条数不对：要 ${texts.length} 条，回来 ${Array.isArray(data) ? data.length : '非数组'}`);
      }
      // 逐条校验 index：必须正好是 0..n-1 的一个排列。宁可报错，不要静默错位。
      const idx = data.map((d) => d.index);
      const sorted = idx.slice().sort((a, b) => a - b);
      for (let i = 0; i < sorted.length; i++) {
        if (sorted[i] !== i) {
          throw new Error(`嵌入返回的 index 不连续（期望 0..${texts.length - 1}，实际 [${idx.join(',')}]）。换模型或缩小批次。`);
        }
      }
      const dim = data[0].embedding.length;
      const out = new Array(texts.length);
      for (const d of data) {
        const v = Float32Array.from(d.embedding);
        if (v.length !== dim) throw new Error(`同一批向量维度不一致：${dim} vs ${v.length}`);
        out[d.index] = v;
      }
      return out;
    } catch (e) {
      lastErr = e;
      // 外层主动取消（开场预算用完了）就别重试了，立刻往上抛。
      if (signal?.aborted) throw new Error('嵌入被取消（开场超时，向量通道本次跳过）');
      if (String(e.message).includes('index 不连续') || String(e.message).includes('条数不对')) throw e;
      if (attempt === retries - 1) break;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  // 统一包一层：调用方只看「嵌入失败」就知道该退回词面通道，
  // 不需要识别 fetch / DNS / TLS 各自的报错类型。
  throw new Error(`嵌入失败：${lastErr?.message || '未知原因'}`);
}

/** 批量嵌入，自动按批切片。 */
export async function embedAll(texts, { batch = 8, onProgress, ...opts } = {}) {
  const out = [];
  for (let i = 0; i < texts.length; i += batch) {
    const slice = texts.slice(i, i + batch);
    const vecs = await embedBatch(slice, opts);
    out.push(...vecs);
    if (onProgress) onProgress(Math.min(i + batch, texts.length), texts.length);
  }
  return out;
}

export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}
