import { readFile, writeFile } from 'node:fs/promises';

const file = '/app/server.mjs';
let source = await readFile(file, 'utf8');

function replaceOnce(label, before, after) {
  if (!source.includes(before)) throw new Error(`Pipeline 3 patch failed: ${label} anchor not found`);
  source = source.replace(before, after);
}

replaceOnce(
  'runtime settings',
  "const provenanceTagsEnabled = !/^(0|false|no)$/i.test(process.env.PROVENANCE_TAGS || 'true');",
  "const provenanceTagsEnabled = !/^(0|false|no)$/i.test(process.env.PROVENANCE_TAGS || 'true');\nconst autoApplyConfidence = Math.max(minConfidence, Math.min(1, Number(process.env.AUTO_APPLY_CONFIDENCE || 0.80)));\nconst maxRetries = Math.max(0, Math.min(10, Number(process.env.MAX_RETRIES || 2)));\nconst retryDelayMs = Math.max(1000, Number(process.env.RETRY_DELAY_MS || 15000));"
);

replaceOnce(
  'enqueue pending status',
  "  void processQueue();\n}\n\nasync function processQueue()",
  "  await setDocumentStatusTag(documentId, 'Pending').catch(error => log('status', 'Could not set pending tag.', { documentId, error: String(error?.message || error) }));\n  void processQueue();\n}\n\nasync function processQueue()"
);

replaceOnce(
  'retry worker',
`async function processQueue() {
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
}`,
`async function processQueue() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    while (queue.length) {
      const documentId = Number(queue[0]);
      const job = jobs.get(documentId) || { documentId, queuedAt: null, attempt: 0 };
      job.attempt = Number(job.attempt || 0) + 1;
      Object.assign(job, { status: 'processing', startedAt: new Date().toISOString(), error: null, nextRetryAt: null });
      jobs.set(documentId, job);
      try {
        job.result = await scanPaperlessDocument(documentId);
        job.status = 'completed';
        job.finishedAt = new Date().toISOString();
        queue.shift();
        await saveQueue();
      } catch (error) {
        job.error = String(error?.message || error);
        if (job.attempt <= maxRetries) {
          const delay = retryDelayMs * Math.pow(2, job.attempt - 1);
          job.status = 'retrying';
          job.nextRetryAt = new Date(Date.now() + delay).toISOString();
          log('worker', 'Document scan failed; retry scheduled.', { documentId, attempt: job.attempt, maxRetries, delay, error: job.error });
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        job.status = 'failed';
        job.finishedAt = new Date().toISOString();
        log('worker', 'Document scan failed permanently.', { documentId, attempts: job.attempt, error: job.error });
        await setDocumentStatusTag(documentId, 'Failed').catch(tagError => log('status', 'Could not set failed tag.', { documentId, error: String(tagError?.message || tagError) }));
        queue.shift();
        await saveQueue();
      }
    }
  } finally {
    workerRunning = false;
  }
}`
);

replaceOnce(
  'status provenance prefix',
  "function provenancePrefix(name) { return /^(AI: Codex|AI Tool:|AI Pipeline:|AI Model:|AI CLI:|AI OCR:)/i.test(String(name || '')); }",
  "function provenancePrefix(name) { return /^(AI: Codex|AI Tool:|AI Pipeline:|AI Model:|AI CLI:|AI OCR:|AI Status:)/i.test(String(name || '')); }\n\nasync function setDocumentStatusTag(documentId, status) {\n  const taxonomy = await getTaxonomy();\n  const current = await paperlessJson(`/api/documents/${documentId}/`);\n  const colors = { Pending: '#b7791f', Processed: '#198754', Review: '#0d6efd', Failed: '#b02a37' };\n  const tag = await ensureTag(taxonomy, `AI Status: ${status}`, colors[status] || '#607d8b');\n  const ids = new Set(Array.isArray(current.tags) ? current.tags.map(Number) : []);\n  for (const existing of taxonomy.tags) if (/^AI Status:/i.test(String(existing.name || ''))) ids.delete(Number(existing.id));\n  ids.add(Number(tag.id));\n  await paperlessJson(`/api/documents/${documentId}/`, { method: 'PATCH', body: JSON.stringify({ tags: [...ids] }) });\n}"
);

replaceOnce(
  'processed or review provenance tag',
  "const names = ['AI: Codex', `AI Tool: paperless-codex ${toolVersion}`, `AI Pipeline: ${pipelineVersion}`, `AI Model: ${run.model}`, `AI CLI: ${run.codexVersion || 'unknown'}`, `AI OCR: ${run.ocrReplaced ? 'improved' : 'kept-existing'}`]; const created = [];",
  "const names = ['AI: Codex', `AI Tool: paperless-codex ${toolVersion}`, `AI Pipeline: ${pipelineVersion}`, `AI Model: ${run.model}`, `AI CLI: ${run.codexVersion || 'unknown'}`, `AI OCR: ${run.ocrReplaced ? 'improved' : 'kept-existing'}`, `AI Status: ${run.reviewRequired ? 'Review' : 'Processed'}`]; const created = [];"
);

replaceOnce(
  'review gate',
  "    const run = { runId: crypto.randomUUID(), startedAt, finishedAt: null, tool: 'paperless-codex', toolVersion, pipelineVersion, model: extraction.resolvedModel, codexVersion: status.codexVersion || null, confidence: Number(result.confidence), pagesScanned: pageInfo.images.length, totalPages: pageInfo.pages, inputSha256: crypto.createHash('sha256').update(document.bytes).digest('hex'), ocrReplaced: false, ocrConfidence: Number(result.ocrConfidence), ocrDecision: null, warnings: result.warnings || [] };\n    const applied = await applyResult(documentId, current, taxonomy, result, run);",
  "    const reviewRequired = Number(result.confidence) < autoApplyConfidence;\n    const reviewSuggestions = reviewRequired ? { title: result.title, created: result.created, correspondent: result.correspondent, recipient: result.recipient, documentType: result.documentType, tags: result.tags, storagePath: result.storagePath, customFields: result.customFields, summary: result.summary } : null;\n    if (reviewRequired) {\n      result.warnings ||= []; result.warnings.push(`Automatic metadata write-back skipped because confidence ${Number(result.confidence).toFixed(3)} is below AUTO_APPLY_CONFIDENCE=${autoApplyConfidence}.`);\n      result.title = null; result.created = null; result.correspondent = null; result.documentType = null; result.tags = []; result.storagePath = null; result.customFields = [];\n    }\n    const run = { runId: crypto.randomUUID(), startedAt, finishedAt: null, tool: 'paperless-codex', toolVersion, pipelineVersion, model: extraction.resolvedModel, codexVersion: status.codexVersion || null, confidence: Number(result.confidence), reviewRequired, reviewSuggestions, pagesScanned: pageInfo.images.length, totalPages: pageInfo.pages, inputSha256: crypto.createHash('sha256').update(document.bytes).digest('hex'), ocrReplaced: false, ocrConfidence: Number(result.ocrConfidence), ocrDecision: null, warnings: result.warnings || [] };\n    const applied = await applyResult(documentId, current, taxonomy, result, run);"
);

replaceOnce(
  'status response settings',
  "return send(res, 200, { codex, paperless, queued: queue.length, active: workerRunning, toolVersion, pipelineVersion, configuredModel: configuredModel || null, ocr: { minConfidence: ocrMinConfidence, replaceMode: ocrReplaceMode } });",
  "return send(res, 200, { codex, paperless, queued: queue.length, active: workerRunning, toolVersion, pipelineVersion, configuredModel: configuredModel || null, ocr: { minConfidence: ocrMinConfidence, replaceMode: ocrReplaceMode }, review: { autoApplyConfidence }, retry: { maxRetries, retryDelayMs } });"
);

await writeFile(file, source);
