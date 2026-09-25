# jydraft

**让「创意 → 可编辑视频草稿」这条路成立。**

输入是需求、素材和通用库；输出是一份**剪映能打开、人能继续编辑的草稿**。AI 承担机械劳动，人补关键判断。

这个仓库是 jydraft 的运行宿主：一份 **DeepSeek Harness（DSH）的 fork**，加上我们全部的定制工作。

---

## 为什么建在 DSH 上

这个产品里最难的部分不是视频创作业务，是 **Agent 本身**——理解意图、规划任务、调用工具。自己写一个足够强的 Agent，比写剪辑编排难得多。

DSH 恰好提供了这件事，而且它的扩展面足够深：**不用改它的源码，就能把它定制成一个专用 Agent。**

| 我们要的 | DSH 现成的机制 |
|---|---|
| 一个项目 = 一次创作 | **workspace**，带「归属于它的会话的有序账本」 |
| 一个阶段 = 一个会话 | `ctx.agents.create({ sessionId, agentPreset, parentAgent })` |
| 每个阶段有自己的身份与工具 | **agent preset** = 一份子插件行列表；`dsh-persona` 的 `complete: true` 可换掉整个系统提示词 |
| 每个阶段有自己的界面 | **slot** 系统，五个顶级槽位（`sidebar` / `main` / `rightbar` / `shell.overlay` / `shell.leading`） |
| 人在回路 | 会话本身就是人可回看、回改、回跑的地方 |

**这些都不是「打外挂」，是框架设计好的扩展点。** 已有先例：`dsh-web` 的 `dsh-liangshen` 做了 persona 替换 + 自定义注入 + 工具面裁剪 + UI 控件，README 里写着 *Built entirely on the official NPM SDK — no dsh source changes*。

---

## 架构：宿主与核心分开

```
┌─────────────────────────────────────────────────────────────┐
│  DSH 宿主（本仓库，源码不改）                                 │
│    preset 层   每阶段一个：身份 + 工具 + 护栏 + 压缩 + 技能    │
│    插件层      注册工具，agent 可调                          │
│    界面层      slot 贡献                                     │
└──────────────────────────┬──────────────────────────────────┘
                           │ MCP（DSH 是客户端）
┌──────────────────────────▼──────────────────────────────────┐
│  进程外：jydraft 核心（已完成的地基）                         │
│    原子操作 · 保真层 · 引用层 · 落地层 · 加密 · 通用库         │
│    M1 求解（规则）· M1 编译（S1–S4）                          │
└─────────────────────────────────────────────────────────────┘
```

**分界线的判据是任务书自己的 R5**——「替代执行 → 直接自动；替代判断 → 保留人工干预点」：

```
创意 · (a) 视频理解 · (b) 片段筛选 · (c) 切片方案  → 判断 → DSH（preset + 插件 + 界面）
(d) 求解 · (e) 生成草稿 · 保真层/原子操作/编译     → 执行 → 进程外，DSH 通过 MCP 调它
```

**为什么核心不进 DSH**：R6 要求核心不与剪映耦合；同一句话对宿主成立。核心一旦 `import '@deepseek-ai/cordis'`，就同时绑死了剪映和 DSH 两个会变的东西——而 DSH 的 `package.json` 写着 `0.1.7-rc.2`，`AGENTS.md` 原文是 *Public APIs are pre-stable; update every consumer*。

---

## 目录：哪些是我们的

**我们所有的东西都在 `jydraft/` 一个目录里。它之外的一切都是上游的，一行都不改。**

| 路径 | 是谁的 |
|---|---|
| **`jydraft/`** | **我们的。** 见 [`jydraft/README.md`](jydraft/README.md) |
| `packages/` `apps/` `vendor/` `docs/` … | 上游 DSH。**读它、理解它，但不改它** |

这条纪律有两个好处：

1. **diff 可读**：`git diff <fork-point>..HEAD --stat` 只显示 `jydraft/`。
2. **上游升级便宜**：没碰它的代码，换基线时冲突面理论上是零。

**可自动检查**：

```sh
node jydraft/scripts/check-isolation.mjs
```

---

## 跑起来

已验证于 `477b4f4205`（`rel/dsh-0.1.7-rc.2`）。详细记录见 [`jydraft/baseline/README.md`](jydraft/baseline/README.md)。

```sh
# 环境：node ^22.19.0 || >=24.0.0　·　pnpm 11.7.0
pnpm install --frozen-lockfile     # 约 5 分钟，1.4 GB

pnpm run build                     # 构建全部（tsc + tsdown + web 前端）

# 启动（默认 127.0.0.1:3080；被占用时换端口）
node --import tsx/esm apps/cli/src/bin.ts web --no-open --port 3081
```

启动后会打印**带 token 的 URL**：

```
dsh web: http://127.0.0.1:3081/?token=…
```

**验证它真的在服务**（不只是端口开着）：

```sh
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3081/
# 期望 401 —— 认证在生效
```

### 两个环境事实

- **`DSH_HOME` 默认在 `~/.dsh`** —— 状态（profiles / sessions / credentials / logs）在**用户主目录**，不在仓库里。这跟「U 盘便携」的诉求直接相关，后面要处理。
- **默认 `web` profile 挂 184 个插件条目**（其中 59 个默认关闭），来自 312 个叶子包。真实挂载清单在 `jydraft/baseline/dump-config-web.txt`。

---

## 三条纪律

1. **`jydraft/` 之外不改任何东西。** 需要改 `packages/` 时先问扩展点能不能做到——调研结论是绝大多数能。提交前跑 `check-isolation.mjs`。
2. **不改仓库根的配置**（`.rgignore` / `tsconfig` / `package.json`）。那是隔离之外。要配置搜索就用 `--ignore-file`。
3. **生成物不要手改。** `jydraft/docs/00-*` 与 `jydraft/data/*` 由脚本生成，改规则改脚本。

---

## 搜索：别在大海里捞针

这个仓库有 13,850 个文件。**日常你真正要读的是 21 个包 + `jydraft/`。**

```sh
# 只在关心的目录里搜 —— 实测比全仓库搜少 95% 噪声
rg <pattern> $(node jydraft/scripts/attention-map.mjs --paths)
```

完整分层见 [`jydraft/docs/00-代码关注度地图.md`](jydraft/docs/00-代码关注度地图.md)。

---

## 文档

| 文档 | 是什么 |
|---|---|
| [`docs/00-代码关注度地图.md`](docs/00-代码关注度地图.md) | **哪些代码是我的、哪些不用关注**（生成物，勿手改） |
| [`docs/01-上游隔离策略.md`](docs/01-上游隔离策略.md) | 为什么不配 upstream remote、怎么按需拉一个修复、破坏隔离后怎么办 |
| [`baseline/README.md`](baseline/README.md) | 基线记录：验证过的三步、真实挂载规模、怎么复现 |

**待写**（`docs/02-*` 起）：插件清单与开发方案 · 插件开发规范 · 阶段契约。

### 这个目录里有什么

| 路径 | 是什么 |
|---|---|
| `FORK_POINT` | 从哪个 upstream commit 分叉。**不要手改第一行** |
| `README.md` | 本文件 —— 项目入口 |
| `docs/` | 人读的文档 |
| `data/` | 机读产物（生成物） |
| `baseline/` | 基线与 `--dump-config` 快照 |
| `scripts/` | 生成器与检查器，**零依赖**，只用 node 内置模块 |

---

## 当前状态

```
fork point    477b4f4205  2026-09-24  Merge PR #5180 from rel/dsh-0.1.7-rc.2
分叉程度      零（只有 jydraft/ 是新的）
基线          安装 ✓  构建 ✓  启动 ✓（HTTP 200，认证生效）
上游 remote   不配（见隔离策略）
```

**下一步**：写阶段契约（三份产物文件的 schema），然后从 `(c) 切片方案` 这个阶段开始做插件——
它是判断最密集的一段，**如果这一段的界面做不出「人看得懂、改得动」，整个「阶段=会话」的架构假设就不成立**。这个结论越早拿到越便宜。
