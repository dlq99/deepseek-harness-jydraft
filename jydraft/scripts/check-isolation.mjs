#!/usr/bin/env node
/**
 * check-isolation.mjs —— 检查「隔离」有没有被破坏。
 *
 * 隔离的含义（见 jydraft/docs/01-上游隔离策略.md）：
 *   **`jydraft/` 之外的任何文件，都必须与基线提交一模一样。**
 *
 * 为什么这条要能自动检查：隔离不是一次性决定，是**每天都要维持的状态**。
 * 一旦某次改动顺手碰了 `packages/` 里的一行，你就从「零分叉」变成「有一处分叉」，
 * 而「按需从上游拉一个修复」这个选项就开始变贵。**这种漂移没有检查是发现不了的。**
 *
 * 检查四件事：
 *   1. 基线提交记录存在，且指向一个真实的 commit
 *   2. **基线提交的 tree 等于记录的上游 tree** —— 证明基线没被污染
 *   3. `jydraft/` 之外没有未提交的改动
 *   4. `jydraft/` 之外没有已提交的改动（相对基线提交）
 *
 * 第 2 条是历史压成一条之后新增的：基线提交的 tree 直接复用了上游 HEAD 的 tree 对象，
 * 所以 **tree SHA 就是「这是纯净上游」的密码学证据**，不需要上游历史就能核。
 *
 * 用法：
 *   node jydraft/scripts/check-isolation.mjs          检查
 *   node jydraft/scripts/check-isolation.mjs --list    列出被碰过的文件
 *
 * 零依赖：只用 node:child_process 跑 git。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const HERE = path.dirname(url.fileURLToPath(import.meta.url))
const FORK = path.resolve(HERE, '../..')
const POINT_FILE = path.join(FORK, 'jydraft/FORK_POINT')
/** 我们自己东西的唯一目录。**其它任何地方都不该被改。** */
const OURS = 'jydraft/'

/**
 * 跑 git。
 *
 * **`-c core.quotepath=false` 是必须的**：默认情况下 git 会把非 ASCII 路径转义成
 * `"jydraft/docs/00-\344\273\243..."` 并加引号，于是 `startsWith('jydraft/')` 判 false，
 * 中文文件名的正常改动会被误报成「隔离被破坏」。
 */
const git = (...args) => {
  try {
    return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
      cwd: FORK,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    return `__GIT_ERROR__ ${error.stderr?.toString().trim() ?? error.message}`
  }
}

const problems = []
const notes = []
const verbose = process.argv.includes('--list')

// ---------------------------------------------------------------- 1 & 2. 基线

let baseline = null
let expectedTree = null

if (!fs.existsSync(POINT_FILE)) {
  problems.push(`缺少 ${path.relative(FORK, POINT_FILE)} —— 隔离策略要求记录基线提交`)
} else {
  const text = fs.readFileSync(POINT_FILE, 'utf8')
  baseline = text.trim().split('\n')[0].split(/\s+/)[0]

  // 从注释里取记录的上游 tree
  const treeLine = /^#\s*tree\s+([0-9a-f]{7,40})\s*$/m.exec(text)
  expectedTree = treeLine?.[1] ?? null

  if (!/^[0-9a-f]{7,40}$/.test(baseline)) {
    problems.push(`FORK_POINT 第一行不是 commit sha：${JSON.stringify(baseline)}`)
    baseline = null
  } else {
    const type = git('cat-file', '-t', baseline).trim()
    if (type.startsWith('__GIT_ERROR__') || type !== 'commit') {
      problems.push(`FORK_POINT 指向的 ${baseline} 不是本仓库里的 commit`)
      baseline = null
    } else {
      const desc = git('log', '-1', '--format=%h %ad %s', '--date=short', baseline).trim()
      notes.push(`基线提交: ${desc}`)
    }
  }

  // 第 2 条：基线 tree 必须是记录的上游 tree
  if (baseline && expectedTree) {
    const actual = git('rev-parse', `${baseline}^{tree}`).trim()
    if (actual !== expectedTree) {
      problems.push(
        `基线提交的 tree 与记录的上游 tree 不一致！\n` +
          `      期望 ${expectedTree}\n` +
          `      实际 ${actual}\n` +
          `      → 基线被污染了（或 FORK_POINT 里的 tree 记错了）。`,
      )
    } else {
      notes.push(`基线 tree 未被污染 ✓  ${actual}`)
    }
  } else if (baseline && !expectedTree) {
    problems.push('FORK_POINT 里没有记录上游 tree（`# tree <sha>`），无法验证基线是否纯净')
  }
}

// ---------------------------------------------------------------- 3. 未提交改动

const dirty = git('status', '--porcelain')
if (dirty.startsWith('__GIT_ERROR__')) {
  problems.push(dirty)
} else {
  const lines = dirty.split('\n').filter(Boolean)
  const outside = lines.filter((l) => {
    // porcelain 格式：XY<space>PATH（重命名是 `XY old -> new`）
    const p = l.slice(3).split(' -> ').pop()
    return !p.startsWith(OURS)
  })
  if (outside.length) {
    problems.push(`jydraft/ 之外有 ${outside.length} 个未提交改动：`)
    for (const l of outside.slice(0, 30)) problems.push(`    ${l}`)
    if (outside.length > 30) problems.push(`    … 其余 ${outside.length - 30} 个`)
  } else if (lines.length) {
    notes.push(`未提交改动 ${lines.length} 个，全部在 ${OURS} 内 ✓`)
  }
}

// ---------------------------------------------------------------- 4. 已提交改动

if (baseline) {
  const committed = git('diff', '--name-only', `${baseline}..HEAD`)
  if (committed.startsWith('__GIT_ERROR__')) {
    problems.push(committed)
  } else {
    const files = committed.split('\n').filter(Boolean)
    const outside = files.filter((f) => !f.startsWith(OURS))
    if (outside.length) {
      problems.push(`相对基线提交，jydraft/ 之外有 ${outside.length} 个文件被改过：`)
      for (const f of outside.slice(0, 30)) problems.push(`    ${f}`)
      if (outside.length > 30) problems.push(`    … 其余 ${outside.length - 30} 个`)
      problems.push('  → 隔离已破坏。见 jydraft/docs/01-上游隔离策略.md 的「破坏隔离之后怎么办」')
    } else {
      notes.push(`相对基线提交，改动全部在 ${OURS} 内（${files.length} 个文件）✓`)
    }
  }
}

// ---------------------------------------------------------------- 报告

console.log('')
for (const n of notes) console.log(`  ${n}`)

if (verbose) {
  console.log('\n  jydraft/ 内的文件：')
  const tracked = git('ls-files', OURS).split('\n').filter(Boolean)
  for (const f of tracked) console.log(`    ${f}`)
  const untracked = git('status', '--porcelain', '--untracked-files=all', OURS)
    .split('\n')
    .filter((l) => l.startsWith('??'))
  if (untracked.length) {
    console.log('\n  未纳入版本控制的：')
    for (const l of untracked) console.log(`    ${l.slice(3)}`)
  }
}

if (problems.length) {
  console.log(`\n✗ 隔离检查未通过（${problems.length} 项）：`)
  for (const p of problems) console.log(`  ${p}`)
  process.exit(1)
}

console.log('\n✓ 隔离完好：jydraft/ 之外与基线提交一致，且基线 tree 是纯净上游')
