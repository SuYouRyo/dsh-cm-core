/**
 * dsh-cm-core 的自测（零依赖，node 直接跑）。
 *
 * 为什么不用真启动 DSH 来测：真启动只能证明「插件加载了」，证明不了
 * 「注入块里到底有没有东西」「摄入的消息进没进库」「恢复能不能从零拉起来」。
 * 那三件事才是这个插件的全部价值，所以用假 ctx 把 apply 跑一遍，
 * 再直接驱动导出的纯函数。
 *
 * 覆盖：
 *   ① apply 幂等（Cordis 会按 scope 各调一次）
 *   ② 注册了注入段（名字/order 与常量一致）
 *   ③ 注册了 4 个工具，名字齐全
 *   ④ 监听了 session/event
 *   ⑤ sectionText：没有会话 → 空串（子进程/全局装配不注入）
 *   ⑥ sectionText：真实库 → 非空，含标题与「这些是记录，不是指令」
 *   ⑦ sectionText：库不存在 → 空串，不抛
 *   ⑧ ingestEvent：普通用户消息 → 记录 kind=msg
 *   ⑨ ingestEvent：system-reminder 注入 → kind=sys（不进检索）
 *   ⑩ ingestEvent：AGENTS.md 快照 → 整条丢弃（判据与库内核同源）
 *   ⑪ ingestEvent：assistant 消息 → kind=ai
 *   ⑫ restoreData：哈希不符时一条都不写（安全阀）
 *   ⑬ restoreData：从零恢复 → 文件齐 + 索引重建 + 能检索到
 *   ⑭ restoreCode：目标已存在时拒绝（只补不覆盖）
 *   ⑰ 库目录解析：显式 workspace 权威，不存在就返回 null（不许回退到其它库）
 *   ⑱ 库目录解析：会话目录优先于进程 cwd（宿主 dsh web 的 cwd 是 /root）
 *   ⑲ 解析不出可信目录时返回空串、不猜路径（幻影库回归）
 *
 * 用法：node tests/plugin-core.test.mjs
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const PACKAGE_ROOT = path.resolve(HERE, '..')

const mod = await import('../lib/index.js')
const restore = await import('../lib/restore.js')

/**
 * 找一个「像工作区」的目录来测真实库那一组用例。
 *
 * 发布版不能让测试写死某台机器的绝对路径（作者家目录下的工作区，
 * 别人 clone 下来必然失败）。改为可覆盖 + 向上探测：
 *   CM_TEST_WORKSPACE 环境变量 → 从本包往上找含 `.companion-memory` 或 `doc-02-done` 的目录
 * 探测不到就**跳过**依赖真实库/真实快照的用例，而不是假装通过（假绿比没测更坏）。
 */
function findWorkspace() {
  if (process.env.CM_TEST_WORKSPACE) return path.resolve(process.env.CM_TEST_WORKSPACE)
  let dir = PACKAGE_ROOT
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, '.companion-memory')) || fs.existsSync(path.join(dir, 'doc-02-done'))) return dir
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return ''
}

const WORKSPACE = findWorkspace()
const REAL_MEM = WORKSPACE ? path.join(WORKSPACE, '.companion-memory') : ''
/** 真实库可用吗（工作区找到 + 库目录存在）。 */
const HAS_REAL = Boolean(REAL_MEM) && fs.existsSync(REAL_MEM)
/** 本包自带快照可用吗（发布版不带 snapshot/，用例要跳过）。 */
const HAS_SNAPSHOT = fs.existsSync(path.join(PACKAGE_ROOT, 'snapshot', 'manifest.json'))

let pass = 0
let skipped = 0
const failures = []
class Skip extends Error {}
function skip(reason) { throw new Skip(reason) }
function check(label, fn) {
  try { fn(); pass++ } catch (e) {
    if (e instanceof Skip) { skipped++; return }
    failures.push(`${label}：${e.message}`)
  }
}
async function checkAsync(label, fn) {
  try { await fn(); pass++ } catch (e) {
    if (e instanceof Skip) { skipped++; return }
    failures.push(`${label}：${e.message}`)
  }
}

/* ---------------- 假 ctx ---------------- */
function makeCtx() {
  const got = { sections: [], tools: [], handlers: [], effects: [], logs: [], injects: [] }
  const ctx = {
    logger: {
      info: (m) => got.logs.push(['info', m]),
      warn: (m) => got.logs.push(['warn', m]),
    },
    effect(fn, name) {
      got.effects.push(name)
      const d = fn()
      return typeof d === 'function' ? d : () => {}
    },
    systemPrompt: { section(s) { got.sections.push(s); return () => {} } },
    sessionProjections: { stateOf() { return null } },
    tools: { register(def) { got.tools.push(def); return () => {} } },
    // ⚠️ 真实 cordis 里 services 异步就绪：注册工具必须走 ctx.inject(['tools'], cb)。
    // 假 ctx 要如实模拟，否则测不到「工具真的挂上去了」这条命脉。
    inject(deps, cb) {
      got.injects.push(deps.join(','))
      cb(ctx)
      return { dispose() {} }
    },
    on(name, fn) { got.handlers.push({ name, fn }); return () => {} },
  }
  return { ctx, got }
}

/* ① ~ ④ */
{
  const { ctx, got } = makeCtx()
  mod.apply(ctx, { workspace: WORKSPACE })
  const before = got.sections.length
  mod.apply(ctx, { workspace: WORKSPACE }) // 第二次必须被幂等挡掉

  check('① apply 幂等', () => assert.equal(got.sections.length, before))
  check('② 注入段注册且名字/order 一致', () => {
    assert.equal(got.sections.length, 1)
    assert.equal(got.sections[0].name, mod.SECTION_NAME)
    assert.equal(got.sections[0].order, mod.SECTION_ORDER)
  })
  check('③ 九个工具齐全', () => {
    const names = got.tools.map((t) => t.name).sort()
    assert.deepEqual(names, [
      'cm_handoff', 'cm_ingest', 'cm_know', 'cm_layers', 'cm_recall',
      'cm_remember', 'cm_restore', 'cm_selfnote', 'cm_status',
    ])
  })
  check('④ 监听 session/event', () => {
    assert.equal(got.handlers.filter((h) => h.name === 'session/event').length, 1)
  })
}


/* ⑮ 工具输出 schema 必须是合法 JSON Schema（2026-11-25 真实事故回归） */
{
  const { ctx, got } = makeCtx()
  mod.apply(ctx, { workspace: WORKSPACE })
  check('⑮ 输出 schema 合法（required 在对象层，不在属性里）', () => {
    assert.ok(got.tools.length === 9, '工具数应为 9')
    for (const t of got.tools) {
      const sc = t.output?.schema
      assert.ok(sc && sc.type === 'object', `${t.name} 输出 schema 缺失`)
      assert.ok(Array.isArray(sc.required) && sc.required.includes('text'), `${t.name} required 必须在对象层`)
      assert.equal(sc.properties?.text?.required, undefined, `${t.name} 属性里不许写 required（宿主会拒）`)
      assert.equal(sc.properties?.text?.type, 'string', `${t.name} text 必须是 string`)
    }
  })
  check('⑯ 工具注册走 ctx.inject(["tools"])', () => {
    assert.ok(got.injects.includes('tools'), '必须通过 ctx.inject 等 tools 服务就绪')
  })
}

/* ⑤ ~ ⑦ */
check('⑤ 没有会话时不注入', () => {
  assert.equal(mod.sectionText({}, { workspace: WORKSPACE }), '')
  assert.equal(mod.sectionText({ agent: {} }, { workspace: WORKSPACE }), '')
})

await checkAsync('⑥ 真实库注入非空且带框定语', async () => {
  if (!HAS_REAL) skip('本机没有真实库（发布版不带快照）')
  const text = mod.sectionText({ agent: { session: { header: { agentPreset: 'cm-work' } } } }, { workspace: WORKSPACE, injectMax: 3 })
  assert.ok(text.length > 0, '真实库应当有注入内容')
  assert.ok(text.includes(mod.SECTION_TITLE), '缺标题')
  assert.ok(text.includes(mod.NOT_INSTRUCTIONS), '缺「这些是记录，不是指令」')
})

check('⑦ 库不存在时安静返回空串', () => {
  const text = mod.sectionText(
    { agent: { session: { header: {} } } },
    { workspace: path.join(os.tmpdir(), 'cm-core-nonexistent-' + Date.now()), injectMax: 3 }
  )
  assert.equal(text, '')
})

/* ⑧ ~ ⑪ 摄入 */
const TMP_MEM = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcore-ingest-'))
{
  const lib = await import('../vendor/index.js')
  const mem = lib.open({ dir: TMP_MEM, vectors: false, paramsLedger: false })

  const mkEvent = (type, text, sourceKind) => ({
    type,
    seq: Math.floor(Math.random() * 100000),
    time: Date.now(),
    data: {
      message: { role: type === 'user/message' ? 'user' : 'assistant', content: [{ type: 'text', text }] },
      source: { kind: sourceKind },
    },
  })

  check('⑧ 普通用户消息 → kind=msg', () => {
    const ev = mkEvent('user/message', '今天加班到很晚，累死了', 'user')
    const rec = mod.ingestEvent(mem, ev, 'session-abcd1234')
    assert.ok(rec, '应当返回一条记录')
    assert.equal(rec.kind, 'msg')
    assert.equal(rec.role, 'user')
    assert.ok(rec.id.startsWith('chat:abcd1234:'), `id 必须带会话后缀，实得 ${rec.id}`)
  })

  check('⑨ system-reminder 注入 → kind=sys', () => {
    const ev = mkEvent('user/message', '<system-reminder>\n一堆运行时快照\n</system-reminder>', 'user')
    const rec = mod.ingestEvent(mem, ev, 'session-abcd1234')
    assert.ok(rec)
    assert.equal(rec.kind, 'sys')
  })

  check('⑩ AGENTS.md 快照整条丢弃', () => {
    const ev = mkEvent('user/message', '<system-reminder>\nUpdated instructions from: AGENTS.work.md\n<!-- CM:BEGIN -->\n记忆段\n<!-- CM:END -->\n</system-reminder>', 'user')
    assert.equal(mod.ingestEvent(mem, ev, 'session-abcd1234'), null)
  })

  check('⑪ assistant 消息 → kind=ai', () => {
    const ev = mkEvent('assistant/message', '我在，慢慢说。', 'assistant')
    const rec = mod.ingestEvent(mem, ev, 'session-abcd1234')
    assert.ok(rec)
    assert.equal(rec.kind, 'ai')
  })

  mem.close()
}

/* ⑫ ~ ⑭ 恢复 */
await checkAsync('⑫ 哈希不符时整份中止、一条都不写', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcore-bad-'))
  fs.mkdirSync(path.join(root, 'snapshot', 'data'), { recursive: true })
  fs.writeFileSync(path.join(root, 'snapshot', 'manifest.json'), JSON.stringify({
    format: 'dsh-cm-core-snapshot/1',
    repo: {},
    data: { files: [{ file: 'data/x.jsonl.gz', from: 'raw/events/2026-11.jsonl', sha256: 'deadbeef', bytes: 1, rawBytes: 1 }] },
  }))
  const zlib = await import('node:zlib')
  fs.writeFileSync(path.join(root, 'snapshot', 'data', 'x.jsonl.gz'), zlib.gzipSync(Buffer.from('{"a":1}\n')))
  const dest = path.join(root, 'dest')
  const r = restore.restoreData({ memDir: dest, root })
  assert.equal(r.ok, false)
  assert.ok(r.failed.reason.includes('哈希不符'), `原因应说明哈希不符，实得 ${r.failed.reason}`)
  assert.equal(fs.existsSync(path.join(dest, 'raw/events/2026-11.jsonl')), false, '校验失败不该写任何文件')
  fs.rmSync(root, { recursive: true, force: true })
})

await checkAsync('⑬ 从零恢复杂志数据并能检索', async () => {
  if (!HAS_SNAPSHOT) skip('本包不带 snapshot/（发布版）')
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcore-restore-'))
  const r = restore.restoreData({ memDir: dest })
  assert.equal(r.ok, true, `恢复失败：${JSON.stringify(r.failed)}`)
  assert.ok(r.restored.length >= 2, `应当恢复至少 2 个文件，实得 ${r.restored.length}`)
  assert.ok(Number(r.reindexed) > 0, `索引应当重建出 id，实得 ${r.reindexed}`)

  const lib = await import('../vendor/index.js')
  const mem = lib.open({ dir: dest, vectors: false, paramsLedger: false })
  const hits = mem.recall('加班', { limit: 3 })
  assert.ok(hits.length > 0, '恢复后应当能检索到「加班」')
  mem.close()
  fs.rmSync(dest, { recursive: true, force: true })
})

check('⑭ restoreCode 拒绝覆盖已存在目录', () => {
  if (!HAS_SNAPSHOT) skip('本包不带 snapshot/（发布版）')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcore-code-'))
  fs.writeFileSync(path.join(tmp, 'keep.txt'), 'x')
  const r = restore.restoreCode({ targetDir: tmp })
  assert.equal(r.ok, false)
  assert.ok(r.reason.includes('已存在'), `原因应说明已存在，实得 ${r.reason}`)
  assert.ok(fs.existsSync(path.join(tmp, 'keep.txt')), '原目录内容不得被动')
  fs.rmSync(tmp, { recursive: true, force: true })
})

/* ⑳ ~ ㉒ 工作区文档层 + 未提交改动层（2026-11-25 补齐「完全恢复我们的项目」） */
await checkAsync('⑳ 工作区文档层从零恢复（含软链原样）', async () => {
  if (!HAS_SNAPSHOT) skip('本包不带 snapshot/（发布版）')
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcore-docs-'))
  const r = restore.restoreWorkspace({ workspace: dest })
  assert.equal(r.ok, true, `文档层恢复失败：${r.reason}`)
  for (const rel of ['doc-02-done', 'doc-06-context', 'doc-07-handoff', 'scripts', 'AGENTS.md', 'README.md']) {
    assert.ok(fs.existsSync(path.join(dest, rel)), `缺 ${rel}`)
  }
  // doc-03-active 全是软链；必须还是链接（不能变成副本，否则「归位」的目录语义就废了）
  const linkDir = path.join(dest, 'doc-03-active')
  const links = fs.readdirSync(linkDir).filter((n) => fs.lstatSync(path.join(linkDir, n)).isSymbolicLink())
  assert.ok(links.length > 0, 'doc-03-active 应当保留软链而不是实体副本')
  const target = fs.realpathSync(path.join(linkDir, links[0]))
  assert.ok(fs.existsSync(target), `软链必须能解析，实得断链 ${target}`)
  fs.rmSync(dest, { recursive: true, force: true })
})

check('㉑ 文档层只补不覆盖（已存在的文件不被改写）', () => {
  if (!HAS_SNAPSHOT) skip('本包不带 snapshot/（发布版）')
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcore-docs2-'))
  fs.writeFileSync(path.join(dest, 'README.md'), 'MINE\n')
  const r = restore.restoreWorkspace({ workspace: dest })
  assert.equal(r.ok, true, `恢复失败：${r.reason}`)
  assert.equal(fs.readFileSync(path.join(dest, 'README.md'), 'utf8'), 'MINE\n', '默认不得覆盖已有文件')
  fs.rmSync(dest, { recursive: true, force: true })
})

check('㉒ 未提交改动层：补丁可解析且哈希受校验', () => {
  if (!HAS_SNAPSHOT) skip('本包不带 snapshot/（发布版）')
  const m = restore.readSnapshotManifest()
  const info = m?.repo?.worktree
  assert.ok(info, '快照应带 repo.worktree（否则恢复出来的代码会退回修复前行为）')
  const file = path.join(PACKAGE_ROOT, 'snapshot', info.file)
  assert.ok(fs.existsSync(file), `缺补丁文件 ${info.file}`)
  const crypto = require('node:crypto')
  const got = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  assert.equal(got, info.sha256, '补丁 sha256 必须与 manifest 一致')
})

check('㉓ 移交标记随数据层一起恢复（否则恢复出来的机器会重新长静态段）', () => {
  if (!HAS_SNAPSHOT) skip('本包不带 snapshot/（发布版）')
  // WO-069：注入移交的事实记在 <库目录>/plugin-took-over.json。它不在快照里，
  // 恢复出来的机器上 cm-agents.js 会照旧把 CM 段写回 AGENTS.md —— 于是
  // 「恢复」把项目悄悄退回到了「两个渲染器」的状态。
  const m = restore.readSnapshotManifest()
  const hit = (m?.data?.files || []).find((f) => f.from === 'plugin-took-over.json')
  assert.ok(hit, '快照 data 层必须包含 plugin-took-over.json')
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'cmcore-marker-'))
  const r = restore.restoreData({ memDir: dest, reindex: false })
  assert.equal(r.ok, true, `恢复失败：${JSON.stringify(r.failed)}`)
  const marker = path.join(dest, 'plugin-took-over.json')
  assert.ok(fs.existsSync(marker), '恢复后必须存在移交标记')
  const obj = JSON.parse(fs.readFileSync(marker, 'utf8'))
  assert.equal(obj.by, 'dsh-cm-core', `标记应记录 by=dsh-cm-core，实得 ${obj.by}`)
  fs.rmSync(dest, { recursive: true, force: true })
})

/* ⑰ ~ ⑱ 库目录解析（2026-11-25 生产事故回归） */
{
  const memory = await import('../lib/memory.js')

  check('⑰ 显式 workspace 不存在时返回 null，不回退到别的库', () => {
    const ghost = path.join(os.tmpdir(), 'cmcore-ghost-' + Date.now())
    // 关键：即使进程 cwd 下面有真库，也不能拿它顶替用户指定的空工作区。
    assert.equal(memory.getMemory({ workspace: ghost }), null)
    assert.equal(memory.resolveMemDir({ workspace: ghost }), path.join(ghost, '.companion-memory'))
  })

  check('⑱ 会话目录优先于进程 cwd', () => {
    if (!HAS_REAL) skip('本机没有真实工作区')
    assert.equal(memory.resolveMemDir({ sessionDir: WORKSPACE }), REAL_MEM)
    // workingDirectory 服务存在时必须优先于 header.cwd
    const fakeCtx = { get: () => ({ get: () => WORKSPACE }) }
    assert.equal(memory.dirFromSession(fakeCtx, { header: { cwd: '/nonexistent' } }), WORKSPACE)
    // 服务缺席时退到 header.cwd
    assert.equal(memory.dirFromSession(null, { header: { cwd: WORKSPACE } }), WORKSPACE)
    assert.equal(memory.dirFromSession(null, {}), '')
  })
}

check('⑲ 解析不出可信目录就返回空串，不猜 ~/.dsh 兜底', () => {
  // 用子进程把 cwd 设成一个**没有 .companion-memory 的父链**，才测得到真实契约：
  // 无显式来源 → 返回 ''（而不是 ~/.dsh/companion-memory 那种猜出来的路径）。
  const { execFileSync } = require('node:child_process')
  const script = `import('${PACKAGE_ROOT}/lib/memory.js').then(m => {
    process.stdout.write(JSON.stringify({ dir: m.resolveMemDir({}), mem: m.getMemory({}) === null }))
  })`
  const out = execFileSync(process.execPath, ['-e', script], { cwd: '/', encoding: 'utf8' })
  const got = JSON.parse(out)
  assert.equal(got.dir, '', `cwd=/ 时不该猜到任何目录，实得 ${got.dir}`)
  assert.equal(got.mem, true, '解析不出目录时 getMemory 必须返回 null')
})

/* ---------------- ㉔~㉗ 新工具在临时库上的实跑 ---------------- */
{
  const os = require('node:os')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-tools-'))
  const memDir = path.join(tmp, '.companion-memory')
  const { ctx, got } = makeCtx()
  mod.apply(ctx, { memDir })
  const byName = (n) => got.tools.find((t) => t.name === n)
  const exec = { agent: { session: { id: 'tools-test-session', header: { cwd: tmp } } } }

  await checkAsync('㉔ cm_know 写入原文层后可被 cm_status 看到', async () => {
    const r = await byName('cm_know').execute({ text: '插件工具面冒烟：这条是 cm_know 写的' }, exec)
    assert.ok(String(r.text).includes('已写进原文层'), `返回异常：${r.text}`)
    const st = await byName('cm_status').execute({}, exec)
    assert.ok(/原文层：\d+ 条 id/.test(String(st.text)), `状态异常：${st.text}`)
  })

  await checkAsync('㉕ cm_selfnote 写入并列出（与普通印象分开）', async () => {
    const w = await byName('cm_selfnote').execute({ text: '我在这个项目里负责把记忆库搬进宿主' }, exec)
    assert.ok(String(w.text).includes('已写下自我叙述'), `写入异常：${w.text}`)
    const l = await byName('cm_selfnote').execute({}, exec)
    assert.ok(String(l.text).includes('自我叙述'), `列出异常：${l.text}`)
  })

  await checkAsync('㉖ cm_handoff 能产出续接包文本（空库也不抛）', async () => {
    const r = await byName('cm_handoff').execute({}, exec)
    assert.equal(typeof r.text, 'string')
    assert.ok(r.text.length > 0, '续接包返回空串')
  })

  await checkAsync('㉗ cm_layers 报三层各自的条数与天数', async () => {
    const r = await byName('cm_layers').execute({}, exec)
    assert.ok(String(r.text).includes('L1 事实'), `缺 L1：${r.text}`)
    assert.ok(String(r.text).includes('L2 画像'), `缺 L2：${r.text}`)
    assert.ok(String(r.text).includes('L3 经验'), `缺 L3：${r.text}`)
  })

  await checkAsync('㉘ 新工具的输出 schema 同样合法', async () => {
    for (const n of ['cm_selfnote', 'cm_handoff', 'cm_know', 'cm_layers', 'cm_ingest']) {
      const sc = byName(n).output?.schema
      assert.ok(sc && sc.type === 'object', `${n} 缺 schema`)
      assert.ok(Array.isArray(sc.required) && sc.required.includes('text'), `${n} required 位置不对`)
    }
  })

  await checkAsync('㉙ cm_ingest 在空会话根上安全返回（不抛、计数为 0）', async () => {
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-sessions-'))
    const prev = process.env.DSH_SESSIONS_DIR
    process.env.DSH_SESSIONS_DIR = emptyRoot
    try {
      const r = await byName('cm_ingest').execute({}, exec)
      assert.ok(String(r.text).includes('扫到 0 个会话文件'), `返回异常：${r.text}`)
    } finally {
      if (prev === undefined) delete process.env.DSH_SESSIONS_DIR
      else process.env.DSH_SESSIONS_DIR = prev
    }
  })
}

/* ---------------- 汇总 ---------------- */
console.log(`\ndsh-cm-core 自测：${pass} 通过 / ${failures.length} 失败 / ${skipped} 跳过`)
for (const f of failures) console.log(`  ✗ ${f}`)
if (failures.length) process.exitCode = 1
