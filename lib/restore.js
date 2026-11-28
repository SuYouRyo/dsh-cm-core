/**
 * dsh-cm-core/restore —— 「数据全面丢失时，只靠这一个插件把项目恢复回来」。
 *
 * ============ 这个模块要回答的问题 ============
 * 苏的原话（验收标准）：「当数据全面丢失时，只通过一个插件就完全恢复我们的项目」。
 *
 * 「全面丢失」的三种真实形态，本模块每一层都对应一种：
 *   ① 记忆库数据没了（.companion-memory 被删，或换到一台新机器）
 *      → 从插件自带的 snapshot/data/*.gz 解压回去，reindex 重建倒排索引。
 *   ② 代码仓没了（work/companion/companion-memory 不在）
 *      → 从 snapshot/code.bundle 克隆出一个完整历史仓。
 *   ③ 索引/向量这类派生物没了
 *      → reindex（倒排）+ 可选 buildVectors（向量，要 API key）。
 *
 * ============ 三条纪律 ============
 * 1. **只补不覆盖。** 目标文件已存在就跳过并报告，绝不静默覆盖当前正在用的库。
 *    想强制重来必须先自己删——「恢复」误伤现有数据比不恢复更糟。
 * 2. **校验原文哈希。** manifest 里存的是**解压后**内容的 sha256（gzip 容器可变），
 *    逐文件核对；不符就整份中止，不写半个坏库。
 * 3. **失败要说清哪一步。** 恢复是低频、高风险动作，返回结构化结果而不是抛异常，
 *    让调用方（工具/CLI）能把「哪一层没成」原话转告。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/** 读插件自带的 snapshot/manifest.json；没有就返回 null。 */
export function readSnapshotManifest(root = PACKAGE_ROOT) {
  const file = path.join(root, 'snapshot', 'manifest.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 恢复记忆库数据层。
 *
 * @param {object} opts
 * @param {string} opts.memDir     目标数据目录（会被创建）
 * @param {string} [opts.root]     插件包根（默认本包）
 * @param {boolean} [opts.force]   true 时覆盖已存在文件（默认 false，只补不覆盖）
 * @param {boolean} [opts.reindex] 写完是否重建倒排索引（默认 true）
 * @returns {{ok, restored:string[], skipped:string[], failed:null|{file,reason}, manifest}}
 */
export function restoreData({ memDir, root = PACKAGE_ROOT, force = false, reindex = true } = {}) {
  const manifest = readSnapshotManifest(root)
  if (!manifest) {
    return { ok: false, restored: [], skipped: [], failed: { file: 'snapshot/manifest.json', reason: '插件包里没有快照清单' }, manifest: null }
  }
  if (!memDir) {
    return { ok: false, restored: [], skipped: [], failed: { file: '(memDir)', reason: '必须显式给目标数据目录' }, manifest }
  }

  // 先整份校验，再落盘：任何一份哈希不符就一条都不写。
  const planned = []
  for (const item of manifest.data?.files || []) {
    const gzPath = path.join(root, 'snapshot', item.file)
    let raw
    try {
      raw = zlib.gunzipSync(fs.readFileSync(gzPath))
    } catch (e) {
      return { ok: false, restored: [], skipped: [], failed: { file: item.file, reason: `解压失败：${e?.message ?? e}` }, manifest }
    }
    const got = sha256(raw)
    if (got !== item.sha256) {
      return { ok: false, restored: [], skipped: [], failed: { file: item.file, reason: `哈希不符：期望 ${item.sha256.slice(0, 12)}… 实得 ${got.slice(0, 12)}…` }, manifest }
    }
    planned.push({ ...item, raw })
  }

  const restored = []
  const skipped = []
  for (const item of planned) {
    const dest = path.join(memDir, item.from)
    if (fs.existsSync(dest) && !force) {
      skipped.push(item.from)
      continue
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, item.raw)
    restored.push(item.from)
  }

  let reindexed = null
  if (reindex && restored.length) {
    try {
      reindexed = reindexStore(memDir)
    } catch (e) {
      reindexed = { ok: false, reason: String(e?.message ?? e) }
    }
  }

  return { ok: true, restored, skipped, failed: null, manifest, reindexed }
}

/** 重建倒排索引 + manifest（两者必须一起，见 src/index.js 的 reindex 注释）。 */
export function reindexStore(memDir) {
  const lib = loadVendor()
  const cm = lib.open({ dir: memDir, vectors: false, paramsLedger: false })
  try {
    return cm.reindex()
  } finally {
    try { cm.close?.() } catch { /* 忽略 */ }
  }
}

/** 恢复代码仓：从 snapshot/code.bundle 克隆出一个完整历史仓。 */
export function restoreCode({ targetDir, root = PACKAGE_ROOT, force = false } = {}) {
  const bundle = path.join(root, 'snapshot', 'code.bundle')
  if (!fs.existsSync(bundle)) {
    return { ok: false, reason: '插件包里没有 snapshot/code.bundle' }
  }
  if (fs.existsSync(targetDir) && !force) {
    return { ok: false, reason: `目标已存在：${targetDir}（只补不覆盖；确认要重建请先自己移走）` }
  }
  try {
    execFileSync('git', ['clone', bundle, targetDir], { stdio: 'pipe' })
    const head = execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    // 第二层：把快照时**未提交**的改动打回去。git bundle 只含已提交历史，
    // 少了这层，恢复出来的代码会静默退回修复前的行为（例如 life 污染红线）。
    const worktree = applyWorktreePatch({ targetDir, root })
    return { ok: true, targetDir, head, worktree }
  } catch (e) {
    return { ok: false, reason: String(e?.stderr?.toString?.() || e?.message || e) }
  }
}

/** 应用 snapshot/code-worktree.patch（若快照里有）。失败不使整层失败，只报告。 */
export function applyWorktreePatch({ targetDir, root = PACKAGE_ROOT } = {}) {
  const manifest = readSnapshotManifest(root)
  const info = manifest?.repo?.worktree
  if (!info) return { ok: true, applied: false, reason: '快照里没有未提交改动层' }
  const file = path.join(root, 'snapshot', info.file)
  let buf
  try {
    buf = fs.readFileSync(file)
  } catch (e) {
    return { ok: false, applied: false, reason: `读不到 ${info.file}：${e?.message ?? e}` }
  }
  const got = sha256(buf)
  if (got !== info.sha256) {
    return { ok: false, applied: false, reason: `补丁哈希不符：期望 ${info.sha256.slice(0, 12)}… 实得 ${got.slice(0, 12)}…` }
  }
  try {
    // --3way 让新增文件/上下文漂移也能落；失败再退回普通 apply。
    try {
      execFileSync('git', ['-C', targetDir, 'apply', '--3way', file], { stdio: 'pipe' })
    } catch {
      execFileSync('git', ['-C', targetDir, 'apply', file], { stdio: 'pipe' })
    }
    return { ok: true, applied: true, trackedFiles: info.trackedFiles ?? null, untrackedFiles: info.untrackedFiles ?? null }
  } catch (e) {
    return { ok: false, applied: false, reason: String(e?.stderr?.toString?.() || e?.message || e) }
  }
}

/**
 * 恢复工作区文档层（治理文档 + 门禁脚本 + 根目录白名单 .md）。
 *
 * 为什么这层也要恢复：项目不只是「代码 + 数据」。doc-00~07 里的工单、红线、
 * 知识库、交接，以及 scripts/ 的六门禁，是这套工程的**规则本身**。只恢复代码和
 * 数据，恢复出来的东西能跑，但不知道该怎么改、什么不能碰。
 *
 * 纪律同 restoreData：**只补不覆盖**（tar --skip-old-files）。软链原样解开
 * （doc-03-active 指向 doc-02-done 的那些链接必须还是链接，不能变成副本）。
 */
export function restoreWorkspace({ workspace, root = PACKAGE_ROOT, force = false } = {}) {
  const manifest = readSnapshotManifest(root)
  if (!manifest) {
    return { ok: false, reason: '插件包里没有快照清单' }
  }
  const info = manifest.workspace?.archive
  if (!info) {
    return { ok: false, reason: '快照里没有工作区文档层（生成时用了 --no-workspace）' }
  }
  if (!workspace) {
    return { ok: false, reason: '必须显式给工作区根目录' }
  }
  const tgz = path.join(root, 'snapshot', info.file)
  let buf
  try {
    buf = fs.readFileSync(tgz)
  } catch (e) {
    return { ok: false, reason: `读不到 ${info.file}：${e?.message ?? e}` }
  }
  const got = sha256(buf)
  if (got !== info.sha256) {
    return { ok: false, reason: `哈希不符：期望 ${info.sha256.slice(0, 12)}… 实得 ${got.slice(0, 12)}…` }
  }
  try {
    fs.mkdirSync(workspace, { recursive: true })
  } catch (e) {
    return { ok: false, reason: `工作区建不出来：${e?.message ?? e}` }
  }
  const args = ['-xzf', tgz, '-C', workspace, '--no-same-owner']
  if (!force) args.push('--skip-old-files')
  try {
    execFileSync('tar', args, { stdio: 'pipe' })
    return { ok: true, workspace, entries: manifest.workspace?.entries ?? null, force: !!force }
  } catch (e) {
    return { ok: false, reason: String(e?.stderr?.toString?.() || e?.message || e) }
  }
}

/**
 * 一键恢复：代码 + 数据 + 索引，能恢复多少恢复多少，逐层报告。
 * 这是验收口径对应的那个入口。
 */
export function restoreAll({ workspace, memDir, codeDir, root = PACKAGE_ROOT, force = false, withDocs = true } = {}) {
  const ws = path.resolve(workspace || process.cwd())
  const mem = path.resolve(memDir || path.join(ws, '.companion-memory'))
  const code = path.resolve(codeDir || path.join(ws, 'work', 'companion', 'companion-memory'))

  const layers = {}
  // 文档层先放：它只有 2MiB，且恢复后立刻就能读工单/红线，排障顺序更顺。
  if (withDocs) layers.docs = restoreWorkspace({ workspace: ws, root, force })
  layers.code = restoreCode({ targetDir: code, root, force })
  layers.data = restoreData({ memDir: mem, root, force, reindex: true })
  const ok = layers.data.ok
    && (layers.code.ok || layers.code.reason?.includes('目标已存在'))
    && (!withDocs || layers.docs.ok)
  return { ok, workspace: ws, memDir: mem, codeDir: code, layers }
}

/** vendor 里的记忆库内核（companion-memory/src 全量副本）。Node 22.12+ 可用 require() 加载 ESM。 */
const requireVendor = createRequire(import.meta.url)

function loadVendor() {
  return requireVendor(new URL('../vendor/index.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
}
