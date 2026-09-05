import { readFile, writeFile } from 'node:fs/promises';

const file = '/app/server.mjs';
let source = await readFile(file, 'utf8');

function block(lines) {
  return lines.join('\n');
}

function replaceOnce(label, before, after) {
  if (!source.includes(before)) throw new Error(`Pipeline 10 patch failed: ${label} anchor not found`);
  source = source.replace(before, after);
}

replaceOnce(
  'result compatibility and queue pacing settings',
  "const maxNewSemanticTags = Math.max(0, Math.min(3, Number(process.env.MAX_NEW_SEMANTIC_TAGS || 2)));",
  block([
    "const maxNewSemanticTags = Math.max(0, Math.min(3, Number(process.env.MAX_NEW_SEMANTIC_TAGS || 2)));",
    "const resultCompatibilityVersion = String(process.env.RESULT_COMPATIBILITY_VERSION || '9').trim() || '9';",
    "const queueInterScanDelayMs = Math.max(0, Math.min(60000, Number(process.env.QUEUE_INTER_SCAN_DELAY_MS || 3000)));"
  ])
);

replaceOnce(
  'queue pacing runtime state',
  "let bulkDocumentIds = new Set();",
  "let bulkDocumentIds = new Set();\nlet lastQueueItemFinishedAt = 0;"
);

replaceOnce(
  'result compatibility skip semantics',
  block([
    "function currentProvenanceMatches(documentId) {",
    "  const latest = provenance[String(documentId)]?.latest;",
    "  if (!latest) return false;",
    "  if (String(latest.toolVersion || '') !== toolVersion) return false;",
    "  if (String(latest.pipelineVersion || '') !== pipelineVersion) return false;",
    "  if (configuredModel && String(latest.model || '') !== configuredModel) return false;",
    "  return true;",
    "}"
  ]),
  block([
    "function currentProvenanceMatches(documentId) {",
    "  const latest = provenance[String(documentId)]?.latest;",
    "  if (!latest) return false;",
    "  const latestCompatibility = String(latest.resultCompatibilityVersion || latest.pipelineVersion || '');",
    "  if (latestCompatibility !== resultCompatibilityVersion) return false;",
    "  if (configuredModel && String(latest.model || '') !== configuredModel) return false;",
    "  return true;",
    "}"
  ])
);

replaceOnce(
  'pace queue between completed scans',
  block([
    "      const documentId = Number(queue[0]);",
    "      while (bulkDocumentIds.has(documentId) && bulkScan.status === 'paused') await new Promise(resolve => setTimeout(resolve, 1000));",
    "      const job = jobs.get(documentId) || { documentId, queuedAt: null, attempt: 0 };"
  ]),
  block([
    "      const documentId = Number(queue[0]);",
    "      while (bulkDocumentIds.has(documentId) && bulkScan.status === 'paused') await new Promise(resolve => setTimeout(resolve, 1000));",
    "      if (lastQueueItemFinishedAt > 0 && queueInterScanDelayMs > 0) {",
    "        const remainingDelay = queueInterScanDelayMs - (Date.now() - lastQueueItemFinishedAt);",
    "        if (remainingDelay > 0) await new Promise(resolve => setTimeout(resolve, remainingDelay));",
    "      }",
    "      const job = jobs.get(documentId) || { documentId, queuedAt: null, attempt: 0 };"
  ])
);

replaceOnce(
  'mark queue completion after successful scan',
  block([
    "        queue.shift();",
    "        await saveQueue();",
    "      } catch (error) {"
  ]),
  block([
    "        queue.shift();",
    "        await saveQueue();",
    "        lastQueueItemFinishedAt = Date.now();",
    "      } catch (error) {"
  ])
);

replaceOnce(
  'mark queue completion after permanent failure',
  block([
    "        queue.shift();",
    "        await saveQueue();",
    "      }",
    "    }"
  ]),
  block([
    "        queue.shift();",
    "        await saveQueue();",
    "        lastQueueItemFinishedAt = Date.now();",
    "      }",
    "    }"
  ])
);

replaceOnce(
  'record result compatibility in provenance',
  "toolVersion, pipelineVersion, model: extraction.resolvedModel",
  "toolVersion, pipelineVersion, resultCompatibilityVersion, model: extraction.resolvedModel"
);

replaceOnce(
  'diagnostic OCR scan logging',
  "    log('scan', 'Document scanned and updated.', { documentId, confidence: result.confidence, pages: pageInfo.images.length, model: run.model, pipelineVersion, ocrReplaced: run.ocrReplaced, ocrDecision: run.ocrDecision });",
  "    log('scan', 'Document scanned and updated.', { documentId, confidence: result.confidence, pages: pageInfo.images.length, model: run.model, pipelineVersion, resultCompatibilityVersion, ocrReplaced: run.ocrReplaced, ocrDecision: run.ocrDecision, ocrMetrics: run.ocrDecision === 'Candidate OCR failed plausibility checks' ? { existing: run.oldOcr, candidate: run.newOcr } : undefined });"
);

replaceOnce(
  'return result compatibility',
  "model: run.model, toolVersion, pipelineVersion, codexVersion: run.codexVersion",
  "model: run.model, toolVersion, pipelineVersion, resultCompatibilityVersion, codexVersion: run.codexVersion"
);

await writeFile(file, source);
