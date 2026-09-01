import { readFile, writeFile } from 'node:fs/promises';

const file = '/app/server.mjs';
let source = await readFile(file, 'utf8');

function block(lines) {
  return lines.join('\n');
}

function replaceOnce(label, before, after) {
  if (!source.includes(before)) throw new Error(`Pipeline 7 patch failed: ${label} anchor not found`);
  source = source.replace(before, after);
}

function replaceRange(label, start, end, replacement) {
  const from = source.indexOf(start);
  if (from < 0) throw new Error(`Pipeline 7 patch failed: ${label} start anchor not found`);
  const to = source.indexOf(end, from);
  if (to < 0) throw new Error(`Pipeline 7 patch failed: ${label} end anchor not found`);
  source = source.slice(0, from) + replacement + '\n\n' + source.slice(to);
}

replaceOnce(
  'pipeline 7 settings',
  "const provenanceFieldName = String(process.env.PROVENANCE_FIELD_NAME || 'AI Provenienz').trim().slice(0, 128) || 'AI Provenienz';",
  "const provenanceFieldName = String(process.env.PROVENANCE_FIELD_NAME || 'AI Provenienz').trim().slice(0, 128) || 'AI Provenienz';\nconst maxSemanticTags = Math.max(0, Math.min(2, Number(process.env.MAX_SEMANTIC_TAGS || 2)));\nconst verifyPaperlessWrites = !/^(0|false|no)$/i.test(process.env.VERIFY_PAPERLESS_WRITES || 'true');"
);

replaceOnce(
  'self test runtime state',
  'let legacyDeletedTagIds = new Set();',
  'let legacyDeletedTagIds = new Set();\nlet lastSelfTest = null;'
);

replaceOnce(
  'strict tag prompt',
  '- Tags gezielt und nicht redundant wählen.',
  '- Tags sind optional und nur für wenige, breite, wiederverwendbare Querschnittskategorien gedacht. Maximal 2 Tags.\\n- Für Tags ausschließlich bereits vorhandene Paperless-Tags per existingId verwenden. Niemals neue Tags vorschlagen.\\n- Niemals Dokumenttyp, Korrespondent/Absender, Empfänger, Monat/Jahr, Produktnamen, Marken, einzelne OCR-Stichwörter oder den Titel als Tag duplizieren.\\n- Beispiele wie Rechnung, Kassenbon, Gehaltsabrechnung gehören in documentType und NICHT zusätzlich in tags. Wenn kein wirklich hilfreicher vorhandener Tag passt, tags=[] zurückgeben.'
);

replaceRange(
  'validated OCR replacement',
  'function decideOcrReplacement(existingText, candidateText, ocrConfidence) {',
  'async function backupExistingOcr(documentId, currentContent) {',
  block([
    'function decideOcrReplacement(existingText, candidateText, ocrConfidence, run = null) {',
    '  const oldMetrics = textMetrics(existingText);',
    '  const newMetrics = textMetrics(candidateText);',
    '  const confidence = Number(ocrConfidence);',
    "  if (!writeContent) return { replace: false, reason: 'WRITE_CONTENT=false', oldMetrics, newMetrics };",
    '  if (!Number.isFinite(confidence) || confidence < ocrMinConfidence) return { replace: false, reason: `OCR confidence below ${ocrMinConfidence}`, oldMetrics, newMetrics };',
    "  if (newMetrics.length < 40 || newMetrics.words < 5 || newMetrics.suspiciousRatio > 0.08 || newMetrics.noiseRatio > 0.03) return { replace: false, reason: 'Candidate OCR failed plausibility checks', oldMetrics, newMetrics };",
    '  const pagesScanned = Number(run?.pagesScanned || 0);',
    '  const totalPages = Number(run?.totalPages || pagesScanned || 0);',
    '  if (totalPages > pagesScanned && pagesScanned > 0) return { replace: false, reason: `Document truncated (${pagesScanned}/${totalPages} pages); existing full OCR preserved`, oldMetrics, newMetrics };',
    "  return { replace: true, reason: 'Validated Codex OCR replaces Paperless OCR', oldMetrics, newMetrics };",
    '}'
  ])
);

replaceOnce(
  'pass run to OCR decision',
  'const ocrDecision = decideOcrReplacement(current.content, result.fullText, result.ocrConfidence);',
  'const ocrDecision = decideOcrReplacement(current.content, result.fullText, result.ocrConfidence, run);'
);

replaceOnce(
  'existing-only semantic tags',
  "  const semanticTagIds = new Set(); for (const selection of Array.isArray(result.tags) ? result.tags.slice(0, 25) : []) { const tag = await resolveMetadata('/api/tags/', taxonomy.tags, selection, { color: '#a6cee3' }); if (tag) semanticTagIds.add(Number(tag.id)); }",
  block([
    '  const blockedTagNames = new Set([',
    '    normalizeName(correspondent?.name),',
    '    normalizeName(documentType?.name),',
    '    ...taxonomy.documentTypes.map(item => normalizeName(item.name)),',
    '    ...taxonomy.correspondents.map(item => normalizeName(item.name))',
    '  ].filter(Boolean));',
    '  const semanticTagIds = new Set();',
    '  const dateLikeTag = /^(?:januar|februar|maerz|marz|april|mai|juni|juli|august|september|oktober|november|dezember)[ -]?\\d{2,4}$|^\\d{4}[ -]?(?:0?[1-9]|1[0-2])$|^\\d{1,2}[./-]\\d{1,2}[./-]\\d{2,4}$/i;',
    '  for (const selection of Array.isArray(result.tags) ? result.tags.slice(0, maxSemanticTags) : []) {',
    '    const tag = itemById(taxonomy.tags, selection?.existingId);',
    '    if (!tag) continue;',
    '    const normalized = normalizeName(tag.name);',
    '    if (!normalized || blockedTagNames.has(normalized) || dateLikeTag.test(normalized)) continue;',
    '    semanticTagIds.add(Number(tag.id));',
    '  }'
  ])
);

replaceRange(
  'managed tag cleanup and runtime helpers',
  'async function applyProvenanceTags(current, taxonomy, semanticTagIds, run) {',
  'async function applyResult(documentId, current, taxonomy, result, run) {',
  block([
    'async function applyProvenanceTags(current, taxonomy, semanticTagIds, run) {',
    '  const legacyIds = await cleanupLegacyToolTags(taxonomy);',
    '  const field = await ensureProvenanceCustomField(taxonomy);',
    '  const hasFieldValue = Boolean(field && Array.isArray(current.custom_fields) && current.custom_fields.some(item => Number(item?.field) === Number(field.id) && String(item?.value || "").startsWith("pc=")));',
    '  const wasPreviouslyManaged = hasFieldValue || Boolean(provenance[String(current.id)]?.latest);',
    '  const existingIds = new Set();',
    '  if (!wasPreviouslyManaged) {',
    '    for (const id of Array.isArray(current.tags) ? current.tags.map(Number) : []) if (!legacyIds.has(id)) existingIds.add(id);',
    '  } else {',
    '    for (const id of Array.isArray(current.tags) ? current.tags.map(Number) : []) {',
    '      const tag = taxonomy.tags.find(item => Number(item.id) === id);',
    '      if (tag?.is_inbox_tag) existingIds.add(id);',
    '    }',
    '  }',
    '  for (const id of semanticTagIds) existingIds.add(Number(id));',
    '  return { ids: [...existingIds], tags: [], field, replacedManagedTags: wasPreviouslyManaged };',
    '}',
    '',
    'function sameScalar(a, b) {',
    '  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);',
    '}',
    '',
    'async function verifyAppliedPatch(documentId, patch) {',
    '  if (!verifyPaperlessWrites) return { enabled: false, ok: null, checks: {} };',
    '  const persisted = await paperlessJson(`/api/documents/${documentId}/`);',
    '  const checks = {};',
    "  if (Object.hasOwn(patch, 'content')) checks.content = String(persisted.content || '') === String(patch.content || '');",
    "  if (Object.hasOwn(patch, 'title')) checks.title = String(persisted.title || '') === String(patch.title || '');",
    "  if (Object.hasOwn(patch, 'created')) checks.created = String(persisted.created || '') === String(patch.created || '');",
    "  if (Object.hasOwn(patch, 'correspondent')) checks.correspondent = sameScalar(persisted.correspondent, patch.correspondent);",
    "  if (Object.hasOwn(patch, 'document_type')) checks.documentType = sameScalar(persisted.document_type, patch.document_type);",
    "  if (Object.hasOwn(patch, 'storage_path')) checks.storagePath = sameScalar(persisted.storage_path, patch.storage_path);",
    "  if (Object.hasOwn(patch, 'tags')) {",
    '    const expected = [...new Set((patch.tags || []).map(Number))].sort((a, b) => a - b);',
    '    const actual = [...new Set((persisted.tags || []).map(Number))].sort((a, b) => a - b);',
    '    checks.tags = JSON.stringify(actual) === JSON.stringify(expected);',
    '  }',
    "  if (Object.hasOwn(patch, 'custom_fields')) {",
    '    const expected = new Map((patch.custom_fields || []).map(item => [Number(item.field), item.value ?? null]));',
    '    const actual = new Map((persisted.custom_fields || []).map(item => [Number(item.field), item.value ?? null]));',
    '    checks.customFields = [...expected].every(([id, value]) => actual.has(id) && sameScalar(actual.get(id), value));',
    '  }',
    '  const ok = Object.values(checks).every(Boolean);',
    '  return { enabled: true, ok, checks, verifiedAt: new Date().toISOString() };',
    '}',
    '',
    'async function provenanceSystemStatus() {',
    '  if (!provenanceCustomFieldEnabled) return { customField: null, technicalTags: false, fieldExists: false, fieldId: null, fieldType: null, lastSelfTest };',
    '  try {',
    '    const taxonomy = await getTaxonomy();',
    '    const field = await ensureProvenanceCustomField(taxonomy);',
    '    return { customField: provenanceFieldName, technicalTags: false, fieldExists: Boolean(field), fieldId: field ? Number(field.id) : null, fieldType: field?.data_type || null, lastSelfTest };',
    '  } catch (error) {',
    '    return { customField: provenanceFieldName, technicalTags: false, fieldExists: false, fieldId: null, fieldType: null, error: String(error?.message || error), lastSelfTest };',
    '  }',
    '}',
    '',
    'async function runPaperlessSelfTest() {',
    '  const startedAt = new Date().toISOString();',
    '  const taxonomy = await getTaxonomy();',
    '  const field = await ensureProvenanceCustomField(taxonomy);',
    "  const page = await paperlessJson('/api/documents/?ordering=-added&page_size=1');",
    '  const first = Array.isArray(page) ? page[0] : page?.results?.[0];',
    '  if (!first?.id) {',
    '    lastSelfTest = { ok: Boolean(field), startedAt, finishedAt: new Date().toISOString(), fieldExists: Boolean(field), contentWrite: null, customFieldWrite: null, documentId: null, note: "No document available for write verification." };',
    '    return lastSelfTest;',
    '  }',
    '  const documentId = Number(first.id);',
    '  const current = await paperlessJson(`/api/documents/${documentId}/`);',
    '  const originalFields = (Array.isArray(current.custom_fields) ? current.custom_fields : []).map(item => ({ field: Number(item.field), value: item.value ?? null })).filter(item => Number.isInteger(item.field));',
    '  const probe = `selftest:${Date.now()}`;',
    '  const probeFields = withProvenanceField(originalFields, field, probe);',
    '  let contentWrite = false;',
    '  let customFieldWrite = false;',
    '  let restoreError = null;',
    '  try {',
    '    await paperlessJson(`/api/documents/${documentId}/`, { method: "PATCH", body: JSON.stringify({ content: String(current.content || ""), custom_fields: probeFields }) });',
    '    const persisted = await paperlessJson(`/api/documents/${documentId}/`);',
    '    contentWrite = String(persisted.content || "") === String(current.content || "");',
    '    customFieldWrite = Array.isArray(persisted.custom_fields) && persisted.custom_fields.some(item => Number(item.field) === Number(field.id) && String(item.value || "") === probe);',
    '  } finally {',
    '    await paperlessJson(`/api/documents/${documentId}/`, { method: "PATCH", body: JSON.stringify({ custom_fields: originalFields }) }).catch(error => { restoreError = String(error?.message || error); });',
    '  }',
    '  lastSelfTest = { ok: Boolean(field) && contentWrite && customFieldWrite && !restoreError, startedAt, finishedAt: new Date().toISOString(), fieldExists: Boolean(field), fieldId: field ? Number(field.id) : null, contentWrite, customFieldWrite, documentId, restored: !restoreError, restoreError };',
    '  return lastSelfTest;',
    '}'
  ])
);

replaceOnce(
  'verify applied write',
  block([
    "  await paperlessJson(`/api/documents/${documentId}/`, { method: 'PATCH', body: JSON.stringify(patch) });",
    '  return { patch, appliedCustomFields: merged.applied, recipient: result.recipient || null, ocr: ocrDecision, provenanceTags: [], provenanceField: provenanceTags?.field ? { id: Number(provenanceTags.field.id), name: provenanceTags.field.name, value: provenanceValue(run) } : null };'
  ]),
  block([
    "  await paperlessJson(`/api/documents/${documentId}/`, { method: 'PATCH', body: JSON.stringify(patch) });",
    '  const writeVerification = await verifyAppliedPatch(documentId, patch);',
    "  if (writeVerification.enabled && !writeVerification.ok) throw new Error(`Paperless write verification failed: ${JSON.stringify(writeVerification.checks)}`);",
    '  run.writeVerification = writeVerification;',
    '  return { patch, appliedCustomFields: merged.applied, recipient: result.recipient || null, ocr: ocrDecision, provenanceTags: [], provenanceField: provenanceTags?.field ? { id: Number(provenanceTags.field.id), name: provenanceTags.field.name, value: provenanceValue(run) } : null, writeVerification };'
  ])
);

replaceOnce(
  'live provenance status',
  'provenance: { customField: provenanceCustomFieldEnabled ? provenanceFieldName : null, technicalTags: false }',
  'provenance: await provenanceSystemStatus()'
);

replaceOnce(
  'self test endpoint',
  "    if (req.method === 'GET' && url.pathname === '/metadata') return send(res, 200, compactTaxonomy(await getTaxonomy()));",
  "    if (req.method === 'POST' && url.pathname === '/selftest') return send(res, 200, await runPaperlessSelfTest());\n    if (req.method === 'GET' && url.pathname === '/metadata') return send(res, 200, compactTaxonomy(await getTaxonomy()));"
);

await writeFile(file, source);
