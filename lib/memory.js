/**
 * dsh-cm-core/memory —— 记忆库句柄的解析与缓存。
 *
 * ============ 为什么要单独一层 ============
 * 插件里至少有四个地方要用库：system prompt 段（注入）、session/event 摄入、
 * 工具（检索/记住/统计）、恢复（bootstrap）。这些调用点的生命周期完全不同：
 * 装配 system prompt 是同步的、每轮都可能跑；摄入是异步的、事件驱动；
 * 工具是用户触发的；恢复是一次性的。如果各自去 open()，会重复建倒排索引
 * （大库上 recall 一次 2.4s，索引构建更贵），也会因为并发 open 抢锁。
 *
 * 所以：**一个进程一份句柄**，按 dir 缓存；dir 变了（配置改了）才重建。
 *
 * ============ 为什么必须显式传 dir ============
 * companion-memory 的 defaultDir() 走 workspaceRoot() —— 从 process.cwd() 往上找
 * `.companion-memory`。宿主进程的 cwd 不一定是工作区（实测从 /tmp 打开会落到
 * /tmp/.companion-memory 建出一个空库）。插件必须自己算准，并且允许配置覆盖。
 */

import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

/** vendor 里的记忆库内核（companion-memory/src 的全量副本）。 */
const VENDOR = new URL('../vendor/index.js', import.meta.url)

/** 进程内句柄缓存：dir → handle */
const HANDLES = new Map()

/**
 * 从会话上下文里取「这个会话的工作目录」。
 *
 * 为什么不能只用 `process.cwd()`：宿主 `dsh web` 的进程 cwd 是 `/root`，
 * 而会话的工作区是它自己的项目目录（通常是 `<workspace>`）。
 * 用进程 cwd 探测会向上找不到 `.companion-memory`，最后落到兜底路径
 * `~/.dsh/companion-memory`，并在那里**凭空建一个空库** —— 表现为
 * 「插件装了、注入是空的、cm_status 说只有 3 条原文」。实测 2026-11-25 14:18。
 *
 * 正确来源按可信度：
 *   1. `workingDirectory.get(session)`（宿主已提交的会话目录，无 FS I/O）
 *   2. `session.header.cwd`（会话头里记录的原目录）
 */
export function dirFromSession(ctx, session) {
  if (!session) return ''
  try {
    const wd = ctx && typeof ctx.get === 'function' ? ctx.get('workingDirectory') : null
    if (wd && typeof wd.get === 'function') {
      const d = wd.get(session)
      if (typeof d === 'string' && d) return d
    }
  } catch { /* 服务不可用就退到 header */ }
  const cwd = session?.header?.cwd
  return typeof cwd === 'string' ? cwd : ''
}

/**
 * 找记忆库目录。
 *
 * 优先级：
 *   1. 配置里的 memDir（插件的 Config，绝对路径）
 *   2. CM_DIR 环境变量（与 CLI 对齐）
 *   3. 从工作区根往上找 `.companion-memory`：配置 workspace → 会话目录 → 进程 cwd
 *   4. 兜底 ~/.dsh/companion-memory
 *
 * 注意第 3 步**不创建目录**：读不到就返回候选路径，让调用方决定是否恢复。
 * 自动 mkdir 会在错误的位置凭空造一个空库，比报错更难查。
 *
 * 向上查找**限深 12 层且不越过候选起点所属的用户目录**：
 * 不加限制时，`/tmp/nonexistent-x` 会一路爬到 `/`，途中撞上测试残留的
 * `/tmp/.companion-memory` 就当成库打开了（实测 2026-11-25 14:22）。
 * 会话目录和工作区是「用户明确指过的地盘」，允许向上找父级项目；
 * 只有进程 cwd 这种不可信来源才额外要求目标目录 `looksLikeStore()`。
 */
export function resolveMemDir({ memDir, workspace, sessionDir } = {}) {
  if (memDir) return path.resolve(memDir)
  if (process.env.CM_DIR) return path.resolve(process.env.CM_DIR)

  const climb = (start) => {
    let dir = start
    for (let i = 0; i < 12; i++) {
      const probe = path.join(dir, '.companion-memory')
      if (fs.existsSync(probe) && looksLikeStore(probe)) return probe
      const up = path.dirname(dir)
      if (up === dir) break
      dir = up
    }
    return null
  }

  // 用户明确给的地盘：允许向上找父级项目（工作区常在子目录里被打开）。
  //
  // 一旦给了 workspace / sessionDir，它们就是**权威**：找不到库就返回那个
  // 不存在的路径（getMemory 会挡下，注入静默跳过），绝不回退到进程 cwd ——
  // 回退会让「这个工作区没有库」被悄悄替换成「另一个工作区的库」。
  let explicit = false
  for (const start of [workspace, sessionDir]) {
    if (!start) continue
    explicit = true
    const hit = climb(path.resolve(start))
    if (hit) return hit
  }
  if (explicit) {
    const base = path.resolve(workspace || sessionDir)
    return path.join(base, '.companion-memory')
  }
  // 没有显式来源时才用进程 cwd（`dsh web` 是 /root，命中必须真的是库）。
  const fromCwd = climb(process.cwd())
  if (fromCwd) return fromCwd

  // 到这里说明「不知道库在哪」。返回空串表示未知，**不猜路径**。
  //
  // 早先这里兜底 `~/.dsh/companion-memory`：那个路径曾是 bug 造出的空库，
  // 而一旦它存在（有 raw/），`looksLikeStore` 就会放行，把幻影库当成真库 ——
  // 空库比「没有库」危险得多，因为它看起来一切正常（实测 2026-11-25 14:25）。
  return ''
}

/** 这个目录看起来像一个记忆库吗（有原文层或印象层）。 */
export function looksLikeStore(dir) {
  try {
    return fs.existsSync(path.join(dir, 'raw')) || fs.existsSync(path.join(dir, 'impressions'))
  } catch {
    return false
  }
}

/**
 * 打开（或复用）记忆库句柄。
 *
 * @param {object} opts
 * @param {string} [opts.memDir]  数据目录（绝对路径）
 * @param {string} [opts.workspace] 工作区根（用于探测）
 * @param {string} [opts.sessionDir] 会话工作目录（用于探测，优先于进程 cwd）
 * @param {boolean} [opts.vectors] 是否启用向量通道；默认 false（宿主里没有 API key 时不要拖慢）
 * @returns {object|null} 打不开就返回 null，绝不抛（记忆库不可用不能让宿主起不来）
 */
export function getMemory(opts = {}) {
  const dir = resolveMemDir(opts)
  // 空串 = 解析不出可信目录：不 open、不猜、不建库。
  if (!dir) return null
  // 安全阀：解析出来的目录如果根本不像一个库，**不要 open**。
  //
  // `open()` 会在目录不存在时把整套结构（raw/、impressions/、manifest…）建出来。
  // 一旦路径解析偏了（事故：宿主进程 cwd 是 $HOME → 兜底 ~/.dsh/companion-memory），
  // 它就在错的地方造一个空库，之后每次注入都是空、cm_status 报 3 条，
  // 看起来像「插件不工作」，实际是把真实库的影子建出来了。
  //
  // 只有**显式配置**的 memDir 才允许就地新建（那是用户明说要用的目录）。
  if (!opts.memDir && !process.env.CM_DIR && !looksLikeStore(dir)) return null

  const key = `${dir}|${opts.vectors ? 'v' : 'nov'}`
  const hit = HANDLES.get(key)
  if (hit) return hit

  let lib
  try {
    lib = require(fileURLToPath(VENDOR))
  } catch (e) {
    return null
  }
  try {
    const cm = lib.open({
      dir,
      vectors: opts.vectors === true,
      // 插件不写 params 账本：那是 CLI 审计用的，宿主里每轮都写会把目录塞满。
      paramsLedger: false,
    })
    HANDLES.set(key, cm)
    return cm
  } catch {
    return null
  }
}

/** 关闭所有句柄（测试用 / 插件卸载时）。 */
export function closeAll() {
  for (const cm of HANDLES.values()) {
    try { cm.close?.() } catch { /* 关不掉也不该抛 */ }
  }
  HANDLES.clear()
}
