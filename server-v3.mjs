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
const provenancePath = path.join(stateDir, 'provenance.json');
const backupDir = path.join(stateDir, 'ocr-backups');

const toolVersion = String(process.env.PAPERLESS_CODEX_VERSION || '0.1.0').trim();
const pipelineVersion = String(process.env.PAPERLESS_CODEX_PIPELINE_VERSION || '2').trim();
const configuredModel = String(process.env.CODEX_MODEL || '').trim();
const maxDocumentBytes = Number(process.env.MAX_DOCUMENT_BYTES || 50 * 1024 * 1024);
const maxPages = Math.max(1, Math.min(50, Number(process.env.MAX_PAGES || 20)));
const renderDpi = Math.max(96, Math.min(240, Number(process.env.PDF_DPI || 150)));
const codexTimeoutMs = Math.max(60000, Number(process.env.CODEX_TIMEOUT_MS || 360000));
const createMissingMetadata = /^(1|true|yes)$/i.test(process.env.CREATE_MISSING_METADATA || 'true');
const overwriteCustomFields = /^(1|true|yes)$/i.test(process.env.OVERWRITE_CUSTOM_FIELDS || 'false');
const writeContent = !/^(0|false|no)$/i.test(process.env.WRITE_CONTENT || 'true');
const minConfidence = Math.max(0, Math.min(1, Number(process.env.MIN_CONFIDENCE || 0.55)));
const ocrMinConfidence = Math.max(0, Math.min(1, Number(process.env.OCR_MIN_CONFIDENCE || 0.70)));
const ocrReplaceMode = String(process.env.OCR_REPLACE_MODE || 'better').toLowerCase();
const existingMatchThreshold = Math.max(0.5, Math.min(1, Number(process.env.EXISTING_MATCH_THRESHOLD || 0.86)));
const provenanceTagsEnabled = !/^(0|false|no)$/i.test(process.env.PROVENANCE_TAGS || 'true');

if (!paperlessUrl) throw new Error('PAPERLESS_URL is required.');
if (!paperlessToken) throw new Error('PAPERLESS_TOKEN is required.');
if (!bridgeKey) throw new Error('BRIDGE_KEY is required.');

await mkdir(codexHome, { recursive: true });
await mkdir(workRoot, { recursive: true });
await mkdir(stateDir, { recursive: true });
await mkdir(backupDir, { recursive: true });

const queue = await loadJson(queuePath, []);
const provenance = await loadJson(provenancePath, {});
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

async function loadJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return structuredClone(fallback);
  }
}

async function atomicWriteJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temp, file);
}

async function saveQueue() {
  await atomicWriteJson(queuePath, queue);
}

async function saveProvenance() {
  await atomicWriteJson(provenancePath, provenance);
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
      const documentId = Number(queue[0]);
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
  const files = (await readdir(runDir)).filter(name => /^page-\d+\.png$/i.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map(name => path.join(runDir, name));
  if (!files.length) throw new Error('PDF rendering produced no pages.');
  log('scan', 'Rendered PDF pages.', { documentId, pages: files.length, sourcePages: pageCount, dpi: renderDpi });
  return { images: files, truncated: Boolean(pageCount && pageCount > files.length), pages: pageCount || files.length };
}

function normalizeName(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('de-DE').replace(/&/g, ' und ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function bigrams(value) {
  const s = ` ${normalizeName(value)} `;
  const out = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

function similarity(a, b) {
  const aa = normalizeName(a); const bb = normalizeName(b);
  if (!aa || !bb) return 0; if (aa === bb) return 1;
  if (aa.includes(bb) || bb.includes(aa)) { const ratio = Math.min(aa.length, bb.length) / Math.max(aa.length, bb.length); if (ratio >= 0.72) return Math.max(0.9, ratio); }
  const A = bigrams(aa); const B = bigrams(bb); const counts = new Map();
  for (const x of A) counts.set(x, (counts.get(x) || 0) + 1);
  let hits = 0; for (const x of B) { const n = counts.get(x) || 0; if (n > 0) { hits++; counts.set(x, n - 1); } }
  return (2 * hits) / Math.max(1, A.length + B.length);
}

function findBestNamed(items, value) {
  const wanted = normalizeName(value); if (!wanted) return { item: null, score: 0 };
  const exact = items.find(x => normalizeName(x.name) === wanted); if (exact) return { item: exact, score: 1 };
  let best = null; let score = 0; for (const item of items) { const current = similarity(item.name, value); if (current > score) { best = item; score = current; } }
  return { item: best, score };
}

function itemById(items, id) { const n = Number(id); return Number.isInteger(n) ? items.find(x => Number(x.id) === n) || null : null; }

async function getTaxonomy() {
  const [correspondents, documentTypes, tags, storagePaths, customFields] = await Promise.all([listAll('/api/correspondents/'), listAll('/api/document_types/'), listAll('/api/tags/'), listAll('/api/storage_paths/'), listAll('/api/custom_fields/')]);
  return { correspondents, documentTypes, tags, storagePaths, customFields };
}

const selectionSchema = { type: ['object', 'null'], additionalProperties: false, required: ['existingId', 'name'], properties: { existingId: { type: ['integer', 'null'] }, name: { type: ['string', 'null'] } } };

function extractionSchema() {
  return { type: 'object', additionalProperties: false, required: ['title','created','correspondent','recipient','documentType','tags','storagePath','customFields','fullText','ocrConfidence','language','summary','confidence','warnings'], properties: {
    title: { type: ['string','null'] }, created: { type: ['string','null'] }, correspondent: selectionSchema, recipient: { type: ['string','null'] }, documentType: selectionSchema, tags: { type: 'array', items: selectionSchema }, storagePath: selectionSchema,
    customFields: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['fieldId','fieldName','value','selectOptionId','confidence'], properties: { fieldId: { type: 'integer' }, fieldName: { type: ['string','null'] }, value: { type: ['string','number','boolean','null'] }, selectOptionId: { type: ['string','null'] }, confidence: { type: 'number', minimum: 0, maximum: 1 } } } },
    fullText: { type: 'string' }, ocrConfidence: { type: 'number', minimum: 0, maximum: 1 }, language: { type: ['string','null'] }, summary: { type: ['string','null'] }, confidence: { type: 'number', minimum: 0, maximum: 1 }, warnings: { type: 'array', items: { type: 'string' } }
  } };
}

function compactTaxonomy(taxonomy) {
  const named = items => items.slice(0, 2500).map(x => ({ id: x.id, name: x.name }));
  return { correspondents: named(taxonomy.correspondents), documentTypes: named(taxonomy.documentTypes), tags: named(taxonomy.tags), storagePaths: named(taxonomy.storagePaths), customFields: taxonomy.customFields.slice(0, 1000).map(field => ({ id: field.id, name: field.name, dataType: field.data_type, selectOptions: Array.isArray(field.extra_data?.select_options) ? field.extra_data.select_options.map(x => typeof x === 'object' ? { id: x.id, label: x.label } : { id: null, label: String(x) }) : [] })) };
}

function buildPrompt(taxonomy, pageInfo) {
  return `Du bist ein präziser Dokumenten-Scanner für Paperless-ngx. Analysiere ausschließlich die angehängten Dokumentseiten. Verwende keine Shell, kein Web und keine externen Quellen.\n\nOCR / VOLLTEXT:\n- Lies den sichtbaren Inhalt direkt aus den Seiten und erzeuge in fullText einen möglichst vollständigen, durchsuchbaren Text.\n- Korrigiere offensichtliche OCR-Artefakte, falsche Worttrennungen an Zeilenenden und kaputte Leerzeichen.\n- Bewahre Schreibweise, Zahlen und Bedeutung des Originals. Erfinde niemals fehlende Inhalte.\n- Rechnungsnummern, Kundennummern, Vertragsnummern, Aktenzeichen, IBAN, BIC, Beträge, Datumswerte, E-Mail-Adressen, Telefonnummern und Adressen besonders strikt transkribieren. Nicht raten.\n- Wenn Zeichen oder Wörter wirklich unleserlich sind, verwende [unleserlich] statt eine plausible Zeichenfolge zu erfinden.\n- Entferne keine wichtigen Kopf-/Fußzeilen, sofern sie Identifikations- oder Suchinformationen enthalten.\n- ocrConfidence bewertet ausschließlich die Zuverlässigkeit des Volltexts von 0 bis 1.\n\nMETADATEN:\n- Vorhandene Paperless-Einträge haben Vorrang. Wenn ein existierender Korrespondent, Dokumenttyp, Tag oder Storage Path semantisch passt, MUSST du dessen existingId verwenden.\n- Keine leicht anders geschriebenen Dubletten erzeugen.\n- Nur wenn wirklich kein vorhandener Korrespondent, Dokumenttyp oder Tag passt, existingId=null und einen neuen Namen vorschlagen.\n- Storage Paths niemals neu erfinden; bei fehlender Übereinstimmung null.\n- Tags gezielt und nicht redundant wählen.\n\nCUSTOM FIELDS:\n- Verwende ausschließlich existierende fieldIds.\n- Befülle nur eindeutig erkennbare Werte.\n- Bei select muss selectOptionId exakt einer vorhandenen Option entsprechen.\n- documentlink nicht automatisch befüllen.\n- date als YYYY-MM-DD, boolean true/false, integer/float als Zahl.\n- Nur Werte mit field-level confidence >= 0.65 vorschlagen.\n\nWEITERE AUFGABEN:\n1. Kurzer eindeutiger deutscher Titel ohne Dateiendung.\n2. Tatsächliches Dokumentdatum als YYYY-MM-DD.\n3. Absender/Korrespondent, Empfänger und Dokumenttyp.\n4. Passende Tags und Storage Path.\n5. confidence bewertet die Gesamtsicherheit von 0 bis 1.\n\nVorhandene Paperless-Struktur:\n${JSON.stringify(compactTaxonomy(taxonomy))}\n\nSeiteninformation: ${pageInfo.images.length} gerenderte Seite(n), bekannte Gesamtseiten=${pageInfo.pages}, abgeschnitten=${pageInfo.truncated}.\n\nAntworte ausschließlich entsprechend dem JSON-Schema.`;
}

async function codexStatus() {
  const version = await spawnCapture('codex', ['--version'], { timeoutMs: 15000, env: { ...process.env, CODEX_HOME: codexHome } });
  const status = await spawnCapture('codex', ['login', 'status'], { timeoutMs: 20000, env: { ...process.env, CODEX_HOME: codexHome } });
  const text = `${status.stdout}\n${status.stderr}`.trim();
  return { connected: status.code === 0 && !/not logged|not signed|logged out/i.test(text), codexVersion: version.stdout.trim() || version.stderr.trim() || null, statusText: text || null };
}

function findModelInValue(value, depth = 0) {
  if (depth > 6 || value == null) return null;
  if (Array.isArray(value)) { for (const x of value) { const found = findModelInValue(x, depth + 1); if (found) return found; } return null; }
  if (typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) { if (/^(model|model_name|model_slug)$/i.test(key) && typeof child === 'string' && child.trim()) return child.trim(); const found = findModelInValue(child, depth + 1); if (found) return found; }
  return null;
}

function detectResolvedModel(stdout) {
  for (const line of String(stdout || '').split(/\r?\n/)) { try { const found = findModelInValue(JSON.parse(line)); if (found) return found; } catch {} }
  return configuredModel || 'account-default';
}

async function runExtraction(runDir, images, prompt) {
  const schemaPath = path.join(runDir, 'schema.json'); const outputPath = path.join(runDir, 'result.json');
  await writeFile(schemaPath, JSON.stringify(extractionSchema()), { mode: 0o600 });
  const args = ['exec', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--json', '--sandbox', 'read-only'];
  for (const image of images) args.push('--image', image);
  args.push('--output-schema', schemaPath, '--output-last-message', outputPath); if (configuredModel) args.push('--model', configuredModel); args.push(prompt);
  const execution = await spawnCapture('codex', args, { cwd: runDir, timeoutMs: codexTimeoutMs, env: { ...process.env, CODEX_HOME: codexHome } });
  if (execution.code !== 0) throw new Error(`Codex scan failed: ${execution.stderr.slice(-2000) || execution.stdout.slice(-2000)}`);
  const raw = await readFile(outputPath, 'utf8'); let result;
  try { result = JSON.parse(raw); } catch { const start = raw.indexOf('{'); const end = raw.lastIndexOf('}'); if (start >= 0 && end > start) result = JSON.parse(raw.slice(start, end + 1)); else throw new Error('Codex returned no valid structured JSON.'); }
  return { result, resolvedModel: detectResolvedModel(execution.stdout) };
}

async function resolveMetadata(endpoint, items, selection, extra = {}, allowCreate = true) {
  if (!selection) return null; const byId = itemById(items, selection.existingId); if (byId) return byId;
  const name = String(selection.name || '').trim(); if (!name) return null; const best = findBestNamed(items, name);
  if (best.item && best.score >= existingMatchThreshold) { log('metadata', 'Reused similar existing metadata.', { requested: name, existing: best.item.name, score: Number(best.score.toFixed(3)) }); return best.item; }
  if (!allowCreate || !createMissingMetadata) return null;
  const created = await paperlessJson(endpoint, { method: 'POST', body: JSON.stringify({ name: name.slice(0, 128), ...extra }) }); items.push(created); log('metadata', 'Created genuinely missing metadata.', { endpoint, name: created.name, id: created.id }); return created;
}

async function ensureTag(taxonomy, name, color = '#607d8b') {
  const exact = taxonomy.tags.find(x => normalizeName(x.name) === normalizeName(name)); if (exact) return exact;
  const created = await paperlessJson('/api/tags/', { method: 'POST', body: JSON.stringify({ name: name.slice(0, 128), color }) }); taxonomy.tags.push(created); return created;
}

function validDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : null; }
function existingCustomFieldMap(current) { const map = new Map(); for (const item of Array.isArray(current.custom_fields) ? current.custom_fields : []) { const id = Number(item?.field); if (Number.isInteger(id)) map.set(id, { field: id, value: item.value ?? null }); } return map; }
function isFilled(value) { return value !== null && value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0); }

function normalizeCustomFieldValue(field, suggestion) {
  if (!field || !suggestion || Number(suggestion.confidence) < 0.65) return undefined; const type = String(field.data_type || '').toLowerCase(); if (type === 'documentlink') return undefined;
  if (type === 'select') { const options = Array.isArray(field.extra_data?.select_options) ? field.extra_data.select_options : []; const exactId = options.find(x => typeof x === 'object' && String(x.id) === String(suggestion.selectOptionId || '')); if (exactId) return exactId.id; const wanted = String(suggestion.value ?? '').trim(); const byLabel = options.filter(x => typeof x === 'object').map(x => ({ option: x, score: similarity(x.label, wanted) })).sort((a, b) => b.score - a.score)[0]; return byLabel?.score >= existingMatchThreshold ? byLabel.option.id : undefined; }
  const value = suggestion.value; if (value === null || value === undefined || value === '') return undefined;
  if (type === 'boolean') { if (typeof value === 'boolean') return value; if (/^(true|ja|yes|1)$/i.test(String(value))) return true; if (/^(false|nein|no|0)$/i.test(String(value))) return false; return undefined; }
  if (type === 'integer') { const n = Number(value); return Number.isInteger(n) ? n : undefined; }
  if (type === 'float') { const n = Number(String(value).replace(',', '.')); return Number.isFinite(n) ? n : undefined; }
  if (type === 'date') return validDate(value) || undefined;
  if (type === 'url') { try { return new URL(String(value)).toString(); } catch { return undefined; } }
  if (type === 'monetary') return String(value).trim().slice(0, 128); if (type === 'string') return String(value).trim().slice(0, 128); return String(value).trim().slice(0, 1000);
}

function mergeCustomFields(current, taxonomy, suggestions) {
  const values = existingCustomFieldMap(current); const applied = [];
  for (const suggestion of Array.isArray(suggestions) ? suggestions : []) { const field = taxonomy.customFields.find(x => Number(x.id) === Number(suggestion.fieldId)); if (!field) continue; const existing = values.get(Number(field.id)); if (!overwriteCustomFields && existing && isFilled(existing.value)) continue; const value = normalizeCustomFieldValue(field, suggestion); if (value === undefined) continue; values.set(Number(field.id), { field: Number(field.id), value }); applied.push({ fieldId: Number(field.id), fieldName: field.name, value }); }
  return { customFields: [...values.values()], applied };
}

function textMetrics(value) {
  const text = String(value || '').trim(); if (!text) return { length: 0, words: 0, score: 0, suspiciousRatio: 1 };
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}._\/@:+-]*/gu) || []; const lettersDigits = (text.match(/[\p{L}\p{N}]/gu) || []).length; const suspicious = (text.match(/[�□■]{1}|\?\?\?|\[unleserlich\]/giu) || []).length; const suspiciousRatio = suspicious / Math.max(1, words.length); const usefulRatio = lettersDigits / Math.max(1, text.length); const unique = new Set(words.map(x => x.toLocaleLowerCase('de-DE'))).size; const diversity = unique / Math.max(1, words.length);
  const score = Math.max(0, Math.min(1, usefulRatio * 0.45 + Math.min(1, words.length / 80) * 0.25 + Math.min(1, diversity * 1.8) * 0.20 + Math.max(0, 1 - suspiciousRatio * 8) * 0.10));
  return { length: text.length, words: words.length, score, suspiciousRatio };
}

function decideOcrReplacement(existingText, candidateText, ocrConfidence) {
  const oldMetrics = textMetrics(existingText); const newMetrics = textMetrics(candidateText); const confidence = Number(ocrConfidence);
  if (!writeContent) return { replace: false, reason: 'WRITE_CONTENT=false', oldMetrics, newMetrics };
  if (!Number.isFinite(confidence) || confidence < ocrMinConfidence) return { replace: false, reason: `OCR confidence below ${ocrMinConfidence}`, oldMetrics, newMetrics };
  if (newMetrics.length < 40 || newMetrics.words < 5 || newMetrics.suspiciousRatio > 0.08) return { replace: false, reason: 'Candidate OCR failed plausibility checks', oldMetrics, newMetrics };
  if (ocrReplaceMode === 'always') return { replace: true, reason: 'OCR_REPLACE_MODE=always', oldMetrics, newMetrics };
  if (!oldMetrics.length || oldMetrics.words < 5) return { replace: true, reason: 'Existing OCR is empty/very weak', oldMetrics, newMetrics };
  const materiallyBetter = newMetrics.score >= oldMetrics.score + 0.04; const comparableButMoreComplete = newMetrics.score >= oldMetrics.score - 0.02 && newMetrics.length >= Math.max(80, oldMetrics.length * 0.75) && newMetrics.words >= oldMetrics.words * 0.80;
  return { replace: materiallyBetter || comparableButMoreComplete, reason: materiallyBetter ? 'Codex OCR quality score is better' : (comparableButMoreComplete ? 'Codex OCR is comparable and sufficiently complete' : 'Existing OCR kept'), oldMetrics, newMetrics };
}

async function backupExistingOcr(documentId, currentContent) {
  if (!String(currentContent || '').trim()) return null; const file = path.join(backupDir, `${documentId}.json`); const backup = { documentId, savedAt: new Date().toISOString(), sha256: crypto.createHash('sha256').update(String(currentContent)).digest('hex'), content: String(currentContent) }; await atomicWriteJson(file, backup); return file;
}

function provenancePrefix(name) { return /^(AI: Codex|AI Tool:|AI Pipeline:|AI Model:|AI CLI:|AI OCR:)/i.test(String(name || '')); }

async function applyProvenanceTags(current, taxonomy, semanticTagIds, run) {
  if (!provenanceTagsEnabled) return null; const existingIds = new Set(Array.isArray(current.tags) ? current.tags.map(Number) : []); for (const tag of taxonomy.tags) if (provenancePrefix(tag.name)) existingIds.delete(Number(tag.id));
  const names = ['AI: Codex', `AI Tool: paperless-codex ${toolVersion}`, `AI Pipeline: ${pipelineVersion}`, `AI Model: ${run.model}`, `AI CLI: ${run.codexVersion || 'unknown'}`, `AI OCR: ${run.ocrReplaced ? 'improved' : 'kept-existing'}`]; const created = [];
  for (const name of names) { const tag = await ensureTag(taxonomy, name); existingIds.add(Number(tag.id)); created.push({ id: Number(tag.id), name: tag.name }); }
  for (const id of semanticTagIds) existingIds.add(Number(id)); return { ids: [...existingIds], tags: created };
}

async function applyResult(documentId, current, taxonomy, result, run) {
  const patch = {}; if (result.title?.trim()) patch.title = result.title.trim().slice(0, 255); const date = validDate(result.created); if (date) patch.created = date;
  const correspondent = await resolveMetadata('/api/correspondents/', taxonomy.correspondents, result.correspondent); if (correspondent) patch.correspondent = correspondent.id;
  const documentType = await resolveMetadata('/api/document_types/', taxonomy.documentTypes, result.documentType); if (documentType) patch.document_type = documentType.id;
  const semanticTagIds = new Set(); for (const selection of Array.isArray(result.tags) ? result.tags.slice(0, 25) : []) { const tag = await resolveMetadata('/api/tags/', taxonomy.tags, selection, { color: '#a6cee3' }); if (tag) semanticTagIds.add(Number(tag.id)); }
  const storagePath = await resolveMetadata('/api/storage_paths/', taxonomy.storagePaths, result.storagePath, {}, false); if (storagePath) patch.storage_path = storagePath.id;
  const merged = mergeCustomFields(current, taxonomy, result.customFields); if (merged.applied.length) patch.custom_fields = merged.customFields;
  const ocrDecision = decideOcrReplacement(current.content, result.fullText, result.ocrConfidence); run.ocrReplaced = ocrDecision.replace; run.ocrDecision = ocrDecision.reason; run.ocrConfidence = Number(result.ocrConfidence); run.oldOcr = ocrDecision.oldMetrics; run.newOcr = ocrDecision.newMetrics;
  if (ocrDecision.replace) { run.ocrBackup = await backupExistingOcr(documentId, current.content); patch.content = String(result.fullText).trim(); }
  const provenanceTags = await applyProvenanceTags(current, taxonomy, semanticTagIds, run); if (provenanceTags?.ids?.length) patch.tags = provenanceTags.ids; else { const tagIds = new Set(Array.isArray(current.tags) ? current.tags.map(Number) : []); for (const id of semanticTagIds) tagIds.add(id); if (tagIds.size) patch.tags = [...tagIds]; }
  await paperlessJson(`/api/documents/${documentId}/`, { method: 'PATCH', body: JSON.stringify(patch) });
  return { patch, appliedCustomFields: merged.applied, recipient: result.recipient || null, ocr: ocrDecision, provenanceTags: provenanceTags?.tags || [] };
}

async function recordProvenance(documentId, run) { const key = String(documentId); const history = Array.isArray(provenance[key]?.history) ? provenance[key].history : []; history.push(run); provenance[key] = { latest: run, history: history.slice(-20) }; await saveProvenance(); }

async function scanPaperlessDocument(documentId) {
  const status = await codexStatus(); if (!status.connected) throw new Error(`Codex is not logged in. ${status.statusText || ''}`.trim());
  const runDir = path.join(workRoot, `${documentId}-${crypto.randomUUID()}`); await mkdir(runDir, { recursive: true }); const startedAt = new Date().toISOString();
  try {
    const [current, taxonomy, document] = await Promise.all([paperlessJson(`/api/documents/${documentId}/`), getTaxonomy(), downloadDocument(documentId)]); const pageInfo = await prepareImages(runDir, document, documentId); const extraction = await runExtraction(runDir, pageInfo.images, buildPrompt(taxonomy, pageInfo)); const result = extraction.result;
    if (!Number.isFinite(result.confidence) || result.confidence < minConfidence) throw new Error(`Codex confidence ${result.confidence ?? 'unknown'} is below MIN_CONFIDENCE=${minConfidence}.`);
    if (pageInfo.truncated) { result.warnings ||= []; result.warnings.push(`Only the first ${pageInfo.images.length} of ${pageInfo.pages} pages were scanned.`); }
    const run = { runId: crypto.randomUUID(), startedAt, finishedAt: null, tool: 'paperless-codex', toolVersion, pipelineVersion, model: extraction.resolvedModel, codexVersion: status.codexVersion || null, confidence: Number(result.confidence), pagesScanned: pageInfo.images.length, totalPages: pageInfo.pages, inputSha256: crypto.createHash('sha256').update(document.bytes).digest('hex'), ocrReplaced: false, ocrConfidence: Number(result.ocrConfidence), ocrDecision: null, warnings: result.warnings || [] };
    const applied = await applyResult(documentId, current, taxonomy, result, run); run.finishedAt = new Date().toISOString(); run.appliedCustomFields = applied.appliedCustomFields.map(x => x.fieldName); run.provenanceTags = applied.provenanceTags.map(x => x.name); await recordProvenance(documentId, run);
    log('scan', 'Document scanned and updated.', { documentId, confidence: result.confidence, pages: pageInfo.images.length, model: run.model, pipelineVersion, ocrReplaced: run.ocrReplaced, ocrDecision: run.ocrDecision });
    return { confidence: result.confidence, ocrConfidence: result.ocrConfidence, ocrReplaced: run.ocrReplaced, ocrDecision: run.ocrDecision, model: run.model, toolVersion, pipelineVersion, codexVersion: run.codexVersion, pagesScanned: pageInfo.images.length, totalPages: pageInfo.pages, warnings: result.warnings || [], recipient: result.recipient || null, appliedCustomFields: applied.appliedCustomFields, provenanceTags: applied.provenanceTags, patch: applied.patch };
  } finally { await rm(runDir, { recursive: true, force: true }).catch(() => {}); }
}

function parseAuthHints(text) { const clean = String(text || '').replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, ''); return { verificationUrl: clean.match(/https?:\/\/[^\s)]+/i)?.[0] || null, userCode: clean.match(/\b[A-Z0-9]{4,}(?:-[A-Z0-9]{3,})+\b/)?.[0] || null }; }

async function startDeviceAuth() {
  if (activeAuthId && authSessions.get(activeAuthId)?.status === 'waiting') return authSessions.get(activeAuthId); const id = crypto.randomUUID(); const session = { id, status: 'waiting', startedAt: new Date().toISOString(), completedAt: null, verificationUrl: null, userCode: null, error: null, output: [] }; authSessions.set(id, session); activeAuthId = id;
  const child = spawn('codex', ['login', '--device-auth'], { cwd: workRoot, env: { ...process.env, CODEX_HOME: codexHome }, stdio: ['ignore', 'pipe', 'pipe'] }); const timer = setTimeout(() => child.kill('SIGTERM'), 10 * 60 * 1000);
  const consume = stream => { let pending = ''; stream.on('data', chunk => { pending += chunk.toString('utf8'); const lines = pending.split(/\r?\n/); pending = lines.pop() || ''; for (const line of lines) { session.output.push(line); if (session.output.length > 100) session.output.shift(); const hints = parseAuthHints(line); session.verificationUrl ||= hints.verificationUrl; session.userCode ||= hints.userCode; } }); };
  consume(child.stdout); consume(child.stderr);
  child.on('error', error => { clearTimeout(timer); session.status = 'error'; session.error = error.message; session.completedAt = new Date().toISOString(); activeAuthId = null; });
  child.on('close', code => { clearTimeout(timer); if (session.status === 'waiting') session.status = code === 0 ? 'connected' : 'error'; if (code !== 0 && !session.error) session.error = `codex login exited with ${code}`; session.completedAt = new Date().toISOString(); activeAuthId = null; void processQueue(); });
  return session;
}

function publicAuth(session) { if (!session) return null; return { id: session.id, status: session.status, startedAt: session.startedAt, completedAt: session.completedAt, verificationUrl: session.verificationUrl, userCode: session.userCode, error: session.error, output: session.output }; }
function extractDocumentId(body) { for (const value of [body.document_id, body.doc_id, body.id]) { const n = Number(value); if (Number.isInteger(n) && n > 0) return n; } const text = String(body.doc_url || body.url || ''); const match = text.match(/\/documents\/(\d+)/); return match ? Number(match[1]) : null; }

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, queued: queue.length, workerRunning, toolVersion, pipelineVersion });
    if (!authorized(req)) return send(res, 401, { error: 'Unauthorized.' });
    if (req.method === 'GET' && url.pathname === '/status') { const [codex, paperless] = await Promise.all([codexStatus(), paperlessFetch('/api/documents/?page_size=1').then(() => ({ connected: true })).catch(error => ({ connected: false, error: error.message }))]); return send(res, 200, { codex, paperless, queued: queue.length, active: workerRunning, toolVersion, pipelineVersion, configuredModel: configuredModel || null, ocr: { minConfidence: ocrMinConfidence, replaceMode: ocrReplaceMode } }); }
    if (req.method === 'GET' && url.pathname === '/metadata') return send(res, 200, compactTaxonomy(await getTaxonomy()));
    if (req.method === 'GET' && url.pathname === '/provenance') return send(res, 200, provenance);
    const provMatch = url.pathname.match(/^\/documents\/(\d+)\/provenance$/); if (req.method === 'GET' && provMatch) return send(res, 200, provenance[String(Number(provMatch[1]))] || { latest: null, history: [] });
    if (req.method === 'POST' && url.pathname === '/auth/start') return send(res, 202, publicAuth(await startDeviceAuth()));
    const authMatch = url.pathname.match(/^\/auth\/([0-9a-f-]+)$/i); if (req.method === 'GET' && authMatch) { const session = authSessions.get(authMatch[1]); return session ? send(res, 200, publicAuth(session)) : send(res, 404, { error: 'Auth session not found.' }); }
    if (req.method === 'POST' && url.pathname === '/webhook/paperless') { const body = await readJson(req); const documentId = extractDocumentId(body); if (!documentId) return send(res, 400, { error: 'document_id/doc_id/doc_url is required.' }); await enqueue(documentId); return send(res, 202, { accepted: true, documentId }); }
    const scanMatch = url.pathname.match(/^\/documents\/(\d+)\/scan$/); if (req.method === 'POST' && scanMatch) { const documentId = Number(scanMatch[1]); await enqueue(documentId); return send(res, 202, { accepted: true, documentId }); }
    if (req.method === 'GET' && url.pathname === '/jobs') return send(res, 200, { queue, jobs: [...jobs.values()].slice(-100) });
    return send(res, 404, { error: 'Not found.' });
  } catch (error) { log('http', 'Request failed.', { error: String(error?.message || error) }); return send(res, 500, { error: String(error?.message || error) }); }
});

server.listen(port, '0.0.0.0', () => { log('server', `paperless-codex ${toolVersion} pipeline ${pipelineVersion} listening on ${port}`); if (queue.length) void processQueue(); });
