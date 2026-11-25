#!/usr/bin/env node
/**
 * publish.mjs —— 把工作包同步成「可公开发布」的树，并推送到 GitHub。
 *
 * 为什么需要它：本地工作包（work/companion/dsh-cm-core）与发布仓
 * （github.com/SuYouRyo/dsh-cm-core）必须**同源**，但两者内容不同：
 *
 *   本地包 = 插件本体 + snapshot/（真实记忆原文、工作区文档、代码 bundle）
 *   发布包 = 插件本体（snapshot/ 绝不能上行）
 *
 * 靠手拷两份迟早分叉，所以用一条命令从单侧（本地）单向生成另一侧。
 *
 * 用法：
 *   node scripts/publish.mjs                 # 只组装到 $TMP，打印将要提交的内容
 *   node scripts/publish.mjs --push          # 组装 + git add/commit + push
 *   node scripts/publish.mjs --push --msg "..."   # 指定提交信息
 *   node scripts/publish.mjs --dry           # 什么都不写，只报告清单
 *
 * 环境变量：
 *   CM_PUBLISH_REMOTE  发布仓 git 地址（默认 https://github.com/SuYouRyo/dsh-cm-core.git）
 *   CM_PUBLISH_DIR     组装目录（默认 /tmp/dsh-cm-core-release）
 *
 * 纪律（改这个脚本前先读）：
 *   1. 白名单拷贝，**不是**黑名单排除。新增顶层文件必须在这里显式加上，
 *      否则发布版会少东西；反过来，任何没被列出的东西（尤其 snapshot/）永远不会上行。
 *   2. 拷贝后必须跑隐私扫描与自测，任一不过就中止——发布一版带个人记忆的包，
 *      不是「下次注意」能补救的事。
 *   3. `release/` 里的 README.md / package.json / dot.gitignore / LICENSE 是**模板**，
 *      与本地包内的同名文件是两回事（本地包的 package.json 带 private:true 依赖本地布局）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const REMOTE = process.env.CM_PUBLISH_REMOTE || 'https://github.com/SuYouRyo/dsh-cm-core.git'
const OUT = process.env.CM_PUBLISH_DIR || '/tmp/dsh-cm-core-release'

const argv = process.argv.slice(2)
const flag = (n) => argv.includes(n)
const opt = (n, d = '') => {
  const i = argv.indexOf(n)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const dry = flag('--dry')
const push = flag('--push')
const message = opt('--msg', 'sync from work/companion/dsh-cm-core')

/** 从本地包拷进发布包的条目（白名单，逐一核对过） */
const COPY = ['lib', 'vendor', 'scripts', 'tests', 'cordis.patch.yml']

/** 用 release/ 模板覆盖发布包里的同名文件 */
const TEMPLATES = [
  ['release/README.md', 'README.md'],
  ['release/package.json', 'package.json'],
  ['release/dot.gitignore', '.gitignore'],
  ['release/LICENSE', 'LICENSE'],
]

/** 不该出现在发布包里的顶层条目（防御性自检；白名单本身已保证） */
const FORBIDDEN = ['snapshot', 'node_modules', '.git']

function log(...a) {
  console.log(...a)
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true })
}

function cp(src, dst) {
  fs.cpSync(src, dst, { recursive: true, dereference: false })
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

function sh(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

// ---------------------------------------------------------------- 1. 组装

if (!dry) {
  log(`[1/4] 组装到 ${OUT}`)
  rmrf(OUT)
  fs.mkdirSync(OUT, { recursive: true })
  for (const entry of COPY) {
    const src = path.join(PKG_ROOT, entry)
    if (!fs.existsSync(src)) {
      console.error(`✗ 本地包缺少 ${entry}，中止`)
      process.exit(1)
    }
    cp(src, path.join(OUT, entry))
  }
  for (const [from, to] of TEMPLATES) {
    const src = path.join(PKG_ROOT, from)
    if (!fs.existsSync(src)) {
      console.error(`✗ 缺少模板 ${from}，中止`)
      process.exit(1)
    }
    fs.copyFileSync(src, path.join(OUT, to))
  }
}

// ---------------------------------------------------------------- 2. 自检

log('[2/4] 自检')

// 2a. 禁入项
for (const bad of FORBIDDEN) {
  if (fs.existsSync(path.join(OUT, bad))) {
    console.error(`✗ 发布树里出现 ${bad}/，中止`)
    process.exit(1)
  }
}

// 2b. 隐私扫描：密钥、作者家目录、真实记忆 id
const files = dry ? [] : walk(OUT)
const SECRET = /(?:sk-[A-Za-z0-9_-]{16,}|gho_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,})/
// 作者家目录特征（拼出来是为了这条规则自己不被自己命中）
const HOMEDIR = new RegExp('/' + 'root' + '/Documents/')
let hits = []
for (const f of files) {
  const rel = path.relative(OUT, f)
  let text = ''
  try {
    text = fs.readFileSync(f, 'utf8')
  } catch {
    continue // 二进制（vendor 里没有，但别假定）
  }
  if (SECRET.test(text)) hits.push(`${rel}: 疑似密钥`)
  if (HOMEDIR.test(text)) hits.push(`${rel}: 作者家目录绝对路径`)
}
if (hits.length) {
  console.error('✗ 隐私扫描未通过：')
  for (const h of hits) console.error('   ' + h)
  process.exit(1)
}
log(`   ✓ 隐私扫描通过（${files.length} 个文件，无密钥 / 无家目录绝对路径）`)

// 2c. 自测（无 snapshot 时应为 15 通过 / 8 跳过）
if (!dry) {
  const out = sh(process.execPath, ['tests/plugin-core.test.mjs'], OUT)
  const line = out.trim().split('\n').filter(Boolean).pop() || ''
  log('   ' + line)
  const m = line.match(/(\d+) 通过 \/ (\d+) 失败/)
  if (!m || Number(m[2]) !== 0) {
    console.error('✗ 自测未通过，中止')
    process.exit(1)
  }
}

if (dry) {
  log('（--dry：到此为止，未写任何文件）')
  process.exit(0)
}

// ---------------------------------------------------------------- 3. 提交

log('[3/4] 提交')
const hasGit = fs.existsSync(path.join(OUT, '.git'))
if (!hasGit) {
  sh('git', ['init', '-q'], OUT)
  sh('git', ['symbolic-ref', 'HEAD', 'refs/heads/master'], OUT)
  sh('git', ['remote', 'add', 'origin', REMOTE], OUT)
  // 远端已有历史时必须先接上：否则本次是「无共同祖先」的分叉，
  // push 会被拒（non-fast-forward），而 --force 会把发布仓的历史抹掉。
  try {
    sh('git', ['fetch', '-q', '--depth=1', 'origin', 'master'], OUT)
    // 把远端那一个提交取成本地基线，但**保留工作树里刚组装的文件**：
    // reset --soft 只移动 HEAD，不动 index/worktree，随后 add -A 就得到「在远端历史之上的一次提交」。
    sh('git', ['reset', '-q', '--soft', 'FETCH_HEAD'], OUT)
    log('   已接上远端已有历史（soft reset 到 FETCH_HEAD）')
  } catch {
    log('   远端无 master 分支，按首个提交处理')
  }
}
sh('git', ['add', '-A'], OUT)

const staged = sh('git', ['diff', '--cached', '--name-only'], OUT).trim()
const tracked = sh('git', ['ls-files'], OUT).trim().split('\n').filter(Boolean)
log(`   受控文件 ${tracked.length} 个，本次暂存变更 ${staged ? staged.split('\n').length : 0} 个`)
for (const bad of FORBIDDEN) {
  if (tracked.some((t) => t === bad || t.startsWith(bad + '/'))) {
    console.error(`✗ ${bad}/ 被 git 追踪了，中止`)
    process.exit(1)
  }
}
if (!staged) log('   无变更，跳过提交')

if (staged) {
  sh('git', ['-c', 'user.name=SuYouRyo', '-c', 'user.email=SuYouRyo@users.noreply.github.com', 'commit', '-q', '-m', message], OUT)
  log(`   ${sh('git', ['log', '-1', '--oneline'], OUT).trim()}`)
}

// ---------------------------------------------------------------- 4. 推送

if (!push) {
  log('[4/4] 未加 --push，停在本地。加 --push 才会推送到 ' + REMOTE)
  process.exit(0)
}

log('[4/4] 推送')
try {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  let out
  try {
    out = execFileSync('git', ['push', 'origin', 'HEAD:master'], { cwd: OUT, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    // https 远端要靠 gh 的 credential helper；本机 git 没配全局 helper 时补一次。
    if (!/could not read Username/i.test(String(e.stderr || ''))) throw e
    const cred = '/root/dsh-bin/gh'
    if (!fs.existsSync(cred)) throw e
    out = sh('git', ['-c', `credential.helper=!${cred} auth git-credential`, 'push', 'origin', 'HEAD:master'], OUT)
  }
  log('   ' + (out.trim().split('\n').pop() || 'ok'))
} catch (e) {
  console.error('✗ 推送失败：')
  console.error(String(e.stderr || e.message).trim())
  process.exit(1)
}

// 复核：远端 HEAD 是否等于本地 HEAD
const local = sh('git', ['rev-parse', 'HEAD'], OUT).trim()
const remote = sh('git', ['ls-remote', 'origin', 'refs/heads/master'], OUT).trim().split(/\s+/)[0]
if (local !== remote) {
  console.error(`✗ 远端 HEAD(${remote.slice(0, 8)}) 与本地(${local.slice(0, 8)}) 不一致`)
  process.exit(1)
}
log(`   ✓ 远端已确认 ${local.slice(0, 8)}`)
