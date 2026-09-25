# 基线记录

> 建立日期：2026-09-25　｜　fork point：`477b4f4205`（`rel/dsh-0.1.7-rc.2`）
> 目的：**在改动任何东西之前，先证明这份 fork 能装、能建、能跑。**
> 没有这条基线，「我的改动有没有弄坏什么」就无法回答。

---

## 验证过的三步

| 步骤 | 命令 | 结果 |
|---|---|---|
| 安装 | `pnpm install --frozen-lockfile` | **exit 0**，4 分 60 秒 |
| 构建 | `pnpm run build` | **exit 0**，343 个 client artifact |
| 启动 | `node --import tsx/esm apps/cli/src/bin.ts web --no-open --port 3081` | **HTTP 200**，`<title>DSH Local Build</title>` |

**认证也验证过**：不带 token 请求 → **401**；带启动时打印的 token → 200（38,513 字节）。所以「服务起来了」不是只看端口，是**真的在正确应答**。

## 环境

```
node          v22.22.2      （要求 ^22.19.0 || >=24.0.0）✓
pnpm          11.7.0        （packageManager 声明 pnpm@11.7.0）✓
安装体积      node_modules 1,470 MB / 1,388 个包
DSH_HOME      C:\Users\Administrator\.dsh   ← 状态在用户主目录，不在仓库里
```

## 安装时的三条警告（不是错误）

```
[WARN] Failed to create bin ... lib/bin.js.EXE    ×3
```

`@deepseek-ai/dsh` 的 `lib/bin.js` 在**构建之前不存在**，所以 pnpm 建 bin 链接时找不到目标。
构建完成后这些链接就有效了。**这是「先装后建」顺序的正常现象。**

另外 `postinstall` 装了 git hooks（`pre-commit` / `pre-merge-commit` / `pre-push`）。它们不在 git 跟踪范围内，不影响隔离，
但**将来提交时会被上游的检查拦截** —— 到时见 `jydraft/docs/` 里的记录。

## 默认 `web` profile 的真实规模

从 `dump-config-web.txt`（1320 行，带层归属注释）数出来：

| 项 | 数 |
|---|---:|
| 插件条目（`- id:`） | **184** |
| 其中默认 `disabled:` | **59** |
| `name:` 行（含子路径条目） | 298 |
| 仓库里的叶子包总数 | 312 |

**层归属**（dump 里的 `# ==` 注释）：

```
@deepseek-ai/dsh-base
  → patched by ~/.dsh/profiles/web/cordis.patch.yml
  → patched by @deepseek-ai/dsh-web-app
@deepseek-ai/dsh-web-app
  → patched by dsh-lan-access
dsh-lan-access
~/.dsh/profiles/web/cordis.patch.yml
```

**这条链很重要**：`dsh-lan-access` 与用户自己的 patch 都在 `base`/`web-app` 之上叠加。
所以**改行为的第一选择是 patch，不是改源码**。

> `attention-map.mjs` 估算「直接挂载 172 个包」，真实是 **184 个条目**。
> 差 12 是因为估算按「不同的包」去重，而 dump 按「条目」计（同一包可能有多个条目）。
> **两者都对，口径不同。** 精确数字以本目录的 dump 为准。

## 这个目录里有什么

| 文件 | 是什么 |
|---|---|
| `dump-config-web.txt` | `--profile web --dump-config` 的完整输出。**「默认挂了什么」的权威答案** |
| `dump-config-web.err.txt` | 同上的 stderr（只有 UNDICI 实验特性警告） |

**它不是生成物、不要手改，但也别指望它永远有效** —— 上游升级或我们改了 profile 之后要重新采。
重新采：

```sh
node --import tsx/esm apps/cli/src/bin.ts --profile web --dump-config > jydraft/baseline/dump-config-web.txt 2> jydraft/baseline/dump-config-web.err.txt
```

## 这份基线怎么用

**每次要判断「是不是我弄坏的」**，回到这三步：

```sh
pnpm run build
node --import tsx/esm apps/cli/src/bin.ts web --no-open --port 3081
# 另开一个终端
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3081/     # 期望 401（有认证）
```

**期望值**：构建 exit 0；启动打印带 token 的 URL；不带 token 请求得到 401。

## 一个待办

**3080 端口被另一个 node 进程占着**（PID 20024，不是本次基线起的）。我没有动它 —— 可能是另一个正在运行的 DSH 实例。
基线用 **3081**。将来做自动化验证时要先探测端口，不能假定 3080 可用。
