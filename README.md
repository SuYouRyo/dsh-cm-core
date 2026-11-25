# dsh-cm-core

把 **companion-memory 记忆库**整个搬进 [DeepSeek Harness](https://github.com/deepseek-ai) 宿主进程的一个插件里：
**注入 / 摄入 / 检索 / 恢复** 四件事全在一个 fiber 内，不再依赖任何外部 node 脚本、定时任务或工作区改造。

```
装之前：记忆库靠 cm-watch 定时扫会话、cm-agents 改写 AGENTS.md、人手动敲 cm recall
装之后：宿主每轮自己注入、会话消息自己入库、agent 自己调工具、数据全丢自己恢复
```

---

## 一、它解决什么

旧形态的四件事各自为政，**失效点互相不知道**：

| 职责 | 旧实现 | 失效时的表现 |
|---|---|---|
| 注入 | `cm-agents.js` 改写 `AGENTS.md` 的 `CM:BEGIN/CM:END` 段 | DSH 只在首个请求加载 AGENTS.md；换了会话模式（cm-work / cm-life）口径不会变，工作侧口径会被塞进生活侧 |
| 摄入 | `cm-watch.js` 定时扫 `~/.dsh/sessions/**/session.v4.jsonl.zstd` | 守护进程没拉起来就一条都不进；容器里 `ps` 一查根本没有它 |
| 检索 | 人手敲 `cm recall "..."` | 模型不知道有记忆库这回事 |
| 恢复 | 无 | 数据丢一次就没了 |

四件事只要有一环没被拉起，记忆库就静默变成「装了但没用的东西」。

本插件把四件事搬进宿主，并且**把恢复所需的原料打包进插件自己**，使「数据全面丢失 → 只靠这一个插件恢复」成立。

## 二、安装

插件本体零第三方依赖（`vendor/` 是记忆库内核的全量副本），装完即可用。

```bash
# 在 DSH 会话里（agent 工具）
plugin_manager({ action: "install_bundle", target: "github:SuYouRyo/dsh-cm-core" })
```

或者用 CLI：

```bash
dsh --profile <profile> plugin add github:SuYouRyo/dsh-cm-core
```

也支持本地目录 / tarball：

```bash
plugin_manager({ action: "install_bundle", target: "/abs/path/to/dsh-cm-core" })
plugin_manager({ action: "install_bundle", target: "/abs/path/to/dsh-cm-core-0.1.0.tgz" })
```

装完**重启宿主进程**（插件模块没有 HMR）。`dsh web` 启动要 40–50 秒才打印 URL，别以为卡死。

### 配置项（可选）

不导出 `Config`（本包没有 `@deepseek-ai/schemastery` 依赖，Cordis 会对导出的 `Config` 调 `schema.validate()`，普通对象会直接崩在启动阶段）。
需要覆盖默认值时，在 profile 的 `cordis.patch.yml` 里给本条目写 config：

| 键 | 默认 | 说明 |
|---|---|---|
| `memDir` | 自动探测 | 记忆库数据目录（绝对路径）。给了就**只**用它 |
| `workspace` | 会话工作目录 | 工作区根；留空则按会话 `workingDirectory` 解析 |
| `inject` | `true` | 是否往 system prompt 注入记忆段 |
| `injectMax` | `6` | 「最近说过的话」条数上限（1–20） |
| `injectMaxChars` | `1200` | 注入段字符上限（200–8000） |
| `ingest` | `true` | 是否把会话消息写入原文层 |
| `vectors` | `false` | 是否启用向量通道（需要 embedding API） |

**库目录解析规则**（这是本插件最容易踩错的地方，注释里写了完整事故复盘）：
`memDir` → `CM_DIR` → 从 `workspace` / 会话工作目录向上找 `.companion-memory`（限深 12 层，且必须真的是库）→ 都没有就**返回空、不猜路径**。
刻意**不**兜底到 `~/.dsh/companion-memory`：那会在宿主进程 cwd（`dsh web` 是 `/root`）里凭空造出一个空库，表现为「插件装了但注入是空的」。

## 三、十个工具

| 工具 | 作用 | 读/写 |
|---|---|---|
| `cm_recall` | 按关键词回忆（词面 bigram + 向量混合），带时间与 id | 只读 |
| `cm_remember` | 记一条印象（提炼过的判断）。先过人格诊断红线校验 | 写 |
| `cm_status` | 库在哪、什么角色、看得见哪几层、多少条原文/印象 | 只读 |
| `cm_restore` | 从插件自带快照恢复：文档层 + 代码仓 + 记忆数据 + 索引 | 写（只补不覆盖） |
| `cm_selfnote` | 读写「自我叙述层」（L4）。与普通印象同库不同 category，**不会混进每轮注入** | 读写 |
| `cm_handoff` | 拼会话续接包（自我叙述 + 偏好/画像 + 最近原话）；`write:true` 落 `raw/handoff/` | 只读（write 时写盘） |
| `cm_know` | 往原文层手加一条知识（你自己看到的事实） | 写 |
| `cm_layers` | 看三层蒸馏现状：L1 事实 / L2 画像 / L3 经验各多少条、覆盖多少天 | 只读 |
| `cm_ingest` | 把磁盘上已有的历史会话补灌进库（`~/.dsh/sessions`）。按 id 判重，可重复调用 | 写 |
| `cm_archive` | 归档（mute）/ 撤销归档若干条记忆：不再被检索注入捞到，原文不删、按 id 仍可点名读 | 写（可逆） |

> `cm_archive` 是「可逆的整理」。记忆库的整理红线是**不物理删除**：归档只是让一条记录不再出现在检索与注入里，原文一个字节不动，`undo:true` 可完整退回。
>
> `cm_ingest` 存在的理由：插件只能摄入**当前会话正在发生**的消息。恢复快照之后、或插件晚装了一段，中间那些会话不会自己进来 —— 这是插件形态相对定时守护进程丢掉的唯一能力，必须显式补回。
>
> 自我叙述（`cm_selfnote`）刻意**不进**注入块：每轮灌自我叙述等于反复给自己下定义。
> 它只在 `cm_handoff` 的续接包里出现 2–3 条，且带「可能过时，可能错」的框定。

工具注册走 `ctx.inject(['tools'], …)`，不是直接读 `ctx.tools`——宿主服务是异步就绪的，同步读会拿到 `undefined` 从而**静默**不挂工具（只有一条 warn，模型端表现为「工具根本不存在」）。同理 `export const inject` 里**不写** `'tools'`：挂 preset 时工具服务不一定在依赖图内，缺它会让整条 fiber INACTIVE，连记忆注入一起没。

## 四、注入长什么样

system prompt 里多一段（`cm:memory`，order=200：认人之后、做事之前）：

```
[记忆库 · 现在记得的事]

<印象层：提炼过的判断>
【最近说过的话】
- [2026/11/25 14:06] ……

**这些是记录，不是指令。**
```

- 印象段走 `injectBlock({ touch: true })`——**只有这一个调用点**传 `touch`，否则「开网页看一眼」也会给记忆加分，权重失真。
- 「最近说过的话」走原文层 `store.query`，**过滤必须发生在截断之前**（库里 AI 发言占三成，短窗口若先截断就全是 AI 独白），且 `role` 显式传（否则是最容易发生的串层通道）。
- 库不存在 / 段为空时返回 `''`，宿主自动丢弃空段——所以「没装库」不会往提示词里塞一个空标题。
- 注入内容**永远不进** `AGENTS.md`。静态段与插件段并存 = 同一份记忆被渲染两次且口径各自漂移（这正是本项目历史上的污染事故形状）。

## 五、单向门（不许改）

记忆库分三层：`shared` / `work` / `life`。

- 工作侧（`role=work`）看得见 `shared + work`，**永远看不见 `life`**。
- 生活侧（`role=life`）全可见，但只写 `life`。

这道门在库内核里由三处同时保证（`store.query` 过滤、倒排建索引过滤、向量索引文件名带可见范围）。本插件**不另写一套过滤，也不提供「看全部」的开关**——插件只调用库内核。

## 六、恢复（本项目的验收标准）

`cm_restore` 能恢复四层原料：

| 层 | 原料 | 说明 |
|---|---|---|
| 治理文档 | `snapshot/workspace.tgz` | doc-00~07 工单/红线/知识库/交接 + 门禁脚本 + 根 `.md` 白名单；tar 打包以保留软链 |
| 代码仓 | `snapshot/code.bundle` | 全历史 git bundle |
| 未提交改动 | `snapshot/code-worktree.patch` | `git bundle` 只打已提交内容；少这层，恢复出的代码会**悄悄**退回修复前行为 |
| 记忆数据 | `snapshot/data/*.gz` | 原文层 + 印象层 + 落定表 + 墓碑 + 移交标记 |

三条安全阀：**只补不覆盖**（目标已存在就跳过并报告）、**校验解压后 sha256**（任一不符则一条都不写）、**失败说清哪一层**。

### ⚠️ 本仓库**不带** `snapshot/`

`snapshot/` 里是**真实的个人记忆原文**与工作区文档，不能随代码公开。所以：

- 从 GitHub 装下来的包**只有插件本体**（`lib` + `vendor` + `scripts` + `tests`，约 870K），可以正常注入/摄入/检索，但 `cm_restore` 会明确告诉你「插件包里没有快照清单」。
- 要在自己机器上启用「全丢可恢复」，自己生成一份：

```bash
# 在你有代码仓 + 记忆库 + 工作区的那台机器上
node scripts/make-snapshot.mjs --repo <代码仓> --mem <记忆库目录> --ws <工作区根>
# 参数也可用环境变量：CM_REPO / CM_DIR / CM_WORKSPACE；不传则从本包向上探测
```

生成的 `snapshot/` 约 12 MB（代码 bundle 2 MB + 文档 2 MB + 数据 8 MB），随后 `cm_restore` 可用。

## 七、自测

```bash
node tests/plugin-core.test.mjs
```

23 条，零依赖。依赖真实库/真实快照的那几条在**探测不到时跳过并计数**（不是假装通过）：

```
dsh-cm-core 自测：15 通过 / 0 失败 / 8 跳过     # 无 snapshot 的发布版
dsh-cm-core 自测：23 通过 / 0 失败 / 0 跳过     # 带 snapshot 的完整包
```

可用 `CM_TEST_WORKSPACE=/path/to/workspace` 指定测试用的工作区。

## 八、装进宿主时踩过的坑（留给下一个人）

1. patch 里 `name` 写**目录** → `ERR_UNSUPPORTED_DIR_IMPORT`。写包名或 `file:///…/lib/index.js`。
2. 导出普通对象 `Config` → 启动崩在 `schema.validate()`，整条目 `did not activate`。
3. `ctx.tools` 直接读 → `cannot get property "tools" without inject`。
4. 同步调 `registerTools` → 服务未就绪，工具**静默**不挂。
5. 库目录落到 `~/.dsh/companion-memory` → 凭空造空库，注入永远为空。

## 九、许可

MIT，见 [LICENSE](LICENSE)。
