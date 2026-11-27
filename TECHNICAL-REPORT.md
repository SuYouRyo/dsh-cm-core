# dsh-cm-core 技术报告

**把一套外部脚本形态的个人长期记忆库，改造成 DSH 宿主内的一个自包含插件**

版本 0.1.3 · 2026-11-27 · MIT

---

## 定档声明

**作者不再维护本项目。这是定档（frozen）版本。**

原因很直接：这个插件是为一台特定机器上的特定记忆库写的，它解决的问题（四件事各自为政、
守护进程没拉起来就静默失效、数据丢了没法救）在写完之后就不再困扰作者了。后续如果要继续，
更合理的方向不是在这份代码上叠功能，而是按本报告 §5 的取舍重新设计一遍。

定档的含义，具体到操作层面：

- **不接 issue、不接 PR**。仓库保留可读，作为一份可复现的实现记录。
- **不做兼容性承诺**。它对着 `dsh 0.2.2-rc.1` / Cordis 的宿主接口写成，宿主接口一变就可能不工作。
- **`vendor/` 不再跟随上游更新**。它是 2026-11-26 那一刻 `companion-memory/src` 的全量副本。
- **仍然可用**。`tests/plugin-core.test.mjs` 在发布版上 23 通过 / 0 失败 / 8 跳过，
  全丢恢复演练实测 ~2 秒完成（附录 D 有原始输出）。可用与维护是两件事。

---

## 摘要

`dsh-cm-core` 是一个 Cordis 插件，装进 DSH 宿主后承担四件事：**注入**（每轮把记忆塞进
system prompt）、**摄入**（会话消息直接写进原文层）、**检索**（把 recall/remember 等包成
agent 可调工具）、**恢复**（数据全丢时从插件自带的快照把库与代码仓重建回来）。

它的两个非显然之处：

1. **记忆库内核是 vendored 的，不是 npm 依赖。** `vendor/` 是 45 个文件 14834 行的全量副本，
   零第三方依赖。代价是升级要手动重拷，收益是插件包自包含 —— 而"自包含"正是"全丢可恢复"的前提。
2. **它真的能恢复一个项目，不只是恢复一份记忆。** 快照带四层原料：治理文档层、代码仓全历史、
   未提交改动补丁、记忆数据。第三层最容易被忽略，也最阴险（`git bundle` 只打已提交内容）。

---

## 一、它解决什么问题

改造前的形态是**四个外部脚本各管一段**，彼此不知道对方死了：

| 职责 | 改造前的实现 | 失效时的表现 |
|---|---|---|
| 注入 | `cm-agents.js` 改写工作区 `AGENTS.md` 的 `CM:BEGIN/CM:END` 段 | DSH 只在首个请求加载 `AGENTS.md`；换会话模式（work/life）口径不会变，工作侧口径会被塞进生活侧 |
| 摄入 | `cm-watch.js` 定时扫 `~/.dsh/sessions/**/session.v4.jsonl.zstd` | 守护进程没被拉起来就一条都不进；`ps` 一查根本没有它 |
| 检索 | 人手敲 `cm recall "..."` | 模型不知道有记忆库这回事 |
| 恢复 | 无 | 数据丢一次就没了 |

这不是假想的失效。改造时实测过：容器里 `ps` 没有任何 `cm-watch`/`cm-sync`/`cm-guard`/`cm-reflect`
进程，`crontab -l` 为空 —— 也就是说**四件事在这台机器上本来就没在跑**，而记忆库看起来"装好了"。

这引出本项目的核心判断：**"装了但没用的东西"比"没装"更糟**，因为它不报错。
判据因此不是"功能在不在"，而是"失效的时候有没有人知道"。

---

## 二、原理

### 2.1 为什么把内核 vendored 进来

`companion-memory` 的 `src/` 是零第三方依赖的纯 ESM（45 个文件、14834 行、748 KB）。
它本可以是一个 npm 包，但选择整份拷进 `vendor/`：

- **零安装摩擦**：装插件不需要 `npm install`，不需要网络（除可选的向量/精排 API），
  不需要目标机器上有 `work/companion/companion-memory`。
- **恢复原料必须在包内**。"数据全丢也能恢复"若依赖外部仓库在场，就不成立。
- **判据同源**：摄入的消息过滤有一条唯一实现（`vendor/ingest.js` 的 `flatten`），
  插件直接调用它，而不是"再实现一遍相似逻辑"。判据写两份，迟早两份不一致。

代价是升级要手动重跑 `scripts/make-snapshot.mjs` 或重新拷贝。这是刻意的取舍，
写在 `lib/index.js` 头注释里，避免后来者以为是偷懒。

### 2.2 注入原理

宿主提供 `systemPrompt.section()`，插件注册一个命名段：

```js
export const SECTION_NAME = 'cm:memory'
export const SECTION_ORDER = 200   // persona=0, selfnote=100, 计划策略=500
```

`order=200` 的语义是"认人之后、做事之前"。段内容两段拼接：

**① 印象段** —— 走 `mem.injectBlock({ max, maxChars, touch: true })`。
印象是**提炼过的判断**（"他讨厌开会"），带权重、带来源、带时间衰减。

`touch: true` 是整个插件里**唯一**传 true 的地方。原因：`touch` 会更新印象的"被用到"计数，
影响后续权重。如果开网页看一眼、跑一次统计也传 true，权重就被"看"这个动作污染了 ——
这不是理论问题，是 `injectBlock` 的默认值被刻意设成 `false` 的原因。

**② 原话段** —— 走原文层 `mem.store.query({ limit, kind: ['msg','user'], role })`。
两个必须照抄的修法：

- **过滤必须发生在截断之前。** 库里 AI 发言约占三成，若先 `query({limit:N})` 再 filter(kind)，
  短窗口几乎全是 AI 独白，人话一条不剩。
- **`role` 必须显式传。** 不传就按进程默认角色选，这是最容易发生的串层通道。

三段护栏：没有会话（子进程/全局装配）→ 返回 `''`；库打不开 → 返回 `''` 不报错；
`inject` 配置关掉 → 返回 `''`。宿主对空段自动丢弃，所以"没装库"不会往提示词里塞一个空标题。

**注入内容永远不进 `AGENTS.md`。** 静态段与插件段并存 = 同一份记忆被渲染两次且口径各自漂移，
这正是本项目历史上的污染事故形状（2026-11-04 红线）。

### 2.3 摄入原理

监听 `session/event`，只处理 `user/message` 与 `assistant/message`：

```js
ctx.on('session/event', (session, event) => {
  if (event.type !== 'user/message' && event.type !== 'assistant/message') return
  ingestEvent(mem, event, session.id)
})
```

`ingestEvent` **不重写**过滤判据，直接调 `vendor/ingest.js` 的 `flatten`。它已经处理了：

- 只收 `content[].type === 'text'`（丢 reasoning、丢 tool 块）
- `AGENTS.md` 注入快照整条丢弃（`isAgentsSnapshot`，与去污染工具共用同一判据）
- `SYSTEM_SOURCES`（`runtime-context` / `skill-catalog` / `dsha-emotion-inject` …）→ `kind='sys'`
- `looksInjected`（以 `<system-reminder>`/`<command-` 开头，或含 `Instructions from: AGENTS.md`）→ `kind='sys'`

`kind` 三态是检索的开关：`msg`/`ai`/`user` 参与检索，`sys` 入库但不参与。
"完全保留"是原则 —— 系统提示也存，只是不让它污染召回。

**id 必须带会话后缀**：`chat:<sessionId 后 8 位>:<seq>`。否则两个会话的 seq 1 会互相判重，
后一条被当重复丢弃，而且完全静默。

### 2.4 检索原理

链路是固定的，改动都要重新标定：

```
向量召回 ──┐
           ├─> 融合前 40/60 ──> 精排 ──> MMR 去重 ──> 装包 ──> 输出
词面召回 ──┘
```

**词面通道**：中文按 **2 字 bigram** 切分建倒排，打分用 BM25（Robertson/Sparck-Jones 的
idf 形式）。2 字是中文的最小有意义单元 —— 单字噪音太大（"的""了"），三字以上会切碎
"加班""记忆库"这类高频双字词。

**融合**：

```
sim = alpha × 词面coverage + (1 - alpha) × 向量余弦
```

`alpha` 默认 **0.3**（即 0.3×词面 + 0.7×向量）。一个反直觉的实测事实：`alpha` 在 0→0.3
区间结果完全一样 —— 它是**平台不是尖峰**，所以取 0.3 而不是精确的"最优值"。

**最终打分**：

```
score = 0.7 × 相似度 + 0.2 × 鲜活度 + 0.1 × 重要度
```

三项权重是移植自上游的设计，不是本项目的标定结果（见 §8.1 `rank.js`）。

**精排池 `RERANK_POOL = 60`**：召回后取前 60 条送交叉编码器。2026-11-08 由 40 提到 60，
依据是 714 题全量 A/B：hit@10 从 94.40% 提到 95.80%（+1.4 个点）、MRR 0.8671→0.8695，
而外发原文量只从每次 4885 字涨到约 7300 字（+50%）。没有取 100 的理由：多 2.2 个点的收益，
代价是把翻倍的私事发给第三方。

**MMR 去重**（Maximal Marginal Relevance）：`λ = 0.6`，`topWindow = 12`。
召回结果里常是同一件事的 N 种说法，取前 5 条等于把同一件事说五遍。
MMR 逐条挑「λ×相关度 − (1−λ)×与已选集最大相似度」最高的那条。

λ 的定值依据是实测，不是拍脑袋：46 个查询 / 33 个池内对，把"让位所需最小 λ"排出来，
近似重复那几对是 0.751 / 0.773（λ 必须 < 0.75 才压得住），弱重叠那批 p50 = 0.69。
λ=0.6 落在"全部近似重复都让位、多数弱重叠不误伤"的区间；λ=0.7 已有 0.72~0.75 的
近似重复开始不让位。端到端前 5 多样性 0.891 → 0.947，top-1 8/8 未变。

一条硬约束：**不许为多样牺牲相关性**。低分条目不许靠"不同"挤进前列 —— 这条不是靠注释保证的，
是靠 `TIE_BAND` 硬阈值在 `eligiblePool()` 里拦。

**装包 `packByIds`**：`budget = 2400` 字符、`maxItem = 150` 字符/条。逐字等价移植
灵枢 LINGSHU 的确定性估算器与装包循环（见 §8.1）。

### 2.5 单向门原理

记忆库分三层：`shared` / `work` / `life`。

- 工作侧（`role=work`）看得见 `shared + work`，**永远看不见 `life`**。
- 生活侧（`role=life`）全可见，但只写 `life`。

这道门在**库内核里由三处同时保证**：`store.query()` 过滤、倒排建索引过滤、
向量索引文件名带可见范围（如 `BAAI_bge-m3.shared_work.ids.jsonl`）。

插件**不另写一套过滤，也不提供"看全部"的开关** —— 它只调用库内核。
这是 2026-11-04 污染事故的直接教训：一个记忆写在两个地方，口径各自漂移。

### 2.6 恢复原理

验收口径是"数据全面丢失时，只通过一个插件就完全恢复我们的项目"。
"全面丢失"有三种真实形态，快照四层各自对应一种：

| 层 | 原料 | 对应哪种丢失 |
|---|---|---|
| 治理文档 | `snapshot/workspace.tgz` | doc-00~07 工单/红线/知识库/交接 + 门禁脚本 + 根 `.md` 白名单全没了 |
| 代码仓 | `snapshot/code.bundle` | 完整历史 git bundle，可 clone 出 162 个提交的仓 |
| 未提交改动 | `snapshot/code-worktree.patch` | `git bundle` 只打已提交内容；少这层，恢复出的代码会**悄悄**退回修复前行为 |
| 记忆数据 | `snapshot/data/*.gz` | 原文层 + 印象层 + 落定表 + 墓碑 + 移交标记 |

三条安全阀：

1. **只补不覆盖。** 目标文件已存在就跳过并报告。"恢复"误伤现有数据比不恢复更糟。
2. **校验解压后 sha256。** manifest 里存的是**解压后**内容的哈希（gzip 容器可变，
   存 `.gz` 的哈希会在不同 zlib 版本间失配）。逐文件核对，任一不符则**一条都不写**。
3. **失败要说清哪一层。** 恢复是低频高风险动作，返回结构化结果而不是抛异常，
   让调用方能原话转告"哪一层没成"。

`restoreAll` 的执行顺序是 **文档 → 代码 → 数据**。文档层只有 2 MB，恢复后立刻就能读工单/红线，
排障顺序更顺。

---

## 三、结构

### 3.1 包结构

```
dsh-cm-core/
├── package.json           # name/version/dsh.bundle.patch/files 白名单
├── cordis.patch.yml       # 插件与 preset 的挂载声明
├── cordis.patch.yml 内容：- insert: [{ id: dsh-cm-core, name: 'dsh-cm-core' }]
├── lib/
│   ├── index.js           # 791 行 · 插件入口：注入段、摄入、11 个工具
│   ├── memory.js          # 182 行 · 库句柄解析与进程内缓存
│   └── restore.js         # 243 行 · 四层恢复
├── scripts/
│   ├── make-snapshot.mjs  # 222 行 · 生成 snapshot/
│   └── publish.mjs        # 284 行 · 本地包 → 发布包 + 四道闸 + push
├── tests/
│   └── plugin-core.test.mjs  # 468 行 · 31 条自测
└── vendor/                # 45 个文件 · 14834 行 · 记忆库内核全量副本
```

插件本体 2190 行（`lib` + `scripts` + `tests`），内核 14834 行，合计约 17000 行。

### 3.2 `lib/` 三模块的职责边界

- **`lib/index.js`** —— 唯一与宿主对话的地方。它导出 `name` / `inject` / `apply`，
  并向内调用 `memory.js` 拿句柄、向 `restore.js` 要恢复能力。它**不懂记忆库的数据格式**。
- **`lib/memory.js`** —— 只管"库在哪、怎么打开、缓存住"。
  为什么单独一层：至少有四个调用点要用库（注入/摄入/工具/恢复），生命周期完全不同
  （同步每轮 / 异步事件驱动 / 用户触发 / 一次性）。各自 `open()` 会重复建倒排索引
  （大库上 `recall` 一次 2.4 秒，建索引更贵），并发 open 还会抢锁。
  所以**一个进程一份句柄，按 dir 缓存**。
- **`lib/restore.js`** —— 只做恢复。三条纪律写在文件头（只补不覆盖 / 校验哈希 / 说清哪层）。

### 3.3 `vendor/` 45 个模块的分组

| 组 | 模块 |
|---|---|
| 存储与索引 | `store` `paths` `dedupe` `receipts` `local time` |
| 检索 | `search` `bm25` `idf` `rank` `rerank` `mmr` `pack` `workingset` |
| 向量 | `vectors` `vectors-derive` `embed` |
| 印象与分层 | `impressions` `layers` `classify` `validate` |
| 摄入 | `ingest` `importmd` |
| 整理/归档 | `archive` `archive-compress` `cold-archive` `recall-archive` `retention` `upkeep` `maint` `life-sweep` |
| 会话交接 | `handoff` `close-channel` `trigger-read` `reinject` |
| 情绪 | `emotion` `emotion-delta` `emotion-words` |
| 自省 | `reflect` `auto-compact` `state-params` |
| 其他 | `shared` `index` `work-trace` `freeze-guard.mjs` `reinject.selftest.mjs` |

### 3.4 数据目录布局（记忆库侧）

```
.companion-memory/
├── raw/
│   ├── events/2026-11.jsonl        # shared + work 的原文层，按月分片
│   ├── events-life/                # life 的原文层，独立目录
│   ├── index/ids.txt               # 倒排索引的 id 清单
│   ├── manifest.json               # 分片清单
│   ├── tombstones.txt              # 墓碑（物理清理标记）
│   ├── session-scope.jsonl         # 会话落定 scope 表
│   ├── session-scope-life.jsonl    # life 落定表（本机专属）
│   ├── recall-archive.jsonl        # 归档（可逆）
│   └── handoff-notes.jsonl         # 续接包
├── impressions/
│   ├── impressions.jsonl           # 印象层（shared+work）
│   └── impressions-life.jsonl      # 印象层（life）
├── vectors/                        # 向量索引（可重建，不同步）
├── emotion-feed.json               # 情绪层
└── plugin-took-over.json           # 移交标记
```

`raw/events-life/` 独立成目录是为了同步隔离：数据仓的远端 pre-receive 会拒绝
被追踪文件里含 `"scope":"life"` 的内容。

`vectors/`、`raw/index/`、`raw/manifest.json` **不在 git 里**（151 MB），
因为它们可由 `cm.reindex()` + `cm.buildVectors()` 重建 —— 派生物不该进版本库。

### 3.5 11 个工具

| 工具 | 作用 | 读写 |
|---|---|---|
| `cm_recall` | 按关键词回忆（词面 bigram + 向量混合） | 只读 |
| `cm_remember` | 记一条印象，先过人格诊断红线校验 | 写 |
| `cm_status` | 库在哪、什么角色、看得见哪层、多少条 | 只读 |
| `cm_restore` | 从快照恢复四层 | 写（只补不覆盖） |
| `cm_selfnote` | 读写自我叙述层（L4） | 读写 |
| `cm_handoff` | 拼会话续接包 | 只读（write 时写盘） |
| `cm_know` | 往原文层手加一条知识 | 写 |
| `cm_layers` | 三层蒸馏现状（L1/L2/L3） | 只读 |
| `cm_ingest` | 把磁盘上已有历史会话补灌进库 | 写（按 id 判重） |
| `cm_archive` | 归档/撤销归档若干条（可逆） | 写 |
| `cm_read` | 按 id 读全文 / 上下文 / 追查链 | 只读 |

划分口径：**可逆的读与写进插件；不可逆的整理（gc/tombstone）与需外发模型的加工（reflect）留 CLI。**
理由见 §5.5。

---

## 四、实现

### 4.1 Cordis 插件形态

```js
export const name = 'dsh-cm-core'
export const inject = ['systemPrompt', 'sessionProjections']

export function apply(ctx, config) {
  if (REGISTERED.has(ctx)) return       // Cordis 会按 scope 各调一次 apply
  REGISTERED.add(ctx)
  const cfg = cfgOf(config)
  ctx.effect(() => ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: (context) => sectionText(context, cfg, ctx),
  }))
  ctx.on('session/event', (session, event) => { /* 摄入 */ })
  ctx.inject(['tools'], (sub) => registerTools(sub, cfg))
}
```

`REGISTERED` 用 `WeakSet` 按 **ctx 对象**去重，不能用全局布尔 —— 因为 apply 会被两个 scope
各调用一次。这是从另一个插件（`dsh-sae-host`）学来的教训，写在源码注释里。

### 4.2 为什么刻意不导出 `Config`

Cordis 的 `resolveConfig` 对导出的 `Config` 调 `schema.validate(value)`
（`cordis/lib/index.js:246`）。如果导出一个普通对象：

```
TypeError: Cannot read properties of undefined (reading 'validate')
```

整个条目 `did not activate`。本包没有 `@deepseek-ai/schemastery` 依赖（它只在部分包里有），
所以正确做法只有两条：① 引入 schemastery 的 `z.object`；② 不导出，自己校验。

选 ②。理由：本插件配置只有 7 个标量，`cfgOf()` 已经做了类型收敛与范围钳制
（`injectMax` 1–20、`injectMaxChars` 200–8000），多一个 schema 依赖只会增加
"装到新机器上解析不到"的风险 —— 与"自包含"的核心取舍冲突。

### 4.3 工具注册必须走 `ctx.inject(['tools'])`

两个坑都是实测的：

```js
// ✗ 崩：cannot get property "tools" without inject
const tools = ctx.tools

// ✗ 静默：apply 时服务还没就绪，get() 返回 undefined，工具一个都不挂
const tools = ctx.get('tools')
registerTools(ctx, cfg)

// ✓ 正确：等依赖就绪再回调
ctx.inject(['tools'], (sub) => registerTools(sub, cfg))
```

第二坑最隐蔽：只有一条 warn，模型端表现为"工具根本不存在"。

同时 **`inject` 里不写 `'tools'`**。本插件要挂在 `cm-work`/`cm-life` 这类 preset 里，
工具服务不一定在 preset 的依赖图内；写进 `inject` 会让整条 fiber INACTIVE，
连记忆注入一起没了 —— 代价远大于"没有工具的只读记忆"。

输出 schema 也要合规：`required` 写在**对象层级**，不能写在属性里。
`{text: {type:'string', required:true}}` 会被宿主拒：
`unsupported JSON schema: schema.properties.text.required is not supported on type "string"`。

### 4.4 库目录解析：五层修法

这是整个插件最容易踩错的地方，事故现场是：生产宿主里 `cm_status` 报
"3 条原文"，而真实库有 22,000 条。

根因链：`dsh web` 的进程 cwd 是 `/root` → 向上找不到 `.companion-memory` →
落到兜底 `~/.dsh/companion-memory` → `open()` 在那里**凭空建了一个空库**。

五层修法：

1. `dirFromSession(ctx, session)` —— 先取 `workingDirectory.get(session)`（宿主已提交的会话目录），
   退 `session.header.cwd`。**不能用 `process.cwd()`**。
2. `resolveMemDir` 里，显式来源（`memDir` / `workspace` / 会话目录）是**权威**：
   找不到库就返回 `<base>/.companion-memory`，**绝不回退到进程 cwd** ——
   否则"这个工作区没有库"会被悄悄替换成"另一个工作区的库"。
3. **删除兜底路径**，改为返回空串（未知）。空库比"没有库"危险，因为它长得正常。
4. `getMemory` 加双闸：dir 为空 → `null`；非显式配置且 `looksLikeStore(dir)` 为假 → 不 open
   （杜绝在任何位置造库）。
5. `climb()` 向上 12 层时，命中探针还要 `looksLikeStore()` 校验，防止 `/tmp` 残留空库被认领。

### 4.5 恢复实现

```js
restoreData({ memDir, root, force, reindex })      // 数据层
restoreCode({ targetDir, root, force })            // git clone <bundle>
applyWorktreePatch({ targetDir, root })            // git apply --3way，失败退普通 apply
restoreWorkspace({ workspace, root, force })       // tar -xzf --skip-old-files
restoreAll({ workspace, memDir, codeDir, root, force, withDocs })  // 逐层报告
```

`restoreWorkspace` 用 tar 而非逐文件拷贝，是因为工作区里有 88~444 条软链
（`doc-03-active` 全是指向 `doc-02-done` 的软链），必须原样保留链接关系，不能 follow。

`restoreAll` 的 `ok` 判定：

```js
const ok = layers.data.ok
  && (layers.code.ok || layers.code.reason?.includes('目标已存在'))
  && (!withDocs || layers.docs.ok)
```

"代码仓已存在"算成功 —— 恢复一个已经在用的项目时，代码层本来就该跳过。

### 4.6 发布流水线四道闸

`scripts/publish.mjs` 从本地包单向生成发布包：

1. **白名单拷贝**：`COPY = ['lib','vendor','scripts','tests','cordis.patch.yml']`。
   白名单而非黑名单 —— 任何没被列出的东西（尤其 `snapshot/`）永远不会上行。
2. **隐私扫描**：密钥正则 + 作者家目录绝对路径。
   这一道**第一次运行就红了一次**，拦住了一次会带出作者家目录的发布。
3. **版本一致性闸**：两个 `package.json` 的 version 必须相等；README 里写死的
   `.tgz` 版本必须等于当前版本。
4. **自测闸**：跑 `tests/plugin-core.test.mjs`，失败数非 0 即中止。

推送后复核远端 HEAD 与本地一致。两个坑写进脚本：历史分叉要用
`fetch --depth=1` + `reset --soft FETCH_HEAD`（不能 `--force`，会抹掉发布仓历史）；
https 凭据要走 credential helper。

### 4.7 自测设计

31 条，零依赖。核心设计是**"探测不到就跳过并计数"，不是假装通过**：

```
dsh-cm-core 自测：23 通过 / 0 失败 / 8 跳过     # 无 snapshot 的发布版
dsh-cm-core 自测：31 通过 / 0 失败 / 0 跳过     # 带 snapshot 的完整包
```

`CM_TEST_WORKSPACE` 可指定测试工作区；不指定就从包往上找含 `.companion-memory`
或 `doc-02-done` 的目录；找不到就 `skip()`。

一条踩过的坑写进自测本身：**async 用例必须 `await checkAsync(...)`**。
写成 `check(... async () => {...})` 时，`check` 同步返回不 await，async 回调里的断言
失败会变成未捕获拒绝，汇总**算通过** —— 曾经出现过一次假的"28 通过"。

---

## 五、设计思路与关键取舍

### 5.1 零依赖 vendor vs npm 依赖

选 vendor。见 §2.1。一句话：**自包含是"全丢可恢复"的前提条件，不是优化项。**

### 5.2 不导出 `Config`

见 §4.2。一句话：**多一个依赖就多一个"新机器上起不来"的失败点。**

### 5.3 只读优先 / 只补不覆盖

注入与检索只读；摄入只追加；恢复只补不覆盖。
这是"记忆库比插件重要"的体现：插件坏了可以重装，记忆库被覆盖不可逆。

### 5.4 归档而非删除

`cm_archive` 只做**可逆归档**（mute），不提供物理删除。
一条记忆被归档后不再出现在检索与注入里，但原文一个字节不动，`undo: true` 可完整退回。

这条与库内核红线一致：**整理不物理删除，只降级 `kind=sys`**。
理由：判"这条没用了"是错的概率很高，而判错的代价是不可逆的。

### 5.5 刻意不做的事

| 不做 | 理由 |
|---|---|
| 自省（CLI 的 `cm reflect`） | 需外发模型做加工，成本与不确定性都高；留在 CLI 里手动跑 |
| 整理（CLI 的 `cm reap` / `cm archive --tombstone`） | 不可逆整理，不适合暴露给模型自主调用 |
| 批量导入（CLI 的 `cm import`） | 一次性运维动作，不是会话内的需求 |
| 多设备同步 | 已由独立插件 `dsha-sync-agent` 承担，职责不该合并 |
| 快照自动重打 | 挂提交钩子会让每次 commit 背 3 秒副作用；只有检测（门禁）没有自动重打，是取舍 |

### 5.6 `snapshot/` 永不进公开仓

`snapshot/` 里是真实的个人记忆原文与工作区文档。发布版只有插件本体（约 870 KB），
可以正常注入/摄入/检索，但 `cm_restore` 会明确告诉你"插件包里没有快照清单"。
要启用"全丢可恢复"，在自己机器上跑 `node scripts/make-snapshot.mjs` 生成。

`cm_restore` 在这种情况下**报错是正确行为**，不是缺陷 —— 它没有假装成功。

---

## 六、踩过的坑（留给下一个人）

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | `ERR_UNSUPPORTED_DIR_IMPORT` | patch 里 `name` 写了目录路径 | 写包名或 `file:///…/lib/index.js` |
| 2 | 启动崩在 `schema.validate()` | 导出普通对象 `Config` | 不导出，自己用 `cfgOf()` 校验 |
| 3 | `cannot get property "tools" without inject` | 直接读 `ctx.tools` | 用 `ctx.get('tools')` 或 `ctx.inject` |
| 4 | 工具全部静默不挂 | 同步调 `registerTools`，服务未就绪 | `ctx.inject(['tools'], cb)` |
| 5 | 注入永远为空 | 库目录解析落到 `~/.dsh/companion-memory` 空库 | 按会话工作目录解析 + 不兜底 |
| 6 | 恢复报告全 ✓ 但代码是旧的 | `git bundle --all` 只打已提交内容 | 补 `code-worktree.patch` 层 |
| 7 | 恢复出的项目又长出静态注入段 | 快照没带 `plugin-took-over.json` | 把它算进数据层（12 个文件） |
| 8 | 自测"通过"但断言没跑 | `check(async ...)` 没 await | `await checkAsync(...)` |

---

## 七、局限与未做

1. **对着 `dsh 0.2.2-rc.1` 写成**。Cordis 宿主接口是 rc 版本，接口变动会破坏兼容。
2. **`vendor/` 冻结在 2026-11-26**。上游 `companion-memory` 的改进不会自动进来。
3. **`workspace.tgz` 带的是当时的工作区快照**。恢复出的文档是那一刻的，不是最新的。
4. **恢复不校验"目标工作区是否真的是我们的工作区"**。`--force` 会覆盖，这是给作者自己用的。
5. **`cm_ingest` 只支持按精确 session id 补灌**，不支持前缀匹配（"补 A 结果补了 A2"会静默发生）与批量限量。
6. **没有 Windows 实跑验证**。`tar` / `git` 调用假定 Unix 语义。
7. **未做快照自动重打**，靠一道门禁（`snapshot-fresh`）检测落后，不自动修。
8. **多设备同步不在本插件内**。

---

## 八、引用文献

### 8.1 上游开源代码（vendor 内逐条标注）

| 上游 | 许可 | 用在哪 | 程度 |
|---|---|---|---|
| [`NoMindSama/qq-dsh-bridge`](https://github.com/NoMindSama/qq-dsh-bridge) | MIT（© 2026 Derpyu520 及贡献者） | `vendor/store.js`、`vendor/search.js`、`vendor/impressions.js`；L4 自我认知层的设计依据（README「前三层记的都是你，第四层记的是它」） | 改自（原文层/倒排/打分骨架）+ 设计借鉴 |
| `qq-bridge-memory` 7ge233 | MIT（© 7ge233） | `vendor/rank.js` | 逻辑移植（排序、门控、时间语义），只用纯 JS 小数函数重写，不搬 numpy/ORM |
| [`ssamurias/dsh-fish`](https://github.com/ssamurias/dsh-fish) | MIT | `vendor/idf.js`（`lib/recall.js:205-213`）、`vendor/bm25.js`（`[floor,ceil]`） | **逐字移植公式**；上下界标 0.6/1.0 标注"未在本地标定" |
| [`FuRongJun-1999/dsh-memory`](https://github.com/FuRongJun-1999/dsh-memory)（灵枢 LINGSHU） | MIT（© 2026 FuRongJun-1999） | `vendor/pack.js` | **逐字等价移植**确定性估算器与装包循环 |
| [`BAAI/BioCore`](https://github.com/BAAI/BioCore) | AGPL-3.0 | `vendor/mmr.js`（`biocore_memory/recall/mmr.py`） | **只看思路，一行代码没抄**；不引依赖 |
| `Johnhmzm/astrbot_plugin_biocore` | AGPL-3.0 | `vendor/emotion.js`（状态确定性/闭环回流/coping 滑动平均/意图选择器） | **只抽思路**；不引依赖、不复制代码 |
| `qwen-rag`（`app/rerank.py`） | — | `vendor/rerank.js` | 思路照搬（池子全送、截断交调用方、门限只卡第一名）；门限自己标定 |
| 洛灯鱼《陪伴型个人 agent 的真长期记忆系统》（小黑盒，2026-10-27，**非开源**） | — | `vendor/close-channel.js`、`vendor/workingset.js` | 上游参考（原文投喂形态、注入拼接顺序、TTL 语义） |

**许可边界声明**：`vendor/` 里所有 AGPL-3.0 上游（BioCore、astrbot_plugin_biocore）
**均未引入依赖、未复制代码**，只借鉴思路；涉及处逐条在文件头注明。

### 8.2 评测基准

| 基准 | 许可 | 用途 |
|---|---|---|
| [`Ornn8/chat-memory-benchmark`](https://github.com/Ornn8/chat-memory-benchmark) | MIT | **714 题**主基准（三步判分 `grading/grade.py`）；RERANK_POOL 的 +1.4 点依据 |
| 同上 `grading/`（"B3 尺子"） | MIT | 内部纵向 A/B。**不能与 596/714 横比** |
| [`FuRongJun-1999/hive-memory-bench`](https://github.com/FuRongJun-1999/hive-memory-bench)（HIVE） | — | 中文长文本记忆理解（184 题 + 判分器）。**结论均为其自述，本项目未独立复现** |

HIVE 的四条结论对本项目的方向选择有影响（**自述，非本项目实测**）：
抽取式方案的引文在原语料内可定位率 0%，原文路线 ≈100%；压缩丢的是
"与提问词面不重叠的那一侧"（方向性偏差）；写入成本跨 4 个数量级与效果无关；
零材料对照下材料净贡献 −5.4 ~ −33.8 pp。

### 8.3 学术与工程方法

| 来源 | 采纳情况 |
|---|---|
| BM25 / Robertson & Sparck-Jones 的 idf 形式 | 词面打分的数学基础 |
| [Maximal Marginal Relevance](https://dl.acm.org/doi/10.1145/290941.291025)（Carbonell & Goldstein, SIGIR 1998） | MMR 去重的算法出处；λ 由本项目实测标定 |
| FMEA（严重度 × 概率 × 可检测性） | 采纳，产出风险优先级表 |
| 架构适应度函数（Fitness Functions） | 采纳，落成"W-LOG-C 门禁" |
| Docs as Code + Fail-Closed | 文档侧采纳；Fail-Closed 单向门**不采纳**（会卡死正常流程） |
| OpenTelemetry Trace Span | 部分采纳；token 级追踪做不了 |
| 属性测试 / TLA+ | 有条件采纳（未落地） |

### 8.4 宿主与插件范式的参考实现

| 来源 | 借了什么 |
|---|---|
| `@deepseek-ai/dsh-session-stats` | "projection unit + wire view"的插件写法 |
| `dsh-sae-host` | `ctx.tools` / WeakSet 去重 / 工具 schema 的四条踩坑教训 |
| `dsh-cm-role` / `dsh-cm-selfnote` / `dsha-emotion-inject` | 本项目前三个插件的接法（`shellEnv` / `systemPrompt.section` / `agent/pre-step`） |

### 8.5 引用纪律

本项目对引用有三条硬纪律（写在 `docs/references.md`）：

1. **不收无出处的转述。** 说不出出处的数字不进文档。
2. **不把 `/tmp` 下的东西当真源。** 临时目录重启即丢，引用它等于引用空气。
3. **外部数字不冒充己方实测。** 一律标"自述"或"本地实跑"，两者不混。

本文档遵守这三条：§8.2 的 HIVE 结论标了"自述"，RERANK_POOL 的 +1.4 点标了
"714 题全量 A/B"（本项目实测），MMR 的 λ 依据标了"46 个查询 / 33 个池内对"（本项目实测）。

---

## 附录

### 附录 A · 配置项

| 键 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `memDir` | 自动探测 | 绝对路径 | 记忆库数据目录。给了就只用它 |
| `workspace` | 会话工作目录 | 绝对路径 | 工作区根；留空按会话 `workingDirectory` 解析 |
| `inject` | `true` | bool | 是否注入 system prompt 段 |
| `injectMax` | `6` | 1–20 | "最近说过的话"条数上限 |
| `injectMaxChars` | `1200` | 200–8000 | 注入段字符上限 |
| `ingest` | `true` | bool | 是否把会话消息写入原文层 |
| `vectors` | `false` | bool | 是否启用向量通道（需 embedding API key） |

### 附录 B · 快照 manifest 结构

```json
{
  "format": "dsh-cm-core-snapshot/1",
  "generatedAt": "2026-11-26T07:15:37.995Z",
  "repo": {
    "path": "<代码仓>",
    "commit": "4d4dd78ad7e9779fac87881abdde66ddde8b0648",
    "bundle": { "file": "code.bundle", "bytes": 2189531, "sha256": "…" },
    "worktree": { "file": "code-worktree.patch", "sha256": "…",
                  "trackedFiles": 6, "untrackedFiles": 1 }
  },
  "data": {
    "path": "<记忆库>",
    "files": [
      { "file": "impressions/impressions.jsonl", "from": "impressions/impressions.jsonl",
        "bytes": 16800, "rawBytes": 20000, "sha256": "<原文的哈希>" }
    ]
  },
  "workspace": {
    "path": "<工作区>",
    "archive": { "file": "workspace.tgz", "bytes": 2144958, "sha256": "…" },
    "entries": 444
  },
  "notes": []
}
```

数据层 12 个文件、原始总量约 30.8 MB；`workspace.tgz` 444 条目 / 2.05 MB；
`code.bundle` 2.09 MB。

### 附录 C · 术语表

| 术语 | 含义 |
|---|---|
| 原文层（L0） | 只追加、永不修改的原始消息。检索的最终来源 |
| 印象层（L2） | 从原文提炼的判断，带 tag 权重、来源、时间衰减 |
| 三层蒸馏 | L1 事实 / L2 画像 / L3 经验 |
| 自我叙述层（L4） | AI 对自己的描述，同库不同 category，**不进每轮注入** |
| 单向门 | work 侧永远看不见 life 层的强制约束 |
| 落定 scope | 一个会话判定归属哪一层，一旦落定不可放宽 |
| 墓碑 | 物理清理的标记文件，被标记的 id 不再入库 |
| 归档（mute） | 可逆，不再被召回但原文不动 |
| touch | 印象被"真的用到"的计数。只有实际注入时才 +1 |
| 快照 | 插件自带的恢复原料四层包 |

### 附录 D · 验证记录

**自测**（发布版，无 `snapshot/`）：

```
$ node tests/plugin-core.test.mjs
dsh-cm-core 自测：23 通过 / 0 失败 / 8 跳过
```

（完整包含 `snapshot/` 时为 31 通过 / 0 失败 / 0 跳过。）

**全丢恢复演练**：清空目标目录，只放 5 项（`package.json` / `cordis.patch.yml` / `lib` /
`vendor` / `snapshot`），调 `restoreAll`：

```
ok = true
耗时 ~2 秒
docs.entries = 444
code.head    = 4d4dd78a
worktree     = { ok: true, applied: true, trackedFiles: 6, untrackedFiles: 1 }
data         = { restored: 12, skipped: 0, failed: null }
reindexed    = 20478 条 id
```

恢复出的工作区自跑文档门禁：`doc-gate-root` exit 0、`doc-gate-status` exit 0；
恢复出的代码仓可跑 `node bin/cm.js version` 正常输出。

**发布包复核**：全新 `git clone` 后 `diff -r` 比对本仓库与本地工作包的
`lib` / `vendor` / `tests` / `scripts` 四个目录，全无差异。

---

## 许可

MIT，见 [LICENSE](LICENSE)。Copyright (c) 2026 SuYouRyo。

`vendor/` 内各组件的上游许可与引用程度见 §8.1。AGPL-3.0 上游未引入依赖、未复制代码。
