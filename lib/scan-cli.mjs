// dsh-input-insight / lib/scan-cli.mjs
// 用法：node lib/scan-cli.mjs [--full] [--days 56] [--json]
// 打印扫描耗时、最近 7 天表、前 10 会话、报告 JSON 体积、与已知基线对账。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { createScanner, buildReport, dayKey, cp } from './scan.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.dirname(HERE);

// 日志根目录：显式环境变量 > DSH_HOME > ~/.dsh。不写死任何机器路径。
const SESSIONS_ROOT = process.env.INSIGHT_SESSIONS_ROOT
  || (process.env.DSH_HOME && process.env.DSH_HOME !== ''
    ? path.join(process.env.DSH_HOME, 'sessions')
    : path.join(os.homedir(), '.dsh', 'sessions'));
const CACHE_FILE = path.join(PLUGIN_ROOT, '.cache', 'scan-cache.json');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const numArg = (f, dflt) => {
  const i = argv.indexOf(f);
  if (i === -1) return dflt;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) ? v : dflt;
};
const FORCE_FULL = has('--full');
const RANGE_DAYS = numArg('--days', 56);

const pad = (s, n) => {
  const str = String(s);
  const w = cp(str);
  return w >= n ? str : ' '.repeat(n - w) + str;
};
const padR = (s, n) => {
  const str = String(s);
  const w = cp(str);
  return w >= n ? str : str + ' '.repeat(n - w);
};
const kb = (n) => (n / 1024).toFixed(1) + ' KB';

function main() {
  return run();
}

async function run() {
  if (FORCE_FULL) { try { fs.rmSync(CACHE_FILE, { force: true }); } catch (_) {} }

  const lines = [];
  const scanner = createScanner({ sessionsRoot: SESSIONS_ROOT, cacheFile: CACHE_FILE });

  // ---- 第一次：全量（缓存不存在时）或增量
  let r1;
  try {
    r1 = await scanner.scan({});
  } catch (err) {
    console.error('[scan failed]', err && err.stack ? err.stack : err);
    process.exit(1);
    return;
  }

  // ---- 第二次：同缓存再跑，纯增量
  const r2 = await scanner.scan({});

  const agg = r2.agg;
  const report = buildReport(agg, { days: RANGE_DAYS });
  const jsonStr = JSON.stringify(report);
  const jsonBytes = Buffer.byteLength(jsonStr);
  // 一致性自检：第一次与第二次（纯增量）折叠出的总量应当相同
  const r1Totals = buildReport(r1.agg, { days: RANGE_DAYS }).totals;
  const consistent = JSON.stringify(r1Totals) === JSON.stringify(report.totals);

  lines.push('=== dsh-input-insight 扫描报告 ===');
  lines.push('sessionsRoot : ' + SESSIONS_ROOT);
  lines.push('cacheFile    : ' + CACHE_FILE);
  lines.push('文件数       : ' + r1.files + '（扫描 ' + r1.filesScanned + ' 个，跳过 ' + r1.skippedFiles + ' 个）');
  lines.push('会话数       : ' + Object.keys(agg.sessions).length);
  lines.push('');
  lines.push('--- 耗时 ---');
  lines.push('第 1 次（' + (r1.fullScan ? '全量' : '带缓存增量') + '）: ' + r1.elapsedMs + ' ms  [' + r1.incrementalFiles + ' 个文件走增量尾巴]');
  lines.push('第 2 次（纯增量）        : ' + r2.elapsedMs + ' ms  [' + r2.incrementalFiles + ' 个文件走增量尾巴]');
  lines.push('增量一致性: 第一次与第二次聚合 ' + (consistent ? '完全一致' : '不一致(见下)'));
  lines.push('解码统计: frames=' + agg.stats.frames + '  badFrames=' + agg.stats.badFrames + '  bytes=' + (agg.stats.bytes / 1048576).toFixed(1) + ' MB');
  lines.push('');
  lines.push('--- 口径计数 ---');
  lines.push('events=' + agg.stats.events + '  user/message=' + (agg.stats.humanMsgs + agg.stats.injectedMsgs)
    + '（真人 ' + agg.stats.humanMsgs + ' / 注入 ' + agg.stats.injectedMsgs + '）');
  lines.push('multiText=' + agg.stats.multiText + '  noText=' + agg.stats.noText
    + '  fork重复去重=' + agg.stats.dupSkipped + ' 条/' + agg.stats.dupChars + ' 字符  badJson=' + agg.stats.badJson);
  lines.push('机器粘贴(不计入字数): ' + (agg.stats.machineMsgs || 0) + ' 条 / ' + (agg.stats.machineChars || 0) + ' 字符');
  lines.push('ask: 调用 ' + agg.stats.askCalls + ' 次 / answers ' + agg.stats.askAnswers
    + ' 条 / selected ' + report.totals.askSelected + ' 个 / custom ' + report.totals.askCustom + ' 字');
  lines.push('累计: 真人 ' + report.totals.msgs + ' 条 / ' + report.totals.chars + ' 字符 / '
    + report.totals.hanzi + ' 汉字 / 有输入天数 ' + report.totals.activeDays);
  lines.push('今天(' + report.today.key + '): ' + report.today.msgs + ' 条 / ' + report.today.chars + ' 字符 / ' + report.today.hanzi + ' 汉字');
  lines.push('连续输入: 当前 ' + report.streak.current + ' 天 / 最长 ' + report.streak.longest + ' 天');
  lines.push('');

  // ---- 最近 7 天
  const last7 = report.byDay.slice(-7);
  lines.push('--- 最近 7 天 ---');
  lines.push('日期         条数   字符   汉字   ask次数  ask手写   粘贴(未计入)');
  for (const d of last7) {
    lines.push(d.key + '  ' + pad(d.msgs, 5) + ' ' + pad(d.chars, 6) + ' ' + pad(d.hanzi, 6)
      + '   ' + pad(d.asks, 5) + '   ' + pad(d.askCustom, 6) + '   ' + pad(d.pasteChars || 0, 8));
  }
  lines.push('');

  // ---- 前 10 会话
  lines.push('--- 前 10 会话（字符降序）---');
  lines.push('字符     汉字   条数  最近活动            场景/标题');
  for (const s of report.bySession.slice(0, 10)) {
    const when = s.lastTime ? dayKey(s.lastTime) : '-';
    lines.push(pad(s.chars, 7) + '  ' + pad(s.hanzi, 6) + ' ' + pad(s.msgs, 5) + '  '
      + pad(when, 19) + ' ' + (s.title || s.sid).slice(0, 40));
  }
  lines.push('');

  // ---- 体积
  const bySessionBytes = Buffer.byteLength(JSON.stringify(report.bySession));
  lines.push('--- 报告体积 ---');
  lines.push('report JSON: ' + jsonBytes + ' 字节 (' + kb(jsonBytes) + ')  bySession: ' + Buffer.byteLength(JSON.stringify(report.bySession.slice(0, 200))) + ' 字节');
  lines.push('bySession.days 是否被收窄: ' + report.meta.trimmedSessionDays);
  if (has('--json')) {
    const outDir = path.join(PLUGIN_ROOT, '.cache');
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, 'report.json');
    fs.writeFileSync(outFile, jsonStr, 'utf8');
    lines.push('已写出: ' + outFile);
  }
  lines.push('');

  // ---- 口径自检（只依赖本机这次扫描，不写死任何具体数值）
  lines.push('--- 口径自检 ---');
  const checks = [];

  checks.push({
    name: '增量与全量聚合一致',
    ok: consistent,
    detail: consistent ? 'totals 逐字段相同' : 'totals 不同（增量拼接可能漏行）',
  });

  checks.push({
    name: '解码无坏帧 / 坏 JSON',
    ok: agg.stats.badFrames === 0 && agg.stats.badJson === 0,
    detail: 'badFrames=' + agg.stats.badFrames + ' badJson=' + agg.stats.badJson,
  });

  // 全局日账由 sessions 派生：窗口内两者必须逐日相等。
  // 注意要对 agg.sessions 全量求和 —— 报表里的 bySession 只留前 200 个会话，拿它求和会漏。
  const derived = new Map();
  for (const s of Object.values(agg.sessions)) {
    for (const [key, d] of Object.entries(s.days || {})) {
      const cur = derived.get(key) || { chars: 0, hanzi: 0, msgs: 0, asks: 0, askCustom: 0, pasteChars: 0, pasteMsgs: 0 };
      cur.chars += d.chars || 0;
      cur.hanzi += d.hanzi || 0;
      cur.msgs += d.msgs || 0;
      cur.asks += d.asks || 0;
      cur.askCustom += d.askCustom || 0;
      cur.pasteChars += d.pasteChars || 0;
      cur.pasteMsgs += d.pasteMsgs || 0;
      derived.set(key, cur);
    }
  }
  let dayDrift = 0;
  for (const d of report.byDay) {
    const a = derived.get(d.key) || { chars: 0, hanzi: 0, msgs: 0, asks: 0, askCustom: 0, pasteChars: 0, pasteMsgs: 0 };
    if (a.chars !== d.chars || a.hanzi !== d.hanzi || a.msgs !== d.msgs
      || a.asks !== d.asks || a.askCustom !== d.askCustom
      || a.pasteChars !== (d.pasteChars || 0) || a.pasteMsgs !== (d.pasteMsgs || 0)) dayDrift += 1;
  }
  checks.push({
    name: '全局日账 = 会话分日之和',
    ok: dayDrift === 0,
    detail: dayDrift === 0 ? report.byDay.length + ' 天逐日相等' : dayDrift + ' 天不一致',
  });

  // 有输入天数应等于"全期有字符的天数"，两者同源但算法不同
  const allDays = new Set();
  for (const s of Object.values(agg.sessions)) {
    for (const [key, d] of Object.entries(s.days || {})) if (d.chars > 0) allDays.add(key);
  }
  checks.push({
    name: '活动天数口径一致',
    ok: allDays.size === report.totals.activeDays,
    detail: '派生 ' + allDays.size + ' 天 / 报表 ' + report.totals.activeDays + ' 天',
  });

  for (const c of checks) {
    lines.push((c.ok ? '[PASS] ' : '[FAIL] ') + c.name + '  —  ' + c.detail);
  }
  lines.push('');

  const summary = {
    elapsed: { first: r1.elapsedMs, second: r2.elapsedMs, firstFull: r1.fullScan, files: r1.files },
    totals: report.totals,
    today: report.today,
    streak: report.streak,
    jsonBytes,
    checks,
    last7: last7.map((d) => ({ key: d.key, msgs: d.msgs, chars: d.chars, hanzi: d.hanzi, askCustom: d.askCustom, pasteChars: d.pasteChars || 0 })),
    topSessions: report.bySession.slice(0, 10).map((s) => ({ sid: s.sid, chars: s.chars, title: s.title })),
    known: report.known,
  };
  lines.push('SUMMARY_JSON ' + JSON.stringify(summary));
  console.log(lines.join('\n'));
}

function awaitScan() { throw new Error('unreachable'); }

main();
