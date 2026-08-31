import { readFile, writeFile } from 'node:fs/promises';

const file = '/app/server.mjs';
let source = await readFile(file, 'utf8');

function block(lines) {
  return lines.join('\n');
}

function replaceOnce(label, before, after) {
  if (!source.includes(before)) throw new Error(`Pipeline 6 patch failed: ${label} anchor not found`);
  source = source.replace(before, after);
}

function replaceRange(label, start, end, replacement) {
  const from = source.indexOf(start);
  if (from < 0) throw new Error(`Pipeline 6 patch failed: ${label} start anchor not found`);
  const to = source.indexOf(end, from);
  if (to < 0) throw new Error(`Pipeline 6 patch failed: ${label} end anchor not found`);
  source = source.slice(0, from) + replacement + '\n\n' + source.slice(to);
}

replaceOnce(
  'pipeline 6 settings',
  "const discoveryPageSize = Math.max(10, Math.min(1000, Number(process.env.DISCOVERY_PAGE_SIZE || 200)));",
  "const discoveryPageSize = Math.max(10, Math.min(1000, Number(process.env.DISCOVERY_PAGE_SIZE || 200)));\nconst usageLimitRetryMs = Math.max(60000, Number(process.env.USAGE_LIMIT_RETRY_MS || 1800000));\nconst provenanceCustomFieldEnabled = !/^(0|false|no)$/i.test(process.env.PROVENANCE_CUSTOM_FIELD || 'true');\nconst provenanceFieldName = String(process.env.PROVENANCE_FIELD_NAME || 'AI Provenienz').trim().slice(0, 128) || 'AI Provenienz';"
);

replaceOnce(
  'usage runtime state',
  'let discoveryTimer = null;',
  "let discoveryTimer = null;\nlet usageLimitState = { paused: false, detectedAt: null, retryAt: null, lastError: null };\nlet legacyToolTagsCleaned = false;\nlet legacyDeletedTagIds = new Set();"
);

replaceRange(
  'ocr quality logic',
  'function textMetrics(value) {',
  'async function backupExistingOcr(documentId, currentContent) {',
  block([
    'function textMetrics(value) {',
    "  const text = String(value || '').trim();",
    '  if (!text) return { length: 0, words: 0, score: 0, suspiciousRatio: 1, singleCharRatio: 1, noiseRatio: 1, shortLineRatio: 1 };',
    "  const words = text.match(/[\\p{L}\\p{N}][\\p{L}\\p{N}._\\/@:+-]*/gu) || [];",
    "  const lettersDigits = (text.match(/[\\p{L}\\p{N}]/gu) || []).length;",
    "  const suspicious = (text.match(/[�□■]|\\?\\?\\?|\\[unleserlich\\]/giu) || []).length;",
    '  const suspiciousRatio = suspicious / Math.max(1, words.length);',
    "  const singleChars = words.filter(word => word.length === 1 && !/^\\d$/.test(word)).length;",
    '  const singleCharRatio = singleChars / Math.max(1, words.length);',
    "  const noise = (text.match(/[^\\p{L}\\p{N}\\p{P}\\p{Z}\\r\\n\\t]/gu) || []).length;",
    '  const noiseRatio = noise / Math.max(1, text.length);',
    "  const lines = text.split(/\\r?\\n/).map(line => line.trim()).filter(Boolean);",
    '  const shortLineRatio = lines.filter(line => line.length <= 2).length / Math.max(1, lines.length);',
    '  const usefulRatio = lettersDigits / Math.max(1, text.length);',
    "  const unique = new Set(words.map(x => x.toLocaleLowerCase('de-DE'))).size;",
    '  const diversity = unique / Math.max(1, words.length);',
    '  const score = Math.max(0, Math.min(1,',
    '    usefulRatio * 0.38 +',
    '    Math.min(1, words.length / 80) * 0.22 +',
    '    Math.min(1, diversity * 1.8) * 0.18 +',
    '    Math.max(0, 1 - suspiciousRatio * 8) * 0.08 +',
    '    Math.max(0, 1 - singleCharRatio * 4) * 0.07 +',
    '    Math.max(0, 1 - shortLineRatio * 4) * 0.07',
    '  ));',
    '  return { length: text.length, words: words.length, score, suspiciousRatio, singleCharRatio, noiseRatio, shortLineRatio };',
    '}',
    '',
    'function decideOcrReplacement(existingText, candidateText, ocrConfidence) {',
    '  const oldMetrics = textMetrics(existingText);',
    '  const newMetrics = textMetrics(candidateText);',
    '  const confidence = Number(ocrConfidence);',
    "  if (!writeContent) return { replace: false, reason: 'WRITE_CONTENT=false', oldMetrics, newMetrics };",
    '  if (!Number.isFinite(confidence) || confidence < ocrMinConfidence) return { replace: false, reason: `OCR confidence below ${ocrMinConfidence}`, oldMetrics, newMetrics };',
    "  if (newMetrics.length < 40 || newMetrics.words < 5 || newMetrics.suspiciousRatio > 0.08 || newMetrics.noiseRatio > 0.03) return { replace: false, reason: 'Candidate OCR failed plausibility checks', oldMetrics, newMetrics };",
    "  if (ocrReplaceMode === 'always') return { replace: true, reason: 'OCR_REPLACE_MODE=always', oldMetrics, newMetrics };",
    "  if (!oldMetrics.length || oldMetrics.words < 5) return { replace: true, reason: 'Existing OCR is empty/very weak', oldMetrics, newMetrics };",
    '',
    '  const existingClearlyBroken =',
    '    oldMetrics.score < 0.58 ||',
    '    oldMetrics.suspiciousRatio > 0.01 ||',
    '    oldMetrics.singleCharRatio > 0.10 ||',
    '    oldMetrics.noiseRatio > 0.015 ||',
    '    oldMetrics.shortLineRatio > 0.12;',
    '  const candidateHealthy =',
    '    newMetrics.score >= 0.58 &&',
    '    newMetrics.singleCharRatio < 0.10 &&',
    '    newMetrics.noiseRatio < 0.02 &&',
    '    newMetrics.shortLineRatio < 0.12;',
    '',
    '  if (existingClearlyBroken && candidateHealthy) {',
    "    return { replace: true, reason: 'Existing Paperless OCR appears corrupted; healthy Codex OCR preferred', oldMetrics, newMetrics };",
    '  }',
    '',
    '  const materiallyBetter = newMetrics.score >= oldMetrics.score + 0.025;',
    '  const comparableButMoreComplete = newMetrics.score >= oldMetrics.score - 0.03 && newMetrics.length >= Math.max(60, oldMetrics.length * 0.60) && newMetrics.words >= oldMetrics.words * 0.65;',
    "  return { replace: materiallyBetter || comparableButMoreComplete, reason: materiallyBetter ? 'Codex OCR quality score is better' : (comparableButMoreComplete ? 'Codex OCR is comparable and sufficiently complete' : 'Existing OCR kept'), oldMetrics, newMetrics };",
    '}'
  ])
);

replaceRange(
  'provenance custom field',
  'function provenancePrefix(name) {',
  'async function applyResult(documentId, current, taxonomy, result, run) {',
  block([
    "function provenancePrefix(name) { return /^(AI: Codex|AI Tool:|AI Pipeline:|AI Model:|AI CLI:|AI OCR:|AI Status:)/i.test(String(name || '')); }",
    '',
    'async function ensureProvenanceCustomField(taxonomy) {',
    '  if (!provenanceCustomFieldEnabled) return null;',
    '  const existing = taxonomy.customFields.find(field => normalizeName(field.name) === normalizeName(provenanceFieldName));',
    '  if (existing) return existing;',
    "  const created = await paperlessJson('/api/custom_fields/', { method: 'POST', body: JSON.stringify({ name: provenanceFieldName, data_type: 'string' }) });",
    '  taxonomy.customFields.push(created);',
    "  log('provenance', 'Created Paperless provenance custom field.', { id: created.id, name: created.name });",
    '  return created;',
    '}',
    '',
    'function provenanceValue(run, statusOverride = null) {',
    "  const status = String(statusOverride || (run?.reviewRequired ? 'review' : 'processed')).toLowerCase();",
    "  const model = String(run?.model || configuredModel || 'account-default').replace(/\\s+/g, '-');",
    "  const cli = String(run?.codexVersion || 'unknown').replace(/^codex-cli\\s*/i, '').replace(/\\s+/g, '-');",
    "  const ocr = run ? (run.ocrReplaced ? 'improved' : 'kept') : 'pending';",
    "  const confidence = Number.isFinite(Number(run?.confidence)) ? Number(run.confidence).toFixed(2) : '-';",
    "  const stamp = String(run?.finishedAt || run?.startedAt || new Date().toISOString()).replace(/[-:]/g, '').replace(/\\.\\d+Z$/, 'Z');",
    "  const hash = String(run?.inputSha256 || '').slice(0, 8) || '-';",
    '  return `pc=${toolVersion};p=${pipelineVersion};m=${model};cli=${cli};ocr=${ocr};st=${status};c=${confidence};at=${stamp};h=${hash}`.slice(0, 128);',
    '}',
    '',
    'async function cleanupLegacyToolTags(taxonomy) {',
    '  if (legacyToolTagsCleaned) return legacyDeletedTagIds;',
    '  const legacy = taxonomy.tags.filter(tag => provenancePrefix(tag.name));',
    '  legacyDeletedTagIds = new Set(legacy.map(tag => Number(tag.id)));',
    '  for (const tag of legacy) {',
    "    await paperlessFetch(`/api/tags/${Number(tag.id)}/`, { method: 'DELETE' }).catch(error => log('provenance', 'Could not delete legacy tool tag.', { tag: tag.name, id: tag.id, error: String(error?.message || error) }));",
    '  }',
    '  if (legacy.length) taxonomy.tags = taxonomy.tags.filter(tag => !provenancePrefix(tag.name));',
    '  legacyToolTagsCleaned = true;',
    "  if (legacy.length) log('provenance', 'Removed legacy technical AI tags from Paperless.', { count: legacy.length });",
    '  return legacyDeletedTagIds;',
    '}',
    '',
    'function withProvenanceField(currentFields, field, value) {',
    '  const values = new Map();',
    '  for (const item of Array.isArray(currentFields) ? currentFields : []) {',
    '    const id = Number(item?.field);',
    '    if (Number.isInteger(id)) values.set(id, { field: id, value: item.value ?? null });',
    '  }',
    '  if (field) values.set(Number(field.id), { field: Number(field.id), value });',
    '  return [...values.values()];',
    '}',
    '',
    'async function setDocumentStatusTag(documentId, status) {',
    '  const taxonomy = await getTaxonomy();',
    '  await cleanupLegacyToolTags(taxonomy);',
    '  const current = await paperlessJson(`/api/documents/${documentId}/`);',
    '  const field = await ensureProvenanceCustomField(taxonomy);',
    '  if (!field) return;',
    '  const customFields = withProvenanceField(current.custom_fields, field, provenanceValue(null, status));',
    "  await paperlessJson(`/api/documents/${documentId}/`, { method: 'PATCH', body: JSON.stringify({ custom_fields: customFields }) });",
    '}',
    '',
    'async function applyProvenanceTags(current, taxonomy, semanticTagIds, run) {',
    '  const legacyIds = await cleanupLegacyToolTags(taxonomy);',
    '  const existingIds = new Set(Array.isArray(current.tags) ? current.tags.map(Number).filter(id => !legacyIds.has(id)) : []);',
    '  for (const id of semanticTagIds) existingIds.add(Number(id));',
    '  const field = await ensureProvenanceCustomField(taxonomy);',
    '  return { ids: [...existingIds], tags: [], field };',
    '}'
  ])
);

replaceOnce(
  'write provenance field',
  block([
    '  const merged = mergeCustomFields(current, taxonomy, result.customFields); if (merged.applied.length) patch.custom_fields = merged.customFields;',
    '  const ocrDecision = decideOcrReplacement(current.content, result.fullText, result.ocrConfidence); run.ocrReplaced = ocrDecision.replace; run.ocrDecision = ocrDecision.reason; run.ocrConfidence = Number(result.ocrConfidence); run.oldOcr = ocrDecision.oldMetrics; run.newOcr = ocrDecision.newMetrics;',
    '  if (ocrDecision.replace) { run.ocrBackup = await backupExistingOcr(documentId, current.content); patch.content = String(result.fullText).trim(); }',
    '  const provenanceTags = await applyProvenanceTags(current, taxonomy, semanticTagIds, run); if (provenanceTags?.ids?.length) patch.tags = provenanceTags.ids; else { const tagIds = new Set(Array.isArray(current.tags) ? current.tags.map(Number) : []); for (const id of semanticTagIds) tagIds.add(id); if (tagIds.size) patch.tags = [...tagIds]; }',
    "  await paperlessJson(`/api/documents/${documentId}/`, { method: 'PATCH', body: JSON.stringify(patch) });",
    '  return { patch, appliedCustomFields: merged.applied, recipient: result.recipient || null, ocr: ocrDecision, provenanceTags: provenanceTags?.tags || [] };'
  ]),
  block([
    '  const merged = mergeCustomFields(current, taxonomy, result.customFields);',
    '  const ocrDecision = decideOcrReplacement(current.content, result.fullText, result.ocrConfidence); run.ocrReplaced = ocrDecision.replace; run.ocrDecision = ocrDecision.reason; run.ocrConfidence = Number(result.ocrConfidence); run.oldOcr = ocrDecision.oldMetrics; run.newOcr = ocrDecision.newMetrics;',
    '  if (ocrDecision.replace) { run.ocrBackup = await backupExistingOcr(documentId, current.content); patch.content = String(result.fullText).trim(); }',
    '  const provenanceTags = await applyProvenanceTags(current, taxonomy, semanticTagIds, run);',
    '  if (provenanceTags?.field) patch.custom_fields = withProvenanceField(merged.customFields, provenanceTags.field, provenanceValue(run));',
    '  else if (merged.applied.length) patch.custom_fields = merged.customFields;',
    '  if (provenanceTags?.ids) patch.tags = provenanceTags.ids;',
    "  await paperlessJson(`/api/documents/${documentId}/`, { method: 'PATCH', body: JSON.stringify(patch) });",
    '  return { patch, appliedCustomFields: merged.applied, recipient: result.recipient || null, ocr: ocrDecision, provenanceTags: [], provenanceField: provenanceTags?.field ? { id: Number(provenanceTags.field.id), name: provenanceTags.field.name, value: provenanceValue(run) } : null };'
  ])
);

replaceOnce(
  'record provenance field',
  'run.provenanceTags = applied.provenanceTags.map(x => x.name); await recordProvenance(documentId, run);',
  'run.provenanceTags = []; run.provenanceField = applied.provenanceField || null; await recordProvenance(documentId, run);'
);

replaceOnce(
  'usage helper',
  'async function processQueue() {',
  block([
    'function isUsageLimitError(error) {',
    "  const text = String(error?.message || error || '').toLowerCase();",
    '  return /usage limit|rate limit|quota|too many requests|insufficient_quota|credits? exhausted|limit reached|http 429|status 429/.test(text);',
    '}',
    '',
    'function usagePublic() {',
    '  return { ...usageLimitState, retryInMs: usageLimitState.retryAt ? Math.max(0, new Date(usageLimitState.retryAt).getTime() - Date.now()) : 0 };',
    '}',
    '',
    'async function processQueue() {'
  ])
);

replaceOnce(
  'usage pause in worker',
  block([
    '        job.error = String(error?.message || error);',
    '        if (job.attempt <= maxRetries) {'
  ]),
  block([
    '        job.error = String(error?.message || error);',
    '        if (isUsageLimitError(error)) {',
    '          const retryAt = new Date(Date.now() + usageLimitRetryMs).toISOString();',
    '          usageLimitState = { paused: true, detectedAt: new Date().toISOString(), retryAt, lastError: job.error };',
    "          job.status = 'waiting-usage-limit';",
    '          job.nextRetryAt = retryAt;',
    '          job.attempt = Math.max(0, job.attempt - 1);',
    "          log('usage', 'Codex usage/rate limit reached; queue paused without failing document.', { documentId, retryAt, error: job.error });",
    '          await new Promise(resolve => setTimeout(resolve, usageLimitRetryMs));',
    '          usageLimitState = { paused: false, detectedAt: usageLimitState.detectedAt, retryAt: null, lastError: null };',
    '          continue;',
    '        }',
    '        if (job.attempt <= maxRetries) {'
  ])
);

replaceOnce(
  'usage status response',
  "return send(res, 200, { codex, paperless, queued: queue.length, active: workerRunning, toolVersion, pipelineVersion, configuredModel: configuredModel || null, ocr: { minConfidence: ocrMinConfidence, replaceMode: ocrReplaceMode }, review: { autoApplyConfidence }, retry: { maxRetries, retryDelayMs }, discovery: discoveryPublic() });",
  "return send(res, 200, { codex, paperless, queued: queue.length, active: workerRunning, toolVersion, pipelineVersion, configuredModel: configuredModel || null, ocr: { minConfidence: ocrMinConfidence, replaceMode: ocrReplaceMode }, review: { autoApplyConfidence }, retry: { maxRetries, retryDelayMs }, discovery: discoveryPublic(), usage: usagePublic(), provenance: { customField: provenanceCustomFieldEnabled ? provenanceFieldName : null, technicalTags: false } });"
);

await writeFile(file, source);
