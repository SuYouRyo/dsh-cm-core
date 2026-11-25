// 批量导入 Markdown 知识库：递归扫目录 → 解析 frontmatter → 按标题切块 → 生成 import 记录。
//
// 为什么单独一个文件：
//   切块逻辑和「记一条」完全不同——一个 md 可能 132KB，得按标题/段落切成
//   若干条可检索的原文记录，每条带上「文档名 › 章节」面包屑，检索命中时才能自解释。
//   这里不碰存储/向量，只负责「目录 → 记录数组」，调用方拿到记录后 appendRaw + buildVectors。
//
// 记录契约（和 src/store.js、src/search.js 对齐）：
//   src='import'（store.js 里合法的来源之一）
//   kind='msg'、role='user'（search.js 只索引 kind∈{msg,ai,user} 且 role∉噪声词）
//   scope 默认 'shared'（两边都能看，可用 --scope 覆盖）
//   seq=稳定哈希（同一条文件+同一块序号，重跑不会重复入库）

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CHUNK_MAX = 1600;      // 单块正文上限（字符）。留足给面包屑，且 < embed 的 2000 截断线。
const TEXT_EXT = new Set(['.md', '.markdown', '.txt']);

/** 摘掉 YAML frontmatter。返回 { fm, body }；没有 frontmatter 时 fm 为 null。 */
export function parseFrontmatter(text) {
  let fm = null;
  let body = text;
  if (text.startsWith('---\n') || text.startsWith('---\r\n')) {
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
    if (m) {
      fm = parseYamlLite(m[1]);
      body = text.slice(m[0].length);
    }
  }
  return { fm, body };
}

/** 极简 YAML：只取顶层标量键，够摘 title/type/category/aliases 用。 */
function parseYamlLite(src) {
  const out = {};
  for (const line of src.split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

/** 按 H1/H2 切成节（H3+ 留在正文里，不拆，保住小节上下文）。 */
function splitTopSections(body) {
  const lines = body.split(/\r?\n/);
  const sections = [];
  let h1 = '';
  let h2 = '';
  let buf = [];
  const flush = () => {
    const text = buf.join('\n').trim();
    if (text) sections.push({ headings: [h1, h2].filter(Boolean), text });
    buf = [];
  };
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m && m[1].length <= 2) {
      flush();
      if (m[1].length === 1) { h1 = m[2].trim(); h2 = ''; }
      else { h2 = m[2].trim(); }
    } else {
      buf.push(line);
    }
  }
  flush();
  return sections;
}

/** 按空行分段，贪心打包到 max 字符。单段超长则硬切。 */
function hardSplit(text, max) {
  const paras = text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  let cur = '';
  const push = (s) => { if (s.trim()) out.push(s.trim()); };
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > max) { push(cur); cur = p; }
    else { cur = cur ? cur + '\n\n' + p : p; }
    while (cur.length > max) { push(cur.slice(0, max)); cur = cur.slice(max); }
  }
  push(cur);
  return out;
}

function stableSeq(relPath, index) {
  return crypto.createHash('sha1').update(relPath + '#' + index).digest('hex').slice(0, 20);
}

/**
 * 把一个 md 文件切成 import 记录。
 * @param {string} filePath 绝对路径
 * @param {string} root     扫描根目录（算相对路径用，写进 meta.source）
 * @param {string} scope    默认 shared
 * @param {number} t        时间戳（同一次导入保持一致即可）
 */
export function chunkFile(filePath, root, { scope = 'shared', t = Date.now() } = {}) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return []; }
  if (!raw.trim()) return [];
  const { fm, body } = parseFrontmatter(raw);
  if (!body.trim()) return [];

  const relPath = path.relative(root, filePath).split(path.sep).join('/');
  const title = (fm && fm.title) || path.basename(filePath, path.extname(filePath));

  const records = [];
  let i = 0;   // 跨 section 全局递增：seq 必须唯一，否则重跑会互相去重吃掉块。
  for (const sec of splitTopSections(body)) {
    const crumbs = [title, ...sec.headings];
    const label = [...new Set(crumbs)].join(' › ');
    for (const piece of hardSplit(sec.text, CHUNK_MAX)) {
      const text = `【${label}】\n${piece}`;
      records.push({
        src: 'import',
        seq: stableSeq(relPath, i),
        kind: 'msg',
        role: 'user',
        scope,
        t,
        text,
        meta: { owner: 'import', source: relPath, title, section: sec.headings.join(' › ') }
      });
      i++;
    }
  }
  return records;
}

/** 递归列出目录下所有可导入的 md/txt 文件（绝对路径）。 */
export function scanFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__pycache__') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (TEXT_EXT.has(path.extname(e.name).toLowerCase())) out.push(full);
    }
  };
  walk(root);
  return out;
}

/**
 * 一键：目录 → 记录数组。返回 { files, records }。
 */
export function importDir(root, opts = {}) {
  if (!root || !fs.existsSync(root)) throw new Error(`目录不存在：${root}`);
  const st = fs.statSync(root);
  if (!st.isDirectory()) throw new Error(`不是目录：${root}`);
  const files = scanFiles(root);
  const records = [];
  for (const f of files) records.push(...chunkFile(f, root, opts));
  return { files: files.length, records };
}
