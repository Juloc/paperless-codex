import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rm, readdir, rename } from 'node:fs/promises';
import path from 'node:path';

const port = Number(process.env.PORT || 8080);
const paperlessUrl = String(process.env.PAPERLESS_URL || '').replace(/\/$/, '');
const paperlessToken = String(process.env.PAPERLESS_TOKEN || '');
const bridgeKey = String(process.env.BRIDGE_KEY || '');
const codexHome = process.env.CODEX_HOME || '/data/codex';
const workRoot = process.env.CODEX_WORKDIR || '/tmp/paperless-codex';
const stateDir = process.env.STATE_DIR || '/data/state';
const queuePath = path.join(stateDir, 'queue.json');
const maxDocumentBytes = Number(process.env.MAX_DOCUMENT_BYTES || 50 * 1024 * 1024);
const maxPages = Math.max(1, Math.min(50, Number(process.env.MAX_PAGES || 20)));
const renderDpi = Math.max(96, Math.min(240, Number(process.env.PDF_DPI || 150)));
const codexTimeoutMs = Math.max(60000, Number(process.env.CODEX_TIMEOUT_MS || 360000));
const model = String(process.env.CODEX_MODEL || '').trim();
const createMissingMetadata = /^(1|true|yes)$/i.test(process.env.CREATE_MISSING_METADATA || 'true');
const overwriteCustomFields = /^(1|true|yes)$/i.test(process.env.OVERWRITE_CUSTOM_FIELDS || 'false');
const writeContent = !/^(0|false|no)$/i.test(process.env.WRITE_CONTENT || 'true');
const minConfidence = Math.max(0, Math.min(1, Number(process.env.MIN_CONFIDENCE || 0.55)));
const existingMatchThreshold = Math.max(0.5, Math.min(1, Number(process.env.EXISTING_MATCH_THRESHOLD || 0.86)));

if (!paperlessUrl) throw new Error('PAPERLESS_URL is required.');
if (!paperlessToken) throw new Error('PAPERLESS_TOKEN is required.');
if (!bridgeKey) throw new Error('BRIDGE_KEY is required.');

await mkdir(codexHome, { recursive: true });
await mkdir(workRoot, { recursive: true });
await mkdir(stateDir, { recursive: true });

const queue = await loadQueue();
const jobs = new Map();
let workerRunning = false;
const authSessions = new Map();
let activeAuthId = null;

function log(scope, message, extra = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), scope, message, ...extra }));
}

function safeEqual(a, b) {
  if (!a || !b) return false;
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function authorized(req) {
  return safeEqual(req.headers['x-paperless-codex-key'], bridgeKey);
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(json);
}

async function readJson(req, max = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new Error('Request body too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function loadQueue() {
  try {
    const parsed = JSON.parse(await readFile(queuePath, 'utf8'));
    return Array.isArray(parsed) ? [...new Set(parsed.map(Number).filter(Number.isInteger))] : [];
  } catch {
    return [];
  }
}

async function saveQueue() {
  const temp = `${queuePath}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(queue), { mode: 0o600 });
  await rename(temp, queuePath);
}

async function enqueue(documentId) {
  if (!Number.isInteger(documentId) || documentId <= 0) throw new Error('Invalid document id.');
  if (!queue.includes(documentId)) {
    queue.push(documentId);
    await saveQueue();
  }
  jobs.set(documentId, {
    documentId,
    status: 'queued',
    queuedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    error: null,
    result: null
  });
  void processQueue();
}

async function processQueue() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    while (queue.length) {
      const documentId = queue[0];
      const job = jobs.get(documentId) || { documentId, queuedAt: null };
      Object.assign(job, { status: 'processing', startedAt: new Date().toISOString(), error: null });
      jobs.set(documentId, job);
      try {
        job.result = await scanPaperlessDocument(documentId);
        job.status = 'completed';
      } catch (error) {
        job.status = 'failed';
        job.error = String(error?.message || error);
        log('worker', 'Document scan failed.', { documentId, error: job.error });
      }
      job.finishedAt = new Date().toISOString();
      queue.shift();
      await saveQueue();
    }
  } finally {
    workerRunning = false;
  }
}

function paperlessHeaders(json = false) {
  return {
    Authorization: `Token ${paperlessToken}`,
    Accept: 'application/json; version=10',
    ...(json ? { 'Content-Type': 'application/json' } : {})
  };
}

async function paperlessFetch(apiPath, options = {}) {
  const url = apiPath.startsWith('http') ? apiPath : `${paperlessUrl}${apiPath}`;
  const target = new URL(url);
  if (target.origin !== new URL(paperlessUrl).origin) throw new Error('Paperless pagination URL changed origin.');
  const response = await fetch(target, {
    ...options,
    headers: { ...paperlessHeaders(Boolean(options.body)), ...(options.headers || {}) }
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Paperless ${options.method || 'GET'} ${target.pathname} failed: ${response.status} ${text.slice(0, 500)}`);
  }
  return response;
}

async function paperlessJson(apiPath, options = {}) {
  return await (await paperlessFetch(apiPath, options)).json();
}

async function listAll(apiPath) {
  let next = `${apiPath}${apiPath.includes('?') ? '&' : '?'}page_size=1000`;
  const all = [];
  while (next) {
    const body = await paperlessJson(next);
    if (Array.isArray(body)) return body;
    all.push(...(body.results || []));
    next = body.next || null;
  }
  return all;
}

function detectType(bytes, contentType = '') {
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString('ascii') === '%PDF-') return { ext: '.pdf', mime: 'application/pdf' };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { ext: '.jpg', mime: 'image/jpeg' };
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return { ext: '.png', mime: 'image/png' };
  if (bytes.length >= 12 && bytes.subarray(0,4).toString('ascii') === 'RIFF' && bytes.subarray(8,12).toString('ascii') === 'WEBP') return { ext: '.webp', mime: 'image/webp' };
  if (/application\/pdf/i.test(contentType)) return { ext: '.pdf', mime: 'application/pdf' };
  return null;
}

async function tryDownload(documentId, original) {
  try {
    const suffix = original ? '?original=true' : '';
    const response = await paperlessFetch(`/api/documents/${documentId}/download/${suffix}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) return null;
    if (bytes.length > maxDocumentBytes) throw new Error(`Document exceeds ${maxDocumentBytes} bytes.`);
    const type = detectType(bytes, response.headers.get('content-type') || '');
    return type ? { bytes, ...type, original } : null;
  } catch (error) {
    if (original) return null;
    throw error;
  }
}

async function downloadDocument(documentId) {
  return await tryDownload(documentId, true)
    || await tryDownload(documentId, false)
    || Promise.reject(new Error('Document is not a PDF/JPEG/PNG/WebP and no archived PDF is available.'));
}

async function spawnCapture(command, args, { cwd = workRoot, timeoutMs = 60000, env = process.env } = {}) {
  return await new Promise(resolve => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let done = false;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    }, timeoutMs);
    const finish = code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    };
    child.stdout.on('data', x => stdout.push(Buffer.from(x)));
    child.stderr.on('data', x => stderr.push(Buffer.from(x)));
    child.on('error', error => { stderr.push(Buffer.from(error.message)); finish(-1); });
    child.on('close', finish);
  });
}

async function prepareImages(runDir, document, documentId) {
  const input = path.join(runDir, `document${document.ext}`);
  await writeFile(input, document.bytes, { mode: 0o600 });
  if (document.ext !== '.pdf') return { images: [input], truncated: false, pages: 1 };

  let pageCount = null;
  const info = await spawnCapture('pdfinfo', [input], { cwd: runDir, timeoutMs: 20000 });
  const match = info.stdout.match(/^Pages:\s+(\d+)/mi);
  if (match) pageCount = Number(match[1]);
  const lastPage = pageCount ? Math.min(pageCount, maxPages) : maxPages;
  const base = path.join(runDir, 'page');
  const converted = await spawnCapture('pdftoppm', ['-f', '1', '-l', String(lastPage), '-png', '-r', String(renderDpi), input, base], { cwd: runDir, timeoutMs: 180000 });
  if (converted.code !== 0) throw new Error(`PDF rendering failed: ${converted.stderr.slice(0, 1000)}`);
  const files = (await readdir(runDir))
    .filter(name => /^page-\d+\.png$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map(name => path.join(runDir, name));
  if (!files.length) throw new Error('PDF rendering produced no pages.');
  log('scan', 'Rendered PDF pages.', { documentId, pages: files.length, sourcePages: pageCount, dpi: renderDpi });
  return { images: files, truncated: Boolean(pageCount && pageCount > files.length), pages: pageCount || files.length };
}

function normalizeName(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('de-DE')
    .replace(/&/g, ' und ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function bigrams(value) {
  const s = ` ${normalizeName(value)} `;
  const out = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

function similarity(a, b) {
  const aa = normalizeName(a);
  const bb = normalizeName(b);
  if (!aa || !bb) return 0;
  if (aa === bb) return 1;
  if (aa.includes(bb) || bb.includes(aa)) {
    const ratio = Math.min(aa.length, bb.length) / Math.max(aa.length, bb.length);
    if (ratio >= 0.72) return Math.max(0.9, ratio);
  }
  const A = bigrams(aa);
  const B = bigrams(bb);
  const counts = new Map();
  for (const x of A) counts.set(x, (counts.get(x) || 0) + 1);
  let hits = 0;
  for (const x of B) {
    const n = counts.get(x) || 0;
    if (n > 0) {
      hits++;
      counts.set(x, n - 1);
    }
  }
  return (2 * hits) / Math.max(1, A.length + B.length);
}

function findBestNamed(items, value) {
  const wanted = normalizeName(value);
  if (!wanted) return { item: null, score: 0 };
  const exact = items.find(x => normalizeName(x.name) === wanted);
  if (exact) return { item: exact, score: 1 };
  let best = null;
  let score = 0;
  for (const item of items) {
    const current = similarity(item.name, value);
    if (current > score) {
      best = item;
      score = current;
    }
  }
  return { item: best, score };
}

function itemById(items, id) {
  const n = Number(id);
  return Number.isInteger(n) ? items.find(x => Number(x.id) === n) || null : null;
}

async function getTaxonomy() {
  const [correspondents, documentTypes, tags, storagePaths, customFields] = await Promise.all([
    listAll('/api/correspondents/'),
    listAll('/api/document_types/'),
    listAll('/api/tags/'),
    listAll('/api/storage_paths/'),
    listAll('/api/custom_fields/')
  ]);
  return { correspondents, documentTypes, tags, storagePaths, customFields };
}

const selectionSchema = {
  type: ['object', 'null'],
  additionalProperties: false,
  required: ['existingId', 'name'],
  properties: {
    existingId: { type: ['integer', 'null'] },
    name: { type: ['string', 'null'] }
  }
};

function extractionSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['title','created','correspondent','recipient','documentType','tags','storagePath','customFields','fullText','language','summary','confidence','warnings'],
    properties: {
      title: { type: ['string','null'] },
      created: { type: ['string','null'] },
      correspondent: selectionSchema,
      recipient: { type: ['string','null'] },
      documentType: selectionSchema,
      tags: { type: 'array', items: selectionSchema },
      storagePath: selectionSchema,
      customFields: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['fieldId','fieldName','value','selectOptionId','confidence'],
          properties: {
            fieldId: { type: 'integer' },
            fieldName: { type: ['string','null'] },
            value: { type: ['string','number','boolean','null'] },
            selectOptionId: { type: ['string','null'] },
            confidence: { type: 'number', minimum: 0, maximum: 1 }
          }
        }
      },
      fullText: { type: 'string' },
      language: { type: ['string','null'] },
      summary: { type: ['string','null'] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      warnings: { type: 'array', items: { type: 'string' } }
    }
  };
}

function compactTaxonomy(taxonomy) {
  const named = items => items.slice(0, 2500).map(x => ({ id: x.id, name: x.name }));
  return {
    correspondents: named(taxonomy.correspondents),
    documentTypes: named(taxonomy.documentTypes),
    tags: named(taxonomy.tags),
    storagePaths: named(taxonomy.storagePaths),
    customFields: taxonomy.customFields.slice(0, 1000).map(field => ({
      id: field.id,
      name: field.name,
      dataType: field.data_type,
      selectOptions: Array.isArray(field.extra_data?.select_options)
        ? field.extra_data.select_options.map(x => typeof x === 'object' ? { id: x.id, label: x.label } : { id: null, label: String(x) })
        : []
    }))
  };
}

function buildPrompt(taxonomy, pageInfo) {
  return `Du bist ein Dokumenten-Scanner für Paperless-ngx. Analysiere ausschließlich die angehängten Dokumentseiten. Verwende keine Shell, kein Web und keine externen Quellen.\n\nWICHTIGE REGEL FÜR METADATEN:\n- Vorhandene Paperless-Einträge haben Vorrang. Wenn ein existierender Korrespondent, Dokumenttyp, Tag oder Storage Path semantisch passt, MUSST du dessen existingId zurückgeben und darfst keinen leicht anders geschriebenen Namen neu vorschlagen.\n- Beispiele: \"BKK Firmus\" und \"BKK firmus\", \"Amazon.de\" und \"Amazon\" oder Singular/Plural-Varianten sollen nicht als neue Objekte entstehen, wenn der bestehende Eintrag dieselbe Bedeutung hat.\n- Nur wenn wirklich kein vorhandener Eintrag passt, setze existingId=null und gib bei name einen sinnvollen neuen Namen zurück. Storage Paths dürfen niemals neu erfunden werden: dort bei fehlender Übereinstimmung null verwenden.\n- Für Tags mehrere passende bestehende IDs wählen, aber nicht redundant taggen.\n\nCUSTOM FIELDS:\n- Du erhältst alle bereits in Paperless definierten Custom Fields mit fieldId, Datentyp und ggf. Select-Optionen.\n- Verwende ausschließlich diese existierenden fieldIds. Erfinde niemals Custom Fields.\n- Befülle nur Felder, deren Wert eindeutig aus dem Dokument erkennbar und zum Feldnamen passend ist, z. B. Rechnungsnummer, Kundennummer, Vertragsnummer, Betrag, Fälligkeit, IBAN, Empfänger, Absender, Steuer-ID usw.\n- Falls ein Custom Field \"Empfänger\", \"Recipient\" o. ä. existiert, verwende den erkannten Dokumentempfänger dort. Zusätzlich gib den erkannten Empfänger in recipient zurück.\n- Bei select muss selectOptionId exakt die ID einer vorhandenen Option sein. Keine neue Option erfinden.\n- documentlink-Felder nicht automatisch befüllen.\n- Bei date YYYY-MM-DD verwenden. boolean als true/false, integer/float als Zahl. monetary als im Dokument erkannten Betrag mit Währung, wenn erkennbar.\n- Nur Werte mit field-level confidence >= 0.65 vorschlagen.\n\nWEITERE AUFGABEN:\n1. Lies den sichtbaren Dokumentinhalt vollständig und schreibe ihn als durchsuchbaren Volltext in fullText. Erfinde keinen Text.\n2. Erzeuge einen kurzen eindeutigen deutschen Titel ohne Dateiendung.\n3. Ermittle das tatsächliche Dokumentdatum als YYYY-MM-DD.\n4. Ermittle Absender/Korrespondent, Empfänger und Dokumenttyp.\n5. Wähle passende Tags und Storage Path.\n6. confidence bewertet die Gesamtsicherheit von 0 bis 1.\n\nVorhandene Paperless-Struktur:\n${JSON.stringify(compactTaxonomy(taxonomy))}\n\nSeiteninformation: ${pageInfo.images.length} gerenderte Seite(n), bekannte Gesamtseiten=${pageInfo.pages}, abgeschnitten=${pageInfo.truncated}.\n\nAntworte ausschließlich entsprechend dem JSON-Schema.`;
}

async function codexStatus() {
  const version = await spawnCapture('codex', ['--version'], { timeoutMs: 15000, env: { ...process.env, CODEX_HOME: codexHome } });
  const status = await spawnCapture('codex', ['login', 'status'], { timeoutMs: 20000, env: { ...process.env, CODEX_HOME: codexHome } });
  const text = `${status.stdout}\n${status.stderr}`.trim();
  return {
    connected: status.code === 0 && !/not logged|not signed|logged out/i.test(text),
    codexVersion: version.stdout.trim() || version.stderr.trim() || null,
    statusText: text || null
  };
}

async function runExtraction(runDir, images, prompt) {
  const schemaPath = path.join(runDir, 'schema.json');
  const outputPath = path.join(runDir, 'result.json');
  await writeFile(schemaPath, JSON.stringify(extractionSchema()), { mode: 0o600 });
  const args = [
    'exec', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
    '--json', '--sandbox', 'read-only'
  ];
  for (const image of images) args.push('--image', image);
  args.push('--output-schema', schemaPath, '--output-last-message', outputPath);
  if (model) args.push('--model', model);
  args.push(prompt);
  const result = await spawnCapture('codex', args, {
    cwd: runDir,
    timeoutMs: codexTimeoutMs,
    env: { ...process.env, CODEX_HOME: codexHome }
  });
  if (result.code !== 0) throw new Error(`Codex scan failed: ${result.stderr.slice(-2000) || result.stdout.slice(-2000)}`);
  const raw = await readFile(outputPath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    throw new Error('Codex returned no valid structured JSON.');
  }
}

async function resolveMetadata(endpoint, items, selection, extra = {}, allowCreate = true) {
  if (!selection) return null;
  const byId = itemById(items, selection.existingId);
  if (byId) return byId;
  const name = String(selection.name || '').trim();
  if (!name) return null;
  const best = findBestNamed(items, name);
  if (best.item && best.score >= existingMatchThreshold) {
    log('metadata', 'Reused similar existing metadata.', { requested: name, existing: best.item.name, score: Number(best.score.toFixed(3)) });
    return best.item;
  }
  if (!allowCreate || !createMissingMetadata) return null;
  const created = await paperlessJson(endpoint, {
    method: 'POST',
    body: JSON.stringify({ name: name.slice(0, 128), ...extra })
  });
  items.push(created);
  log('metadata', 'Created genuinely missing metadata.', { endpoint, name: created.name, id: created.id });
  return created;
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : null;
}

function existingCustomFieldMap(current) {
  const map = new Map();
  for (const item of Array.isArray(current.custom_fields) ? current.custom_fields : []) {
    const id = Number(item?.field);
    if (Number.isInteger(id)) map.set(id, { field: id, value: item.value ?? null });
  }
  return map;
}

function isFilled(value) {
  return value !== null && value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0);
}

function normalizeCustomFieldValue(field, suggestion) {
  if (!field || !suggestion || Number(suggestion.confidence) < 0.65) return undefined;
  const type = String(field.data_type || '').toLowerCase();
  if (type === 'documentlink') return undefined;

  if (type === 'select') {
    const options = Array.isArray(field.extra_data?.select_options) ? field.extra_data.select_options : [];
    const exactId = options.find(x => typeof x === 'object' && String(x.id) === String(suggestion.selectOptionId || ''));
    if (exactId) return exactId.id;
    const wanted = String(suggestion.value ?? '').trim();
    const byLabel = options
      .filter(x => typeof x === 'object')
      .map(x => ({ option: x, score: similarity(x.label, wanted) }))
      .sort((a, b) => b.score - a.score)[0];
    return byLabel?.score >= existingMatchThreshold ? byLabel.option.id : undefined;
  }

  const value = suggestion.value;
  if (value === null || value === undefined || value === '') return undefined;
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (/^(true|ja|yes|1)$/i.test(String(value))) return true;
    if (/^(false|nein|no|0)$/i.test(String(value))) return false;
    return undefined;
  }
  if (type === 'integer') {
    const n = Number(value);
    return Number.isInteger(n) ? n : undefined;
  }
  if (type === 'float') {
    const n = Number(String(value).replace(',', '.'));
    return Number.isFinite(n) ? n : undefined;
  }
  if (type === 'date') return validDate(value) || undefined;
  if (type === 'url') {
    try { return new URL(String(value)).toString(); } catch { return undefined; }
  }
  if (type === 'monetary') return String(value).trim().slice(0, 128);
  if (type === 'string') return String(value).trim().slice(0, 128);
  return String(value).trim().slice(0, 1000);
}

function mergeCustomFields(current, taxonomy, suggestions) {
  const values = existingCustomFieldMap(current);
  const applied = [];
  for (const suggestion of Array.isArray(suggestions) ? suggestions : []) {
    const field = taxonomy.customFields.find(x => Number(x.id) === Number(suggestion.fieldId));
    if (!field) continue;
    const existing = values.get(Number(field.id));
    if (!overwriteCustomFields && existing && isFilled(existing.value)) continue;
    const value = normalizeCustomFieldValue(field, suggestion);
    if (value === undefined) continue;
    values.set(Number(field.id), { field: Number(field.id), value });
    applied.push({ fieldId: Number(field.id), fieldName: field.name, value });
  }
  return { customFields: [...values.values()], applied };
}

async function applyResult(documentId, current, taxonomy, result) {
  const patch = {};
  if (result.title?.trim()) patch.title = result.title.trim().slice(0, 255);
  const date = validDate(result.created);
  if (date) patch.created = date;

  const correspondent = await resolveMetadata('/api/correspondents/', taxonomy.correspondents, result.correspondent);
  if (correspondent) patch.correspondent = correspondent.id;

  const documentType = await resolveMetadata('/api/document_types/', taxonomy.documentTypes, result.documentType);
  if (documentType) patch.document_type = documentType.id;

  const tagIds = new Set(Array.isArray(current.tags) ? current.tags.map(Number) : []);
  for (const selection of Array.isArray(result.tags) ? result.tags.slice(0, 25) : []) {
    const tag = await resolveMetadata('/api/tags/', taxonomy.tags, selection, { color: '#a6cee3' });
    if (tag) tagIds.add(Number(tag.id));
  }
  if (tagIds.size) patch.tags = [...tagIds];

  const storagePath = await resolveMetadata('/api/storage_paths/', taxonomy.storagePaths, result.storagePath, {}, false);
  if (storagePath) patch.storage_path = storagePath.id;

  const merged = mergeCustomFields(current, taxonomy, result.customFields);
  if (merged.applied.length) patch.custom_fields = merged.customFields;

  if (writeContent && typeof result.fullText === 'string' && result.fullText.trim()) {
    patch.content = result.fullText.trim();
  }

  await paperlessJson(`/api/documents/${documentId}/`, {
    method: 'PATCH',
    body: JSON.stringify(patch)
  });
  return { patch, appliedCustomFields: merged.applied, recipient: result.recipient || null };
}

async function scanPaperlessDocument(documentId) {
  const status = await codexStatus();
  if (!status.connected) throw new Error(`Codex is not logged in. ${status.statusText || ''}`.trim());

  const runDir = path.join(workRoot, `${documentId}-${crypto.randomUUID()}`);
  await mkdir(runDir, { recursive: true });
  try {
    const [current, taxonomy, document] = await Promise.all([
      paperlessJson(`/api/documents/${documentId}/`),
      getTaxonomy(),
      downloadDocument(documentId)
    ]);
    const pageInfo = await prepareImages(runDir, document, documentId);
    const result = await runExtraction(runDir, pageInfo.images, buildPrompt(taxonomy, pageInfo));
    if (!Number.isFinite(result.confidence) || result.confidence < minConfidence) {
      throw new Error(`Codex confidence ${result.confidence ?? 'unknown'} is below MIN_CONFIDENCE=${minConfidence}.`);
    }
    if (pageInfo.truncated) {
      result.warnings ||= [];
      result.warnings.push(`Only the first ${pageInfo.images.length} of ${pageInfo.pages} pages were scanned.`);
    }
    const applied = await applyResult(documentId, current, taxonomy, result);
    log('scan', 'Document scanned and updated.', {
      documentId,
      confidence: result.confidence,
      pages: pageInfo.images.length,
      customFields: applied.appliedCustomFields.map(x => x.fieldName)
    });
    return {
      confidence: result.confidence,
      pagesScanned: pageInfo.images.length,
      totalPages: pageInfo.pages,
      warnings: result.warnings || [],
      recipient: result.recipient || null,
      appliedCustomFields: applied.appliedCustomFields,
      patch: applied.patch
    };
  } finally {
    await rm(runDir, { recursive: true, force: true }).catch(() => {});
  }
}

function parseAuthHints(text) {
  const clean = String(text || '').replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '');
  return {
    verificationUrl: clean.match(/https?:\/\/[^\s)]+/i)?.[0] || null,
    userCode: clean.match(/\b[A-Z0-9]{4,}(?:-[A-Z0-9]{3,})+\b/)?.[0] || null
  };
}

async function startDeviceAuth() {
  if (activeAuthId && authSessions.get(activeAuthId)?.status === 'waiting') return authSessions.get(activeAuthId);
  const id = crypto.randomUUID();
  const session = { id, status: 'waiting', startedAt: new Date().toISOString(), completedAt: null, verificationUrl: null, userCode: null, error: null, output: [] };
  authSessions.set(id, session);
  activeAuthId = id;
  const child = spawn('codex', ['login', '--device-auth'], {
    cwd: workRoot,
    env: { ...process.env, CODEX_HOME: codexHome },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const timer = setTimeout(() => child.kill('SIGTERM'), 10 * 60 * 1000);
  const consume = stream => {
    let pending = '';
    stream.on('data', chunk => {
      pending += chunk.toString('utf8');
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      for (const line of lines) {
        session.output.push(line);
        if (session.output.length > 100) session.output.shift();
        const hints = parseAuthHints(line);
        session.verificationUrl ||= hints.verificationUrl;
        session.userCode ||= hints.userCode;
      }
    });
  };
  consume(child.stdout);
  consume(child.stderr);
  child.on('error', error => {
    clearTimeout(timer);
    session.status = 'error';
    session.error = error.message;
    session.completedAt = new Date().toISOString();
    activeAuthId = null;
  });
  child.on('close', code => {
    clearTimeout(timer);
    if (session.status === 'waiting') session.status = code === 0 ? 'connected' : 'error';
    if (code !== 0 && !session.error) session.error = `codex login exited with ${code}`;
    session.completedAt = new Date().toISOString();
    activeAuthId = null;
    void processQueue();
  });
  return session;
}

function publicAuth(session) {
  if (!session) return null;
  return {
    id: session.id,
    status: session.status,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    verificationUrl: session.verificationUrl,
    userCode: session.userCode,
    error: session.error,
    output: session.output
  };
}

function extractDocumentId(body) {
  for (const value of [body.document_id, body.doc_id, body.id]) {
    const n = Number(value);
    if (Number.isInteger(n) && n > 0) return n;
  }
  const text = String(body.doc_url || body.url || '');
  const match = text.match(/\/documents\/(\d+)/);
  return match ? Number(match[1]) : null;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { ok: true, queued: queue.length, workerRunning });
    }
    if (!authorized(req)) return send(res, 401, { error: 'Unauthorized.' });

    if (req.method === 'GET' && url.pathname === '/status') {
      const [codex, paperless] = await Promise.all([
        codexStatus(),
        paperlessFetch('/api/documents/?page_size=1').then(() => ({ connected: true })).catch(error => ({ connected: false, error: error.message }))
      ]);
      return send(res, 200, { codex, paperless, queued: queue.length, active: workerRunning });
    }

    if (req.method === 'GET' && url.pathname === '/metadata') {
      const taxonomy = await getTaxonomy();
      return send(res, 200, compactTaxonomy(taxonomy));
    }

    if (req.method === 'POST' && url.pathname === '/auth/start') {
      return send(res, 202, publicAuth(await startDeviceAuth()));
    }

    const authMatch = url.pathname.match(/^\/auth\/([0-9a-f-]+)$/i);
    if (req.method === 'GET' && authMatch) {
      const session = authSessions.get(authMatch[1]);
      return session ? send(res, 200, publicAuth(session)) : send(res, 404, { error: 'Auth session not found.' });
    }

    if (req.method === 'POST' && url.pathname === '/webhook/paperless') {
      const body = await readJson(req);
      const documentId = extractDocumentId(body);
      if (!documentId) return send(res, 400, { error: 'document_id/doc_id/doc_url is required.' });
      await enqueue(documentId);
      return send(res, 202, { accepted: true, documentId });
    }

    const scanMatch = url.pathname.match(/^\/documents\/(\d+)\/scan$/);
    if (req.method === 'POST' && scanMatch) {
      const documentId = Number(scanMatch[1]);
      await enqueue(documentId);
      return send(res, 202, { accepted: true, documentId });
    }

    if (req.method === 'GET' && url.pathname === '/jobs') {
      return send(res, 200, { queue, jobs: [...jobs.values()].slice(-100) });
    }

    return send(res, 404, { error: 'Not found.' });
  } catch (error) {
    log('http', 'Request failed.', { error: String(error?.message || error) });
    return send(res, 500, { error: String(error?.message || error) });
  }
});

server.listen(port, '0.0.0.0', () => {
  log('server', `paperless-codex v2 listening on ${port}`);
  if (queue.length) void processQueue();
});
