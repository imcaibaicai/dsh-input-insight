# dsh-input-insight

A DeepSeek Harness plugin that answers one question honestly: **how many characters did *I* actually type today?**

It reads the session logs the harness already keeps, folds out everything the model or a plugin produced on your behalf, and shows the remainder as a GitHub-style activity heatmap in the right sidebar — plus today's numbers, the streak, the hour profile and the sessions you wrote the most in.

It is deliberately self-contained: one host half (a background scanner + two read-only HTTP routes), one browser half (a sidebar tab). No dependency on another plugin, no registration into the harness's session projections, no writes to session events, no core changes.

---

## What it shows

| Block | Meaning |
|---|---|
| Heatmap (8 weeks × 7 days) | Your typed characters per day; switch the metric between characters / Hanzi / message count |
| 今日 | Today's characters, Hanzi and message count |
| 连续 / 最长 / 有输入 | Current streak, longest streak, number of days with any typed input |
| 时段分布 | Characters by hour of day (UTC+8) |
| 近 7 天 | The last seven days as bars |
| 输入最多的会话 | Top five sessions by typed characters, plus this session's own line |
| 全期累计 | Characters, Hanzi and ask-card count since the first log |

Clicking a heatmap cell pins that day's full breakdown under the grid; `刷新` forces the host to re-read the logs instead of serving the cached snapshot.

---

## Counting rules (the part that matters)

| Rule | Definition |
|---|---|
| "Typed by you" | `event.type === "user/message"` **and** `data.source.kind === "user"` **and** `data.source.rpcId` is a non-empty string. All three must hold |
| Excluded | Everything else, notably `kind:"user"` without `rpcId` — that is a plugin's auto-continue ("继续 / continue"), not you. Also excluded: reminders, time-context blocks, memory-router injections, and tool results |
| Text | Every `type:"text"` block in `data.content` is concatenated; an image-only message contributes 0 characters |
| Characters | Counted in **code points** (`[...s].length`), so emoji and rare CJK do not double-count |
| Hanzi | `/[\u3400-\u4dbf\u4e00-\u9fff]/g` (basic block + extension A) |
| Ask cards | `ask_user_question` handwritten answers (`answers[].custom`) are counted **separately** and never added to characters — characters stay a pure typing metric. Selected options count as a number of picks, not characters |
| Fork copies | A `data.id` already seen in a different log file is skipped entirely (a forked session physically copies its parent's messages). First occurrence wins; the seen-id table is persisted in the cache, so a fork created between two incremental scans is still deduplicated |
| Pasted machine text | A message that is structurally a log dump (≥2000 chars, ≥40 lines, and one of: hanzi <2% with ASCII ≥95% / `[tag]`-prefixed lines ≥30% / stack-trace lines ≥10% / repeated lines ≥35% of characters) is tracked as `pasteChars` and **never added to characters**. It still counts as one message, and the heatmap tooltip plus the pinned day breakdown show the pasted volume explicitly — nothing is silently dropped |
| Day bucket | Fixed UTC+8, not the machine's time zone, so the calendar does not shift when you change machines |

Why the paste rule exists: on 2026-11-17 a single pasted browser-console dump (543 lines, 480,255 characters, only 64 Hanzi, 99.8% ASCII) was counted as typed input and pushed that cell to 486,867 characters. With the rule, the same day reads 7,441 characters and the dump shows up as `Paste 480255 · not counted`. Prose keeps counting at any length — a 62,784-character Chinese dictation transcript is still counted in full, because it is prose, not machine output.

Two honest limitations: a long *prose* paste (quoted text, a paper abstract) still inflates the count, since only machine-output-shaped blocks are separated; and a file attachment or screenshot contributes nothing.

---

## Install (local package)

```powershell
# 1. link the package into the profile
#    <profile> = the folder that already holds the harness's profile node_modules
#    <repo>    = wherever you cloned this repository
$p = '<profile>\node_modules\dsh-input-insight'
New-Item -ItemType Junction -Path $p -Target '<repo>'

# 2. add the loader row to the profile patch
#    - insert:
#        - id: dsh-input-insight
#          name: 'dsh-input-insight'

# 3. fully quit and restart DSH (the host half loads at startup)
```

Open the right sidebar → guide page → **输入洞察 / Input insight**.

### Uninstall

Delete the `- insert:` row, remove the junction with `[System.IO.Directory]::Delete($p, $false)` (never `Remove-Item -Recurse` on a junction), then delete `<DSH_HOME>\input-insight\scan-cache.json`. Nothing else was touched.

---

## Configuration (all optional)

```yaml
- insert:
    - id: dsh-input-insight
      name: 'dsh-input-insight'
      config:
        sessionsRoot: '<DSH_HOME>\sessions'                  # default: <DSH_HOME>/sessions
        cacheFile: '<DSH_HOME>\input-insight\scan-cache.json' # default: <DSH_HOME>/input-insight/scan-cache.json
        rangeDays: 56          # heatmap window
        autoRefreshMs: 300000  # background re-read cadence; 0 disables the timer
```

---

## Cost, and why it never blocks the UI

The corpus on this machine is 1131 log files / 382 MB / 133k concatenated zstd frames. A cold pass is ~28 s; after that only the tail of each file is re-read (~0.25 s). Therefore:

- the scan runs in the background, never on a request path;
- the routes only ever serve the last completed snapshot, so the panel paints instantly;
- concurrent requests share one in-flight scan;
- a scan failure leaves the previous snapshot in place and never propagates into the harness.

Caches live under `<DSH_HOME>/input-insight/scan-cache.json`, written through `tmp` + `rename`. Delete it to force a cold pass.

### Routes

| Route | Purpose |
|---|---|
| `GET /api/dsh-input-insight/report` | The snapshot; `?refresh=1` re-reads the logs first |
| `GET /api/dsh-input-insight/status` | Cheap progress probe used while the first cold scan runs |

Both are read-only and `cache-control: no-store`.

---

## Command line

The scanner is usable on its own, with no harness running:

```powershell
cd plugins/dsh-input-insight
node lib/scan-cli.mjs            # full + incremental cross-check, 7-day table, top sessions
node lib/scan-cli.mjs --full     # drop the cache and fold everything again
node lib/scan-cli.mjs --json     # also write .cache/report.json
node lib/scan-cli.mjs --days 30  # change the window
```

`INSIGHT_SESSIONS_ROOT` overrides the log root.

See `REPORT.md` for the scanner's design, the counting-rule edge cases, and the measured cost of a cold pass.

---

## Compatibility

Written against the DSH web client's right-sidebar tab contract (`sidebarRightTabs`, `sidebar.right.pane.tab`, `sidebar.right.pane.tab.title`) as shipped on the 0.1.5 line and still present on 0.2.x. The tab registration is a deferred inject wrapped in a guard: on a harness without that registry the plugin loads, registers nothing visible, and stays out of the way.

Host side needs only Node's own `fs` / `path` / `zlib` — no third-party runtime dependency.

MIT.
