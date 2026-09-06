import { readFile, writeFile } from 'node:fs/promises';

const file = '/app/server.mjs';
let source = await readFile(file, 'utf8');

function replaceOnce(label, before, after) {
  if (!source.includes(before)) throw new Error(`Pipeline 20 patch failed: ${label} anchor not found`);
  source = source.replace(before, after);
}

replaceOnce(
  'reconstruct and control restored queue',
  [
    "const bulkStatePath = path.join(stateDir, 'bulk.json');",
    "const persistedBulk = await loadJson(bulkStatePath, null);",
    "let bulkScan = persistedBulk?.scan || { status: 'idle', startedAt: null, finishedAt: null, total: 0, queued: 0, processed: 0, completed: 0, review: 0, failed: 0, skipped: 0, currentDocumentId: null, newestFirst: true };",
    "let bulkDocumentIds = new Set(Array.isArray(persistedBulk?.documentIds) ? persistedBulk.documentIds.map(Number).filter(Number.isInteger) : []);",
    "let metadataOperationProgress = {"
  ].join('\n'),
  [
    "const bulkStatePath = path.join(stateDir, 'bulk.json');",
    "const persistedBulk = await loadJson(bulkStatePath, null);",
    "let bulkScan = persistedBulk?.scan || { status: 'idle', startedAt: null, finishedAt: null, total: 0, queued: 0, processed: 0, completed: 0, review: 0, failed: 0, skipped: 0, currentDocumentId: null, newestFirst: true };",
    "let bulkDocumentIds = new Set(Array.isArray(persistedBulk?.documentIds) ? persistedBulk.documentIds.map(Number).filter(Number.isInteger) : []);",
    "let queuePaused = Boolean(persistedBulk?.queuePaused) || bulkScan.status === 'paused';",
    "const restoredQueueIds = queue.map(Number).filter(id => Number.isInteger(id) && id > 0);",
    "if (restoredQueueIds.length && !['running', 'paused'].includes(bulkScan.status)) {",
    "  bulkDocumentIds = new Set(restoredQueueIds);",
    "  bulkScan = {",
    "    status: queuePaused ? 'paused' : 'running',",
    "    startedAt: new Date().toISOString(),",
    "    finishedAt: null,",
    "    total: restoredQueueIds.length,",
    "    queued: restoredQueueIds.length,",
    "    processed: 0,",
    "    completed: 0,",
    "    review: 0,",
    "    failed: 0,",
    "    skipped: 0,",
    "    currentDocumentId: null,",
    "    newestFirst: true,",
    "    restored: true,",
    "    reconstructed: true",
    "  };",
    "} else if (restoredQueueIds.length && ['running', 'paused'].includes(bulkScan.status)) {",
    "  bulkScan.restored = true;",
    "  if (bulkScan.status === 'paused') queuePaused = true;",
    "}",
    "let metadataOperationProgress = {"
  ].join('\n')
);

replaceOnce(
  'persist queue pause state',
  "  await atomicWriteJson(bulkStatePath, { scan: bulkScan, documentIds: [...bulkDocumentIds] });",
  "  await atomicWriteJson(bulkStatePath, { scan: bulkScan, documentIds: [...bulkDocumentIds], queuePaused });"
);

replaceOnce(
  'bulk public queue truth',
  "function bulkPublic() {\n  return { ...bulkScan, remaining: Math.max(0, bulkScan.total - bulkScan.processed - bulkScan.skipped) };\n}",
  [
    "function bulkPublic() {",
    "  const pendingQueue = queue.length;",
    "  const remaining = Math.max(0, Number(bulkScan.total || 0) - Number(bulkScan.processed || 0) - Number(bulkScan.skipped || 0));",
    "  const effectiveStatus = pendingQueue && queuePaused ? 'paused' : bulkScan.status;",
    "  return { ...bulkScan, status: effectiveStatus, queuePaused, pendingQueue, remaining };",
    "}"
  ].join('\n')
);

replaceOnce(
  'start bulk unpauses queue',
  "async function startBulkScan({ skipCurrent = true } = {}) {\n  if (['running', 'paused'].includes(bulkScan.status)) throw new Error('A bulk scan is already active.');",
  "async function startBulkScan({ skipCurrent = true } = {}) {\n  if (queue.length || ['running', 'paused'].includes(bulkScan.status)) throw new Error('A scan queue is already active. Pause/cancel or let it finish first.');\n  queuePaused = false;"
);

const cancelStart = source.indexOf('async function cancelBulkScan() {');
const cancelEnd = source.indexOf('\n\nfunction paperlessHeaders', cancelStart);
if (cancelStart < 0 || cancelEnd < 0) throw new Error('Pipeline 20 patch failed: cancelBulkScan range not found');
const cancelReplacement = [
  "async function cancelBulkScan() {",
  "  const current = workerRunning && queue.length ? Number(queue[0]) : null;",
  "  const controlledIds = bulkDocumentIds.size ? new Set(bulkDocumentIds) : new Set(queue.map(Number));",
  "  let removed = 0;",
  "  for (let i = queue.length - 1; i >= 0; i--) {",
  "    const id = Number(queue[i]);",
  "    if (controlledIds.has(id) && id !== current) {",
  "      queue.splice(i, 1);",
  "      removed++;",
  "      const job = jobs.get(id);",
  "      if (job && !['completed', 'failed'].includes(job.status)) { job.status = 'cancelled'; job.finishedAt = new Date().toISOString(); }",
  "    }",
  "  }",
  "  queuePaused = false;",
  "  bulkScan.status = 'cancelled';",
  "  bulkScan.finishedAt = new Date().toISOString();",
  "  bulkScan.currentDocumentId = current || null;",
  "  bulkScan.cancelled = Number(bulkScan.cancelled || 0) + removed;",
  "  await saveQueue();",
  "  return bulkPublic();",
  "}"
].join('\n');
source = source.slice(0, cancelStart) + cancelReplacement + source.slice(cancelEnd);

replaceOnce(
  'global queue pause gate',
  "      while (bulkDocumentIds.has(documentId) && bulkScan.status === 'paused') await new Promise(resolve => setTimeout(resolve, 1000));",
  "      while (queuePaused && queue.length) await new Promise(resolve => setTimeout(resolve, 500));\n      if (!queue.length) break;"
);

replaceOnce(
  'queue control routes',
  "    if (req.method === 'POST' && url.pathname === '/bulk/pause') { if (bulkScan.status === 'running') bulkScan.status = 'paused'; await saveBulkState(); return send(res, 200, bulkPublic()); }\n    if (req.method === 'POST' && url.pathname === '/bulk/resume') { if (bulkScan.status === 'paused') { bulkScan.status = 'running'; await saveBulkState(); void processQueue(); } return send(res, 200, bulkPublic()); }",
  [
    "    if (req.method === 'POST' && url.pathname === '/bulk/pause') {",
    "      if (queue.length) { queuePaused = true; bulkScan.status = 'paused'; await saveBulkState(); }",
    "      return send(res, 200, bulkPublic());",
    "    }",
    "    if (req.method === 'POST' && url.pathname === '/bulk/resume') {",
    "      if (queue.length) { queuePaused = false; bulkScan.status = 'running'; await saveBulkState(); void processQueue(); }",
    "      return send(res, 200, bulkPublic());",
    "    }"
  ].join('\n')
);

replaceOnce(
  'jobs endpoint from persisted queue',
  "    if (req.method === 'GET' && url.pathname === '/jobs') return send(res, 200, { queue, jobs: [...jobs.values()].slice(-100) });",
  [
    "    if (req.method === 'GET' && url.pathname === '/jobs') {",
    "      const pending = queue.slice(0, 200).map((rawId, index) => {",
    "        const documentId = Number(rawId);",
    "        const existing = jobs.get(documentId);",
    "        if (existing) return existing;",
    "        return {",
    "          documentId,",
    "          status: queuePaused ? 'paused' : (index === 0 && workerRunning ? 'processing' : 'queued'),",
    "          attempt: 0,",
    "          source: bulkScan.restored ? 'fortgesetzt' : (bulkDocumentIds.has(documentId) ? 'bulk' : 'queue')",
    "        };",
    "      });",
    "      const pendingIds = new Set(pending.map(job => Number(job.documentId)));",
    "      const history = [...jobs.values()].filter(job => !pendingIds.has(Number(job.documentId))).slice(-40).reverse();",
    "      return send(res, 200, { queue: queue.slice(0, 200), queueTotal: queue.length, paused: queuePaused, jobs: [...pending, ...history] });",
    "    }"
  ].join('\n')
);

await writeFile(file, source);
