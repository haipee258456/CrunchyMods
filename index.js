const http = require('http');
const https = require('https');
const zlib = require('zlib');

const CONFIG = {
  AUTH_BASIC: 'dGd6ZXI0aXV3Z3Bha3ljaWs4OHc6emV5Ul9Ud21EWHJYMmpZZVY3RWd0akJSOTZPdEl4QW8=',
  SERVER_REFRESH_TOKEN: 'e28d554b-919d-49d5-b715-320e18b29a4e',
  SERVER_ANON_ID: 'efac9051-2b3b-4aba-840a-f4d8798b0390',
  SERVER_DEVICE_ID: 'd95b01f5-3771-4016-9570-4e30a479ff0f',
  SERVER_DEVICE_NAME: 'Nothing Phone (3a)',
  SERVER_DEVICE_TYPE: 'Nothing A059',
  SERVER_PROFILE_ID: '02ed050e-a14c-58bc-86b1-a6a667e9e2d5',
  SERVER_ACCOUNT_ID: '02ed050e-a14c-58bc-86b1-a6a667e9e2d5',
  SERVER_EXTERNAL_ID: '1176214942',

  UA_APP: 'Crunchyroll/3.122.0 Android/16 okhttp/5.3.2',
  UA_DALVIK: 'Dalvik/2.1.0 (Linux; U; Android 16; A059 Build/BQ2A.250721.001-BP2A.250605.031.A3)',
  UA_ANALYTICS: 'Crunchyroll/3.122.0 Android/16 analytics-android/4.11.3',

  CR_BASE: 'https://www.crunchyroll.com',
  CR_AUTH: 'https://www.crunchyroll.com/auth/v1/token',

  LITIX: 'https://e0vemjple0l1luii7h5vlu5no.litix.io/android',
  LITIX_KEY: 'e0vemjple0l1luii7h5vlu5no',
  LITIX_SHARD: '9f010b94-9906-47af-a6bb-8fcf67810693',
  ANALYTICS: 'https://eec.crunchyroll.com/v1/import',
};

const SERVER = {
  access: '',
  refresh: CONFIG.SERVER_REFRESH_TOKEN,
  expiresAt: 0,
  profileId: CONFIG.SERVER_PROFILE_ID,
  accountId: CONFIG.SERVER_ACCOUNT_ID,
  warmedUp: false,
};

function log(tag, msg) {
  console.log(`[${new Date().toISOString()}] ${tag}: ${msg}`);
}

function makeRequest(targetUrl, method = 'GET', headers = {}, body = null, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const client = u.protocol === 'https:' ? https : http;
    const finalHeaders = { ...headers };

    let bodyBuf = null;
    if (body !== null && body !== undefined) {
      bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body);
      if (!finalHeaders['Content-Length']) finalHeaders['Content-Length'] = bodyBuf.length;
    }

    const reqOpts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: finalHeaders,
      timeout: opts.timeout || 30000,
    };

    const req = client.request(reqOpts, (resp) => {
      const chunks = [];
      const enc = (resp.headers['content-encoding'] || '').toLowerCase();
      const src = enc.includes('gzip') ? resp.pipe(zlib.createGunzip()) : resp;

      src.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      src.on('end', () => resolve({
        statusCode: resp.statusCode,
        headers: resp.headers,
        body: Buffer.concat(chunks),
      }));
      src.on('error', reject);
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// ─── TOKEN REFRESH WITH WARM-UP ───
async function refreshServerToken() {
  log('SERVER_AUTH', 'Refreshing premium token...');

  const body = new URLSearchParams({
    refresh_token: SERVER.refresh,
    grant_type: 'refresh_token',
    scope: 'offline_access',
    device_id: CONFIG.SERVER_DEVICE_ID,
    device_name: CONFIG.SERVER_DEVICE_NAME,
    device_type: CONFIG.SERVER_DEVICE_TYPE,
  }).toString();

  const r = await makeRequest(CONFIG.CR_AUTH, 'POST', {
    'Authorization': `Basic ${CONFIG.AUTH_BASIC}`,
    'ETP-Anonymous-ID': CONFIG.SERVER_ANON_ID,
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': CONFIG.UA_APP,
    'Accept-Encoding': 'gzip',
  }, body);

  if (r.statusCode >= 400) {
    log('SERVER_AUTH', `FAILED ${r.statusCode}: ${r.body.toString().slice(0, 200)}`);
    throw new Error(`Premium token refresh failed: ${r.statusCode}`);
  }

  const json = JSON.parse(r.body.toString());
  SERVER.access = json.access_token;
  SERVER.refresh = json.refresh_token || SERVER.refresh;
  SERVER.expiresAt = Math.floor(Date.now() / 1000) + (json.expires_in || 300);
  SERVER.profileId = json.profile_id || SERVER.profileId;
  SERVER.accountId = json.account_id || SERVER.accountId;
  SERVER.warmedUp = false;

  // ─── WARM-UP: hit a harmless endpoint so token propagates ───
  try {
    await makeRequest(`${CONFIG.CR_BASE}/accounts/v1/me`, 'GET', {
      'Authorization': `Bearer ${SERVER.access}`,
      'ETP-Anonymous-ID': CONFIG.SERVER_ANON_ID,
      'User-Agent': CONFIG.UA_APP,
      'Accept-Encoding': 'gzip',
    });
    // small delay for propagation
    await new Promise(s => setTimeout(s, 400));
    SERVER.warmedUp = true;
    log('SERVER_AUTH', 'Token warmed up');
  } catch (e) {
    log('SERVER_AUTH', `Warm-up failed: ${e.message}`);
  }

  return SERVER.access;
}

async function getServerToken() {
  const now = Math.floor(Date.now() / 1000);

  // Reuse only if token is fresh AND warmed up
  if (SERVER.access && SERVER.expiresAt > now + 60 && SERVER.warmedUp) {
    return SERVER.access;
  }

  // If token exists but not warmed, warm it
  if (SERVER.access && SERVER.expiresAt > now + 60 && !SERVER.warmedUp) {
    try {
      await makeRequest(`${CONFIG.CR_BASE}/accounts/v1/me`, 'GET', {
        'Authorization': `Bearer ${SERVER.access}`,
        'ETP-Anonymous-ID': CONFIG.SERVER_ANON_ID,
        'User-Agent': CONFIG.UA_APP,
        'Accept-Encoding': 'gzip',
      });
      await new Promise(s => setTimeout(s, 400));
      SERVER.warmedUp = true;
      return SERVER.access;
    } catch (e) { /* fall through to full refresh */ }
  }

  return await refreshServerToken();
}

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, ETP-Anonymous-ID, Range, x-cr-content-id, x-cr-video-token, x-cr-tab-id',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, ETag, X-Proxy-Mode, X-Cr-Error-Code',
    'Cache-Control': 'no-store',
    ...extra,
  };
}

function sendJSON(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, corsHeaders({
    'Content-Type': 'application/json',
    'Content-Length': body.length,
  }));
  res.end(body);
}

function sendError(res, status, msg) {
  sendJSON(res, status, { error: msg, timestamp: new Date().toISOString() });
}

async function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function rewriteBody(buf, proxyBase) {
  let s = buf.toString('utf8');
  s = s.replace(/https:\/\/www\.crunchyroll\.com\/playback\//g, `${proxyBase}/playback/`);
  s = s.replace(/https:\/\/www\.crunchyroll\.com\/license\//g, `${proxyBase}/license/`);
  return Buffer.from(s, 'utf8');
}

// ─── Exponential backoff helper ───
function backoffMs(attempt) {
  return Math.min(4000, 500 * Math.pow(2, attempt - 1)); // 500, 1000, 2000, 4000
}

function isOutdatedToken(r) {
  if (r.statusCode !== 400 && r.statusCode !== 403) return false;
  const s = r.body.toString();
  return s.includes('40016') || s.includes('Outdated Token');
}

// ─── SERVER forward with exponential backoff on 40016 ───
async function forwardWithServer(res, method, path, query, body, incoming, proxyBase) {
  const MAX_ATTEMPTS = 4;
  let lastResponse = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await getServerToken();
    const targetUrl = `${CONFIG.CR_BASE}${path}${query}`;

    const headers = {
      'Authorization': `Bearer ${SERVER.access}`,
      'ETP-Anonymous-ID': CONFIG.SERVER_ANON_ID,
      'User-Agent': incoming['user-agent'] || CONFIG.UA_APP,
      'Accept': incoming['accept'] || 'application/json',
      'Accept-Encoding': 'gzip',
      'Connection': 'Keep-Alive',
    };
    if (body && body.length) headers['Content-Type'] = incoming['content-type'] || 'application/json';

    const r = await makeRequest(targetUrl, method, headers, body);
    lastResponse = r;

    if (isOutdatedToken(r)) {
      const delay = backoffMs(attempt);
      log('RETRY', `40016 attempt ${attempt}/${MAX_ATTEMPTS}, backoff ${delay}ms`);
      SERVER.access = '';
      SERVER.expiresAt = 0;
      SERVER.warmedUp = false;
      await new Promise(s => setTimeout(s, delay));
      continue;
    }
    break;
  }

  const r = lastResponse;
  const ct = r.headers['content-type'] || '';
  let outBody = r.body;
  if (ct.includes('json') && r.statusCode < 300) {
    outBody = rewriteBody(r.body, proxyBase);
  }

  const gz = await new Promise((resolve, reject) =>
    zlib.gzip(outBody, { level: 1 }, (e, out) => e ? reject(e) : resolve(out))
  );

  res.writeHead(r.statusCode, corsHeaders({
    'Content-Type': ct || 'application/json',
    'Content-Encoding': 'gzip',
    'Content-Length': gz.length,
    'X-Proxy-Mode': 'premium',
  }));
  res.end(gz);
}

// ─── Streaming/POST pipe with retry ───
async function forwardStreamWithServer(req, res, path, query) {
  const MAX_ATTEMPTS = 4;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await getServerToken();
    const targetUrl = `${CONFIG.CR_BASE}${path}${query}`;
    const u = new URL(targetUrl);

    const incoming = req.headers;
    const headers = {
      'Authorization': `Bearer ${SERVER.access}`,
      'ETP-Anonymous-ID': CONFIG.SERVER_ANON_ID,
      'User-Agent': incoming['user-agent'] || CONFIG.UA_APP,
      'Accept': incoming['accept'] || '*/*',
      'Accept-Encoding': 'identity',
      'Connection': 'Keep-Alive',
    };
    if (incoming['range']) headers['Range'] = incoming['range'];
    if (incoming['content-type']) headers['Content-Type'] = incoming['content-type'];
    if (incoming['x-cr-content-id']) headers['x-cr-content-id'] = incoming['x-cr-content-id'];
    if (incoming['x-cr-video-token']) headers['x-cr-video-token'] = incoming['x-cr-video-token'];
    if (incoming['x-cr-tab-id']) headers['x-cr-tab-id'] = incoming['x-cr-tab-id'];
    if (incoming['x-cr-disable-drm']) headers['x-cr-disable-drm'] = incoming['x-cr-disable-drm'];
    if (incoming['x-cr-enable-drm']) headers['x-cr-enable-drm'] = incoming['x-cr-enable-drm'];

    // Read body once — needs to be cached for retries
    let bodyBuf = null;
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      if (!req._cachedBody) req._cachedBody = await readBody(req);
      bodyBuf = req._cachedBody;
      headers['Content-Length'] = bodyBuf.length;
    }

    const result = await new Promise((resolve) => {
      const upReq = https.request({
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: req.method || 'GET',
        headers,
      }, (up) => {
        const chunks = [];
        up.on('data', (c) => chunks.push(c));
        up.on('end', () => resolve({
          statusCode: up.statusCode,
          headers: up.headers,
          body: Buffer.concat(chunks),
        }));
        up.on('error', () => resolve({ statusCode: 502, headers: {}, body: Buffer.alloc(0) }));
      });
      upReq.on('error', () => resolve({ statusCode: 502, headers: {}, body: Buffer.alloc(0) }));
      if (bodyBuf) upReq.write(bodyBuf);
      upReq.end();
    });

    // Check for outdated token
    const isOutdated = (result.statusCode === 400 || result.statusCode === 403) &&
                       (result.body.toString().includes('40016') || result.body.toString().includes('Outdated Token'));

    if (isOutdated) {
      const delay = backoffMs(attempt);
      log('STREAM-RETRY', `${req.method} ${path} → 40016 attempt ${attempt}/${MAX_ATTEMPTS}, backoff ${delay}ms`);
      SERVER.access = '';
      SERVER.expiresAt = 0;
      SERVER.warmedUp = false;
      await new Promise(s => setTimeout(s, delay));
      continue;
    }

    // Success or non-retryable error — send response
    const out = corsHeaders({
      'Content-Type': result.headers['content-type'] || 'application/octet-stream',
      'Accept-Ranges': result.headers['accept-ranges'] || 'bytes',
      'X-Proxy-Mode': 'premium-stream',
    });
    if (result.headers['content-length']) out['Content-Length'] = result.headers['content-length'];
    if (result.headers['content-range']) out['Content-Range'] = result.headers['content-range'];
    if (result.headers['etag']) out['ETag'] = result.headers['etag'];
    if (result.headers['x-cr-error-code']) out['X-Cr-Error-Code'] = result.headers['x-cr-error-code'];

    log('STREAM', `${req.method} ${path} → ${result.statusCode}`);
    res.writeHead(result.statusCode, out);
    return res.end(result.body);
  }

  // All retries exhausted
  log('STREAM-FAIL', `${req.method} ${path} — all retries failed`);
  if (!res.headersSent) sendError(res, 502, 'stream failed after retries');
}
// ─── LOGIN — return cached premium token (with warm-up) ───
async function handleLogin(req, res) {
  log('LOGIN', 'App login — returning premium token');

  try {
    await readBody(req);

    // Only refresh if needed; getServerToken handles warm-up
    await getServerToken();

    const now = Math.floor(Date.now() / 1000);
    const expiresIn = Math.max(60, SERVER.expiresAt - now);

    sendJSON(res, 200, {
      access_token: SERVER.access,
      refresh_token: SERVER.refresh,
      expires_in: expiresIn,
      token_type: 'Bearer',
      scope: 'account content mp offline_access pins teen-profile',
      country: 'IN',
      account_id: SERVER.accountId,
      profile_id: SERVER.profileId,
    });

    log('LOGIN', `Returned premium token. profile=${SERVER.profileId}, expires in ${expiresIn}s, warmed=${SERVER.warmedUp}`);
  } catch (err) {
    log('LOGIN', `ERROR: ${err.message}`);
    sendJSON(res, 500, { error: 'server_error', error_description: err.message });
  }
}

async function handleDiag(req, res) {
  const now = Math.floor(Date.now() / 1000);
  let serverStatus = 'not-tried';
  let benefits = null;
  try {
    const token = await getServerToken();
    serverStatus = 'ok';
    try {
      const parts = token.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
        benefits = payload.benefits || [];
      }
    } catch (e) {}
  } catch (e) {
    serverStatus = `fail: ${e.message}`;
  }
  sendJSON(res, 200, {
    mode: 'v11-warmed-token',
    server: {
      cached: !!SERVER.access,
      warmed: SERVER.warmedUp,
      status: serverStatus,
      expiresInSec: SERVER.expiresAt - now,
      profile: SERVER.profileId,
      account: SERVER.accountId,
      benefits,
      premium: !!(benefits && benefits.includes('cr_premium')),
    },
    rules: {
      login: 'Returns premium token (warmed up)',
      playback: 'Auto-retry with exponential backoff on 40016',
      everything: 'Premium token',
    },
  });
}

async function handleSubtitleByEpisode(req, res, q) {
  if (!q.episodeId) return sendError(res, 400, 'episodeId required');
  await getServerToken();
  const url = `${CONFIG.CR_BASE}/playback/v3/${q.episodeId}/android/phone/play?queue=false`;
  const r = await makeRequest(url, 'GET', {
    'Authorization': `Bearer ${SERVER.access}`,
    'ETP-Anonymous-ID': CONFIG.SERVER_ANON_ID,
    'User-Agent': CONFIG.UA_APP,
  });
  const json = JSON.parse(r.body.toString());
  const subUrl = json?.subtitles?.['en-US']?.url;
  if (!subUrl) return sendError(res, 404, 'No subtitle found');

  return new Promise((resolve) => {
    const u = new URL(subUrl);
    https.get({
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: { 'User-Agent': CONFIG.UA_APP },
    }, (up) => {
      const out = corsHeaders({ 'Content-Type': 'text/plain' });
      if (up.headers['content-length']) out['Content-Length'] = up.headers['content-length'];
      res.writeHead(up.statusCode, out);
      up.pipe(res);
      up.on('end', () => resolve());
    }).on('error', () => { sendError(res, 502, 'subtitle fetch failed'); resolve(); });
  });
}

async function handleLitix(req, res) {
  const body = await readBody(req);
  const r = await makeRequest(CONFIG.LITIX, 'POST', {
    'Content-Type': 'application/json',
    'x-litix-env-key': CONFIG.LITIX_KEY,
    'x-litix-shard-id': CONFIG.LITIX_SHARD,
    'User-Agent': CONFIG.UA_DALVIK,
    'Accept-Encoding': 'gzip',
  }, body);
  res.writeHead(r.statusCode, corsHeaders({ 'Content-Length': 0 }));
  res.end();
}

async function handleAnalytics(req, res) {
  const body = await readBody(req);
  const r = await makeRequest(CONFIG.ANALYTICS, 'POST', {
    'Content-Type': 'application/json',
    'Content-Encoding': 'gzip',
    'Accept-Encoding': 'gzip',
    'User-Agent': CONFIG.UA_ANALYTICS,
  }, body);
  sendJSON(res, r.statusCode, { ok: true, upstream: r.statusCode });
}

async function handler(req, res) {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = u.pathname;
  const q = Object.fromEntries(u.searchParams);
  const query = u.search || '';

  const proxyHost = req.headers['x-forwarded-host'] || req.headers.host || 'crunchyrollankmods.vercel.app';
  const proxyBase = `https://${proxyHost}`;

  log('REQ', `${req.method} ${p}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(200, corsHeaders());
    return res.end();
  }

  try {
    // ─── LOGIN ───
    if (p === '/auth/v1/token' || p === '/auth/v1/refresh') {
      return await handleLogin(req, res);
    }

    // ─── Analytics ───
    if (p === '/litix') return await handleLitix(req, res);
    if (p === '/analytics') return await handleAnalytics(req, res);
    if (p === '/subtitle') return await handleSubtitleByEpisode(req, res, q);

    // ─── Diag ───
    if (p === '/diag') return await handleDiag(req, res);
    if (p === '/server-token' || p === '/server-token/refresh') {
      try {
        SERVER.access = ''; SERVER.expiresAt = 0; SERVER.warmedUp = false;
        await getServerToken();
        const now = Math.floor(Date.now() / 1000);
        return sendJSON(res, 200, { ok: true, expiresInSec: SERVER.expiresAt - now, warmed: SERVER.warmedUp });
      } catch (e) {
        return sendJSON(res, 500, { ok: false, error: e.message });
      }
    }

    // ─── Status ───
    if (p === '/' || p === '/status') {
      return sendJSON(res, 200, {
        status: 'running',
        version: '11.0.0',
        mode: 'premium-warmed',
        time: new Date().toISOString(),
      });
    }

    // ─── STREAMING / BINARY (with retry) ───
    if (p.startsWith('/playback/v2/manifest/') ||
        p.includes('/segment') ||
        p.startsWith('/license/') ||
        p.startsWith('/playback/v1/token/')) {
      log('STREAM-REQ', `${req.method} ${p}`);
      return await forwardStreamWithServer(req, res, p, query);
    }

    // ─── EVERYTHING ELSE (premium, buffered) ───
    const premiumPrefixes = [
      '/content/', '/playback/', '/accounts/', '/subs/', '/v1/', '/v2/',
      '/f/', '/recommendations/', '/content-reviews/', '/config-delta/',
      '/music/', '/browse/', '/watchlist/', '/history/',
    ];

    if (premiumPrefixes.some(pref => p.startsWith(pref))) {
      const body = (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE')
        ? await readBody(req)
        : null;
      log('PREMIUM', `${req.method} ${p}`);
      return await forwardWithServer(res, req.method, p, query, body, req.headers, proxyBase);
    }

    sendError(res, 404, `Not found: ${p}`);
  } catch (e) {
    log('ERR', e.stack || e.message);
    if (!res.headersSent) sendError(res, 500, e.message);
  }
}

module.exports = handler;
