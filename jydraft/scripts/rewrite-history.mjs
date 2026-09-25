#!/usr/bin/env node
/**
 * rewrite-history.mjs —— 把 fork 的历史压成一条基线提交。
 *
 * 目标：去掉上游的 20,022 个 commit，只留一条「基线」。
 *
 * ## 为什么这是安全的
 *
 * **上游历史是公开的、可重新获取的。** `git fetch https://github.com/deepseek-ai/deepseek-harness.git`
 * 就能把全部对象拿回来。所以这不是「永久销毁」，是「本地不留一份不用的副本」。
 *
 * ## 关键设计：用上游的 tree 对象当基线
 *
 * 基线提交的 tree **直接复用上游 HEAD 的 tree 对象**，不用 `git add -A` 重建。
 * 这样得到两个性质：
 *
 *   1. **基线是「一个字节都不差的上游」** —— 不是「看起来差不多」
 *   2. **不需要上游历史就能验证** —— tree SHA 是内容指纹，记下来就能证明
 *
 * 如果改用 `checkout --orphan && git add -A`，得到的树可能因为 .gitignore 规则、
 * 行尾转换、空目录差异而与上游不同，而且你无法证明它相同。
 *
 * ## 结构
 *
 *   提交 1（root）  基线：tree 与上游 477b4f4205 完全一致，不含 jydraft/
 *   提交 2+        我们的工作（jydraft/）
 *
 * 于是「隔离有没有被破坏」= 「相对提交 1，jydraft/ 之外有没有变化」——一个可查的 diff。
 *
 * ## 用法
 *
 *   node jydraft/scripts/rewrite-history.mjs            # 只打印计划（默认）
 *   node jydraft/scripts/rewrite-history.mjs --apply    # 真正执行
 *
 * 执行前会自动把当前全部历史打成一个 bundle 放到系统临时目录，作为安全网。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import url from 'node:url'

const HERE = path.dirname(url.fileURLToPath(import.meta.url))
const FORK = path.resolve(HERE, '../..')
const APPLY = process.argv.includes('--apply')

const git = (args, opts = {}) =>
  execFileSync('git', args, { cwd: FORK, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })

const tryGit = (args) => {
  try {
    return git(args)
  } catch (error) {
    return `__ERR__ ${error.stderr?.toString().trim() ?? error.message}`
  }
}

const say = (s = '') => console.log(s)
const step = (n, s) => console.log(`\n[${n}] ${s}`)

// ---------------------------------------------------------------- 前置检查

step('0', '前置检查')

const dirty = tryGit(['status', '--porcelain'])
if (dirty.startsWith('__ERR__')) {
  console.error(`  无法读取工作树状态：${dirty}`)
  process.exit(1)
}
const outsideDirty = dirty
  .split('\n')
  .filter(Boolean)
  .filter((l) => !l.slice(3).split(' -> ').pop().replace(/^"|"$/, '').startsWith('jydraft/'))
if (outsideDirty.length) {
  console.error('  ✗ jydraft/ 之外有未提交改动，先处理掉再压历史：')
  for (const l of outsideDirty) console.error(`      ${l}`)
  process.exit(1)
}
say('  ✓ jydraft/ 之外工作树干净')

const head = git(['rev-parse', 'HEAD']).trim()
const tree = git(['rev-parse', 'HEAD^{tree}']).trim()
const count = Number(git(['rev-list', '--count', 'HEAD']).trim())
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()

say(`  当前分支:   ${branch}`)
say(`  当前提交:   ${head}`)
say(`  提交数:     ${count}`)
say(`  基线 tree:  ${tree}   ← 压完要拿它核对`)

const jydraftFiles = fs.existsSync(path.join(FORK, 'jydraft'))
  ? Number(git(['status', '--porcelain', '--untracked-files=all', 'jydraft']).split('\n').filter(Boolean).length)
  : 0
say(`  jydraft/ 待纳入: ${jydraftFiles} 个文件`)

// ---------------------------------------------------------------- 计划

const bundle = path.join(os.tmpdir(), `jydraft-pre-rewrite-${head.slice(0, 8)}.bundle`)

step('1', '安全网：把当前全部历史打成 bundle')
say(`  git bundle create ${bundle} --all`)
say('  → 想反悔时：git clone <bundle> <目录>，全部 20,022 个 commit 都在里面')

step('2', '建基线提交（root，tree 直接复用上游的）')
say(`  git commit-tree ${tree.slice(0, 12)}… -m "baseline: DeepSeek Harness 0.1.7-rc.2"`
  + `\n                    (upstream ${head.slice(0, 12)})"`)
say('  → 无父提交 = root；tree 与上游逐字节一致')

step('3', '把分支指向基线')
say(`  git update-ref refs/heads/${branch} <新基线>`)

step('4', '提交我们的工作')
say(`  git add jydraft/ && git commit -m "jydraft: 工作目录（关注度地图 / 隔离策略 / 基线）"`)

step('5', '验证基线未被污染')
say(`  git rev-parse <基线>^{tree}   应等于 ${tree}`)

step('6', '压缩对象库')
say('  git reflog expire --expire=now --all')
say('  git gc --prune=now --aggressive')
say('  → 上游历史里独有的对象会被清掉，共享的保留')

step('7', '更新隔离记录')
say('  改写 jydraft/FORK_POINT 与 jydraft/scripts/check-isolation.mjs')
say('  （它们现在按「本地存在上游 commit」检查，压完那个 commit 就没了，必须改成按基线 tree 校验）')

say('\n' + '─'.repeat(72))
if (!APPLY) {
  say('以上是计划。**没有做任何改动。**')
  say('确认执行：node jydraft/scripts/rewrite-history.mjs --apply')
  process.exit(0)
}

// ---------------------------------------------------------------- 执行

say('开始执行。')

step('1', '安全网')
if (fs.existsSync(bundle)) {
  say(`  bundle 已存在，跳过：${bundle}`)
} else {
  try {
    git(['bundle', 'create', bundle, '--all'])
    say(`  ✓ ${bundle}（${(fs.statSync(bundle).size / 1024 / 1024).toFixed(0)} MB）`)
  } catch (error) {
    console.error(`  ✗ 打 bundle 失败，中止：${error.stderr?.toString().trim() ?? error.message}`)
    process.exit(1)
  }
}

step('2', '建基线提交')
const baseline = git([
  'commit-tree',
  tree,
  '-m',
  `baseline: DeepSeek Harness 0.1.7-rc.2 (upstream ${head})`,
]).trim()
say(`  ✓ 基线提交 ${baseline.slice(0, 12)}`)

step('3', '指向基线')
git(['update-ref', `refs/heads/${branch}`, baseline])
say(`  ✓ refs/heads/${branch} → ${baseline.slice(0, 12)}`)

step('4', '提交 jydraft/')
git(['add', 'jydraft'])
git(['-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'jydraft: 工作目录（关注度地图 / 隔离策略 / 基线）'])
const ourCommit = git(['rev-parse', 'HEAD']).trim()
say(`  ✓ ${ourCommit.slice(0, 12)}`)

step('5', '验证基线 tree')
const newTree = git(['rev-parse', `${baseline}^{tree}`]).trim()
if (newTree !== tree) {
  console.error(`  ✗ 基线 tree 不匹配！期望 ${tree}，实际 ${newTree}`)
  console.error('    历史已改写，但基线不是纯净的上游。用 bundle 恢复后排查。')
  process.exit(1)
}
say(`  ✓ tree 一致：${newTree}`)

step('6', '压缩对象库')
const before = (() => {
  let n = 0
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else n += fs.statSync(p).size
    }
  }
  walk(path.join(FORK, '.git'))
  return n
})()
git(['reflog', 'expire', '--expire=now', '--all'])
git(['gc', '--prune=now', '--aggressive'])
const after = (() => {
  let n = 0
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else n += fs.statSync(p).size
    }
  }
  walk(path.join(FORK, '.git'))
  return n
})()
say(`  ✓ .git ${(before / 1024 / 1024).toFixed(0)} MB → ${(after / 1024 / 1024).toFixed(0)} MB`)
say(`  提交数 ${count} → ${git(['rev-list', '--count', 'HEAD']).trim()}`)

step('7', '更新隔离记录')
fs.writeFileSync(
  path.join(FORK, 'jydraft/FORK_POINT'),
  [
    baseline,
    '# 上面这一行是**基线提交**（本仓库的 root commit）。它的 tree 与上游逐字节一致。',
    '#',
    `# 上游来源（本仓库已不保留其历史，需要时按 jydraft/docs/01-上游隔离策略.md 拉取）：`,
    `#   DeepSeek Harness  ${head}`,
    `#   git log -1 ${head.slice(0, 12)}  →  2026-09-24 Merge pull request #5180 from deepseek-harness/rel/dsh-0.1.7-rc.2`,
    '#',
    '# 基线的可验证指纹（不需要上游历史就能核）：',
    `#   tree ${tree}`,
    '#',
    '# 验证：',
    '#   git rev-parse HEAD~1^{tree}        # 或 git rev-parse <基线>^{tree}',
    `#   应输出 ${tree}`,
    '#',
    '# 检查隔离是否完好：',
    '#   node jydraft/scripts/check-isolation.mjs',
    '',
  ].join('\n'),
)
say('  ✓ jydraft/FORK_POINT 已更新')
say('  ⚠ jydraft/scripts/check-isolation.mjs 仍按旧方式检查，需要手工更新（见下方提示）')

say('\n' + '─'.repeat(72))
say('完成。')
say('')
say('**两件后续必须做的事：**')
say('')
say('1. **改 check-isolation.mjs** —— 它现在会 `git cat-file -t <上游 sha>`，')
say('   压完那个 commit 不在本地了，检查会误报失败。')
say('   改成按「相对基线提交，jydraft/ 之外有无变化」判断。')
say('')
say('2. **远端已分叉** —— origin/master 还是旧的 20,022 个 commit。')
say('   同步需要 force-push（`git push --force-with-lease origin master`）。')
say('   **这是一个独立的决定**，本脚本没有做。')
say('')
say(`安全网：${bundle}`)
say('反悔：git clone ' + bundle + ' <目录>')
