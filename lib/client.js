/**
 * dsh-input-insight — browser half.
 *
 * A right-sidebar tab that answers "how much did *I* actually type?" with a
 * GitHub-style activity heatmap plus the numbers behind it.
 *
 * Data path: the host half (`lib/index.js`) scans the session logs in the
 * background and serves one JSON snapshot over `GET /api/dsh-input-insight/report`.
 * This file never touches session storage, another plugin's projection, or the
 * conversation DOM — it only fetches that route, so the panel can run next to
 * dsh-context without either plugin knowing about the other.
 *
 * Seating follows the shipped sidebar contract (dsh-context proves the same
 * shape on this harness):
 *   `ctx.sidebarRightTabs.register` — the tab type + its guide capsule entry;
 *   `sidebar.right.pane.tab`        — the panel body;
 *   `sidebar.right.pane.tab.title`  — the icon + label chip.
 * The whole seating is wrapped: a harness without the tab registry simply shows
 * no tab instead of taking the browser down.
 */
window.__ModuleLoader__.load({
  id: 'dsh-input-insight',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    // One line at load: without it a silently-missing module looks identical to a
    // module whose registration was rejected, and this plugin's only UI is a tab.
    try {
      console.info('[dsh-input-insight] client module loaded');
    } catch (error) {
      /* console unavailable */
    }

    // #region constants
    /** Locale namespace owned by this plugin (dictionary keys + the slot `t` seat). */
    const NS = 'inputInsight';
    /** The tab type's identity in the sidebar tab system (also its body-seat key). */
    const TAB_ID = 'dsh-input-insight';
    /** Namespaced kind: a foreign plugin may well own the bare `input-insight`. */
    const TAB_KIND = 'dsh-input-insight';
    /** Guide capsule position: after the shipped Files entry (10) and dsh-context (20). */
    const GUIDE_ORDER = 30;
    /** Snapshot route served by the host half. */
    const REPORT_ROUTE = '/api/dsh-input-insight/report';
    /** Re-read the in-memory snapshot this often; the route never rescans on its own. */
    const POLL_MS = 60 * 1000;
    /** While the very first cold scan runs, poll the cheap status route at this cadence. */
    const SCAN_POLL_MS = 1200;
    /** Heatmap window. 56 days = 8 whole weeks, which fits the sidebar's width. */
    const RANGE_DAYS = 56;
    /** Cells per row of the hour strip. */
    const HOUR_LABELS = [0, 6, 12, 18, 23];
    /** localStorage key for the chosen heatmap metric. */
    const METRIC_STORE = 'dsh-input-insight:metric';
    // #endregion

    // #region dictionaries
    const zh = {
      tab: '输入洞察',
      title: '真人输入',
      guideTitle: '输入洞察',
      guideDescription: '每天自己真正敲了多少字：热力图 + 今日、连续天数、时段分布与会话排行',
      today: '今日',
      chars: '字符',
      hanzi: '汉字',
      msgs: '条',
      asks: '提问',
      askCustom: '手写',
      paste: '粘贴',
      noteShort: '未计入',
      metricChars: '字符',
      metricHanzi: '汉字',
      metricMsgs: '条数',
      streak: '连续',
      longest: '最长',
      activeDays: '有输入',
      days: '天',
      hours: '时段分布',
      recent: '近 7 天',
      topSessions: '输入最多的会话',
      allTime: '全期累计',
      refresh: '刷新',
      scanning: '正在扫描会话日志…',
      scanningFiles: '已扫 {done}/{total} 个文件',
      loading: '读取中…',
      updatedAt: '更新于 {time}',
      cost: '扫描 {sec}s · {files} 个文件',
      less: '少',
      more: '多',
      empty: '还没有真人输入记录',
      pickedHint: '点方格看当日明细',
      unnamed: '（未命名会话）',
      thisSession: '本会话',
      note: '码点计字；不含 AI 派工、自动续跑、fork 副本；控制台/构建日志类整段粘贴单独计为「粘贴」、不进字数；提问卡片的手写答案单独计',
      retry: '重试',
      errorPrefix: '读取失败：',
      charsUnit: '字'
    };
    const en = {
      tab: 'Input insight',
      title: 'Typed by you',
      guideTitle: 'Input insight',
      guideDescription: 'How many characters you actually typed per day: heatmap plus today, streak, hour profile and session ranking',
      today: 'Today',
      chars: 'Chars',
      hanzi: 'Hanzi',
      msgs: 'msgs',
      asks: 'Asks',
      askCustom: 'Handwritten',
      paste: 'Pasted',
      noteShort: 'not counted',
      metricChars: 'Chars',
      metricHanzi: 'Hanzi',
      metricMsgs: 'Messages',
      streak: 'Streak',
      longest: 'Longest',
      activeDays: 'Active',
      days: 'd',
      hours: 'Hour profile',
      recent: 'Last 7 days',
      topSessions: 'Top sessions by input',
      allTime: 'All time',
      refresh: 'Refresh',
      scanning: 'Scanning session logs…',
      scanningFiles: 'Scanned {done}/{total} files',
      loading: 'Loading…',
      updatedAt: 'Updated {time}',
      cost: 'Scan {sec}s · {files} files',
      less: 'Less',
      more: 'More',
      empty: 'No typed input recorded yet',
      pickedHint: 'Click a cell for that day',
      unnamed: '(untitled session)',
      thisSession: 'This session',
      note: 'Counted in code points; AI dispatch, auto-continue and fork copies excluded; pasted console/build logs are tracked separately as "Pasted" and never added to the char count; handwritten ask answers counted separately',
      retry: 'Retry',
      errorPrefix: 'Load failed: ',
      charsUnit: 'ch'
    };
    // #endregion

    // #region styles
    const css = `
.ii-panel{box-sizing:border-box;display:flex;flex-direction:column;gap:14px;height:100%;overflow-y:auto;
  padding:12px 12px 22px;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px}
.ii-head{display:flex;align-items:center;gap:8px;min-height:24px}
.ii-headTitle{flex:1;min-width:0;font-size:14px;font-weight:600;line-height:20px}
.ii-sub{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary)}
.ii-iconBtn{flex:none;display:grid;place-items:center;width:24px;height:24px;padding:0;border:none;border-radius:7px;
  cursor:pointer;background:transparent;color:var(--dsw-alias-label-tertiary)}
.ii-iconBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ii-iconBtn[data-busy="1"]{animation:ii-spin 1s linear infinite}
@keyframes ii-spin{to{transform:rotate(360deg)}}
.ii-tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
.ii-tile{display:flex;flex-direction:column;gap:2px;min-width:0;padding:8px 9px;border-radius:10px;
  background:var(--dsw-alias-bg-layer-2)}
.ii-tileV{font-size:16px;font-weight:600;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-variant-numeric:tabular-nums}
.ii-tileK{font-size:11px;line-height:14px;color:var(--dsw-alias-label-tertiary);overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.ii-card{display:flex;flex-direction:column;gap:8px;padding:10px;border-radius:12px;
  background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2)}
.ii-cardHead{display:flex;align-items:center;gap:8px}
.ii-cardTitle{flex:1;min-width:0;font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.ii-seg{display:flex;flex:none;gap:2px;padding:2px;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.ii-segBtn{border:none;padding:2px 7px;border-radius:6px;cursor:pointer;background:transparent;
  color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:11px;line-height:16px}
.ii-segBtn[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}
.ii-heat{display:flex;gap:6px;align-items:flex-start}
.ii-wds{display:flex;flex-direction:column;gap:4px;flex:none;padding-top:13px}
.ii-wd{width:14px;height:20px;font-size:10px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.ii-cols{display:flex;gap:4px;min-width:0}
.ii-col{display:flex;flex-direction:column;gap:4px}
.ii-mon{height:13px;font-size:10px;line-height:13px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;
  overflow:visible}
.ii-cell{box-sizing:border-box;width:20px;height:20px;padding:0;border:none;border-radius:5px;
  background:rgba(127,131,141,.16)}
.ii-cell[data-l="1"]{background:rgba(77,107,254,.20)}
.ii-cell[data-l="2"]{background:rgba(77,107,254,.42)}
.ii-cell[data-l="3"]{background:rgba(77,107,254,.66)}
.ii-cell[data-l="4"]{background:rgba(77,107,254,.92)}
.ii-cell[data-pick="1"]{box-shadow:0 0 0 1.5px var(--dsw-alias-label-primary)}
.ii-cell[data-future="1"]{background:transparent;border:.5px dashed var(--dsw-alias-border-l2)}
.ii-cell:not([data-future="1"]):hover{filter:brightness(1.18)}
.ii-legend{display:flex;align-items:center;justify-content:flex-end;gap:4px;font-size:10px;
  color:var(--dsw-alias-label-tertiary)}
.ii-legend .ii-cell{width:11px;height:11px;border-radius:3px}
.ii-picked{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;font-size:11px;line-height:16px;
  color:var(--dsw-alias-label-secondary)}
.ii-pickedKey{font-weight:500;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.ii-mid{display:flex;gap:8px}
.ii-stat{display:flex;flex-direction:column;gap:1px;flex:1;min-width:0}
.ii-statV{font-size:15px;font-weight:600;line-height:19px;font-variant-numeric:tabular-nums}
.ii-statK{font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary)}
.ii-hours{display:flex;align-items:flex-end;gap:2px;height:44px;padding-top:2px}
.ii-hour{flex:1;min-width:0;border-radius:2px 2px 1px 1px;background:rgba(77,107,254,.55);min-height:2px}
.ii-hourAxis{display:flex;justify-content:space-between;font-size:10px;color:var(--dsw-alias-label-tertiary);
  font-variant-numeric:tabular-nums}
.ii-rows{display:flex;flex-direction:column;gap:5px}
.ii-row{display:flex;align-items:center;gap:7px;font-size:11px;line-height:16px}
.ii-rowK{flex:none;width:44px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.ii-rowBar{position:relative;flex:1;min-width:0;height:5px;border-radius:3px;overflow:hidden;
  background:rgba(127,131,141,.18)}
.ii-rowFill{position:absolute;inset:0 auto 0 0;border-radius:3px;background:rgba(77,107,254,.75)}
.ii-rowV{flex:none;width:52px;text-align:right;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-primary)}
.ii-srow{display:flex;flex-direction:column;gap:3px}
.ii-srowTop{display:flex;align-items:baseline;gap:6px;font-size:11px;line-height:15px}
.ii-srowName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:var(--dsw-alias-label-primary)}
.ii-srowV{flex:none;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.ii-foot{display:flex;flex-direction:column;gap:3px;font-size:10px;line-height:14px;
  color:var(--dsw-alias-label-tertiary)}
.ii-empty{padding:18px 8px;text-align:center;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary)}
.ii-err{color:var(--dsw-alias-state-error-primary)}
.ii-retry{align-self:flex-start;margin-top:2px;padding:2px 9px;border-radius:6px;cursor:pointer;
  border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);
  font-family:inherit;font-size:11px;line-height:17px}
`;

    // Style injection stays at factory top level (synchronous, tagged with the
    // plugin id) so the host never attributes it to another plugin.
    try {
      if (typeof document !== 'undefined' && document.querySelector('style[data-plugin="' + TAB_ID + '"]') === null) {
        const tag = document.createElement('style');
        tag.dataset.plugin = TAB_ID;
        tag.textContent = css;
        document.head.appendChild(tag);
      }
    } catch (error) {
      /* a stylesheet failure must not break the panel */
    }
    // #endregion

    // #region helpers
    /** Thousands-separated integer, locale-independent by design (tabular columns). */
    function fmt(n) {
      const v = Number(n);
      if (!Number.isFinite(v)) return '0';
      return Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    /** Compact form for tiles: 12.3k / 980. */
    function fmtShort(n) {
      const v = Number(n);
      if (!Number.isFinite(v)) return '0';
      if (v >= 10000) return (v / 1000).toFixed(Math.abs(v) >= 100000 ? 0 : 1) + 'k';
      return fmt(v);
    }

    /** Shift a `YYYY-MM-DD` calendar key by whole days (timezone-free arithmetic). */
    function shiftKey(key, deltaDays) {
      const ms = Date.parse(key + 'T00:00:00Z') + deltaDays * 86400000;
      return new Date(ms).toISOString().slice(0, 10);
    }

    /** 0 = Sunday … 6 = Saturday for a `YYYY-MM-DD` key. */
    function weekdayOf(key) {
      return new Date(Date.parse(key + 'T00:00:00Z')).getUTCDay();
    }

    /** `MM-DD` + weekday glyph, e.g. `11-16 周日`. */
    function dayLabel(key, weekdays) {
      const wd = weekdayOf(key);
      return key.slice(5) + ' ' + (weekdays[wd] || '');
    }

    /**
     * Depth buckets for the heatmap. Percentiles rather than `value / max`:
     * one 40k-character day would otherwise flatten every other day to level 1.
     * @param values - every in-window metric value (zeros included).
     * @returns a mapper from value to level 0…4.
     */
    function makeLevels(values) {
      const nums = values.filter((v) => v > 0).sort((a, b) => a - b);
      if (nums.length === 0) return () => 0;
      const at = (p) => nums[Math.min(nums.length - 1, Math.floor((nums.length - 1) * p))];
      const t1 = at(0.25);
      const t2 = at(0.5);
      const t3 = at(0.75);
      return (v) => {
        if (!(v > 0)) return 0;
        if (v <= t1) return 1;
        if (v <= t2) return 2;
        if (v <= t3) return 3;
        return 4;
      };
    }

    /** Read the persisted metric, falling back to characters. */
    function readMetric() {
      try {
        const raw = window.localStorage.getItem(METRIC_STORE);
        if (raw === 'chars' || raw === 'hanzi' || raw === 'msgs') return raw;
      } catch (error) {
        /* private mode / storage disabled */
      }
      return 'chars';
    }

    function writeMetric(metric) {
      try {
        window.localStorage.setItem(METRIC_STORE, metric);
      } catch (error) {
        /* ignore */
      }
    }

    /** `{key: row}` index over `report.byDay`. */
    function indexByDay(report) {
      const index = Object.create(null);
      for (const row of report.byDay || []) index[row.key] = row;
      return index;
    }

    /** Icon: three descending bars plus a baseline — "input volume". */
    function InsightIcon({ size = 20, className }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          className,
          'aria-hidden': 'true',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg'
        },
        h('rect', { x: 3, y: 9, width: 4, height: 11, rx: 1.2, fill: 'currentColor', opacity: 0.45 }),
        h('rect', { x: 9, y: 4, width: 4, height: 16, rx: 1.2, fill: 'currentColor', opacity: 0.75 }),
        h('rect', { x: 15, y: 12, width: 4, height: 8, rx: 1.2, fill: 'currentColor', opacity: 0.45 }),
        h('rect', { x: 3, y: 21, width: 16, height: 1.2, rx: 0.6, fill: 'currentColor', opacity: 0.25 })
      );
    }

    /** Icon: a circular refresh arrow. */
    function RefreshIcon() {
      return h(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M20 11a8 8 0 1 0-2.3 6.3',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round'
        }),
        h('path', { d: 'M20 4.5V11h-6.5', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' })
      );
    }
    // #endregion

    // #region data
    /**
     * Fetch one snapshot. The host answers `{status, report, scannedAt, error, progress}`;
     * `refresh=1` asks it to re-read the logs before answering.
     * @param force - re-read the session logs rather than serve the cached snapshot.
     */
    async function fetchReport(force) {
      const url = force === true ? REPORT_ROUTE + '?refresh=1' : REPORT_ROUTE;
      const response = await fetch(url, { cache: 'no-store', headers: { accept: 'application/json' } });
      const body = await response.json();
      if (body === null || typeof body !== 'object') throw new Error('empty payload');
      return body;
    }

    /**
     * Own the snapshot: first load on mount, a light 60 s re-read afterwards, and
     * a tighter poll only while the very first cold scan is still running.
     */
    function useSnapshot() {
      const [state, setState] = React.useState({
        status: 'loading',
        report: null,
        error: null,
        scannedAt: 0,
        elapsedMs: 0,
        progress: null
      });
      const [busy, setBusy] = React.useState(false);

      const load = React.useCallback(async (force) => {
        try {
          const body = await fetchReport(force);
          setState({
            status: typeof body.status === 'string' ? body.status : 'ready',
            report: body.report || null,
            error: body.error || null,
            scannedAt: Number(body.scannedAt) || 0,
            elapsedMs: Number(body.elapsedMs) || 0,
            progress: body.progress || null
          });
        } catch (error) {
          setState((prev) => Object.assign({}, prev, {
            status: 'error',
            error: String((error && error.message) || error)
          }));
        }
      }, []);

      React.useEffect(() => {
        let alive = true;
        load(false).catch(() => {});
        const timer = setInterval(() => {
          if (alive) load(false).catch(() => {});
        }, POLL_MS);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [load]);

      // Cold start: the first pass over the whole corpus takes ~28 s, so keep
      // asking until a report exists instead of leaving the panel on a spinner.
      React.useEffect(() => {
        if (state.report !== null) return undefined;
        if (state.status !== 'scanning' && state.status !== 'loading') return undefined;
        const timer = setInterval(() => {
          load(false).catch(() => {});
        }, SCAN_POLL_MS);
        return () => clearInterval(timer);
      }, [state.report, state.status, load]);

      const refresh = React.useCallback(() => {
        setBusy(true);
        load(true)
          .catch(() => {})
          .then(() => setBusy(false));
      }, [load]);

      return { state, busy, refresh };
    }
    // #endregion

    // #region heatmap
    /**
     * 8-week × 7-day grid ending in the current week, Sunday-first like the
     * stock activity heatmap.
     * @param todayKey - today in UTC+8 (`report.today.key`).
     */
    function gridOf(todayKey, weeks) {
      const dow = weekdayOf(todayKey);
      const lastSunday = shiftKey(todayKey, -dow);
      const firstSunday = shiftKey(lastSunday, -(weeks - 1) * 7);
      const columns = [];
      for (let wi = 0; wi < weeks; wi += 1) {
        const column = [];
        for (let d = 0; d < 7; d += 1) {
          const key = shiftKey(firstSunday, wi * 7 + d);
          column.push({ key, future: key > todayKey });
        }
        columns.push(column);
      }
      return columns;
    }

    function Heatmap(props) {
      const { t, rows, monthOf, weekdays, metric, picked, onPick } = props;
      const todayKey = props.today;
      const weeks = Math.ceil(props.rangeDays / 7);
      const columns = gridOf(todayKey, weeks);
      const byKey = React.useMemo(() => indexByDay({ byDay: rows }), [rows]);
      const valueOf = (row) => {
        if (metric === 'hanzi') return row.hanzi;
        if (metric === 'msgs') return row.msgs;
        return row.chars;
      };
      const values = [];
      for (const column of columns) {
        for (const cell of column) {
          const row = byKey[cell.key];
          if (row !== undefined && !cell.future) values.push(valueOf(row));
        }
      }
      const levelOf = makeLevels(values);
      const unit = metric === 'msgs' ? t('msgs') : metric === 'hanzi' ? t('hanzi') : t('charsUnit');

      const cellTitle = (key) => {
        const row = byKey[key];
        if (row === undefined) return key;
        return (
          key +
          '\n' + t('chars') + ' ' + fmt(row.chars) +
          ' · ' + t('hanzi') + ' ' + fmt(row.hanzi) +
          ' · ' + fmt(row.msgs) + ' ' + t('msgs') +
          (Number(row.pasteChars) > 0 ? '\n' + t('paste') + ' ' + fmt(row.pasteChars) + ' · ' + t('noteShort') : '') +
          '\n' + t('asks') + ' ' + fmt(row.asks) + ' · ' + t('askCustom') + ' ' + fmt(row.askCustom)
        );
      };

      return h(
        'div',
        { className: 'ii-card' },
        h(
          'div',
          { className: 'ii-cardHead' },
          h('div', { className: 'ii-cardTitle' }, t('title') + ' · ' + t('allTime')),
          h(
            'div',
            { className: 'ii-seg', role: 'group', 'aria-label': t('title') },
            [
              ['chars', t('metricChars')],
              ['hanzi', t('metricHanzi')],
              ['msgs', t('metricMsgs')]
            ].map(([value, label]) =>
              h(
                'button',
                {
                  key: value,
                  type: 'button',
                  className: 'ii-segBtn',
                  'aria-pressed': metric === value ? 'true' : 'false',
                  onClick: () => props.onMetric(value)
                },
                label
              )
            )
          )
        ),
        h(
          'div',
          { className: 'ii-heat', role: 'group', 'aria-label': t('title') },
          h(
            'div',
            { className: 'ii-wds', 'aria-hidden': 'true' },
            [0, 1, 2, 3, 4, 5, 6].map((row) =>
              h('span', { key: row, className: 'ii-wd' }, row === 1 ? weekdays[1] : row === 3 ? weekdays[3] : row === 5 ? weekdays[5] : '')
            )
          ),
          h(
            'div',
            { className: 'ii-cols' },
            columns.map((column, wi) =>
              h(
                'div',
                { key: wi, className: 'ii-col' },
                h(
                  'span',
                  { className: 'ii-mon', 'aria-hidden': 'true' },
                  wi === 0 || column[0].key.slice(0, 7) !== column[6].key.slice(0, 7)
                    ? monthOf(column[6].key.slice(5, 7))
                    : ''
                ),
                column.map((cell) => {
                  if (cell.future) {
                    return h('span', { key: cell.key, className: 'ii-cell', 'data-future': '1', 'aria-hidden': 'true' });
                  }
                  const row = byKey[cell.key];
                  const level = row === undefined ? 0 : levelOf(valueOf(row));
                  return h('button', {
                    key: cell.key,
                    type: 'button',
                    className: 'ii-cell',
                    'data-l': String(level),
                    'data-pick': picked === cell.key ? '1' : '0',
                    title: cellTitle(cell.key),
                    'aria-label': cellTitle(cell.key).replace(/\n/g, ' '),
                    onClick: () => onPick(picked === cell.key ? null : cell.key)
                  });
                })
              )
            )
          )
        ),
        h(
          'div',
          { className: 'ii-legend', 'aria-hidden': 'true' },
          h('span', null, t('less')),
          [0, 1, 2, 3, 4].map((level) => h('span', { key: level, className: 'ii-cell', 'data-l': String(level) })),
          h('span', null, t('more'))
        ),
        picked !== null && byKey[picked] !== undefined
          ? h(
              'div',
              { className: 'ii-picked' },
              h('span', { className: 'ii-pickedKey' }, picked),
              h('span', null, t('chars') + ' ' + fmt(byKey[picked].chars)),
              h('span', null, t('hanzi') + ' ' + fmt(byKey[picked].hanzi)),
              h('span', null, fmt(byKey[picked].msgs) + ' ' + t('msgs')),
              h('span', null, t('asks') + ' ' + fmt(byKey[picked].asks)),
              h('span', null, t('askCustom') + ' ' + fmt(byKey[picked].askCustom)),
              Number(byKey[picked].pasteChars) > 0
                ? h('span', null, t('paste') + ' ' + fmt(byKey[picked].pasteChars) + '（' + t('noteShort') + '）')
                : null
            )
          : h('div', { className: 'ii-sub' }, t('pickedHint') + ' · ' + unit)
      );
    }
    // #endregion

    // #region panel
    function Panel(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackT;
      const { state, busy, refresh } = useSnapshot();
      const [metric, setMetric] = React.useState(readMetric);
      const [picked, setPicked] = React.useState(null);
      const sessionId = React.useMemo(() => currentSessionId(), []);
      const weekdays = React.useMemo(() => weekdaysOf(t), [t]);
      const monthOf = React.useMemo(() => monthOfFactory(t), [t]);

      const chooseMetric = React.useCallback((next) => {
        setMetric(next);
        writeMetric(next);
      }, []);

      const report = state.report;

      if (report === null) {
        const scanning = state.status === 'scanning' || state.status === 'loading';
        const progress = state.progress;
        return h(
          'div',
          { className: 'ii-panel' },
          h('div', { className: 'ii-head' }, h('div', { className: 'ii-headTitle' }, t('title'))),
          h(
            'div',
            { className: 'ii-empty' },
            scanning ? t('scanning') : state.status === 'error' ? h('span', { className: 'ii-err' }, t('errorPrefix') + String(state.error || '')) : t('empty'),
            scanning && progress !== null && Number(progress.total) > 0
              ? h('div', { className: 'ii-sub' }, t('scanningFiles', { done: progress.done, total: progress.total }))
              : null,
            state.status === 'error'
              ? h('button', { type: 'button', className: 'ii-retry', onClick: refresh }, t('retry'))
              : null
          )
        );
      }

      const rows = report.byDay || [];
      const today = report.today || { chars: 0, hanzi: 0, msgs: 0 };
      const streak = report.streak || { current: 0, longest: 0 };
      const totals = report.totals || {};
      const byHour = report.byHour || new Array(24).fill(0);
      const hourMax = byHour.reduce((m, v) => (v > m ? v : m), 0);
      const recent = rows.slice(-7).reverse();
      const recentMax = recent.reduce((m, r) => (r.chars > m ? r.chars : m), 0);
      const sessions = (report.bySession || []).slice(0, 5);
      const sessionMax = sessions.reduce((m, s) => (s.chars > m ? s.chars : m), 0);
      const mine = sessionId === null ? undefined : (report.bySession || []).find((s) => s.sid === sessionId);
      const time = state.scannedAt > 0 ? clockOf(state.scannedAt) : '';

      return h(
        'div',
        { className: 'ii-panel' },
        h(
          'div',
          { className: 'ii-head' },
          h('div', { className: 'ii-headTitle' }, t('title')),
          time !== '' ? h('div', { className: 'ii-sub' }, t('updatedAt', { time })) : null,
          h(
            'button',
            {
              type: 'button',
              className: 'ii-iconBtn',
              'data-busy': busy ? '1' : '0',
              title: t('refresh'),
              'aria-label': t('refresh'),
              onClick: refresh
            },
            h(RefreshIcon, null)
          )
        ),
        h(
          'div',
          { className: 'ii-tiles' },
          h('div', { className: 'ii-tile' }, h('div', { className: 'ii-tileV' }, fmtShort(today.chars)), h('div', { className: 'ii-tileK' }, t('today') + ' · ' + t('chars'))),
          h('div', { className: 'ii-tile' }, h('div', { className: 'ii-tileV' }, fmtShort(today.hanzi)), h('div', { className: 'ii-tileK' }, t('today') + ' · ' + t('hanzi'))),
          h('div', { className: 'ii-tile' }, h('div', { className: 'ii-tileV' }, fmt(today.msgs)), h('div', { className: 'ii-tileK' }, t('today') + ' · ' + t('msgs')))
        ),
        h(Heatmap, {
          t,
          rows,
          today: today.key,
          rangeDays: report.rangeDays || RANGE_DAYS,
          metric,
          picked,
          onPick: setPicked,
          onMetric: chooseMetric,
          weekdays,
          monthOf
        }),
        h(
          'div',
          { className: 'ii-card' },
          h(
            'div',
            { className: 'ii-mid' },
            h('div', { className: 'ii-stat' }, h('div', { className: 'ii-statV' }, fmt(streak.current) + ' ' + t('days')), h('div', { className: 'ii-statK' }, t('streak'))),
            h('div', { className: 'ii-stat' }, h('div', { className: 'ii-statV' }, fmt(streak.longest) + ' ' + t('days')), h('div', { className: 'ii-statK' }, t('longest'))),
            h('div', { className: 'ii-stat' }, h('div', { className: 'ii-statV' }, fmt(totals.activeDays)), h('div', { className: 'ii-statK' }, t('activeDays')))
          )
        ),
        h(
          'div',
          { className: 'ii-card' },
          h('div', { className: 'ii-cardHead' }, h('div', { className: 'ii-cardTitle' }, t('hours'))),
          h(
            'div',
            { className: 'ii-hours' },
            byHour.map((v, hour) =>
              h('div', {
                key: hour,
                className: 'ii-hour',
                style: { height: hourMax > 0 ? Math.max(2, Math.round((v / hourMax) * 42)) + 'px' : '2px' },
                title: hour + ':00 · ' + fmt(v) + ' ' + t('chars')
              })
            )
          ),
          h(
            'div',
            { className: 'ii-hourAxis' },
            HOUR_LABELS.map((hour) => h('span', { key: hour }, String(hour)))
          )
        ),
        h(
          'div',
          { className: 'ii-card' },
          h('div', { className: 'ii-cardHead' }, h('div', { className: 'ii-cardTitle' }, t('recent'))),
          h(
            'div',
            { className: 'ii-rows' },
            recent.map((row) =>
              h(
                'div',
                { key: row.key, className: 'ii-row' },
                h('span', { className: 'ii-rowK' }, dayLabel(row.key, weekdays)),
                h('span', { className: 'ii-rowBar' }, h('span', { className: 'ii-rowFill', style: { width: recentMax > 0 ? Math.max(2, (row.chars / recentMax) * 100) + '%' : '0%' } })),
                h('span', { className: 'ii-rowV' }, fmt(row.chars))
              )
            )
          )
        ),
        sessions.length > 0
          ? h(
              'div',
              { className: 'ii-card' },
              h('div', { className: 'ii-cardHead' }, h('div', { className: 'ii-cardTitle' }, t('topSessions'))),
              h(
                'div',
                { className: 'ii-rows' },
                sessions.map((session) =>
                  h(
                    'div',
                    { key: session.sid, className: 'ii-srow' },
                    h(
                      'div',
                      { className: 'ii-srowTop' },
                      h('span', { className: 'ii-srowName', title: session.title || t('unnamed') }, session.title || t('unnamed')),
                      h('span', { className: 'ii-srowV' }, fmt(session.chars))
                    ),
                    h('span', { className: 'ii-rowBar' }, h('span', { className: 'ii-rowFill', style: { width: sessionMax > 0 ? Math.max(2, (session.chars / sessionMax) * 100) + '%' : '0%' } }))
                  )
                )
              ),
              mine !== undefined
                ? h('div', { className: 'ii-sub' }, t('thisSession') + ' · ' + fmt(mine.chars) + ' ' + t('chars') + ' · ' + fmt(mine.hanzi) + ' ' + t('hanzi'))
                : null
            )
          : null,
        h(
          'div',
          { className: 'ii-card' },
          h('div', { className: 'ii-cardTitle' }, t('allTime')),
          h(
            'div',
            { className: 'ii-mid' },
            h('div', { className: 'ii-stat' }, h('div', { className: 'ii-statV' }, fmtShort(totals.chars)), h('div', { className: 'ii-statK' }, t('chars'))),
            h('div', { className: 'ii-stat' }, h('div', { className: 'ii-statV' }, fmtShort(totals.hanzi)), h('div', { className: 'ii-statK' }, t('hanzi'))),
            h('div', { className: 'ii-stat' }, h('div', { className: 'ii-statV' }, fmt(totals.asks)), h('div', { className: 'ii-statK' }, t('asks')))
          )
        ),
        h(
          'div',
          { className: 'ii-foot' },
          h('span', null, t('note')),
          h('span', null, t('cost', { sec: (state.elapsedMs / 1000).toFixed(1), files: fmt((report.known && report.known.files) || 0) }))
        )
      );
    }

    /** Chinese weekday names, English when the active locale is not zh. */
    function weekdaysOf(t) {
      const zhNames = ['日', '一', '二', '三', '四', '五', '六'];
      const enNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const probe = t('tab');
      const names = probe === zh.tab ? zhNames : enNames;
      return names;
    }

    function monthOfFactory(t) {
      const months = probeLocale(t) === 'zh'
        ? ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']
        : ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return (mm) => months[Number(mm) - 1] || '';
    }

    /** Which dictionary the bound translate answers with (labels that need names, not keys). */
    function probeLocale(t) {
      try {
        return t('tab') === zh.tab ? 'zh' : 'en';
      } catch (error) {
        return 'en';
      }
    }

    /** `HH:MM` in UTC+8, the same calendar the report uses. */
    function clockOf(ms) {
      const d = new Date(Number(ms) + 8 * 3600 * 1000);
      const hh = String(d.getUTCHours()).padStart(2, '0');
      const mm = String(d.getUTCMinutes()).padStart(2, '0');
      return hh + ':' + mm;
    }

    /**
     * The current session id, taken from the URL (`/session/<id>`) so the panel can
     * point at this conversation's own number without importing a session service.
     */
    function currentSessionId() {
      try {
        const match = /(?:^|\/)session\/([0-9a-zA-Z-]+)/.exec(window.location.pathname || '');
        return match === null ? null : match[1];
      } catch (error) {
        return null;
      }
    }

    /** Translate used when a seat hands no `t` (older harness): pick by page language. */
    function fallbackT(key, params) {
      let dict = en;
      try {
        const lang = (document.documentElement.lang || navigator.language || '').toLowerCase();
        if (lang.indexOf('zh') === 0) dict = zh;
      } catch (error) {
        /* keep English */
      }
      const raw = dict[key] !== undefined ? dict[key] : zh[key] !== undefined ? zh[key] : key;
      if (params === undefined) return raw;
      return String(raw).replace(/\{(\w+)\}/g, (whole, name) => (params[name] !== undefined ? String(params[name]) : whole));
    }

    /** The tab chip: icon + label, rendered from the plugin's bound translate. */
    function makeTabTitle(t) {
      return function InputInsightTabTitle() {
        return h(
          React.Fragment,
          null,
          h(InsightIcon, { size: 16, className: 'ii-chipIcon' }),
          h('span', null, t('tab'))
        );
      };
    }
    // #endregion

    // #region plugin
    /** Hard injects: the slot registry and the locale service, nothing else. */
    const inject = ['slots', 'locale'];

    /**
     * Seat the tab if — and only if — this harness serves the sidebar tab registry.
     * Deferred, so a harness without it never pends this plugin's fiber.
     */
    function watchTab(ctx, t, ns) {
      const handle = ctx.inject(['sidebarRightTabs'], (raw) => {
        const injected = raw;
        const disposers = [];
        const own = (result) => {
          if (typeof result === 'function') disposers.push(result);
        };
        try {
          const tabs = injected.sidebarRightTabs;
          if (tabs === undefined || tabs === null || typeof tabs.register !== 'function') {
            console.warn('[dsh-input-insight] sidebarRightTabs unavailable — no tab registered');
            return;
          }
          own(
            tabs.register({
              id: TAB_ID,
              kind: TAB_KIND,
              title: () => t('tab'),
              guide: [
                {
                  order: GUIDE_ORDER,
                  title: () => t('guideTitle'),
                  description: () => t('guideDescription'),
                  icon: InsightIcon
                }
              ]
            })
          );
          console.info('[dsh-input-insight] tab type registered: ' + TAB_ID);
          const slots = injected.slots;
          if (slots === undefined || slots === null || typeof slots.inject !== 'function') {
            console.warn('[dsh-input-insight] slots service unavailable — tab body missing');
            return () => {
              for (const dispose of disposers) {
                try {
                  dispose();
                } catch (inner) {
                  /* ignore */
                }
              }
            };
          }
          own(
            slots.inject('sidebar.right.pane.tab', () =>
              slots.register(
                { name: 'sidebar.right.pane.tab', key: TAB_ID, locale: ns },
                (props) => h(Panel, Object.assign({}, props, { host: 'sidebar' }))
              )
            )
          );
          own(
            slots.inject('sidebar.right.pane.tab.title', () =>
              slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, makeTabTitle(t))
            )
          );
          console.info('[dsh-input-insight] tab body + chip title registered');
        } catch (error) {
          console.error('[dsh-input-insight] tab registration failed', error);
          for (const dispose of disposers) {
            try {
              dispose();
            } catch (inner) {
              /* keep unwinding */
            }
          }
          return;
        }
        return () => {
          for (const dispose of disposers) {
            try {
              dispose();
            } catch (inner) {
              /* ignore */
            }
          }
        };
      });
      return () => {
        try {
          if (handle !== undefined && handle !== null && typeof handle.dispose === 'function') handle.dispose();
        } catch (error) {
          /* ignore */
        }
      };
    }

    /**
     * Client plugin body: register the dictionaries, then seat the tab. No timers,
     * no DOM readers, no other plugin's services.
     * @param ctx - client cordis context.
     */
    function apply(ctx) {
      // Everything below is guarded: a missing locale service must degrade to the
      // built-in fallback translate, never abort `apply` and lose the tab.
      const locale = ctx.locale;
      try {
        if (locale !== undefined && locale !== null && typeof locale.register === 'function') {
          ctx.effect(() => locale.register(NS, { zh, en }), 'input-insight: dictionaries');
        } else {
          console.warn('[dsh-input-insight] locale service unavailable — using built-in dictionary');
        }
      } catch (error) {
        console.warn('[dsh-input-insight] dictionary registration failed', error);
      }
      let t = fallbackT;
      try {
        if (locale !== undefined && locale !== null && typeof locale.bind === 'function') t = locale.bind(NS);
      } catch (error) {
        console.warn('[dsh-input-insight] locale bind failed — using built-in dictionary', error);
      }
      try {
        ctx.effect(() => watchTab(ctx, t, NS), 'input-insight: sidebar tab');
      } catch (error) {
        console.error('[dsh-input-insight] tab seating failed', error);
      }
      console.info('[dsh-input-insight] client apply done');
    }
    // #endregion

    exports.Panel = Panel;
    exports.Heatmap = Heatmap;
    exports.InsightIcon = InsightIcon;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
