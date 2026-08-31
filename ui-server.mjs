import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const publicPort = Number(process.env.PORT || 8080);
const innerPort = Number(process.env.INNER_PORT || 8081);
const bridgeKey = String(process.env.BRIDGE_KEY || '');
const codexHome = process.env.CODEX_HOME || '/data/codex';
const paperlessUrl = String(process.env.PAPERLESS_URL || '').replace(/\/$/, '');
const paperlessToken = String(process.env.PAPERLESS_TOKEN || '');
const uiPath = new URL('./ui.html', import.meta.url);
const fallbackThemeColor = '#17541f';

if (!bridgeKey) throw new Error('BRIDGE_KEY is required.');
if (!paperlessUrl) throw new Error('PAPERLESS_URL is required.');
if (!paperlessToken) throw new Error('PAPERLESS_TOKEN is required.');

const backend = spawn(process.execPath, ['/app/server.mjs'], {
  env: { ...process.env, PORT: String(innerPort) },
  stdio: ['ignore', 'inherit', 'inherit']
});

backend.on('exit', (code, signal) => {
  console.error(`paperless-codex backend stopped code=${code} signal=${signal || ''}`);
  process.exitCode = code ?? 1;
});
backend.on('error', error => {
  console.error(error);
  process.exitCode = 1;
});

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    backend.kill(signal);
    setTimeout(() => process.exit(), 250).unref();
  });
}

async function proxy(req, res, path, injectKey = false) {
  const headers = { ...req.headers, host: `127.0.0.1:${innerPort}` };
  delete headers['content-length'];
  if (injectKey) headers['x-paperless-codex-key'] = bridgeKey;
  const target = `http://127.0.0.1:${innerPort}${path}`;
  const init = { method: req.method, headers };
  if (!['GET', 'HEAD'].includes(req.method || 'GET')) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    init.body = Buffer.concat(chunks);
  }
  try {
    const upstream = await fetch(target, init);
    const body = Buffer.from(await upstream.arrayBuffer());
    const responseHeaders = {};
    for (const [key, value] of upstream.headers) {
      if (!['content-encoding', 'transfer-encoding', 'connection'].includes(key.toLowerCase())) responseHeaders[key] = value;
    }
    responseHeaders['content-length'] = String(body.length);
    res.writeHead(upstream.status, responseHeaders);
    res.end(body);
  } catch (error) {
    const body = Buffer.from(JSON.stringify({ error: `Backend unavailable: ${error.message}` }));
    res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
    res.end(body);
  }
}

function parseBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (/^(true|1|yes)$/i.test(value)) return true;
    if (/^(false|0|no)$/i.test(value)) return false;
  }
  return fallback;
}

function normalizeHexColor(value) {
  const raw = String(value || '').trim();
  if (!raw) return fallbackThemeColor;
  const withHash = raw.startsWith('#') ? raw : `#${raw}`;
  return /^#[0-9a-f]{6}$/i.test(withHash) ? withHash.toLowerCase() : fallbackThemeColor;
}

async function paperlessTheme() {
  const response = await fetch(`${paperlessUrl}/api/ui_settings/`, {
    headers: {
      Authorization: `Token ${paperlessToken}`,
      Accept: 'application/json; version=10'
    }
  });
  if (!response.ok) throw new Error(`Paperless UI settings failed: ${response.status}`);
  const body = await response.json();
  const settings = body?.settings || {};
  const theme = settings?.theme || {};
  const darkMode = settings?.dark_mode || {};
  const useSystem = parseBoolean(darkMode?.use_system, true);
  const darkEnabled = parseBoolean(darkMode?.enabled, false);
  return {
    color: normalizeHexColor(theme?.color),
    appearance: useSystem ? 'system' : (darkEnabled ? 'dark' : 'light')
  };
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(body);
}

async function logout(res) {
  const child = spawn('codex', ['logout'], {
    env: { ...process.env, CODEX_HOME: codexHome },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  child.on('close', code => {
    const ok = code === 0;
    sendJson(res, ok ? 200 : 500, ok ? { success: true } : { error: stderr.trim() || `codex logout exited with ${code}` });
  });
  child.on('error', error => sendJson(res, 500, { error: error.message }));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const html = await readFile(uiPath);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': html.length,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'"
    });
    return res.end(html);
  }

  if (req.method === 'GET' && url.pathname === '/ui-api/theme') {
    try {
      return sendJson(res, 200, await paperlessTheme());
    } catch (error) {
      return sendJson(res, 200, { color: fallbackThemeColor, appearance: 'system', fallback: true, error: error.message });
    }
  }

  if (url.pathname.startsWith('/ui-api/')) {
    const path = url.pathname.slice('/ui-api'.length) + url.search;
    if (req.method === 'POST' && path === '/logout') return logout(res);
    const allowed =
      (req.method === 'GET' && ['/status', '/metadata', '/jobs', '/bulk/status'].includes(path)) ||
      (req.method === 'POST' && ['/auth/start', '/bulk/start', '/bulk/pause', '/bulk/resume', '/bulk/cancel'].includes(path)) ||
      (req.method === 'GET' && /^\/auth\/[0-9a-f-]+$/i.test(path));
    if (!allowed) return sendJson(res, 404, { error: 'UI API route not allowed.' });
    return proxy(req, res, path, true);
  }

  return proxy(req, res, url.pathname + url.search, false);
});

server.listen(publicPort, '0.0.0.0', () => {
  console.log(`paperless-codex UI listening on ${publicPort}; backend on ${innerPort}`);
});
