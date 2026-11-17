/**
 * dsh-input-insight — host half.
 *
 * Purpose: answer "how much did *I* actually type?" from the session logs the
 * harness already keeps, and hand the answer to the browser half over a plain
 * HTTP route.
 *
 * Design constraints, in order of importance:
 *
 * 1. **Nobody else's data.** This plugin owns exactly two things: an in-memory
 *    scan result and one cache file under DSH_HOME. It registers no session
 *    projection, writes no session event, and reads nothing through another
 *    plugin's API. Uninstall = delete the row from `cordis.patch.yml`.
 *
 * 2. **The logs are the source of truth, but they are cold storage.** A full
 *    pass over the whole corpus is ~28 s (382 MB of concatenated zstd frames),
 *    so it must never run on the request path more than once. The scan runs in
 *    the background on load and after that only re-reads the tail of each file
 *    (~0.25 s). The HTTP routes only ever serve the last completed snapshot.
 *
 * 3. **A scan failure must never take DSH down.** Every entry point is
 *    guarded; a throwing route answers 500 with a message, and a throwing scan
 *    leaves the previous snapshot in place.
 *
 * @module dsh-input-insight
 */

import { createScanner, buildReport } from './scan.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const name = 'dsh-input-insight';

/** Optional services: `connection` for the routes, `dshHomePath` for the layout. */
export const inject = [];

/** How long a finished snapshot stays "fresh" before a re-read is armed. */
const STALE_MS = 60 * 1000;

/** A scan started by a request waits this long for the first run before answering "scanning". */
const FIRST_SCAN_WAIT_MS = 15 * 1000;

const ROUTE_PREFIX = '/api/dsh-input-insight';

/**
 * Defaults for the optional config keys.
 *
 * Deliberately NOT exported as `Config`: Cordis treats an exported `Config` as a
 * Schemastery schema and calls `.validate()` on it, so a plain object there makes
 * the plugin fiber fail ("Cannot read properties of undefined (reading
 * 'validate')"). Defaults live here and are merged by hand instead — the same
 * reason this plugin does not depend on `@deepseek-ai/schemastery`, which a
 * junction-installed package cannot resolve anyway.
 */
const DEFAULT_CONFIG = {
  /** Override the session log root (defaults to `<DSH_HOME>/sessions`). */
  sessionsRoot: undefined,
  /** Override the cache file (defaults to `<DSH_HOME>/input-insight/scan-cache.json`). */
  cacheFile: undefined,
  /** Days of heatmap window handed to the browser. */
  rangeDays: 56,
  /** Run a background re-read every N ms; 0 disables the timer. */
  autoRefreshMs: 5 * 60 * 1000,
};

function messageOf(error) {
  try {
    return String((error && error.message) || error);
  } catch {
    return 'unprintable error';
  }
}

export function apply(ctx, config) {
  const cfg = Object.assign({}, DEFAULT_CONFIG, config || {});

  /** Resolve the log root and cache path through the harness's own home layout. */
  const resolvePaths = () => {
    let sessionsRoot = typeof cfg.sessionsRoot === 'string' && cfg.sessionsRoot !== '' ? cfg.sessionsRoot : '';
    let cacheFile = typeof cfg.cacheFile === 'string' && cfg.cacheFile !== '' ? cfg.cacheFile : '';
    if (sessionsRoot === '' || cacheFile === '') {
      try {
        const homePath = ctx.get('dshHomePath');
        if (typeof homePath === 'function') {
          if (sessionsRoot === '') sessionsRoot = homePath('sessions');
          if (cacheFile === '') cacheFile = homePath('input-insight', 'scan-cache.json');
        }
      } catch {
        /* no home service: fall through to the environment fallback */
      }
    }
    // Fallback so a renamed or absent `dshHomePath` service does not leave the
    // plugin without a log root. DSH_HOME is what the harness itself exports.
    if (sessionsRoot === '' || cacheFile === '') {
      try {
        const home = process.env && process.env.DSH_HOME ? process.env.DSH_HOME : join(homedir(), '.dsh');
        if (sessionsRoot === '') sessionsRoot = join(home, 'sessions');
        if (cacheFile === '') cacheFile = join(home, 'input-insight', 'scan-cache.json');
      } catch {
        /* leave whatever config gave us */
      }
    }
    return { sessionsRoot, cacheFile };
  };

  /** The one piece of state this plugin owns. Read by routes, written by `runScan`. */
  const state = {
    status: 'idle', // idle | scanning | ready | error
    report: null,
    scannedAt: 0,
    progress: null,
    error: null,
    elapsedMs: 0,
    scans: 0,
  };

  let inFlight = null;
  let timer = null;

  const snapshot = () => ({
    status: state.status,
    report: state.report,
    scannedAt: state.scannedAt,
    progress: state.progress,
    error: state.error,
    elapsedMs: state.elapsedMs,
    scans: state.scans,
  });

  /**
   * Run one scan. Concurrent callers share the in-flight promise, so a burst of
   * polls costs one pass, not N.
   */
  const runScan = (opts) => {
    if (inFlight !== null) return inFlight;
    const { sessionsRoot, cacheFile } = resolvePaths();
    if (sessionsRoot === '') {
      state.status = 'error';
      state.error = 'cannot resolve the session log root';
      return Promise.resolve(snapshot());
    }
    const previous = state.report;
    state.status = 'scanning';
    state.progress = { done: 0, total: 0, phase: 'start' };
    state.error = null;
    inFlight = (async () => {
      try {
        const scanner = createScanner({
          sessionsRoot,
          cacheFile,
          onProgress: (p) => {
            state.progress = p;
          },
        });
        const run = await scanner.scan({ onProgress: (p) => { state.progress = p; } });
        const report = buildReport(run.agg, {
          days: Number(cfg.rangeDays) || 56,
          now: Date.now(),
          sessionLimit: 200,
        });
        state.report = report;
        state.scannedAt = Date.now();
        state.elapsedMs = run.elapsedMs;
        state.scans += 1;
        state.status = 'ready';
        state.progress = { done: run.files, total: run.files, phase: 'done' };
        ctx.logger.debug(
          `dsh-input-insight: ${run.fullScan ? 'full' : 'incremental'} scan of ${run.files} file(s) in ${run.elapsedMs} ms`
        );
      } catch (error) {
        state.status = previous === null ? 'error' : 'ready';
        state.error = messageOf(error);
        ctx.logger.warn(`dsh-input-insight: scan failed (${state.error})`);
      } finally {
        inFlight = null;
      }
      return snapshot();
    })();
    return inFlight;
  };

  /** Arm a background pass, swallowing anything it throws. */
  const refreshSoon = () => {
    Promise.resolve()
      .then(() => runScan())
      .catch(() => {});
  };

  // Warm the snapshot right after load: the first paint of the tab then finds a
  // report instead of a spinner. Deferred by a macrotask so plugin load itself
  // stays cheap.
  ctx.effect(() => {
    const handle = setTimeout(refreshSoon, 1500);
    return () => clearTimeout(handle);
  }, 'dsh-input-insight: warm-up');

  const autoRefreshMs = Number(cfg.autoRefreshMs);
  if (Number.isFinite(autoRefreshMs) && autoRefreshMs > 0) {
    ctx.effect(() => {
      timer = setInterval(() => {
        if (Date.now() - state.scannedAt >= STALE_MS) refreshSoon();
      }, autoRefreshMs);
      return () => {
        if (timer !== null) clearInterval(timer);
        timer = null;
      };
    }, 'dsh-input-insight: refresh timer');
  }

  /** The routes ride the connection service, which is not present at boot. */
  ctx.inject(['connection'], (scope) => {
    const connection = scope.get('connection');
    const register = typeof connection?.fetch?.register === 'function'
      ? connection.fetch.register.bind(connection.fetch)
      : undefined;
    if (register === undefined) return;

    const json = (body, status) => Response.json(body, {
      status: status === undefined ? 200 : status,
      headers: { 'cache-control': 'no-store' },
    });

    /** GET /api/dsh-input-insight/report — the snapshot; `?refresh=1` forces a re-read. */
    scope.effect(() => register({
      path: `${ROUTE_PREFIX}/report`,
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const url = new URL(request.url);
          const force = url.searchParams.get('refresh') === '1';
          if (force || state.report === null) {
            // First-ever scan waits a bounded moment so the first open is not
            // always a spinner; a long cold pass answers "scanning" instead.
            const waited = await Promise.race([
              runScan().then(() => true),
              new Promise((resolve) => { setTimeout(() => resolve(false), FIRST_SCAN_WAIT_MS); }),
            ]);
            if (!waited && state.report === null) return json(snapshot());
          } else if (Date.now() - state.scannedAt >= STALE_MS) {
            refreshSoon(); // serve what we have; the next poll gets the fresh one
          }
          return json(snapshot());
        } catch (error) {
          return json({ status: 'error', error: messageOf(error) }, 500);
        }
      },
    }), 'dsh-input-insight: report route');

    /** GET /api/dsh-input-insight/status — progress only, cheap enough to poll. */
    scope.effect(() => register({
      path: `${ROUTE_PREFIX}/status`,
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: () => {
        try {
          return json({
            status: state.status,
            progress: state.progress,
            elapsedMs: state.elapsedMs,
            scannedAt: state.scannedAt,
            error: state.error,
            hasReport: state.report !== null,
          });
        } catch (error) {
          return json({ status: 'error', error: messageOf(error) }, 500);
        }
      },
    }), 'dsh-input-insight: status route');
  });
}
