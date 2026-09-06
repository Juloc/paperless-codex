import { readFile, writeFile } from 'node:fs/promises';

const file = '/app/server.mjs';
let source = await readFile(file, 'utf8');

function replaceOnce(label, before, after) {
  if (!source.includes(before)) throw new Error(`Pipeline 22 patch failed: ${label} anchor not found`);
  source = source.replace(before, after);
}

replaceOnce(
  'maintenance state',
  "let metadataOperationProgress = {",
  "let maintenanceState = { active: false, kind: null, startedAt: null, finishedAt: null, queueWasPaused: false, error: null };\nlet metadataOperationProgress = {"
);

replaceOnce(
  'bulk public maintenance state',
  "  return { ...bulkScan, status: effectiveStatus, queuePaused, pendingQueue, remaining };",
  "  return { ...bulkScan, status: effectiveStatus, queuePaused, pendingQueue, remaining, maintenance: { ...maintenanceState } };"
);

replaceOnce(
  'metadata maintenance helpers',
  "function setMetadataProgress(kind, patch = {}) {",
  `async function beginMaintenance(kind) {
  if (maintenanceState.active) {
    throw new Error(\`Eine schwere Metadatenaktion läuft bereits: \${maintenanceState.kind}. Bitte erst diese Aktion beenden.\`);
  }
  const queueWasPaused = queuePaused;
  maintenanceState = {
    active: true,
    kind,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    queueWasPaused,
    error: null
  };
  if (queue.length && !queuePaused) {
    queuePaused = true;
    bulkScan.status = 'paused';
    bulkScan.maintenancePaused = true;
    await saveBulkState();
    log('maintenance', 'Scan queue auto-paused for metadata maintenance.', { kind, queued: queue.length });
  }
  return { ...maintenanceState };
}

async function endMaintenance(error = null) {
  const previous = { ...maintenanceState };
  maintenanceState = {
    active: false,
    kind: previous.kind,
    startedAt: previous.startedAt,
    finishedAt: new Date().toISOString(),
    queueWasPaused: previous.queueWasPaused,
    error: error ? String(error?.message || error) : null
  };

  if (queue.length && !previous.queueWasPaused) {
    queuePaused = false;
    bulkScan.status = 'running';
    bulkScan.maintenancePaused = false;
    await saveBulkState();
    log('maintenance', 'Scan queue resumed after metadata maintenance.', { kind: previous.kind, queued: queue.length });
    void processQueue();
  } else {
    bulkScan.maintenancePaused = false;
    await saveBulkState();
  }
}

async function runMaintenanceOperation(kind, operation) {
  await beginMaintenance(kind);
  try {
    return await operation();
  } catch (error) {
    await endMaintenance(error).catch(() => {});
    throw error;
  } finally {
    if (maintenanceState.active) await endMaintenance().catch(() => {});
  }
}

function setMetadataProgress(kind, patch = {}) {`
);

replaceOnce(
  'prevent manual resume during maintenance',
  "    if (req.method === 'POST' && url.pathname === '/bulk/resume') {\n      if (queue.length) { queuePaused = false; bulkScan.status = 'running'; await saveBulkState(); void processQueue(); }\n      return send(res, 200, bulkPublic());\n    }",
  "    if (req.method === 'POST' && url.pathname === '/bulk/resume') {\n      if (maintenanceState.active) return send(res, 409, { error: 'Scan-Queue ist wegen Metadatenpflege automatisch pausiert.', maintenance: { ...maintenanceState } });\n      if (queue.length) { queuePaused = false; bulkScan.status = 'running'; await saveBulkState(); void processQueue(); }\n      return send(res, 200, bulkPublic());\n    }"
);

replaceOnce(
  'wrap prune in maintenance lock',
  "    if (req.method === 'POST' && url.pathname === '/assistant/metadata/prune') return send(res, 200, await pruneUnusedMetadata(await readJson(req)));",
  "    if (req.method === 'POST' && url.pathname === '/assistant/metadata/prune') { const body = await readJson(req); return send(res, 200, await runMaintenanceOperation('prune', () => pruneUnusedMetadata(body))); }"
);

replaceOnce(
  'wrap merge in maintenance lock',
  "    if (req.method === 'POST' && url.pathname === '/assistant/metadata/merge') return send(res, 200, await mergeMetadata(await readJson(req)));",
  "    if (req.method === 'POST' && url.pathname === '/assistant/metadata/merge') { const body = await readJson(req); return send(res, 200, await runMaintenanceOperation('merge', () => mergeMetadata(body))); }"
);

replaceOnce(
  'smaller merge batches',
  "    const chunkSize = 200;",
  "    const chunkSize = 50;"
);

replaceOnce(
  'throttle merge batches',
  "        await paperlessJson('/api/documents/bulk_edit/', { method: 'POST', body: JSON.stringify(mergeBulkPayload(kind, chunk, target.id, sourceItem.id)) });\n        movedDocuments += chunk.length;",
  "        await paperlessJson('/api/documents/bulk_edit/', { method: 'POST', body: JSON.stringify(mergeBulkPayload(kind, chunk, target.id, sourceItem.id)) });\n        movedDocuments += chunk.length;\n        if (offset + chunk.length < documentIds.length || sourceIndex + 1 < sourcePlans.length) await new Promise(resolve => setTimeout(resolve, 1000));"
);

await writeFile(file, source);
