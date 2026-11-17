// dsh-input-insight / lib/scan.js
// 会话日志增量扫描器。零依赖：只用 node:fs / node:path / node:zlib。
//
// 关键事实（见 REPORT.md）：
//   * 每个 session.v4.jsonl.zstd 是多个 zstd frame 首尾相接，
//     zstdDecompressSync(整文件) 只解第一个 frame（约 226 字节 = header 行），必须切帧逐解。
//   * 真人输入的唯一硬判据：type==="user/message" && data.source.kind==="user" && 非空 data.source.rpcId。
//   * fork(isSeeded) 会话物理复制父历史，data.id 原样相同 → 跨会话按 data.id 去重。
//   * 全局 days 由 sessions 派生（单一真相），sessions 分日存，截断时整会话扣减。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const LOG_BASENAME = 'session.v4.jsonl.zstd';
export const TZ_OFFSET_MS = 8 * 3600 * 1000; // Asia/Shanghai，写死不跟机器时区走
export const CACHE_VERSION = 2; // v2：机器粘贴单独记账 + seenIds 持久化，旧缓存必须整份作废
export const CALLNAME_CAP = 200;
export const SESSION_LIMIT = 200;
export const REPORT_MAX_BYTES = 1.5 * 1024 * 1024;
/** 去重表落盘的条数上限：超过这个量说明日志规模异常，宁可只在本轮内存里去重。 */
export const SEEN_PERSIST_MAX = 500000;

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const MAGIC_U32 = 0x28b52ffd;
const HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/g;
const DAY_MS = 86400000;

// ---------------------------------------------------------------- 基础口径

export const cp = (s) => [...String(s == null ? '' : s)].length; // 码点计数
export const hanzi = (s) => {
  const m = String(s == null ? '' : s).match(HAN_RE);
  return m ? m.length : 0;
};
export const dayKey = (ms) => new Date(Number(ms) + TZ_OFFSET_MS).toISOString().slice(0, 10);
export const hourOf = (ms) => new Date(Number(ms) + TZ_OFFSET_MS).getUTCHours();
export const isHumanMessage = (data) => {
  const src = (data && data.source) || null;
  return !!src && src.kind === 'user' && typeof src.rpcId === 'string' && src.rpcId.length > 0;
};

// ------------------------------------------------- 机器文本（粘贴）判别
//
// 人会把浏览器控制台、构建日志、JSON 配置整段粘进对话框。那是"发出去的消息"，
// 但不是"自己敲的字"：一条 48 万字的控制台转储会把热力图量纲整个压垮
// —— 2026-11-17 实测单条 480,255 字 / 汉字仅 64 个 / 543 行 / ASCII 占 99.8%。
// 所以按**结构特征**把它单独记为 pasteChars，不计入 chars / hanzi，也不隐藏。
//
// 四条判据都要求"够长 + 结构化"，普通中文口述转写（哪怕几万字、上千行）不会命中：
//   1) ascii-log      行数≥40 且 汉字<2% 且 ASCII≥95% —— 中文口述/手打不可能长这样
//   2) tag-lines      `[tag]` 前缀行占三成以上 —— 控制台日志的典型形态
//   3) stack-trace    at 调用栈 / node_modules / XxxError 行占一成以上
//   4) repeated-lines 整行级重复占字符三成以上 —— 日志回滚、轮询刷屏
//
export const MACHINE_MIN_CHARS = 2000;
export const MACHINE_MIN_LINES = 40;
const TAG_LINE_RE = /^\[[A-Za-z0-9_.-]{1,32}\]/;
const STACK_LINE_RE = /^at\s+\S|node_modules[\\/]|^[A-Za-z]*Error(:|\b)/;

export function classifyText(text) {
  const s = String(text == null ? '' : text);
  const chars = cp(s);
  const hz = hanzi(s);
  const out = { machine: false, reason: '', chars, hanzi: hz, lines: 0 };
  if (chars < MACHINE_MIN_CHARS) return out;

  let nonEmpty = 0;
  let tagLines = 0;
  let stackLines = 0;
  let ascii = 0;
  let dupChars = 0;
  const seenLines = new Map();
  for (const raw of s.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    nonEmpty += 1;
    if (TAG_LINE_RE.test(line)) tagLines += 1;
    else if (STACK_LINE_RE.test(line)) stackLines += 1;
    if (line.length >= 20) {
      const n = (seenLines.get(line) || 0) + 1;
      seenLines.set(line, n);
      if (n > 1) dupChars += cp(line);
    }
  }
  for (let i = 0; i < s.length; i += 1) if (s.charCodeAt(i) < 128) ascii += 1;

  out.lines = nonEmpty;
  if (nonEmpty < MACHINE_MIN_LINES) return out;

  const asciiRatio = s.length > 0 ? ascii / s.length : 0;
  const hzRatio = chars > 0 ? hz / chars : 0;
  if (hzRatio < 0.02 && asciiRatio >= 0.95) out.reason = 'ascii-log';
  else if (tagLines / nonEmpty >= 0.3) out.reason = 'tag-lines';
  else if (stackLines / nonEmpty >= 0.1) out.reason = 'stack-trace';
  else if (dupChars / chars >= 0.35) out.reason = 'repeated-lines';
  out.machine = out.reason !== '';
  return out;
}

// ---------------------------------------------------------------- A. 增量解码

function readRangeBytes(absPath, from, size) {
  const len = size - from;
  if (len <= 0) return Buffer.alloc(0);
  const fd = fs.openSync(absPath, 'r');
  try {
    const buf = Buffer.allocUnsafe(len);
    let got = 0;
    while (got < len) {
      const n = fs.readSync(fd, buf, got, len - got, from + got);
      if (n <= 0) break;
      got += n;
    }
    return got === len ? buf : buf.subarray(0, got);
  } finally {
    try { fs.closeSync(fd); } catch (_) { /* ignore */ }
  }
}

// 从 fromOffset（必须是 frame 边界）解压到文件末尾。
// 返回 { text, nextOffset, frames, badFrames, bytes }。
export function readDelta(absPath, fromOffset = 0) {
  let size;
  try {
    size = fs.statSync(absPath).size;
  } catch (err) {
    return { text: '', nextOffset: fromOffset, frames: 0, badFrames: 0, bytes: 0, missing: true, error: String((err && err.message) || err) };
  }
  let from = Number.isFinite(fromOffset) && fromOffset > 0 ? fromOffset : 0;
  let truncated = false;
  if (from > size) { from = 0; truncated = true; } // 文件被重写/截断
  if (from === size) return { text: '', nextOffset: size, frames: 0, badFrames: 0, bytes: 0, size, truncated };

  let buf;
  try {
    buf = readRangeBytes(absPath, from, size);
  } catch (err) {
    return { text: '', nextOffset: from, frames: 0, badFrames: 0, bytes: 0, size, missing: true, error: String((err && err.message) || err) };
  }

  const parts = [];
  let pos = 0;
  let frames = 0;
  let badFrames = 0;
  let retryFrom = -1; // 尾部解不开的帧起点：下次从这里重试，避免把正在写入的帧永久吞掉
  const n = buf.length;
  while (pos + 4 <= n) {
    if (buf.readUInt32BE(pos) !== MAGIC_U32) {
      const nxt = buf.indexOf(MAGIC, pos);
      if (nxt === -1) break; // 尾部无 magic 的残片，忽略（下轮由 retryFrom 兜底或视为垃圾）
      pos = nxt;
      continue;
    }
    const frameStart = pos;
    let nextMagic = buf.indexOf(MAGIC, pos + 4);
    let settled = false;
    while (!settled) {
      const end = nextMagic === -1 ? n : nextMagic;
      try {
        parts.push(zlib.zstdDecompressSync(buf.subarray(frameStart, end)));
        frames++;
        pos = end;
        settled = true;
      } catch (_) {
        if (nextMagic === -1) {
          // 到文件末尾都解不开：多半是正在写入的半帧，记一笔并从该帧起点重试
          badFrames++;
          retryFrom = frameStart;
          pos = n;
          settled = true;
          break;
        }
        // 命中的 magic 是压缩数据里的假边界，继续向后找
        nextMagic = buf.indexOf(MAGIC, nextMagic + 4);
      }
    }
  }
  return {
    text: Buffer.concat(parts).toString('utf8'),
    nextOffset: retryFrom >= 0 ? from + retryFrom : size,
    pendingFrame: retryFrom >= 0,
    frames,
    badFrames,
    bytes: buf.length,
    size,
    truncated,
  };
}

// ---------------------------------------------------------------- B. 折叠

export function createAgg() {
  return {
    days: {},        // 派生视图：由 deriveDays() 从 sessions 重建，foldEvents 从不写它
    sessions: {},    // 唯一真相：每会话分日明细 + 全期合计 + 24 小时分布
    seenIds: new Map(), // data.id -> 首见文件绝对路径（Map 而非 Set：截断重扫时要区分“我自己之前的记录”）
    callNames: new Map(), // callId -> 工具名（FIFO 上限 CALLNAME_CAP）
    askCallIds: new Set(), // ask 专用 callId 集合（小、精确，不受 FIFO 淘汰影响）
    stats: {
      events: 0,
      badJson: 0,
      badFrames: 0,
      frames: 0,
      bytes: 0,
      humanMsgs: 0,
      injectedMsgs: 0,
      multiText: 0,
      noText: 0,
      machineMsgs: 0,
      machineChars: 0,
      dupSkipped: 0,
      dupChars: 0,
      askCalls: 0,
      askAnswers: 0,
      askParseFail: 0,
      filesScanned: 0,
      skippedFiles: 0,
      tails: 0,
    },
    files: {},     // abs path -> { size, offset, sid, cwd, createdAt, origin, isSeeded, title }
    current: null, // 当前会话 header 信息（beginSession 设置）
    _fileKey: null,
    _carry: new Map(),
    _dirty: true,
  };
}

export function beginSession(agg, info = {}) {
  agg.current = {
    sid: info.sid || '',
    cwd: info.cwd || '',
    createdAt: info.createdAt || 0,
    origin: info.origin || 'main',
    isSeeded: !!info.isSeeded,
    parentSession: info.parentSession || null,
  };
  return agg.current;
}

export function endSession(agg) {
  const cur = agg.current;
  if (cur) {
    const prefix = String(cur.sid) + '\u0000';
    for (const key of Array.from(agg._carry.keys())) {
      if (key.startsWith(prefix)) { agg._carry.delete(key); agg.stats.tails++; }
    }
  }
  agg.current = null;
  return agg;
}

export function getSession(agg, sid) {
  const key = sid || 'unknown';
  let s = agg.sessions[key];
  if (!s) {
    s = agg.sessions[key] = {
      sid: key,
      title: '',
      cwd: '',
      createdAt: 0,
      origin: 'main',
      isSeeded: false,
      msgCount: 0,
      chars: 0,
      hanzi: 0,
      askCount: 0,
      askCustom: 0,
      askSelected: 0,
      pasteMsgs: 0,
      pasteChars: 0,
      lastTime: 0,
      byHour: new Array(24).fill(0),
      days: {},
    };
  }
  return s;
}

function ensureHeaderFields(agg, sid, info) {
  const s = getSession(agg, sid);
  if (!s.cwd && info.cwd) s.cwd = info.cwd;
  if (!s.createdAt && info.createdAt) s.createdAt = info.createdAt;
  if (info.origin) s.origin = info.origin;
  if (info.isSeeded) s.isSeeded = true;
  if (!s.title && info.title) s.title = info.title;
  return s;
}

function emptyDay() {
  return { chars: 0, hanzi: 0, msgs: 0, asks: 0, askCustom: 0, selected: 0, pasteMsgs: 0, pasteChars: 0 };
}

// 唯一的写入口径：增量（sign=+1）与扣减（sign=-1）都走这里，保证合计与分日不漂移。
// pasteChars / pasteMsgs 是"粘进来的机器文本"，只记账不进 chars：它不是自己敲的字。
export function applyContribution(agg, sid, ms, delta, sign = 1) {
  const s = getSession(agg, sid);
  const key = dayKey(ms);
  let dd = s.days[key];
  if (!dd) dd = s.days[key] = emptyDay();
  const chars = (delta.chars || 0) * sign;
  const hz = (delta.hanzi || 0) * sign;
  const msgs = (delta.msgs || 0) * sign;
  const asks = (delta.asks || 0) * sign;
  const askCustom = (delta.askCustom || 0) * sign;
  const selected = (delta.selected || 0) * sign;
  const pasteMsgs = (delta.pasteMsgs || 0) * sign;
  const pasteChars = (delta.pasteChars || 0) * sign;
  dd.chars += chars;
  dd.hanzi += hz;
  dd.msgs += msgs;
  dd.asks += asks;
  dd.askCustom += askCustom;
  dd.selected += selected;
  dd.pasteMsgs += pasteMsgs;
  dd.pasteChars += pasteChars;
  s.chars += chars;
  s.hanzi += hz;
  s.msgCount += msgs;
  s.askCount += asks;
  s.askCustom += askCustom;
  s.askSelected += selected;
  s.pasteMsgs += pasteMsgs;
  s.pasteChars += pasteChars;
  if (sign > 0) s.lastTime = Math.max(s.lastTime, Number(ms) || 0);
  s.byHour[hourOf(ms)] += chars;
  if (dd.chars === 0 && dd.hanzi === 0 && dd.msgs === 0 && dd.asks === 0 && dd.askCustom === 0
    && dd.selected === 0 && dd.pasteMsgs === 0 && dd.pasteChars === 0) delete s.days[key];
  agg._dirty = true;
  return s;
}

// 截断/重写：会话历史整体失效，直接整会话清零（比逐项减法更精确，不会留下浮点残渣）。
export function subtractSession(agg, sid) {
  if (!sid || !agg.sessions[sid]) return false;
  delete agg.sessions[sid];
  agg._dirty = true;
  return true;
}

// 全局 days 完全由 sessions 派生 —— 不写第二份真相。
export function deriveDays(agg) {
  const days = {};
  for (const s of Object.values(agg.sessions)) {
    for (const key of Object.keys(s.days)) {
      const dd = s.days[key];
      let g = days[key];
      if (!g) g = days[key] = { key, msgs: 0, chars: 0, hanzi: 0, asks: 0, askCustom: 0, selected: 0, pasteMsgs: 0, pasteChars: 0 };
      g.msgs += dd.msgs;
      g.chars += dd.chars;
      g.hanzi += dd.hanzi;
      g.asks += dd.asks;
      g.askCustom += dd.askCustom;
      g.selected += dd.selected;
      g.pasteMsgs += dd.pasteMsgs || 0;
      g.pasteChars += dd.pasteChars || 0;
    }
  }
  agg.days = days;
  agg._dirty = false;
  return days;
}

function clipTitle(s, n = 60) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function parseAnswers(txt) {
  const raw = String(txt || '').trim();
  const attempt = (x) => { try { return JSON.parse(x); } catch (_) { return null; } };
  let obj = attempt(raw);
  if (!obj) {
    const i = raw.indexOf('{');
    const j = raw.lastIndexOf('}');
    if (i !== -1 && j > i) obj = attempt(raw.slice(i, j + 1));
  }
  return obj;
}

// 折叠一段（可跨多处）UTF-8 文本。info 省略则沿用 beginSession 设定的 ctx.current。
export function foldEvents(text, agg, info) {
  if (info) beginSession(agg, info);
  const cur = agg.current;
  if (!cur) throw new Error('foldEvents: 需要先 beginSession(agg, info) 或传第三参 info');
  if (typeof text !== 'string' || text.length === 0) return agg;

  const sid = cur.sid || 'unknown';
  ensureHeaderFields(agg, sid, cur);
  const fileKey = agg._fileKey || sid;
  const carryKey = sid + '\u0000' + fileKey;
  const prev = agg._carry.get(carryKey) || '';
  const buf = prev + text;
  // 末尾可能是不完整的行（半帧/正在写入），留给下一次拼
  const cut = buf.lastIndexOf('\n');
  const complete = cut === -1 ? '' : buf.slice(0, cut);
  const lastSeg = cut === -1 ? buf : buf.slice(cut + 1);
  const handleLine = (line, isTail) => {
    const t = line.trim();
    if (!t) return true;
    let ev;
    try {
      ev = JSON.parse(t);
    } catch (_) {
      if (isTail) return false;
      agg.stats.badJson++;
      return true;
    }
    agg.stats.events++;
    const type = ev && ev.type;
    const ms = ev && typeof ev.time === 'number' ? ev.time : 0;
    const d = (ev && ev.data) || {};

    if (type === 'session') {
      if (!agg.current || !agg.current.sid) beginSession(agg, headerInfo(ev, agg.current && agg.current.cwd));
      const h = headerInfo(ev, '');
      ensureHeaderFields(agg, sid, {
        cwd: h.cwd,
        createdAt: h.createdAt,
        origin: h.origin,
        isSeeded: h.isSeeded,
        title: typeof ev.title === 'string' ? ev.title : '',
      });
      return true;
    }

    if (type === 'user/message') {
      const content = Array.isArray(d.content) ? d.content : [];
      let out = '';
      let nText = 0;
      for (const c of content) {
        if (c && c.type === 'text') {
          nText++;
          if (typeof c.text === 'string') out += c.text;
        }
      }
      if (nText > 1) agg.stats.multiText++;
      if (nText === 0) agg.stats.noText++;
      if (!isHumanMessage(d)) { agg.stats.injectedMsgs++; return true; }
      const id = typeof d.id === 'string' && d.id ? d.id : null;
      if (id) {
        const owner = agg.seenIds.get(id);
        if (owner !== undefined && owner !== fileKey) {
          agg.stats.dupSkipped++;
          agg.stats.dupChars += cp(out);
          return true;
        }
        if (owner === undefined) agg.seenIds.set(id, fileKey);
      }
      agg.stats.humanMsgs++;
      const cls = classifyText(out);
      if (cls.machine) {
        agg.stats.machineMsgs = (agg.stats.machineMsgs || 0) + 1; // 日志转储：单独记账，不进 chars
        agg.stats.machineChars = (agg.stats.machineChars || 0) + cls.chars;
      }
      const s = getSession(agg, sid);
      if (!s.title && !cls.machine && out.trim()) s.title = clipTitle(out);
      applyContribution(agg, sid, ms, cls.machine
        ? { msgs: 1, pasteMsgs: 1, pasteChars: cls.chars }
        : { msgs: 1, chars: cls.chars, hanzi: cls.hanzi });
      return true;
    }

    if (type === 'tool/call') {
      const name = typeof d.name === 'string' ? d.name : '';
      const callId = d.callId == null ? '' : String(d.callId);
      if (callId) {
        agg.callNames.delete(callId);
        agg.callNames.set(callId, name);
        while (agg.callNames.size > CALLNAME_CAP) {
          const oldest = agg.callNames.keys().next().value;
          if (oldest === undefined) break;
          agg.callNames.delete(oldest);
        }
      }
      if (name === 'ask_user_question') {
        agg.stats.askCalls++;
        if (callId) agg.askCallIds.add(callId);
        applyContribution(agg, sid, ms, { asks: 1 });
      }
      return true;
    }

    if (type === 'tool/result') {
      const cid = d.toolCallId != null
        ? String(d.toolCallId)
        : (d.message && d.message.source && d.message.source.callId ? String(d.message.source.callId) : '');
      if (!cid) return true;
      const isAsk = agg.askCallIds.has(cid) || agg.callNames.get(cid) === 'ask_user_question';
      if (!isAsk) return true;
      const contents = d.message && Array.isArray(d.message.content) ? d.message.content : [];
      const txt = contents.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n');
      const parsed = parseAnswers(txt);
      const answers = parsed && Array.isArray(parsed.answers) ? parsed.answers : null;
      if (!answers) { agg.stats.askParseFail++; return true; }
      for (const a of answers) {
        agg.stats.askAnswers++;
        const selected = a && Array.isArray(a.selected) ? a.selected.length : 0; // 只计个数，选项文本是 AI 写的
        const custom = a && typeof a.custom === 'string' ? a.custom : '';
        applyContribution(agg, sid, ms, { selected, askCustom: cp(custom) }); // custom 单独累计，不进 chars
      }
      return true;
    }

    if (typeof type === 'string' && /title/i.test(type)) {
      const t = typeof d.title === 'string' ? d.title : typeof d.name === 'string' ? d.name : '';
      if (t) {
        const s = getSession(agg, sid);
        if (!s.title) s.title = clipTitle(t);
      }
    }
    return true;
  };

  for (const line of complete.split('\n')) handleLine(line, false);
  if (lastSeg && lastSeg.trim()) {
    if (!handleLine(lastSeg, true)) agg._carry.set(carryKey, lastSeg);
    else agg._carry.delete(carryKey);
  } else {
    agg._carry.delete(carryKey);
  }
  agg._dirty = true;
  return agg;
}

export function headerInfo(ev, fallbackCwd) {
  const e = ev || {};
  return {
    sid: typeof e.id === 'string' && e.id ? e.id : '',
    cwd: typeof e.cwd === 'string' && e.cwd ? e.cwd : (fallbackCwd || ''),
    createdAt: typeof e.createdAt === 'number' ? e.createdAt : 0,
    origin: typeof e.origin === 'string' && e.origin ? e.origin : 'main',
    isSeeded: e.isSeeded === true,
    parentSession: typeof e.parentSession === 'string' ? e.parentSession : null,
  };
}

// ---------------------------------------------------------------- C. 扫描器

export function listLogFiles(root) {
  const out = [];
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === LOG_BASENAME) out.push(p);
    }
  };
  walk(root);
  out.sort();
  return out;
}

export function createScanner({ sessionsRoot, cacheFile, onProgress } = {}) {
  if (!sessionsRoot) throw new Error('createScanner: sessionsRoot 必填');
  const scan = async (opts = {}) => {
    const progress = opts.onProgress || onProgress;
    const t0 = Date.now();
    const agg = createAgg();
    let cache = null;
    if (!opts.full && cacheFile) {
      try {
        cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (!cache || cache.version !== CACHE_VERSION) cache = null;
      } catch (_) { cache = null; }
    }
    if (cache) {
      agg.sessions = cache.sessions || {};
      agg.files = cache.files || {};
      if (cache.stats) Object.assign(agg.stats, cache.stats);
      // 去重表必须跟着缓存走：否则每次增量扫描都从空表起步，
      // 新 fork 出来的会话把父历史整份复制一遍时会再计一次（跨轮重复计数的根因）。
      if (Array.isArray(cache.seen)) {
        for (const pair of cache.seen) {
          if (Array.isArray(pair) && typeof pair[0] === 'string') agg.seenIds.set(pair[0], pair[1]);
        }
      }
      // 旧缓存可能缺新增字段，补齐成数字，避免 NaN 扩散到合计
      for (const s of Object.values(agg.sessions)) {
        if (!s || typeof s !== 'object') continue;
        s.pasteMsgs = s.pasteMsgs || 0;
        s.pasteChars = s.pasteChars || 0;
        s.byHour = Array.isArray(s.byHour) && s.byHour.length === 24 ? s.byHour : new Array(24).fill(0);
        s.days = s.days && typeof s.days === 'object' ? s.days : {};
        for (const dd of Object.values(s.days)) {
          if (!dd || typeof dd !== 'object') continue;
          dd.pasteMsgs = dd.pasteMsgs || 0;
          dd.pasteChars = dd.pasteChars || 0;
        }
      }
      agg._dirty = true;
    }

    const files = listLogFiles(sessionsRoot);
    const total = files.length || 1;
    let done = 0;
    let incrementalFiles = 0;

    // 1) 截断检测：size < 上次 offset → 该会话历史整体失效
    const truncatedSids = new Set();
    const sizes = new Map();
    for (const f of files) {
      let size;
      try { size = fs.statSync(f).size; } catch (_) { agg.stats.skippedFiles++; continue; }
      sizes.set(f, size);
      const rec = agg.files[f];
      if (rec && rec.sid && typeof rec.offset === 'number' && size < rec.offset) truncatedSids.add(rec.sid);
    }
    for (const sid of truncatedSids) {
      subtractSession(agg, sid);
      // 该会话的文件要整份重读，所以它之前登记的 data.id 也得一起作废，
      // 否则重读时会被自己的去重表当成副本跳过，会话就此少算。
      const own = new Set();
      for (const [p, r] of Object.entries(agg.files)) if (r && r.sid === sid) own.add(p);
      for (const [id, owner] of agg.seenIds) if (own.has(owner)) agg.seenIds.delete(id);
      // 同一 sid 的其它文件也要重扫（否则它们的贡献随会话一起被扣掉了）
      for (const [p, r] of Object.entries(agg.files)) if (r && r.sid === sid) r.offset = 0;
    }

    // 2) 逐文件增量折叠
    for (const f of files) {
      if (!sizes.has(f)) { done++; continue; }
      const size = sizes.get(f);
      const rec = agg.files[f] || null;
      let from = rec && typeof rec.offset === 'number' ? rec.offset : 0;
      let info = rec && rec.sid
        ? { sid: rec.sid, cwd: rec.cwd, createdAt: rec.createdAt, origin: rec.origin, isSeeded: rec.isSeeded, title: rec.title }
        : null;
      // 缓存里没有 sid 或聚合器里没有这个会话，却又有 offset —— 不能只读尾巴，退回全读
      if (from > 0 && (!info || !agg.sessions[info.sid])) from = 0;

      agg._fileKey = f;
      let delta;
      try {
        delta = readDelta(f, from);
      } catch (err) {
        agg.stats.skippedFiles++;
        agg.files[f] = Object.assign({}, rec || {}, { size, offset: from, error: String((err && err.message) || err) });
        done++;
        continue;
      }
      if (delta.missing) {
        agg.stats.skippedFiles++;
        agg.files[f] = Object.assign({}, rec || {}, { size, offset: from, missing: true });
        done++;
        continue;
      }
      agg.stats.badFrames += delta.badFrames || 0;
      agg.stats.frames += delta.frames || 0;
      agg.stats.bytes += delta.bytes || 0;

      let sid = info && info.sid ? info.sid : '';
      if (!sid) {
        // 全新文件（或缓存缺 sid）：先从首行拿 header
        const firstLine = delta.text.slice(0, delta.text.indexOf('\n') === -1 ? delta.text.length : delta.text.indexOf('\n'));
        let header = null;
        try { header = JSON.parse(firstLine.trim()); } catch (_) { header = null; }
        const h = headerInfo(header, '');
        sid = h.sid || path.basename(path.dirname(f));
        info = { sid, cwd: h.cwd, createdAt: h.createdAt, origin: h.origin, isSeeded: h.isSeeded, title: '' };
      }
      if (from > 0) incrementalFiles++;
      beginSession(agg, info);
      if (delta.text) foldEvents(delta.text, agg);
      const s = getSession(agg, sid);
      ensureHeaderFields(agg, sid, info);
      endSession(agg);

      agg.files[f] = {
        size: delta.nextOffset,
        offset: delta.nextOffset,
        sid,
        cwd: info.cwd || s.cwd || '',
        createdAt: info.createdAt || s.createdAt || 0,
        origin: info.origin || s.origin || 'main',
        isSeeded: !!(info.isSeeded || s.isSeeded),
        title: (info.title || s.title || '').slice(0, 80),
      };
      agg.stats.filesScanned++;
      done++;
      if (progress && (done % 50 === 0 || done === files.length)) progress({ done, total, phase: incrementalFiles ? 'incremental' : 'full' });
    }

    deriveDays(agg);
    const elapsedMs = Date.now() - t0;

    if (cacheFile && opts.persist !== false) {
      const payload = {
        version: CACHE_VERSION,
        savedAt: new Date().toISOString(),
        sessionsRoot,
        files: agg.files,
        sessions: agg.sessions, // days 由 sessions 派生，不落盘
        stats: agg.stats, // 累计计数，增量扫描只在此基础上加
        seen: agg.seenIds.size <= SEEN_PERSIST_MAX ? Array.from(agg.seenIds.entries()) : undefined,
      };
      try {
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        const tmp = cacheFile + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
        fs.renameSync(tmp, cacheFile);
      } catch (_) { /* 缓存写失败不影响本次结果 */ }
    }

    return {
      agg,
      elapsedMs,
      files: files.length,
      filesScanned: agg.stats.filesScanned,
      skippedFiles: agg.stats.skippedFiles,
      incrementalFiles,
      fullScan: !cache,
      truncated: Array.from(truncatedSids),
    };
  };
  return { scan };
}

// ---------------------------------------------------------------- D. 输出视图

function streakOf(days, now) {
  const keys = Object.keys(days).filter((k) => days[k] && days[k].msgs > 0).sort();
  let longest = 0;
  let run = 0;
  let prev = null;
  for (const k of keys) {
    const ms = Date.parse(k + 'T00:00:00Z');
    if (prev !== null && Math.round((ms - prev) / DAY_MS) === 1) run++;
    else run = 1;
    if (run > longest) longest = run;
    prev = ms;
  }
  let current = 0;
  let cursor = Number(now);
  if (!(days[dayKey(cursor)] && days[dayKey(cursor)].msgs > 0)) cursor -= DAY_MS; // 今天还没输入时从昨天起算
  while (current < 5000) {
    const k = dayKey(cursor);
    if (!(days[k] && days[k].msgs > 0)) break;
    current++;
    cursor -= DAY_MS;
  }
  return { current, longest };
}

export function buildReport(agg, opts = {}) {
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const rangeDays = opts.days || 56;
  const sessionLimit = opts.sessionLimit || SESSION_LIMIT;
  if (agg._dirty || !agg.days) deriveDays(agg);

  const allKeys = Object.keys(agg.days);
  const totals = { msgs: 0, chars: 0, hanzi: 0, asks: 0, askCustom: 0, askSelected: 0, pasteMsgs: 0, pasteChars: 0, activeDays: allKeys.length };
  for (const k of allKeys) {
    const r = agg.days[k];
    totals.msgs += r.msgs;
    totals.chars += r.chars;
    totals.hanzi += r.hanzi;
    totals.asks += r.asks;
    totals.askCustom += r.askCustom;
    totals.askSelected += r.selected;
    totals.pasteMsgs += r.pasteMsgs || 0;
    totals.pasteChars += r.pasteChars || 0;
  }

  const windowKeys = [];
  for (let i = rangeDays - 1; i >= 0; i--) windowKeys.push(dayKey(now - i * DAY_MS));
  const dayRows = windowKeys.map((key) => {
    const r = agg.days[key] || { key, msgs: 0, chars: 0, hanzi: 0, asks: 0, askCustom: 0, selected: 0, pasteMsgs: 0, pasteChars: 0 };
    return { key, msgs: r.msgs, chars: r.chars, hanzi: r.hanzi, asks: r.asks, askCustom: r.askCustom, pasteMsgs: r.pasteMsgs || 0, pasteChars: r.pasteChars || 0 };
  });
  const maxChars = dayRows.reduce((m, r) => (r.chars > m ? r.chars : m), 0);
  const byDay = dayRows.map((r) => Object.assign({}, r, { maxChars }));

  const byHour = new Array(24).fill(0);
  for (const s of Object.values(agg.sessions)) {
    for (let h = 0; h < 24; h++) byHour[h] += (s.byHour && s.byHour[h]) || 0;
  }

  const today = dayKey(now);
  const todayRow = agg.days[today] || { msgs: 0, chars: 0, hanzi: 0, askCustom: 0 };

  const allSessions = Object.values(agg.sessions)
    .sort((a, b) => (b.chars - a.chars) || (b.lastTime - a.lastTime))
    .slice(0, sessionLimit);
  const sessionRow = (s, keepDay) => {
    const days = {};
    for (const k of Object.keys(s.days)) if (!keepDay || keepDay.has(k)) days[k] = s.days[k];
    return {
      sid: s.sid,
      title: s.title || '',
      cwd: s.cwd || '',
      origin: s.origin || 'main',
      isSeeded: !!s.isSeeded,
      msgs: s.msgCount,
      chars: s.chars,
      hanzi: s.hanzi,
      asks: s.askCount,
      askCustom: s.askCustom,
      pasteMsgs: s.pasteMsgs || 0,
      pasteChars: s.pasteChars || 0,
      lastTime: s.lastTime,
      days,
    };
  };

  const report = {
    generatedAt: new Date(now).toISOString(),
    rangeDays,
    totals,
    today: { key: today, chars: todayRow.chars, hanzi: todayRow.hanzi, msgs: todayRow.msgs },
    streak: streakOf(agg.days, now),
    byDay,
    bySession: allSessions.map((s) => sessionRow(s, null)),
    byHour,
    known: {
      badFrames: agg.stats.badFrames,
      badJson: agg.stats.badJson,
      truncatedScans: agg.stats.truncatedScans || 0,
      tails: agg.stats.tails || 0,
      files: Object.keys(agg.files).length,
      filesScanned: agg.stats.filesScanned,
      skippedFiles: agg.stats.skippedFiles,
      frames: agg.stats.frames,
      bytes: agg.stats.bytes,
      events: agg.stats.events,
      humanMsgs: agg.stats.humanMsgs,
      injectedMsgs: agg.stats.injectedMsgs,
      multiText: agg.stats.multiText,
      noText: agg.stats.noText,
      machineMsgs: agg.stats.machineMsgs || 0,
      machineChars: agg.stats.machineChars || 0,
      dupSkipped: agg.stats.dupSkipped,
      dupChars: agg.stats.dupChars,
      askCalls: agg.stats.askCalls,
      askAnswers: agg.stats.askAnswers,
    },
    meta: { sessionLimit, trimmedSessionDays: false, jsonBytes: 0 },
  };

  // 体积闸门：> 1.5MB 时把 bySession.days 收窄到最近 N 天
  let bytes = Buffer.byteLength(JSON.stringify(report));
  if (bytes > (opts.maxBytes || REPORT_MAX_BYTES)) {
    const keep = new Set(windowKeys);
    report.bySession = allSessions.map((s) => sessionRow(s, keep));
    report.meta.trimmedSessionDays = true;
    bytes = Buffer.byteLength(JSON.stringify(report));
  }
  report.meta.jsonBytes = bytes;
  return report;
}

export default { readDelta, createAgg, beginSession, endSession, foldEvents, deriveDays, buildReport, createScanner };
