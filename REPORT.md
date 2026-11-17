# dsh-input-insight：会话日志增量扫描模块

零依赖（只用 `node:fs` / `node:path` / `node:zlib`）、纯函数式的 DSH 会话日志扫描与日账折叠模块。

- 源码：`lib/scan.js`（ESM）、`lib/scan-cli.mjs`
- 运行时产物：`.cache/scan-cache.json`、`.cache/report.json`，已由 `.gitignore` 排除。删掉即回到冷启动全量扫描。

---

## 一、模块 API

### A. 增量解码器

| 导出 | 说明 | 返回 |
|---|---|---|
| `readDelta(absPath, fromOffset)` | 从 `fromOffset`（必须是 frame 边界，即上次返回的 `nextOffset`）解压到文件末尾 | `{ text, nextOffset, pendingFrame, frames, badFrames, bytes, size, truncated }` |
| `readRangeBytes`（内部） | 用 `fs.openSync` + 定位读，只读增量字节，不把整个会话目录读进内存 | `Buffer` |

实现要点：

1. **多 frame 首尾相接**：每个 `.zstd` 文件由多个 frame 拼成，`zlib.zstdDecompressSync(整个文件)` 只解第一个 frame（约 226 字节 = header 行），会让人误以为日志为空。这里按 magic `28 b5 2f fd` 切帧、逐帧解压、`Buffer.concat` 后再转 UTF-8。
2. **假边界重试**：压缩数据里可能偶然出现 magic 字节。某帧解压失败时不立刻放弃，而是从下一个 magic 继续找，直到解压成功或到文件末尾。
3. **半帧不吞**：到文件末尾仍解不开的帧计入 `badFrames`，但 `nextOffset` **回退到这一帧的起点**（`pendingFrame: true`），下次从原处重试 —— 否则正在写入的帧会被永久跳过。
4. **UTF-8 跨增量拼接安全**：`fromOffset` 永远是 frame 边界，frame 之间是完整 UTF-8 序列，不存在半个字符落在增量切点上的问题。

### B. 事件 → 日账折叠

| 导出 | 说明 |
|---|---|
| `createAgg()` | 建可变累加器 |
| `beginSession(agg, info)` / `endSession(agg)` | 成对包装当前会话（`info = {sid, cwd, createdAt, origin, isSeeded, title}`）；也可以直接给 `foldEvents(text, agg, info)` 传第三参，等价 |
| `foldEvents(text, agg, info?)` | 折叠一段文本（可跨多次调用，行尾残片自动 carry） |
| `getSession(agg, sid)` / `applyContribution(agg, sid, ms, delta, sign)` | 会话级读写；`sign=-1` 即扣减，增量与扣减走**同一条代码路径**，保证合计与分日永不漂移 |
| `subtractSession(agg, sid)` | 整会话清零（截断/重写时用） |
| `deriveDays(agg)` | **全局 `days` 完全由 `sessions` 派生**，不写第二份真相 |
| `dayKey(ms)` / `hourOf(ms)` / `cp(s)` / `hanzi(s)` / `isHumanMessage(data)` | 口径基元 |
| `headerInfo(ev, fallbackCwd)` | 从 header 事件抽 `{sid, cwd, createdAt, origin, isSeeded, parentSession}` |

累加器形态：

```
agg = {
  days: {},        // 派生视图（deriveDays 重建），foldEvents 从不写它
  sessions: { sid: { sid, title, cwd, createdAt, origin, isSeeded,
                     msgCount, chars, hanzi, askCount, askCustom, askSelected,
                     lastTime, byHour[24], days: { "YYYY-MM-DD": {chars,hanzi,msgs,asks,askCustom,selected,pasteChars} } } },
  seenIds: Map,    // data.id -> 首见文件绝对路径（Map 不是 Set：截断重扫时要区分「我自己之前的记录」）
  callNames: Map,  // callId -> 工具名，FIFO 上限 200
  askCallIds: Set, // ask 专用 callId，小且精确，不受 FIFO 淘汰影响
  stats: { events, badJson, badFrames, frames, bytes, humanMsgs, injectedMsgs,
           multiText, noText, dupSkipped, dupChars, askCalls, askAnswers, askParseFail,
           machineMsgs, machineChars, filesScanned, skippedFiles, tails },
  files: {},       // 绝对路径 -> { size, offset, sid, cwd, createdAt, origin, isSeeded, title }
}
```

### C. 增量扫描器

```js
const scanner = createScanner({ sessionsRoot, cacheFile });
const { agg, elapsedMs, files, filesScanned, skippedFiles, incrementalFiles, fullScan, truncated }
  = await scanner.scan({ onProgress: ({done,total,phase}) => {} });
```

- 递归找所有 `session.v4.jsonl.zstd`（`listLogFiles` 也单独导出）。
- 缓存形态 `{ version:2, savedAt, sessionsRoot, files:{abs:{size,offset,sid,cwd,createdAt,origin,isSeeded,title}}, sessions:{...}, stats:{...}, seen:[[data.id, 首见文件]] }`。
- **`seenIds` 持久化（v2 起）**。原设计不落盘，理由是"可能上百万条、序列化大于重解"，但这个判断只对"单次全量扫描"成立：每次增量扫描都从空表起步，**新 fork 出来的会话把父历史整份复制一遍时会被再计一次**（父文件只读尾巴，副本走全新文件全读）。落盘上限 `SEEN_PERSIST_MAX = 500000` 条，超过就只在本轮内存里去重。
- **截断时要连去重表一起作废**：`subtractSession` 之外，还要删掉 owner 为该 sid 文件的那些 `data.id`，否则重读会被自己的去重表当成副本跳过，会话就此少算。
- **`days` 不落盘**：它是 `sessions` 的派生视图，读缓存后一算就有，省一半体积、也免掉「两份真相对不上」。
- 截断处理：`size < 上次 offset` → `subtractSession(agg, sid)` 整会话清零，并把同 sid 的所有文件 `offset` 归零重扫。**用整会话清零而非逐项减法**：会话粒度已足够，且不会留下整数残渣。
- 缓存里缺 `sid`、或聚合器里没有这个会话，却又有非零 `offset` → 退回全读（不能只读尾巴，否则历史静默丢失）。
- 写缓存走 `tmp` + `rename`，中断不会留半截 JSON。
- `onProgress({done,total,phase})` 每 50 个文件回调一次，`phase` 为 `full` / `incremental`。

### D. 输出视图

`buildReport(agg, { days = 56, now = Date.now(), sessionLimit = 200, maxBytes })` →

```
{
  generatedAt, rangeDays,
  totals: { msgs, chars, hanzi, asks, askCustom, askSelected, pasteChars, activeDays },
  today:  { key, chars, hanzi, msgs, pasteChars },
  streak: { current, longest },
  byDay:  [{ key, msgs, chars, hanzi, asks, askCustom, pasteChars, maxChars }],   // 升序，最近 N 天
  bySession: [{ sid, title, cwd, origin, isSeeded, msgs, chars, hanzi, asks, askCustom, lastTime,
                days: { "YYYY-MM-DD": {chars,hanzi,msgs,asks,askCustom,selected,pasteChars} } }],  // chars 降序，上限 200
  byHour: [24 个 chars],
  known: { badFrames, badJson, frames, bytes, events, humanMsgs, injectedMsgs, multiText, noText,
           dupSkipped, dupChars, askCalls, askAnswers, machineMsgs, machineChars,
           files, filesScanned, skippedFiles, truncatedScans, tails },
  meta: { sessionLimit, trimmedSessionDays, jsonBytes }
}
```

- `maxChars` 是**窗口内全局最大值**（不是逐日），供热力图定档。
- `streak.current`：今天还没输入时从昨天起算，避免早上打开界面显示「连续 0 天」。
- **体积闸门**：序列化后 > 1.5 MB 时自动把 `bySession.days` 收窄到最近 N 天并置 `meta.trimmedSessionDays = true`。

---

## 二、口径定义

| 项 | 定义 |
|---|---|
| 真人判据 | `event.type === "user/message"` 且 `data.source.kind === "user"` 且 `data.source.rpcId` 是非空字符串。三条同时成立才算；缺 rpcId 的 `kind:"user"`（插件自动续跑「继续/continue」等）一律计注入 |
| 正文 | `data.content[]` 中 `type:"text"` 的 `text` **全部拼接**（一条消息可有多个 text 块）；`type:"image"` 无 text，拼出空串即 0 字 |
| `chars` | 拼接后的文本按**码点**计数 `[...s].length`，不是 `s.length`（emoji、生僻字不重复计） |
| `hanzi` | 匹配 `/[\u3400-\u4dbf\u4e00-\u9fff]/g` 的个数（基本区 + 扩展 A） |
| ask 手写 | `ask_user_question` 的 `answers[].custom` 单独累计到 `askCustom`，**不计入 `chars`**。两者必须分开看：`chars` 是纯键入量 |
| ask 选项 | `answers[].selected.length` 只统计**个数**到 `askSelected`，不计字（选项文本是 AI 写的，不是用户输入） |
| ask 对齐 | `tool/result` 不带工具名，靠 `callNames(callId→name)` 与 `askCallIds` 双路识别；两个都查，FIFO 淘汰也不会漏 |
| fork 去重 | `data.id` 已存在于 `seenIds` 且首见文件不是本文件 → 整条跳过，计入 `dupSkipped` / `dupChars`。首见文件是本文件时不跳（文件内天然重复不该被吞）。去重表随缓存落盘（v2 起），跨轮增量同样生效 |
| 机器粘贴 | 一条消息若"够长且结构化"（≥2000 字符、≥40 行，且满足任一条：汉字<2% 且 ASCII≥95% / `[tag]` 前缀行≥30% / 调用栈行≥10% / 整行重复≥字符 35%），判为机器文本转储，字符量记进 `pasteChars`、**不进 `chars`/`hanzi`**；它仍算 1 条消息，tooltip 与当日明细里明示"粘贴 N（未计入）" |
| 分日 | `new Date(t + 8*3600e3).toISOString().slice(0,10)`。**硬编码 UTC+8**，不跟机器本地时区 —— 换机器也不会让日历错位 |
| 分时 | 同一偏移下 `getUTCHours()`，得到北京时间 0～23 |

**为什么要有机器粘贴规则**：旧口径把一条整段粘贴的浏览器控制台转储（543 行、约 48 万字符、汉字不足 1%）当成"自己敲的字"，单日热力图被顶到 48.6 万字，量纲彻底失真。新口径把它记进 `pasteChars`，同一日回落到四位数。判据只认**机器输出形态**，所以 6 万字的语音转写、长段引用文章仍全额计入 —— 那是人说的话、人写的字。

### 与早期临时探针脚本的差异

模块化之前用过一个一次性 CJS 探针脚本把口径跑通（未随仓库发布），主要差距：

| 维度 | 临时探针 | 本模块 |
|---|---|---|
| 读取 | 每次 `fs.readFileSync` 整文件，每次重扫都要全量重解 | 定位读增量字节，只解帧增量 |
| 缓存 | 无，跑一次算一次 | `files[abs].offset` + 聚合结果持久化 |
| 去重作用域 | 先全量收集再在报表侧合并（"去重后字符"是额外一列） | 折叠期直接跳过，`seenIds` 内联维护，重复条目**从不进入聚合** |
| 全局日账 | 只有 7 天窗口一个 `table` | `days` 由 `sessions` 派生，56 天窗口 + 全期累计 + 每会话分日明细 |
| ask 识别 | 先扫 `tool/call` 建 `askCallIds`，再单趟判 `tool/result` | 单趟流式，边收边建映射；`askCallIds` + `callNames` 双路，且 FIFO 有上限不会无限涨 |
| 截断/重写 | 无处理 | `size < offset` → 整会话清零重扫 |
| 半帧 | 末尾解不开就丢 | `nextOffset` 回退到帧起点，下次重试 |
| 输出 | 控制台文本 + 手写 Markdown | `buildReport()` 纯函数，前端直用 |

---

## 三、性能实测

单机实测（Windows 11 / Node v24.21.0 / 同步 `zstdDecompressSync`，未走 worker），语料为 **1131 个日志文件 / 382.6 MB / 133356 个 zstd frame / 311665 个事件**：

| 场景 | 耗时 | 备注 |
|---|---|---|
| 全量首扫（冷缓存） | **28877 ms** | 清空 `.cache` 后从零折叠 |
| 全量重扫（`--full`，热缓存） | **28565 ms** | 主要成本还是解压 382.6 MB |
| 增量（第 2 次，同进程内紧接全量） | **744 ms** | 1131 个文件全走尾巴 |
| 增量（第 3 次，独立进程，缓存稳妥） | **250 ms** | 同上，无前置全量占 I/O |

全量 28 s 是**逐帧同步解压**的 CPU 时间，跟语料体积线性相关；换成异步 API 需要引入队列状态、破坏纯函数边界，当前刻意不做。

**增量 < 1 秒**，所以插件端把它放在后台定时器里（默认 5 分钟），从不跑在请求路径上。

---

## 四、报告 JSON 体积

| 项 | 字节数 |
|---|---|
| `report` 全量 JSON | **106708**（104.2 KB） |
| 其中 `bySession`（200 会话 × 分日明细） | 100388 |
| `bySession.days` 是否被收窄 | **否**（104 KB 远低于 1.5 MB 闸门） |
| 缓存文件 `.cache/scan-cache.json` | 约 1.1 MB |

结论：每会话平均不到 1 个有输入的日，`bySession.days` 体积完全可控，**不需要**收窄到最近 N 天。真正占体积的是 `sessions` 全量（缓存文件 1.1 MB），所以缓存不落盘 `days` 是必要的。

---

## 五、口径自检（不写死任何机器数值）

`lib/scan-cli.mjs` 每次运行都做四项自检并打印 `[PASS]` / `[FAIL]`：

1. **增量与全量聚合一致** —— 同一个 CLI 里先扫一遍全量、再扫一遍纯增量，两次 `totals` 逐字段串比对。这是防「增量拼接漏行 / carry 丢半句」的唯一可靠回归手段。
2. **解码无坏帧 / 坏 JSON** —— `badFrames === 0 && badJson === 0`。
3. **全局日账 = 会话分日之和** —— `byDay` 由 `sessions` 派生，两者在窗口内必须逐日、逐字段相等（chars / hanzi / msgs / pasteChars）。
4. **活动天数口径一致** —— 全期「有字符的天数」与 `totals.activeDays` 必须相同。

早期版本在这里写死过一组逐日基线做对账；那种做法只对特定机器成立，换个语料就全红，因此换成上面这组**结构性不变量**：任何机器、任何时点都成立，失败即代表代码有问题。

---

## 六、已知偏差与边界

1. **文件集会随会话目录变动**：被移走 / 清理过的会话不在扫描范围内，所以总数与任何历史快照都可能不同（`badJson = 0`、`badFrames = 0` 说明不是解析漏读）。
2. **真人条数含 fork 去重**：判据命中数含 fork 物理副本，去重后才是最终值（`dupSkipped` / `dupChars` 单独记录）。
3. **截断扣减是整会话粒度**：若某会话有多个日志文件、只有一个被截断，会把整个会话清零后重扫该会话所有文件。代价是重解一个会话，收益是永不留残渣。
4. **`data.id` 缺失的消息不参与去重**：极少数边缘事件可能因此重复计。
5. **`chars` 是键入量不是写作量**：语音输入的中转文本计入（那是自己说的话）。整段粘贴的控制台/构建日志不计入，改记 `pasteChars`；**长段散文式粘贴（引用的文章、论文摘要）依旧计入**，判据只识别机器输出形态。文件附件与截图贡献 0 字。
6. **单进程串行解压**：见第三节。
7. **`.cache/` 是运行时产物**：已由 `.gitignore` 排除，删掉即回到全量首扫，无害。

---

## 七、复现

```powershell
cd plugins/dsh-input-insight
node lib/scan-cli.mjs            # 全量+增量对照，打印 7 天表 / 前 10 会话 / 体积 / 四项自检
node lib/scan-cli.mjs --full     # 强制丢弃缓存做全量
node lib/scan-cli.mjs --json     # 另把 report 写到 .cache/report.json
node lib/scan-cli.mjs --days 30  # 改窗口天数
```

日志根目录按 `INSIGHT_SESSIONS_ROOT` → `DSH_HOME\sessions` → `~/.dsh/sessions` 的顺序解析，不需要改代码。
