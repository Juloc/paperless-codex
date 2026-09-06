import { readFile, writeFile } from 'node:fs/promises';

const file = '/app/server.mjs';
let source = await readFile(file, 'utf8');

function replaceOnce(label, before, after) {
  if (!source.includes(before)) throw new Error(`Pipeline 17 patch failed: ${label} anchor not found`);
  source = source.replace(before, after);
}

replaceOnce(
  'persistent bulk state',
  "let bulkScan = { status: 'idle', startedAt: null, finishedAt: null, total: 0, queued: 0, processed: 0, completed: 0, review: 0, failed: 0, skipped: 0, currentDocumentId: null, newestFirst: true };\nlet bulkDocumentIds = new Set();",
  [
    "const bulkStatePath = path.join(stateDir, 'bulk.json');",
    "const persistedBulk = await loadJson(bulkStatePath, null);",
    "let bulkScan = persistedBulk?.scan || { status: 'idle', startedAt: null, finishedAt: null, total: 0, queued: 0, processed: 0, completed: 0, review: 0, failed: 0, skipped: 0, currentDocumentId: null, newestFirst: true };",
    "let bulkDocumentIds = new Set(Array.isArray(persistedBulk?.documentIds) ? persistedBulk.documentIds.map(Number).filter(Number.isInteger) : []);",
    "let metadataOperationProgress = {",
    "  audit: { active: false, phase: 'idle', percent: 0, current: 0, total: 0, detail: null, startedAt: null, finishedAt: null, error: null },",
    "  prune: { active: false, phase: 'idle', percent: 0, current: 0, total: 0, detail: null, startedAt: null, finishedAt: null, error: null }",
    "};"
  ].join('\n')
);

replaceOnce(
  'persist bulk with queue writes',
  "async function saveQueue() {\n  await atomicWriteJson(queuePath, queue);\n}",
  [
    "async function saveBulkState() {",
    "  await atomicWriteJson(bulkStatePath, { scan: bulkScan, documentIds: [...bulkDocumentIds] });",
    "}",
    "",
    "async function saveQueue() {",
    "  await atomicWriteJson(queuePath, queue);",
    "  await saveBulkState();",
    "}"
  ].join('\n')
);

replaceOnce(
  'restored queue source',
  "const job = jobs.get(documentId) || { documentId, queuedAt: null, attempt: 0 };",
  "const job = jobs.get(documentId) || { documentId, queuedAt: null, attempt: 0, source: 'fortgesetzt' };"
);

replaceOnce(
  'persist cancelled bulk state',
  "  bulkScan.currentDocumentId = current || null;\n  return bulkPublic();",
  "  bulkScan.currentDocumentId = current || null;\n  await saveBulkState();\n  return bulkPublic();"
);

replaceOnce(
  'persist finished bulk state',
  "    if (bulkScan.status === 'running' && bulkScan.processed + bulkScan.skipped >= bulkScan.total) { bulkScan.status = 'completed'; bulkScan.finishedAt = new Date().toISOString(); bulkScan.currentDocumentId = null; }\n  }\n}\n\nfunction bulkPublic()",
  "    if (bulkScan.status === 'running' && bulkScan.processed + bulkScan.skipped >= bulkScan.total) { bulkScan.status = 'completed'; bulkScan.finishedAt = new Date().toISOString(); bulkScan.currentDocumentId = null; }\n    await saveBulkState().catch(error => log('bulk', 'Could not persist bulk state.', { error: String(error?.message || error) }));\n  }\n}\n\nfunction bulkPublic()"
);

replaceOnce(
  'persist pause resume',
  "    if (req.method === 'POST' && url.pathname === '/bulk/pause') { if (bulkScan.status === 'running') bulkScan.status = 'paused'; return send(res, 200, bulkPublic()); }\n    if (req.method === 'POST' && url.pathname === '/bulk/resume') { if (bulkScan.status === 'paused') { bulkScan.status = 'running'; void processQueue(); } return send(res, 200, bulkPublic()); }",
  "    if (req.method === 'POST' && url.pathname === '/bulk/pause') { if (bulkScan.status === 'running') bulkScan.status = 'paused'; await saveBulkState(); return send(res, 200, bulkPublic()); }\n    if (req.method === 'POST' && url.pathname === '/bulk/resume') { if (bulkScan.status === 'paused') { bulkScan.status = 'running'; await saveBulkState(); void processQueue(); } return send(res, 200, bulkPublic()); }"
);

const auditStart = source.indexOf('async function metadataAudit() {');
const auditEnd = source.indexOf('\n\nfunction metadataMergeSpec', auditStart);
if (auditStart < 0 || auditEnd < 0) throw new Error('Pipeline 17 patch failed: metadataAudit range not found');

const auditReplacement = [
  "function setMetadataProgress(kind, patch = {}) {",
  "  const previous = metadataOperationProgress[kind] || {};",
  "  metadataOperationProgress[kind] = { ...previous, ...patch };",
  "  return metadataOperationProgress[kind];",
  "}",
  "",
  "function metadataProgressPublic() {",
  "  return structuredClone(metadataOperationProgress);",
  "}",
  "",
  "async function metadataAudit() {",
  "  const startedAt = new Date().toISOString();",
  "  setMetadataProgress('audit', { active: true, phase: 'Metadaten laden', percent: 3, current: 0, total: 0, detail: null, startedAt, finishedAt: null, error: null });",
  "  try {",
  "    const taxonomy = await getTaxonomy();",
  "    const totalItems = taxonomy.correspondents.length + taxonomy.documentTypes.length + taxonomy.tags.length;",
  "    setMetadataProgress('audit', { phase: 'Lokale Ähnlichkeiten prüfen', percent: 12, current: 0, total: totalItems, detail: `${taxonomy.correspondents.length} Korrespondenten · ${taxonomy.documentTypes.length} Typen · ${taxonomy.tags.length} Tags` });",
  "    const deterministic = {",
  "      correspondents: duplicateGroups(taxonomy.correspondents, 0.88).slice(0, 100),",
  "      documentTypes: duplicateGroups(taxonomy.documentTypes, 0.9).slice(0, 100),",
  "      tags: duplicateGroups(taxonomy.tags.filter(tag => !tag.is_inbox_tag), 0.93).slice(0, 100)",
  "    };",
  "",
  "    const status = await codexStatus();",
  "    if (!status.connected) {",
  "      const result = { generatedAt: new Date().toISOString(), semantic: false, semanticError: 'Codex is not logged in.', counts: { correspondents: taxonomy.correspondents.length, documentTypes: taxonomy.documentTypes.length, tags: taxonomy.tags.length }, ...deterministic };",
  "      setMetadataProgress('audit', { active: false, phase: 'Fertig – lokale Prüfung', percent: 100, current: totalItems, total: totalItems, finishedAt: new Date().toISOString() });",
  "      return result;",
  "    }",
  "",
  "    const correspondents = metadataAuditItems(taxonomy.correspondents);",
  "    const documentTypes = metadataAuditItems(taxonomy.documentTypes);",
  "    const tags = metadataAuditItems(taxonomy.tags.filter(tag => !tag.is_inbox_tag));",
  "    setMetadataProgress('audit', { phase: 'Codex prüft semantische Dubletten', percent: 30, detail: `${correspondents.length + documentTypes.length + tags.length} Einträge werden semantisch verglichen` });",
  "    const prompt = [",
  "      'Du pflegst die Metadaten-Taxonomie einer deutschen Paperless-ngx-Instanz.',",
  "      'Finde NUR echte Dubletten oder semantisch gleichbedeutende Einträge. Breitere und engere Begriffe NICHT zusammenführen.',",
  "      'WICHTIG: Dokumenttypen und thematische Tags sollen einen natürlichen, klaren DEUTSCHEN kanonischen Namen bekommen.',",
  "      'Beispiele: Terms and Service, Terms & Conditions, AGB -> Allgemeine Geschäftsbedingungen; Invoice -> Rechnung; Payslip -> Gehaltsabrechnung.',",
  "      'Bei Korrespondenten, Firmen und Marken Eigennamen NICHT übersetzen. Dort nur Schreibvarianten, Abkürzungen oder offensichtliche Doppelanlagen gruppieren und als suggestedName den offiziellen bzw. saubersten vorhandenen Namen wählen.',",
  "      'Keine bloß verwandten Begriffe gruppieren: Steuern ist nicht dasselbe wie Steuererklärung; Versicherung ist nicht dasselbe wie Haftpflichtversicherung.',",
  "      'memberIds dürfen ausschließlich IDs aus den gelieferten Listen enthalten. Jede Gruppe braucht mindestens zwei verschiedene IDs.',",
  "      '', 'KORRESPONDENTEN:', JSON.stringify(correspondents), '', 'DOKUMENTTYPEN:', JSON.stringify(documentTypes), '', 'TAGS:', JSON.stringify(tags)",
  "    ].join('\\n');",
  "",
  "    try {",
  "      const semantic = await runCodexAssistantStructured(prompt, semanticAuditSchema(), Math.max(codexTimeoutMs, 240000));",
  "      setMetadataProgress('audit', { phase: 'Codex-Ergebnis prüfen und gruppieren', percent: 88, detail: 'IDs, Schutzregeln und deutsche Zielnamen werden validiert' });",
  "      const inboxIds = new Set(taxonomy.tags.filter(tag => tag.is_inbox_tag).map(tag => Number(tag.id)));",
  "      const semanticCorrespondents = normalizeSemanticAuditGroups(semantic.correspondents, taxonomy.correspondents);",
  "      const semanticDocumentTypes = normalizeSemanticAuditGroups(semantic.documentTypes, taxonomy.documentTypes);",
  "      const semanticTags = normalizeSemanticAuditGroups(semantic.tags, taxonomy.tags, inboxIds);",
  "      const result = {",
  "        generatedAt: new Date().toISOString(), semantic: true,",
  "        counts: { correspondents: taxonomy.correspondents.length, documentTypes: taxonomy.documentTypes.length, tags: taxonomy.tags.length },",
  "        correspondents: combineAuditGroups(semanticCorrespondents, deterministic.correspondents),",
  "        documentTypes: combineAuditGroups(semanticDocumentTypes, deterministic.documentTypes),",
  "        tags: combineAuditGroups(semanticTags, deterministic.tags)",
  "      };",
  "      const groups = result.correspondents.length + result.documentTypes.length + result.tags.length;",
  "      setMetadataProgress('audit', { active: false, phase: 'Fertig', percent: 100, current: totalItems, total: totalItems, detail: `${groups} Gruppen gefunden`, finishedAt: new Date().toISOString() });",
  "      return result;",
  "    } catch (error) {",
  "      const result = { generatedAt: new Date().toISOString(), semantic: false, semanticError: String(error?.message || error), counts: { correspondents: taxonomy.correspondents.length, documentTypes: taxonomy.documentTypes.length, tags: taxonomy.tags.length }, ...deterministic };",
  "      setMetadataProgress('audit', { active: false, phase: 'Fertig – Fallback', percent: 100, current: totalItems, total: totalItems, detail: 'Semantische Prüfung fehlgeschlagen; lokale Ähnlichkeit verwendet', finishedAt: new Date().toISOString(), error: String(error?.message || error) });",
  "      return result;",
  "    }",
  "  } catch (error) {",
  "    setMetadataProgress('audit', { active: false, phase: 'Fehler', percent: 100, finishedAt: new Date().toISOString(), error: String(error?.message || error), detail: String(error?.message || error) });",
  "    throw error;",
  "  }",
  "}"
].join('\n');

source = source.slice(0, auditStart) + auditReplacement + source.slice(auditEnd);

const pruneStart = source.indexOf('async function pruneUnusedMetadata(');
const pruneEnd = source.indexOf('\n\nfunction metadataMergeSpec', pruneStart);
if (pruneStart < 0 || pruneEnd < 0) throw new Error('Pipeline 17 patch failed: pruneUnusedMetadata range not found');

const pruneReplacement = [
  "async function pruneUnusedMetadata({ items, confirm }) {",
  "  if (confirm !== true) throw new Error('Prune requires confirm=true.');",
  "  const requested = (Array.isArray(items) ? items : []).slice(0, 500);",
  "  if (!requested.length) throw new Error('No metadata entries selected.');",
  "  const startedAt = new Date().toISOString();",
  "  setMetadataProgress('prune', { active: true, phase: 'Vorbereiten', percent: 0, current: 0, total: requested.length, detail: `${requested.length} Einträge ausgewählt`, startedAt, finishedAt: null, error: null });",
  "  try {",
  "    const taxonomy = await getTaxonomy();",
  "    const specs = { correspondent: { collection: 'correspondents', endpoint: '/api/correspondents/' }, documentType: { collection: 'documentTypes', endpoint: '/api/document_types/' }, tag: { collection: 'tags', endpoint: '/api/tags/' } };",
  "    const results = [];",
  "",
  "    for (let pruneIndex = 0; pruneIndex < requested.length; pruneIndex++) {",
  "      const requestedItem = requested[pruneIndex];",
  "      const kind = String(requestedItem?.kind || '');",
  "      const id = Number(requestedItem?.id);",
  "      const spec = specs[kind];",
  "      const percent = Math.min(99, Math.round((pruneIndex / Math.max(1, requested.length)) * 100));",
  "      setMetadataProgress('prune', { phase: 'Live prüfen und löschen', percent, current: pruneIndex, total: requested.length, detail: `${kind || 'Eintrag'} #${id || '?'}` });",
  "      if (!spec || !Number.isInteger(id) || id <= 0) { results.push({ kind, id, deleted: false, skipped: true, reason: 'Ungültiger Eintrag' }); continue; }",
  "      const item = itemById(taxonomy[spec.collection] || [], id);",
  "      if (!item) { results.push({ kind, id, deleted: false, skipped: true, reason: 'Bereits entfernt' }); continue; }",
  "      setMetadataProgress('prune', { current: pruneIndex, detail: item.name });",
  "      const protectedReason = unusedMetadataProtection(kind, item, taxonomy);",
  "      if (protectedReason) { results.push({ kind, id, name: item.name, deleted: false, skipped: true, reason: protectedReason }); continue; }",
  "      const referencePath = liveMetadataReferencePath(kind, id);",
  "      const referenceBody = await paperlessJson(referencePath);",
  "      const liveCount = responseDocumentCount(referenceBody);",
  "      if (liveCount !== 0) { results.push({ kind, id, name: item.name, deleted: false, skipped: true, reason: `Wird noch von ${liveCount} Dokument(en) verwendet`, liveCount }); continue; }",
  "      try {",
  "        await paperlessFetch(`${spec.endpoint}${id}/`, { method: 'DELETE' });",
  "        results.push({ kind, id, name: item.name, deleted: true, skipped: false, liveCount: 0 });",
  "      } catch (error) {",
  "        results.push({ kind, id, name: item.name, deleted: false, skipped: false, reason: String(error?.message || error), liveCount: 0 });",
  "      }",
  "      const done = pruneIndex + 1;",
  "      setMetadataProgress('prune', { current: done, percent: Math.round((done / requested.length) * 100), detail: item.name });",
  "    }",
  "",
  "    const result = { ok: results.every(item => item.deleted || item.skipped), deleted: results.filter(item => item.deleted).length, skipped: results.filter(item => item.skipped).length, failed: results.filter(item => !item.deleted && !item.skipped).length, results };",
  "    setMetadataProgress('prune', { active: false, phase: 'Fertig', percent: 100, current: requested.length, total: requested.length, detail: `${result.deleted} gelöscht · ${result.skipped} übersprungen · ${result.failed} Fehler`, finishedAt: new Date().toISOString() });",
  "    return result;",
  "  } catch (error) {",
  "    setMetadataProgress('prune', { active: false, phase: 'Fehler', percent: 100, finishedAt: new Date().toISOString(), error: String(error?.message || error), detail: String(error?.message || error) });",
  "    throw error;",
  "  }",
  "}"
].join('\n');

source = source.slice(0, pruneStart) + pruneReplacement + source.slice(pruneEnd);

const routeAnchor = "    if (req.method === 'GET' && url.pathname === '/assistant/metadata/audit') return send(res, 200, await metadataAudit());";
if (!source.includes(routeAnchor)) throw new Error('Pipeline 17 patch failed: metadata audit route not found');
source = source.replace(routeAnchor, "    if (req.method === 'GET' && url.pathname === '/assistant/metadata/progress') return send(res, 200, metadataProgressPublic());\n" + routeAnchor);

await writeFile(file, source);
