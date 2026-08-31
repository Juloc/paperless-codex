import { readFile, writeFile } from 'node:fs/promises';

const file = '/app/server.mjs';
let source = await readFile(file, 'utf8');

function replaceOnce(label, before, after) {
  if (!source.includes(before)) throw new Error(`Pipeline 4 patch failed: ${label} anchor not found`);
  source = source.replace(before, after);
}

replaceOnce(
  'bulk runtime state',
  "const authSessions = new Map();\nlet activeAuthId = null;",
  "const authSessions = new Map();\nlet activeAuthId = null;\nlet bulkScan = { status: 'idle', startedAt: null, finishedAt: null, total: 0, queued: 0, processed: 0, completed: 0, review: 0, failed: 0, skipped: 0, currentDocumentId: null, newestFirst: true };\nlet bulkDocumentIds = new Set();"
);

replaceOnce(
  'bulk helpers before headers',
  "function paperlessHeaders(json = false) {",
  `function bulkPublic() {
  return { ...bulkScan, remaining: Math.max(0, bulkScan.total - bulkScan.processed - bulkScan.skipped) };
}

function currentProvenanceMatches(documentId) {
  const latest = provenance[String(documentId)]?.latest;
  if (!latest) return false;
  if (String(latest.toolVersion || '') !== toolVersion) return false;
  if (String(latest.pipelineVersion || '') !== pipelineVersion) return false;
  if (configuredModel && String(latest.model || '') !== configuredModel) return false;
  return true;
}

async function startBulkScan({ skipCurrent = true } = {}) {
  if (['running', 'paused'].includes(bulkScan.status)) throw new Error('A bulk scan is already active.');
  const documents = await listAll('/api/documents/?ordering=-added');
  const ids = documents.map(x => Number(x.id)).filter(Number.isInteger);
  const selected = skipCurrent ? ids.filter(id => !currentProvenanceMatches(id)) : ids;
  const skipped = ids.length - selected.length;
  bulkDocumentIds = new Set(selected);
  bulkScan = { status: 'running', startedAt: new Date().toISOString(), finishedAt: null, total: ids.length, queued: selected.length, processed: 0, completed: 0, review: 0, failed: 0, skipped, currentDocumentId: null, newestFirst: true };
  for (const documentId of selected) {
    if (!queue.includes(documentId)) queue.push(documentId);
    if (!jobs.has(documentId)) jobs.set(documentId, { documentId, status: 'queued', queuedAt: new Date().toISOString(), startedAt: null, finishedAt: null, error: null, result: null, attempt: 0, bulk: true });
  }
  await saveQueue();
  void processQueue();
  return bulkPublic();
}

async function cancelBulkScan() {
  if (!['running', 'paused'].includes(bulkScan.status)) return bulkPublic();
  const current = bulkScan.currentDocumentId;
  for (let i = queue.length - 1; i >= 0; i--) {
    const id = Number(queue[i]);
    if (bulkDocumentIds.has(id) && id !== current) queue.splice(i, 1);
  }
  await saveQueue();
  bulkScan.status = 'cancelled';
  bulkScan.finishedAt = new Date().toISOString();
  bulkScan.currentDocumentId = current || null;
  return bulkPublic();
}

function paperlessHeaders(json = false) {`
);

replaceOnce(
  'pause bulk worker',
  "      const documentId = Number(queue[0]);\n      const job = jobs.get(documentId) || { documentId, queuedAt: null, attempt: 0 };",
  "      const documentId = Number(queue[0]);\n      while (bulkDocumentIds.has(documentId) && bulkScan.status === 'paused') await new Promise(resolve => setTimeout(resolve, 1000));\n      const job = jobs.get(documentId) || { documentId, queuedAt: null, attempt: 0 };\n      if (bulkDocumentIds.has(documentId)) bulkScan.currentDocumentId = documentId;"
);

replaceOnce(
  'bulk success counters',
  "        job.status = 'completed';\n        job.finishedAt = new Date().toISOString();\n        queue.shift();",
  "        job.status = 'completed';\n        job.finishedAt = new Date().toISOString();\n        if (bulkDocumentIds.has(documentId)) { bulkScan.processed++; if (job.result?.reviewRequired) bulkScan.review++; else bulkScan.completed++; bulkScan.currentDocumentId = null; }\n        queue.shift();"
);

replaceOnce(
  'bulk failure counters',
  "        await setDocumentStatusTag(documentId, 'Failed').catch(tagError => log('status', 'Could not set failed tag.', { documentId, error: String(tagError?.message || tagError) }));\n        queue.shift();",
  "        await setDocumentStatusTag(documentId, 'Failed').catch(tagError => log('status', 'Could not set failed tag.', { documentId, error: String(tagError?.message || tagError) }));\n        if (bulkDocumentIds.has(documentId)) { bulkScan.processed++; bulkScan.failed++; bulkScan.currentDocumentId = null; }\n        queue.shift();"
);

replaceOnce(
  'bulk finish worker',
  "  } finally {\n    workerRunning = false;\n  }\n}\n\nfunction bulkPublic()",
  "  } finally {\n    workerRunning = false;\n    if (bulkScan.status === 'running' && bulkScan.processed + bulkScan.skipped >= bulkScan.total) { bulkScan.status = 'completed'; bulkScan.finishedAt = new Date().toISOString(); bulkScan.currentDocumentId = null; }\n  }\n}\n\nfunction bulkPublic()"
);

replaceOnce(
  'return review flag',
  "return { confidence: result.confidence, ocrConfidence: result.ocrConfidence, ocrReplaced: run.ocrReplaced, ocrDecision: run.ocrDecision, model: run.model, toolVersion, pipelineVersion, codexVersion: run.codexVersion, pagesScanned: pageInfo.images.length, totalPages: pageInfo.pages, warnings: result.warnings || [], recipient: result.recipient || null, appliedCustomFields: applied.appliedCustomFields, provenanceTags: applied.provenanceTags, patch: applied.patch };",
  "return { confidence: result.confidence, reviewRequired: Boolean(run.reviewRequired), ocrConfidence: result.ocrConfidence, ocrReplaced: run.ocrReplaced, ocrDecision: run.ocrDecision, model: run.model, toolVersion, pipelineVersion, codexVersion: run.codexVersion, pagesScanned: pageInfo.images.length, totalPages: pageInfo.pages, warnings: result.warnings || [], recipient: result.recipient || null, appliedCustomFields: applied.appliedCustomFields, provenanceTags: applied.provenanceTags, patch: applied.patch };"
);

replaceOnce(
  'bulk routes',
  "    if (req.method === 'GET' && url.pathname === '/jobs') return send(res, 200, { queue, jobs: [...jobs.values()].slice(-100) });",
  `    if (req.method === 'GET' && url.pathname === '/bulk/status') return send(res, 200, bulkPublic());
    if (req.method === 'POST' && url.pathname === '/bulk/start') { const body = await readJson(req); return send(res, 202, await startBulkScan({ skipCurrent: body.skipCurrent !== false })); }
    if (req.method === 'POST' && url.pathname === '/bulk/pause') { if (bulkScan.status === 'running') bulkScan.status = 'paused'; return send(res, 200, bulkPublic()); }
    if (req.method === 'POST' && url.pathname === '/bulk/resume') { if (bulkScan.status === 'paused') { bulkScan.status = 'running'; void processQueue(); } return send(res, 200, bulkPublic()); }
    if (req.method === 'POST' && url.pathname === '/bulk/cancel') return send(res, 200, await cancelBulkScan());
    if (req.method === 'GET' && url.pathname === '/jobs') return send(res, 200, { queue, jobs: [...jobs.values()].slice(-100) });`
);

await writeFile(file, source);
