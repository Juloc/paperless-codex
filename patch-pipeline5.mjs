import { readFile, writeFile } from 'node:fs/promises';

const file = '/app/server.mjs';
let source = await readFile(file, 'utf8');

function replaceOnce(label, before, after) {
  if (!source.includes(before)) throw new Error(`Pipeline 5 patch failed: ${label} anchor not found`);
  source = source.replace(before, after);
}

replaceOnce(
  'discovery state path',
  "const provenancePath = path.join(stateDir, 'provenance.json');\nconst backupDir = path.join(stateDir, 'ocr-backups');",
  "const provenancePath = path.join(stateDir, 'provenance.json');\nconst discoveryStatePath = path.join(stateDir, 'discovery.json');\nconst backupDir = path.join(stateDir, 'ocr-backups');"
);

replaceOnce(
  'discovery runtime settings',
  "const retryDelayMs = Math.max(1000, Number(process.env.RETRY_DELAY_MS || 15000));",
  "const retryDelayMs = Math.max(1000, Number(process.env.RETRY_DELAY_MS || 15000));\nconst autoDiscoveryEnabled = !/^(0|false|no)$/i.test(process.env.AUTO_DISCOVERY || 'true');\nconst discoveryIntervalMs = Math.max(5000, Number(process.env.DISCOVERY_INTERVAL_MS || 60000));\nconst discoveryPageSize = Math.max(10, Math.min(1000, Number(process.env.DISCOVERY_PAGE_SIZE || 200)));"
);

replaceOnce(
  'load discovery state',
  "const provenance = await loadJson(provenancePath, {});\nconst jobs = new Map();",
  "const provenance = await loadJson(provenancePath, {});\nlet discoveryState = await loadJson(discoveryStatePath, { initialized: false, lastSeenDocumentId: 0, lastPollAt: null, lastSuccessAt: null, lastError: null, queuedLastPoll: 0, totalQueued: 0 });\nconst jobs = new Map();\nlet discoveryPolling = false;\nlet discoveryTimer = null;"
);

replaceOnce(
  'save discovery state',
  "async function saveProvenance() {\n  await atomicWriteJson(provenancePath, provenance);\n}",
  "async function saveProvenance() {\n  await atomicWriteJson(provenancePath, provenance);\n}\n\nasync function saveDiscoveryState() {\n  await atomicWriteJson(discoveryStatePath, discoveryState);\n}"
);

replaceOnce(
  'discovery helpers',
  "async function startBulkScan({ skipCurrent = true } = {}) {",
  `function discoveryPublic() {
  return {
    enabled: autoDiscoveryEnabled,
    intervalMs: discoveryIntervalMs,
    pageSize: discoveryPageSize,
    initialized: Boolean(discoveryState.initialized),
    lastSeenDocumentId: Number(discoveryState.lastSeenDocumentId || 0),
    lastPollAt: discoveryState.lastPollAt || null,
    lastSuccessAt: discoveryState.lastSuccessAt || null,
    lastError: discoveryState.lastError || null,
    queuedLastPoll: Number(discoveryState.queuedLastPoll || 0),
    totalQueued: Number(discoveryState.totalQueued || 0),
    polling: discoveryPolling
  };
}

async function fetchDiscoveryDocuments(lastSeenDocumentId) {
  const body = await paperlessJson(\`/api/documents/?ordering=-added&page_size=\${discoveryPageSize}\`);
  let documents = Array.isArray(body) ? body : (body.results || []);
  const visibleIds = documents.map(x => Number(x.id)).filter(Number.isInteger);
  const pageCouldHideOlderNewDocuments =
    lastSeenDocumentId > 0 &&
    documents.length >= discoveryPageSize &&
    visibleIds.length > 0 &&
    visibleIds.every(id => id > lastSeenDocumentId);

  if (pageCouldHideOlderNewDocuments) {
    log('discovery', 'More new documents than discovery page size; expanding scan to avoid gaps.', { lastSeenDocumentId, discoveryPageSize });
    documents = await listAll('/api/documents/?ordering=-added');
  }
  return documents;
}

async function pollDiscovery() {
  if (!autoDiscoveryEnabled || discoveryPolling) return discoveryPublic();
  discoveryPolling = true;
  const now = new Date().toISOString();
  discoveryState.lastPollAt = now;
  try {
    const lastSeen = Number(discoveryState.lastSeenDocumentId || 0);
    const documents = await fetchDiscoveryDocuments(lastSeen);
    const ids = documents.map(x => Number(x.id)).filter(Number.isInteger);
    const newestId = ids.length ? Math.max(...ids) : lastSeen;

    if (!discoveryState.initialized) {
      discoveryState = {
        initialized: true,
        lastSeenDocumentId: newestId,
        lastPollAt: now,
        lastSuccessAt: now,
        lastError: null,
        queuedLastPoll: 0,
        totalQueued: Number(discoveryState.totalQueued || 0)
      };
      await saveDiscoveryState();
      log('discovery', 'Initialized discovery baseline without scanning existing documents.', { lastSeenDocumentId: newestId });
      return discoveryPublic();
    }

    const candidates = documents
      .filter(x => Number(x.id) > lastSeen)
      .sort((a, b) => Number(a.id) - Number(b.id));

    let queuedNow = 0;
    let insertAt = workerRunning && queue.length ? 1 : 0;
    for (const document of candidates) {
      const documentId = Number(document.id);
      if (!Number.isInteger(documentId) || currentProvenanceMatches(documentId) || queue.includes(documentId)) continue;
      queue.splice(insertAt, 0, documentId);
      insertAt++;
      jobs.set(documentId, {
        documentId,
        status: 'queued',
        queuedAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        error: null,
        result: null,
        attempt: 0,
        source: 'discovery'
      });
      queuedNow++;
      await setDocumentStatusTag(documentId, 'Pending').catch(error => log('discovery', 'Could not set pending tag for discovered document.', { documentId, error: String(error?.message || error) }));
    }

    if (queuedNow) await saveQueue();
    discoveryState.lastSeenDocumentId = Math.max(lastSeen, newestId);
    discoveryState.lastSuccessAt = new Date().toISOString();
    discoveryState.lastError = null;
    discoveryState.queuedLastPoll = queuedNow;
    discoveryState.totalQueued = Number(discoveryState.totalQueued || 0) + queuedNow;
    await saveDiscoveryState();

    if (queuedNow) {
      log('discovery', 'Queued newly added Paperless documents.', { count: queuedNow, lastSeenDocumentId: discoveryState.lastSeenDocumentId });
      if (workerRunning) {
        void processQueue();
      } else {
        const status = await codexStatus().catch(error => ({ connected: false, statusText: String(error?.message || error) }));
        if (status.connected) void processQueue();
        else log('discovery', 'New documents are queued and will wait for Codex login.', { count: queuedNow });
      }
    }
    return discoveryPublic();
  } catch (error) {
    discoveryState.lastError = String(error?.message || error);
    discoveryState.queuedLastPoll = 0;
    await saveDiscoveryState().catch(() => {});
    log('discovery', 'Automatic discovery poll failed.', { error: discoveryState.lastError });
    return discoveryPublic();
  } finally {
    discoveryPolling = false;
  }
}

function startDiscoveryLoop() {
  if (!autoDiscoveryEnabled || discoveryTimer) return;
  void pollDiscovery();
  discoveryTimer = setInterval(() => { void pollDiscovery(); }, discoveryIntervalMs);
  discoveryTimer.unref?.();
}

async function startBulkScan({ skipCurrent = true } = {}) {`
);

replaceOnce(
  'status discovery',
  "return send(res, 200, { codex, paperless, queued: queue.length, active: workerRunning, toolVersion, pipelineVersion, configuredModel: configuredModel || null, ocr: { minConfidence: ocrMinConfidence, replaceMode: ocrReplaceMode }, review: { autoApplyConfidence }, retry: { maxRetries, retryDelayMs } });",
  "return send(res, 200, { codex, paperless, queued: queue.length, active: workerRunning, toolVersion, pipelineVersion, configuredModel: configuredModel || null, ocr: { minConfidence: ocrMinConfidence, replaceMode: ocrReplaceMode }, review: { autoApplyConfidence }, retry: { maxRetries, retryDelayMs }, discovery: discoveryPublic() });"
);

replaceOnce(
  'discovery routes',
  "    if (req.method === 'GET' && url.pathname === '/bulk/status') return send(res, 200, bulkPublic());",
  "    if (req.method === 'GET' && url.pathname === '/discovery/status') return send(res, 200, discoveryPublic());\n    if (req.method === 'POST' && url.pathname === '/discovery/poll') return send(res, 200, await pollDiscovery());\n    if (req.method === 'GET' && url.pathname === '/bulk/status') return send(res, 200, bulkPublic());"
);

replaceOnce(
  'start discovery loop',
  "server.listen(port, '0.0.0.0', () => { log('server', `paperless-codex ${toolVersion} pipeline ${pipelineVersion} listening on ${port}`); if (queue.length) void processQueue(); });",
  "server.listen(port, '0.0.0.0', () => { log('server', `paperless-codex ${toolVersion} pipeline ${pipelineVersion} listening on ${port}`); if (queue.length) void processQueue(); startDiscoveryLoop(); });"
);

await writeFile(file, source);
