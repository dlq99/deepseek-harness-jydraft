#!/usr/bin/env node
/**
 * attention-map.mjs —— 生成「代码关注度地图」。
 *
 * 解决什么问题：这个 fork 有 54 个包组、300+ 个包、13,000+ 个文件。人（和 agent）
 * 在里面工作时最大的成本不是看不懂某段代码，是**不知道该看哪里、哪些碰了会出事**。
 *
 * 这个脚本从**真实数据**推出关注度分层，而不是靠人凭印象写一份清单：
 *
 *   1. 枚举全部叶子包（packages/xx/yy/package.json）
 *   2. 解析各 bundle 的 cordis.patch.yml → 算出**哪些包真的会被挂载**
 *   3. 从 package.json 的 dependencies + peerDependencies 建内部依赖图
 *   4. 算「被挂载的包的依赖闭包」——这是**真正会被加载的集合**
 *   5. 按规则分层
 *
 * 输出：
 *   jydraft/docs/00-代码关注度地图.md    人读
 *   jydraft/data/attention-map.json      机读
 *   jydraft/data/rgignore  建议追加到 .rgignore 的块
 *
 * 查询：
 *   node jydraft/scripts/attention-map.mjs                   生成全部
 *   node jydraft/scripts/attention-map.mjs --tier 4          只看某层
 *   node jydraft/scripts/attention-map.mjs --closure dsh-tools
 *   node jydraft/scripts/attention-map.mjs --who-depends-on dsh-agent
 *   node jydraft/scripts/attention-map.mjs --mounted         只看会被挂载的
 *
 * 零依赖：只用 node:fs / node:path，不装任何东西（fork 里没有 node_modules）。
 */
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const HERE = path.dirname(url.fileURLToPath(import.meta.url))
const FORK = path.resolve(HERE, '../..')
const OUT_DOC = path.join(FORK, 'jydraft/docs/00-代码关注度地图.md')
const OUT_JSON = path.join(FORK, 'jydraft/data/attention-map.json')
const OUT_IGNORE = path.join(FORK, 'jydraft/data/rgignore')

// ---------------------------------------------------------------- 分层定义
//
// T1/T2 是**手写但会被校验**的：脚本会断言它们真实存在，且（T1）确实被挂载。
// 剩下的层由数据推出。

/** T1：写插件时会 `import` 的包。改这些等于改你的编程接口。 */
const T1_IMPORT = [
  ['@deepseek-ai/cordis', '插件框架本身。`Context` 类型、`Service` 基类'],
  ['@deepseek-ai/dsh-tools', '`defineTool` —— 注册工具的唯一入口'],
  ['@deepseek-ai/schemastery', '`Schema` —— 插件配置的声明式校验'],
  ['@deepseek-ai/dsh-agent', '`Agent` / `AgentRegistry` —— 建会话、跨会话投消息'],
  ['@deepseek-ai/dsh-system-prompt', '`PromptSection` / `PromptContext` —— 注入'],
  ['@deepseek-ai/dsh-web', '`WebFetchResult` 等 web 侧类型'],
  ['@deepseek-ai/dsh-session', '会话与事件类型'],
  ['@deepseek-ai/dsh-jobs', '后台任务（转写、编译要用）'],
]

/** T2：影响架构判断的机制。不一定 import，但做决定前要理解。 */
const T2_UNDERSTAND = [
  ['@deepseek-ai/dsh-agent-loop', 'agent 循环本身。**规则：不改 loop，只用扩展点**'],
  ['@deepseek-ai/dsh-base', 'base bundle —— 决定默认挂载什么'],
  ['@deepseek-ai/dsh-web-app', 'web bundle —— 同上，web 侧'],
  ['@deepseek-ai/dsh-agent-preset', 'preset = 子插件列表，阶段定制的机制'],
  ['@deepseek-ai/dsh-agent-preset-registry', 'preset 的选择与代际管理'],
  ['@deepseek-ai/dsh-persona', '阶段身份。`complete: true` 换掉整个系统提示词'],
  ['@deepseek-ai/dsh-workspace', '工作区 = 项目。带会话有序账本'],
  ['@deepseek-ai/dsh-mcp-client', 'jydraft 核心的接入点（MCP 客户端）'],
  ['@deepseek-ai/dsh-client-ui-slots', 'slot 注册表 —— 界面贡献的入口'],
  ['@deepseek-ai/dsh-client-ui-layout', '三列 AppFrame + `main` keyed slot'],
  ['@deepseek-ai/dsh-subprocess', '管外部进程（ASR、jydraft 核心）'],
  ['@deepseek-ai/dsh-compaction-basic', '压缩策略 —— preset 里会挂'],
  ['@deepseek-ai/dsh-skill-filesystem', '技能来源 —— preset 里会挂'],
]

/** T4a：整组都可以无视。这些组从不进入产品挂载。 */
const T4_GROUPS = new Set(['test-support', 'experimental'])

/** 顶层目录里与「产品运行」无关的部分。 */
const T4_TOPLEVEL = [
  ['benchmarks', '性能基准。只有 CI 跑'],
  ['website', 'VitePress 文档站'],
  ['python', 'Python SDK / 运行时'],
  ['native', '原生插件源码（node-addon）'],
  ['snapshots', '录制的会话回放夹具（测试用）'],
  ['docs', '官方文档。**读它，但不改它**'],
  ['.agents', 'agent 工作流与决策记录（历史档案）'],
  ['.github', 'CI 与 issue 模板'],
  ['patches', 'pnpm patch 文件'],
  ['vendor', 'vendored 的 Cordis / cosmokit / schemastery 源码副本'],
]

// ---------------------------------------------------------------- 工具

const read = (p) => fs.readFileSync(p, 'utf8')
const exists = (p) => fs.existsSync(p)
const short = (name) => name.replace('@deepseek-ai/', '')

/** 从 cordis.patch.yml 里抽出所有 name: 值，并剥掉子路径。 */
function parseBundlePatch(file) {
  if (!exists(file)) return []
  const out = []
  for (const line of read(file).split('\n')) {
    const m = /^\s*-?\s*name:\s*'?([^'\s#]+)'?/.exec(line)
    if (!m) continue
    // `@deepseek-ai/dsh-plugin-manager/tools` → `@deepseek-ai/dsh-plugin-manager`
    const parts = m[1].split('/')
    const pkg = m[1].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
    out.push(pkg)
  }
  return out
}

/** 内部依赖（workspace: 协议）。 */
function internalDeps(pkg) {
  const out = new Set()
  for (const field of ['dependencies', 'peerDependencies']) {
    for (const [name, range] of Object.entries(pkg[field] ?? {})) {
      if (typeof range === 'string' && range.startsWith('workspace:')) out.add(name)
    }
  }
  return out
}

// ---------------------------------------------------------------- 枚举包

const packages = new Map() // name -> { name, dir, group, deps }
const groups = new Map() // group -> [name]

for (const group of fs.readdirSync(path.join(FORK, 'packages')).sort()) {
  const groupDir = path.join(FORK, 'packages', group)
  if (!fs.statSync(groupDir).isDirectory()) continue
  for (const leaf of fs.readdirSync(groupDir).sort()) {
    const pkgFile = path.join(groupDir, leaf, 'package.json')
    if (!exists(pkgFile)) continue
    let pkg
    try {
      pkg = JSON.parse(read(pkgFile))
    } catch {
      continue
    }
    if (!pkg.name) continue
    packages.set(pkg.name, {
      name: pkg.name,
      dir: `packages/${group}/${leaf}`,
      group,
      private: pkg.private === true,
      deps: [...internalDeps(pkg)],
    })
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group).push(pkg.name)
  }
}

// vendor 也是内部包（rescope 过的），单独列
const vendorPkgs = []
if (exists(path.join(FORK, 'vendor'))) {
  for (const v of fs.readdirSync(path.join(FORK, 'vendor')).sort()) {
    const pkgFile = path.join(FORK, 'vendor', v, 'package.json')
    if (!exists(pkgFile)) continue
    try {
      const pkg = JSON.parse(read(pkgFile))
      if (pkg.name) vendorPkgs.push({ name: pkg.name, dir: `vendor/${v}` })
    } catch {
      /* 忽略坏文件 */
    }
  }
}

// ---------------------------------------------------------------- 挂载集合

const bundleDir = path.join(FORK, 'packages/bundle')
const bundles = {}
for (const b of fs.readdirSync(bundleDir).sort()) {
  const file = path.join(bundleDir, b, 'cordis.patch.yml')
  if (!exists(file)) continue
  bundles[b] = [...new Set(parseBundlePatch(file))]
}

// web profile = base + web-app；headless = base + headless
const webMounted = new Set([...(bundles.base ?? []), ...(bundles['web-app'] ?? [])])
const headlessMounted = new Set([...(bundles.base ?? []), ...(bundles.headless ?? [])])
const anyMounted = new Set([...webMounted, ...headlessMounted, ...(bundles['sdk-minimal'] ?? [])])

// ---------------------------------------------------------------- 依赖闭包
//
// 「真正会被加载的集合」= 被挂载的包 + 它们的内部依赖闭包。

function closureOf(names) {
  const seen = new Set()
  const stack = [...names]
  while (stack.length) {
    const n = stack.pop()
    if (seen.has(n)) continue
    seen.add(n)
    const p = packages.get(n)
    if (p) for (const d of p.deps) if (!seen.has(d)) stack.push(d)
  }
  return seen
}

const loadedByWeb = closureOf(webMounted)
const loadedByHeadless = closureOf(headlessMounted)
const loadedAny = new Set([...loadedByWeb, ...loadedByHeadless, ...closureOf(bundles['sdk-minimal'] ?? [])])

// 直接挂载（bundle 行指向的包）与依赖闭包是两个不同的数：
//   mounted = 配置里点名挂的
//   closure = 加上它们的内部依赖，也就是真正会进运行时的集合
const mountedDistinctWeb = new Set([...webMounted].filter((n) => packages.has(n)))

// ---------------------------------------------------------------- 分层

const t1 = new Set(T1_IMPORT.map(([n]) => n))
const t2 = new Set(T2_UNDERSTAND.map(([n]) => n))

const problems = []
for (const [n] of [...T1_IMPORT, ...T2_UNDERSTAND]) {
  if (!packages.has(n) && !vendorPkgs.some((v) => v.name === n)) {
    problems.push(`分层清单里的 ${n} 在仓库里找不到`)
  }
}

function tierOf(name) {
  // T1/T2 先判：这两个清单里的包可能落在 vendor/ 而不是 packages/，
  // 而「你会 import 它」这件事比「它在哪」更重要。
  if (t1.has(name)) return 'T1'
  if (t2.has(name)) return 'T2'
  const p = packages.get(name)
  if (!p) return 'T-vendor'
  if (T4_GROUPS.has(p.group)) return 'T4a'
  if (!loadedAny.has(name)) return 'T4b'
  return 'T3'
}

const tiers = { T0: [], T1: [], T2: [], T3: [], T4a: [], T4b: [], 'T-vendor': [] }
for (const name of packages.keys()) tiers[tierOf(name)].push(name)
// T1/T2 里的 vendor 包（如 cordis / schemastery）已经归到 T1/T2，别再进 T-vendor
for (const n of [...t1, ...t2]) {
  const t = tierOf(n)
  if (!tiers[t].includes(n)) tiers[t].push(n)
}
for (const v of vendorPkgs) {
  if (!t1.has(v.name) && !t2.has(v.name) && !tiers['T-vendor'].includes(v.name)) tiers['T-vendor'].push(v.name)
}
for (const k of Object.keys(tiers)) tiers[k].sort()

// 分层必须覆盖到每一个包，一个不重不漏
const classified = Object.values(tiers).flat()
if (classified.length !== packages.size + vendorPkgs.length) {
  problems.push(
    `分层覆盖数 ${classified.length} ≠ 叶子包 ${packages.size} + vendor ${vendorPkgs.length} = ${packages.size + vendorPkgs.length}`,
  )
}
if (new Set(classified).size !== classified.length) {
  problems.push('分层里有重复归类的包')
}

// ---------------------------------------------------------------- 查询模式

const argv = process.argv.slice(2)
const flag = (n) => {
  const i = argv.indexOf(`--${n}`)
  return i > -1 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : null
}

const tierArg = flag('tier')
if (tierArg) {
  const key = `T${tierArg}`
  console.log(`\n${key}（${tiers[key]?.length ?? 0} 个）`)
  for (const n of tiers[key] ?? []) console.log(`  ${short(n)}`)
  process.exit(0)
}

const closureArg = flag('closure')
if (closureArg) {
  const want = closureArg.startsWith('@') ? closureArg : `@deepseek-ai/${closureArg}`
  const c = closureOf([want])
  console.log(`\n${want} 的依赖闭包（${c.size} 个）`)
  for (const n of [...c].sort()) console.log(`  ${short(n)}`)
  process.exit(0)
}

const whoArg = flag('who-depends-on')
if (whoArg) {
  const want = whoArg.startsWith('@') ? whoArg : `@deepseek-ai/${whoArg}`
  const rev = [...packages.values()].filter((p) => p.deps.includes(want))
  console.log(`\n依赖 ${want} 的包（${rev.length} 个）—— 改它的爆炸半径`)
  for (const p of rev.sort((a, b) => a.dir.localeCompare(b.dir))) console.log(`  ${p.dir}  (${short(p.name)})`)
  process.exit(0)
}

if (flag('mounted')) {
  console.log(`\nweb profile 会被加载的包（${loadedByWeb.size} 个）`)
  for (const n of [...loadedByWeb].sort()) console.log(`  ${short(n)}`)
  process.exit(0)
}

// 日常最有用的一条：只在「你真正关心的目录」里搜。
//   rg <pattern> $(node jydraft/scripts/attention-map.mjs --paths)
//
// 比 --ignore-file 更有效：ignore 只能排掉 T4（36 个包），而 T3 有 230 个。
// 真正让搜索安静下来的是**只搜 21 个包 + jydraft/**。
if (flag('paths')) {
  const dirs = []
  for (const n of [...t1, ...t2]) {
    const p = packages.get(n)
    if (p) dirs.push(p.dir)
  }
  dirs.push('jydraft')
  console.log(dirs.sort().join(' '))
  process.exit(0)
}

// ---------------------------------------------------------------- 生成文档

const line = []
const w = (s = '') => line.push(s)
const pct = (n, d) => `${((n / d) * 100).toFixed(1)}%`

w('# 00 · 代码关注度地图')
w()
w('> **本文件由 `jydraft/scripts/attention-map.mjs` 生成，不要手改。**')
w('> 重新生成：`node jydraft/scripts/attention-map.mjs`')
w()
w('这张图回答一个问题：**哪些代码是我的，哪些是不用关注的。**')
w()
w('分层不是凭印象写的，是从真实数据推出来的：枚举全部叶子包 → 解析各 bundle 的 `cordis.patch.yml`')
w('→ 算出哪些包真的会被挂载 → 再算这些包的依赖闭包（真正会被加载的集合）。')
w()

w('## 一眼看全')
w()
w('| 层 | 是什么 | 包数 | 你要做什么 |')
w('|---|---|---:|---|')
w(`| **T0** | 你自己的代码（\`jydraft/\`） | — | **随便改** |`)
w(`| **T1** | 你会 \`import\` 的接口 | ${tiers.T1.length} | **改这些等于改你的编程接口**，要慎重 |`)
w(`| **T2** | 影响架构判断的机制 | ${tiers.T2.length} | **读它、理解它，但不改它** |`)
w(`| **T3** | 被挂载、但你不碰 | ${tiers.T3.length} | 知道它在就行 |`)
w(`| **T4a** | 整组可无视 | ${tiers.T4a.length} | **不用看** |`)
w(`| **T4b** | 未被任何 profile 加载 | ${tiers.T4b.length} | **不用看** |`)
w(`| **T-vendor** | vendored 的框架源码 | ${tiers['T-vendor'].length} | 只在追框架 bug 时看 |`)
w()
w(`合计叶子包 **${packages.size}** 个，分布在 **${groups.size}** 个包组。`)
w()
w('两个数要分清：')
w()
w(`- **直接挂载**（\`web\` profile 的 bundle 行点名挂的）：**${mountedDistinctWeb.size}** 个`)
w(`- **依赖闭包**（再加上它们的内部依赖 —— 真正会进运行时的集合）：**${loadedByWeb.size}** 个（${pct(loadedByWeb.size, packages.size)}）`)
w()
w(`所以 **${tiers.T4b.length}** 个包（${pct(tiers.T4b.length, packages.size)}）**根本不会被加载**。`)
w()
w('> **一个必须说清的点**：这 ' + tiers.T4b.length + ' 个包是「不加载」，不是「没被引用」——')
w('> 有些是测试支持、有些是备用 provider、有些是还没挂进默认 profile 的能力。')
w('> **它们是候选的「可无视」区，但不是「死代码」区。**')
w()

w('## T1 · 你会 import 的接口')
w()
w('**这八个包是你的编程接口。** 它们的类型定义会出现在你的插件代码里。')
w('改这些等于改你的 API —— 但注意：**你不需要改它们**，你要用的是它们。')
w()
w('| 包 | 目录 | 用来干什么 |')
w('|---|---|---|')
for (const [n, why] of T1_IMPORT) {
  const p = packages.get(n)
  w(`| \`${short(n)}\` | \`${p?.dir ?? '（vendor）'}\` | ${why} |`)
}
w()

w('## T2 · 影响架构判断的机制')
w()
w('**不一定 import，但做决定前要理解。** 尤其 `dsh-agent-loop` —— 框架的规则是')
w('「*Plugins, not loop changes*」：新行为放扩展点，不改 loop。')
w()
w('| 包 | 目录 | 为什么要理解 |')
w('|---|---|---|')
for (const [n, why] of T2_UNDERSTAND) {
  const p = packages.get(n)
  w(`| \`${short(n)}\` | \`${p?.dir ?? '（vendor）'}\` | ${why} |`)
}
w()

w('## T3 · 被挂载、但你不碰')
w()
w(`\`web\` profile 会加载、但不在 T1/T2 的包，共 ${tiers.T3.length} 个。**知道它在就行。**`)
w()
w('<details><summary>展开清单</summary>')
w()
for (const n of tiers.T3) {
  const p = packages.get(n)
  w(`- \`${short(n)}\` — \`${p.dir}\``)
}
w()
w('</details>')
w()

w('## T4a · 整组可无视')
w()
w(`这些组**从不进入产品挂载**：${[...T4_GROUPS].join(' · ')}`)
w()
for (const g of T4_GROUPS) {
  const list = groups.get(g) ?? []
  if (!list.length) continue
  w(`**\`packages/${g}/\`**（${list.length} 个）`)
  w()
  for (const n of list.sort()) w(`- \`${short(n)}\``)
  w()
}

w('## T4b · 未被任何 profile 加载')
w()
w(`这 ${tiers.T4b.length} 个包**不在 web / headless / sdk-minimal 的依赖闭包里**，也就是运行时根本不会加载。`)
w('**它们是候选的「可无视」区** —— 但如果将来要开某个能力，可能就会用到其中一个。')
w()
w('<details><summary>展开清单</summary>')
w()
const t4bByGroup = {}
for (const n of tiers.T4b) {
  const g = packages.get(n).group
  ;(t4bByGroup[g] ??= []).push(n)
}
for (const g of Object.keys(t4bByGroup).sort()) {
  w(`**\`packages/${g}/\`**（${t4bByGroup[g].length} 个）：${t4bByGroup[g].map(short).join(' · ')}`)
  w()
}
w('</details>')
w()

w('## T-vendor · vendored 的框架源码')
w()
w('`vendor/` 下是**上游框架源码的固定副本**（`@deepseek-ai/cordis`、`cosmokit`、`schemastery` 等）。')
w('它们被 rescope 成 `@deepseek-ai/*` 并由 workspace `link:` 引用。')
w('**你只在追框架自身的行为时才需要看它们** —— 平时它们就是你的依赖。')
w()
for (const v of vendorPkgs) w(`- \`${short(v.name)}\` — \`${v.dir}\``)
w()

w('## 顶层目录：哪些与「产品运行」无关')
w()
w('| 目录 | 是什么 | 关注度 |')
w('|---|---|---|')
for (const [d, why] of T4_TOPLEVEL) {
  w(`| \`${d}/\` | ${why} | ${d === 'docs' ? '**读，但不改**' : '无视'} |`)
}
w()

w('## 怎么用这张图')
w()
w('### 最有效的一条：只在关心的目录里搜')
w()
w('**这是「太吵」最直接的解法，比排除规则有效得多。**')
w()
w('实测（搜 `agent`）：')
w()
w('| 搜法 | 命中文件 |')
w('|---|---:|')
w('| 全仓库 | 3299 |')
w('| 加 `.rgignore` 排除 T4 | 2207（−33%） |')
w('| **只搜 T1+T2 的 21 个包 + `jydraft/`** | **173（−95%）** |')
w()
w('```sh')
w('# --paths 输出 T1+T2 的目录，直接喂给 rg')
w('rg <pattern> $(node jydraft/scripts/attention-map.mjs --paths)')
w('```')
w()
w('**为什么 scoped 比 ignore 有效**：ignore 只能排掉 T4（36 个包），而 T3 有 **230** 个。')
w('日常你真正要读的是那 **21 个包**，剩下的 291 个不需要出现在搜索结果里。')
w()
w('### 其它查询')
w()
w('```sh')
w('# 只看某一层')
w('node jydraft/scripts/attention-map.mjs --tier 4')
w()
w('# 改某个包之前，先看爆炸半径')
w('node jydraft/scripts/attention-map.mjs --who-depends-on dsh-agent')
w()
w('# 看某个包的完整依赖闭包')
w('node jydraft/scripts/attention-map.mjs --closure dsh-tools')
w()
w('# 列出 web profile 真正会加载的包')
w('node jydraft/scripts/attention-map.mjs --mounted')
w('```')
w()
w('### 全仓库搜索时排除噪声')
w()
w('`jydraft/data/rgignore` 是一份排除规则。**不要改仓库根的 `.rgignore`** —— 那属于 `jydraft/` 之外，会破坏隔离。')
w('用 `--ignore-file` 或环境变量引用它：')
w()
w('```sh')
w('rg --ignore-file jydraft/data/rgignore <pattern>')
w('# 或设一次，之后所有 rg 调用自动生效')
w('export RIPGREP_CONFIG_PATH=jydraft/data/rgignore')
w('```')
w()
w('它**刻意不排除** `docs/` 与 `vendor/` —— 前者是理解框架最该搜的地方，后者是追框架行为时要搜的地方。')
w('把这两个排掉会让「安静」变成「搜不到」。')
w()

// ---------------------------------------------------------------- 写盘

fs.mkdirSync(path.dirname(OUT_DOC), { recursive: true })
fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true })
fs.writeFileSync(OUT_DOC, line.join('\n') + '\n')

fs.writeFileSync(
  OUT_JSON,
  JSON.stringify(
    {
      note: '由 jydraft/scripts/attention-map.mjs 生成',
      counts: {
        packages: packages.size,
        groups: groups.size,
        vendor: vendorPkgs.length,
        mountedDistinct: mountedDistinctWeb.size,
        loadedByWeb: loadedByWeb.size,
        loadedByHeadless: loadedByHeadless.size,
        perTier: Object.fromEntries(Object.entries(tiers).map(([k, v]) => [k, v.length])),
      },
      bundles: Object.fromEntries(Object.entries(bundles).map(([k, v]) => [k, v.length])),
      tiers,
      packages: Object.fromEntries(
        [...packages.values()].map((p) => [p.name, { dir: p.dir, group: p.group, tier: tierOf(p.name), deps: p.deps }]),
      ),
    },
    null,
    1,
  ) + '\n',
)

// .rgignore 规则
//
// 只排除**真的不会去搜**的东西。刻意**不排除** docs/ 与 vendor/：
//   - docs/ 是理解框架最该搜的地方
//   - vendor/ 是追框架自身行为时要搜的地方
// 把这两个排除掉会让「安静」变成「搜不到」。
const ignore = []
ignore.push('# 由 jydraft/scripts/attention-map.mjs 生成 —— 搜索时跳过的噪声区')
ignore.push('#')
ignore.push('# 用法（不要改仓库根的 .rgignore，那会破坏隔离）：')
ignore.push('#   rg --ignore-file jydraft/data/rgignore <pattern>')
ignore.push('# 或设一次环境变量，之后所有 rg 调用自动生效：')
ignore.push('#   export RIPGREP_CONFIG_PATH=jydraft/data/rgignore')
ignore.push('')
ignore.push('# 与产品运行无关的顶层目录')
for (const [d] of T4_TOPLEVEL) {
  // docs / vendor / .agents 保持可搜（见上）
  if (d === 'docs' || d === 'vendor' || d === '.agents') continue
  ignore.push(`/${d}/`)
}
ignore.push('')
ignore.push('# 整组不参与产品挂载')
for (const g of T4_GROUPS) ignore.push(`/packages/${g}/`)
ignore.push('')
ignore.push('# 未被任何 profile 加载的包（要用时单独搜那个目录）')
for (const n of tiers.T4b) ignore.push(`/${packages.get(n).dir}/`)
ignore.push('')
ignore.push('# 归档的 agent notes（冻结的历史，不是当前依据）')
ignore.push('/.agents/notes/archived/')
fs.writeFileSync(OUT_IGNORE, ignore.join('\n') + '\n')

// ---------------------------------------------------------------- 报告

console.log(`\n叶子包 ${packages.size} 个 / 包组 ${groups.size} 个`)
console.log(`web profile 依赖闭包: ${loadedByWeb.size} 个（${pct(loadedByWeb.size, packages.size)}）`)
console.log('')
for (const [k, v] of Object.entries(tiers)) console.log(`  ${k.padEnd(9)} ${String(v.length).padStart(3)} 个`)
console.log('')
if (problems.length) {
  console.log('⚠ 分层清单的问题：')
  for (const p of problems) console.log(`  - ${p}`)
  console.log('')
}
console.log(`✓ ${path.relative(FORK, OUT_DOC)}`)
console.log(`✓ ${path.relative(FORK, OUT_JSON)}`)
console.log(`✓ ${path.relative(FORK, OUT_IGNORE)}`)
