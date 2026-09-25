#!/usr/bin/env node
/**
 * check-isolation.mjs —— 检查「隔离」有没有被破坏。
 *
 * 隔离的含义（见 jydraft/docs/01-上游隔离策略.md）：
 *   **`jydraft/` 之外的任何文件，都必须与 fork point 一模一样。**
 *
 * 为什么这条要能自动检查：隔离不是一次性决定，是**每天都要维持的状态**。
 * 一旦某次改动顺手碰了 `packages/` 里的一行，你就从「零分叉」变成「有一处分叉」，
 * 而「按需从上游拉一个修复」这个选项就开始变贵。**这种漂移没有检查是发现不了的。**
 *
 * 检查三件事：
 *   1. fork point 记录存在且指向一个真实的 commit
 *   2. `jydraft/` 之外没有未提交的改动
 *   3. `jydraft/` 之外没有已提交的改动（相对 fork point）
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

const git = (...args) => {
  try {
    return execFileSync('git', args, { cwd: FORK, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    return `__GIT_ERROR__ ${error.stderr?.toString().trim() ?? error.message}`
  }
}

const problems = []
const notes = []

// ---------------------------------------------------------------- 1. fork point

if (!fs.existsSync(POINT_FILE)) {
  problems.push(`缺少 ${path.relative(FORK, POINT_FILE)} —— 隔离策略要求记录 fork point`)
} else {
  const point = fs.readFileSync(POINT_FILE, 'utf8').trim().split('\n')[0].split(/\s+/)[0]
  if (!/^[0-9a-f]{7,40}$/.test(point)) {
    problems.push(`FORK_POINT 第一行不是 commit sha：${JSON.stringify(point)}`)
  } else {
    const check = git('cat-file', '-t', point)
    if (check.startsWith('__GIT_ERROR__') || check.trim() !== 'commit') {
      problems.push(`FORK_POINT 指向的 ${point} 不是本仓库里的 commit`)
    } else {
      const desc = git('log', '-1', '--format=%h %ad %s', '--date=short', point).trim()
      notes.push(`fork point: ${desc}`)
    }
  }
}

// ---------------------------------------------------------------- 2. 未提交改动

const dirty = git('status', '--porcelain')
if (dirty.startsWith('__GIT_ERROR__')) {
  problems.push(dirty)
} else {
  const lines = dirty.split('\n').filter(Boolean)
  const outside = lines.filter((l) => {
    // porcelain 格式：XY<space>PATH（重命名是 `XY old -> new`）
    const p = l.slice(3).split(' -> ').pop().replace(/^"|"$/g, '')
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

// ---------------------------------------------------------------- 3. 已提交改动

const point = fs.existsSync(POINT_FILE) ? fs.readFileSync(POINT_FILE, 'utf8').trim().split('\n')[0].split(/\s+/)[0] : null
if (point && !point.startsWith('__')) {
  const committed = git('diff', '--name-only', `${point}..HEAD`)
  if (committed.startsWith('__GIT_ERROR__')) {
    problems.push(committed)
  } else {
    const files = committed.split('\n').filter(Boolean)
    const outside = files.filter((f) => !f.startsWith(OURS))
    if (outside.length) {
      problems.push(`相对 fork point，jydraft/ 之外有 ${outside.length} 个文件被改过：`)
      for (const f of outside.slice(0, 30)) problems.push(`    ${f}`)
      if (outside.length > 30) problems.push(`    … 其余 ${outside.length - 30} 个`)
      problems.push('  → 隔离已破坏。见 jydraft/docs/01-上游隔离策略.md 的「破坏隔离后怎么办」')
    } else {
      notes.push(`相对 fork point，改动全部在 ${OURS} 内（${files.length} 个文件）✓`)
    }
  }
}

// ---------------------------------------------------------------- 报告

console.log('')
for (const n of notes) console.log(`  ${n}`)

if (problems.length) {
  console.log(`\n✗ 隔离检查未通过（${problems.length} 项）：`)
  for (const p of problems) console.log(`  ${p}`)
  process.exit(1)
}

console.log('\n✓ 隔离完好：jydraft/ 之外与 fork point 一致')
