import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const publicPort = Number(process.env.PORT || 8080);
const innerPort = Number(process.env.INNER_PORT || 8081);
const bridgeKey = String(process.env.BRIDGE_KEY || '');
const codexHome = process.env.CODEX_HOME || '/data/codex';
const uiPath = new URL('./ui.html', import.meta.url);

if (!bridgeKey) throw new Error('BRIDGE_KEY is required.');

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

async function logout(res) {
  const child = spawn('codex', ['logout'], {
    env: { ...process.env, CODEX_HOME: codexHome },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  child.on('close', code => {
    const ok = code === 0;
    const body = Buffer.from(JSON.stringify(ok ? { success: true } : { error: stderr.trim() || `codex logout exited with ${code}` }));
    res.writeHead(ok ? 200 : 500, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
    res.end(body);
  });
  child.on('error', error => {
    const body = Buffer.from(JSON.stringify({ error: error.message }));
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
    res.end(body);
  });
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

  if (url.pathname.startsWith('/ui-api/')) {
    const path = url.pathname.slice('/ui-api'.length) + url.search;
    if (req.method === 'POST' && path === '/logout') return logout(res);
    const allowed =
      (req.method === 'GET' && ['/status', '/metadata', '/jobs'].includes(path)) ||
      (req.method === 'POST' && path === '/auth/start') ||
      (req.method === 'GET' && /^\/auth\/[0-9a-f-]+$/i.test(path));
    if (!allowed) {
      const body = Buffer.from(JSON.stringify({ error: 'UI API route not allowed.' }));
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
      return res.end(body);
    }
    return proxy(req, res, path, true);
  }

  return proxy(req, res, url.pathname + url.search, false);
});

server.listen(publicPort, '0.0.0.0', () => {
  console.log(`paperless-codex UI listening on ${publicPort}; backend on ${innerPort}`);
});
