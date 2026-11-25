#!/usr/bin/env node
/**
 * make-snapshot —— 把「当前这台机器的完整项目状态」压成插件能自带的快照。
 *
 * 为什么要这个：验收标准是「数据全面丢失时，只通过一个插件就完全恢复我们的项目」。
 * 插件要能恢复，就必须**自带**恢复原料，不能假设原仓还在。这个脚本就是
 * 把原料（代码全历史 + 记忆库数据 + 会话记录）打成一个可校验的 snapshot/。
 *
 * 产出（都是插件包内相对路径，装到任何机器上都在）：
 *   snapshot/manifest.json          清单（版本、生成时间、每个文件的 sha256/大小/来源）
 *   snapshot/code.bundle            companion-memory 代码仓全历史 git bundle
 *   snapshot/data/*.gz             记忆库数据（原文层 + 印象层 + 落定表 + 墓碑）
 *   snapshot/workspace.tgz          工作区文档层（doc-00~07 + scripts/ + 根 .md 白名单）
 *   snapshot/sessions/*.jsonl.gz   可选：DSH 会话原文（不放进插件包时留空，恢复靠 ingest 现场扫）
 *
 * 「完全恢复我们的项目」不只是库数据 + 代码仓：项目还有一层**治理文档**
 * （12 个物理目录里的状态流文档、六门禁脚本、根目录 6 份白名单 .md）。
 * 少了这层，恢复出来的只是一堆代码和数据，规范、工单、红线全没了。
 * 所以单独打一个 workspace.tgz —— 用 tar 是因为里面有 88 条软链（doc-03-active
 * 全是指向 doc-02-done 的软链），必须原样保留链接关系，不能 follow。
 *
 * 用法：
 *   node scripts/make-snapshot.mjs [--repo <代码仓>] [--mem <数据仓>] [--out <目录>]
 *                                  [--ws <工作区根>] [--no-workspace]
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(HERE, '..')

/** 要从记忆库里带走的数据文件（相对数据仓根）。前面的路径必须存在，否则跳过并记警告。 */
const DATA_FILES = [
  'raw/events/2026-10.jsonl',
  'raw/events/2026-11.jsonl',
  'impressions/impressions.jsonl',
  'impressions/impressions-life.jsonl',
  'raw/session-scope.jsonl',
  'raw/session-scope-life.jsonl',
  'raw/tombstones.txt',
  'raw/handoff-notes.jsonl',
  'raw/recall-archive.jsonl',
  'emotion-feed.json',
  'emotion-lastax.json',
  // 移交标记（WO-069）：没有它，恢复出来的机器上 cm-agents.js 会重新把静态
  // CM 段写回 AGENTS.md，于是同一份记忆又有两个渲染器 —— 恢复出来的项目
  // 会悄悄退回移交前的状态。它必须跟着数据一起走。
  'plugin-took-over.json',
]

/** 工作区里要带走的文档层（相对工作区根）。只收治理/规范，不收产物与运行数据。 */
const WS_PATHS = [
  'doc-00-inbox',
  'doc-01-backlog',
  'doc-02-done',
  'doc-03-active',
  'doc-04-wontdo',
  'doc-05-redline',
  'doc-06-context',
  'doc-07-handoff',
  'scripts',
  'AGENTS.md',
  'AGENTS.work.md',
  'AGENTS.life.md',
  'AGENTS.md.work',
  'README.md',
  'MOVED-TO.md',
]

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}

/**
 * 默认路径**不写死作者的家目录**（否则别人 clone 下来跑必炸）。
 * 优先级：命令行参数 → 环境变量 → 从本包往上探测。
 *   --repo / CM_REPO   代码仓
 *   --mem  / CM_DIR    记忆库数据目录
 *   --ws   / CM_WORKSPACE 工作区根
 * 探测不到的层会记进 manifest.notes 并跳过，不中断整份快照。
 */
function findUp(marker, start = PACKAGE_ROOT) {
  let dir = path.resolve(start)
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, marker))) return dir
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return ''
}

const wsGuess = process.env.CM_WORKSPACE || findUp('.companion-memory') || findUp('doc-02-done') || ''
const repoDefault = wsGuess ? path.join(wsGuess, 'work/companion/companion-memory') : ''
const repo = arg('repo', process.env.CM_REPO || repoDefault) ? path.resolve(arg('repo', process.env.CM_REPO || repoDefault)) : ''
const mem = path.resolve(arg('mem', process.env.CM_DIR || (wsGuess ? path.join(wsGuess, '.companion-memory') : path.join(PACKAGE_ROOT, '.companion-memory'))))
const out = path.resolve(arg('out', path.join(PACKAGE_ROOT, 'snapshot')))
const ws = path.resolve(arg('ws', wsGuess || PACKAGE_ROOT))
const withWorkspace = !process.argv.includes('--no-workspace')

fs.mkdirSync(path.join(out, 'data'), { recursive: true })

const manifest = {
  format: 'dsh-cm-core-snapshot/1',
  generatedAt: new Date().toISOString(),
  repo: { path: repo, commit: null, bundle: null },
  data: { path: mem, files: [] },
  workspace: { path: ws, archive: null, entries: null },
  notes: [],
}

// ---- 1. 代码仓 → git bundle（全历史，一个文件就是完整仓）----
if (!repo) {
  manifest.notes.push('未找到代码仓（用 --repo 或 CM_REPO 指定；发布版不带代码快照时属正常）')
} else if (fs.existsSync(path.join(repo, '.git'))) {
  try {
    manifest.repo.commit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch { /* 不是 git 仓就只记路径 */ }
  const bundlePath = path.join(out, 'code.bundle')
  try {
    execFileSync('git', ['-C', repo, 'bundle', 'create', bundlePath, '--all'], { stdio: 'pipe' })
    const buf = fs.readFileSync(bundlePath)
    manifest.repo.bundle = { file: 'code.bundle', bytes: buf.length, sha256: sha256(buf) }
  } catch (e) {
    manifest.notes.push(`git bundle 失败：${String(e?.message ?? e)}`)
  }

  // 工作区未提交改动也要带走：git bundle 只打已提交内容，而「当前这台机器的真实
  // 状态」包含正在改的东西（例如 11/4 红线的两个修复）。少这一层，恢复出来的代码
  // 会悄悄退回到修复前的行为 —— 这比不恢复更危险，因为看起来一切正常。
  try {
    const tracked = execFileSync('git', ['-C', repo, 'diff', 'HEAD'], { encoding: 'utf8', maxBuffer: 1 << 26 })
    const untracked = execFileSync('git', ['-C', repo, 'ls-files', '-o', '--exclude-standard'], { encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean)
    let patch = tracked
    for (const rel of untracked) {
      try {
        patch += execFileSync('git', ['-C', repo, 'diff', '--no-index', '--', '/dev/null', rel], { encoding: 'utf8', maxBuffer: 1 << 26 })
      } catch (e) {
        // --no-index 有差异时退出码为 1，stdout 才是我们要的补丁
        patch += String(e?.stdout ?? '')
      }
    }
    if (patch.trim()) {
      const pbuf = Buffer.from(patch, 'utf8')
      fs.writeFileSync(path.join(out, 'code-worktree.patch'), pbuf)
      manifest.repo.worktree = {
        file: 'code-worktree.patch',
        bytes: pbuf.length,
        sha256: sha256(pbuf),
        trackedFiles: tracked ? execFileSync('git', ['-C', repo, 'diff', '--name-only', 'HEAD'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length : 0,
        untrackedFiles: untracked.length,
      }
    }
  } catch (e) {
    manifest.notes.push(`工作区改动导出失败：${String(e?.message ?? e)}`)
  }
} else {
  manifest.notes.push(`代码仓不存在或不是 git 仓：${repo}`)
}

// ---- 2. 记忆库数据 → gzip ----
for (const rel of DATA_FILES) {
  const abs = path.join(mem, rel)
  let buf
  try {
    buf = fs.readFileSync(abs)
  } catch {
    continue // 没有就跳过：life 层在某些机器上本来就没有
  }
  const gz = execFileSync('gzip', ['-9', '-c'], { input: buf, maxBuffer: 1 << 30 })
  const name = rel.split(path.sep).join('_') + '.gz'
  fs.writeFileSync(path.join(out, 'data', name), gz)
  manifest.data.files.push({
    file: `data/${name}`,
    from: rel,
    bytes: gz.length,
    rawBytes: buf.length,
    sha256: sha256(buf), // 校验的是**解压后**的原文，gzip 容器本身可变
  })
}

// ---- 3. 工作区文档层 → tar.gz（保留软链，不 follow）----
if (withWorkspace) {
  if (!fs.existsSync(ws)) {
    manifest.notes.push(`工作区不存在：${ws}`)
  } else {
    const present = WS_PATHS.filter((p) => fs.existsSync(path.join(ws, p)))
    const missing = WS_PATHS.filter((p) => !present.includes(p))
    if (missing.length) manifest.notes.push(`工作区缺少（已跳过）：${missing.join(', ')}`)
    const tgz = path.join(out, 'workspace.tgz')
    try {
      // --no-recursion 之外的损坏软链：GNU tar 遇到断链会报警但仍照原样记录链接目标，
      // 这正是我们要的（doc-03-active 的软链本来就指向 doc-02-done）。
      execFileSync('tar', ['--exclude=._*', '-czf', tgz, '-C', ws, ...present], { stdio: 'pipe' })
      const buf = fs.readFileSync(tgz)
      const listing = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' }).trim().split('\n')
      manifest.workspace.archive = { file: 'workspace.tgz', bytes: buf.length, sha256: sha256(buf) }
      manifest.workspace.entries = listing.length
      manifest.workspace.paths = present
    } catch (e) {
      manifest.notes.push(`工作区打包失败：${String(e?.message ?? e)}`)
    }
  }
} else {
  manifest.notes.push('已用 --no-workspace 跳过工作区文档层')
}

fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`✓ snapshot 写入 ${out}`)
console.log(`  代码提交 ${manifest.repo.commit || '(未知)'} · bundle ${manifest.repo.bundle ? (manifest.repo.bundle.bytes / 1048576).toFixed(2) + ' MiB' : '无'}`)
console.log(`  数据文件 ${manifest.data.files.length} 个，原始 ${(manifest.data.files.reduce((a, f) => a + f.rawBytes, 0) / 1048576).toFixed(1)} MiB`)
console.log(`  工作区文档层 ${manifest.workspace.archive ? (manifest.workspace.archive.bytes / 1048576).toFixed(2) + ' MiB / ' + manifest.workspace.entries + ' 条目' : '无'}`)
if (manifest.notes.length) for (const n of manifest.notes) console.log(`  ! ${n}`)
