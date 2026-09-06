import { readFile, writeFile } from 'node:fs/promises';

const file = '/app/server.mjs';
let source = await readFile(file, 'utf8');

function replaceOnce(label, before, after) {
  if (!source.includes(before)) throw new Error(`Pipeline 14 patch failed: ${label} anchor not found`);
  source = source.replace(before, after);
}

replaceOnce(
  'semantic German metadata audit',
`async function metadataAudit() {
  const taxonomy = await getTaxonomy();
  return {
    generatedAt: new Date().toISOString(),
    counts: { correspondents: taxonomy.correspondents.length, documentTypes: taxonomy.documentTypes.length, tags: taxonomy.tags.length },
    correspondents: duplicateGroups(taxonomy.correspondents, 0.88).slice(0, 100),
    documentTypes: duplicateGroups(taxonomy.documentTypes, 0.9).slice(0, 100),
    tags: duplicateGroups(taxonomy.tags.filter(tag => !tag.is_inbox_tag), 0.93).slice(0, 100)
  };
}`,
`function semanticAuditSchema() {
  const groupSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['memberIds', 'suggestedName', 'confidence', 'reason'],
    properties: {
      memberIds: { type: 'array', minItems: 2, items: { type: 'integer' } },
      suggestedName: { type: 'string', minLength: 1, maxLength: 128 },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      reason: { type: 'string', maxLength: 300 }
    }
  };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['correspondents', 'documentTypes', 'tags'],
    properties: {
      correspondents: { type: 'array', items: groupSchema },
      documentTypes: { type: 'array', items: groupSchema },
      tags: { type: 'array', items: groupSchema }
    }
  };
}

function metadataAuditItems(items, limit = 1600) {
  return items
    .slice(0, limit)
    .map(item => ({
      id: Number(item.id),
      name: String(item.name || ''),
      documentCount: Number(item.document_count || item.documentCount || 0)
    }))
    .filter(item => item.id > 0 && item.name.trim());
}

function normalizeSemanticAuditGroups(rawGroups, items, protectedIds = new Set()) {
  const byId = new Map(items.map(item => [Number(item.id), metadataEntitySummary(item)]));
  const out = [];
  const seenKeys = new Set();

  for (const raw of Array.isArray(rawGroups) ? rawGroups : []) {
    const memberIds = [...new Set((Array.isArray(raw?.memberIds) ? raw.memberIds : [])
      .map(Number)
      .filter(id => Number.isInteger(id) && id > 0 && byId.has(id) && !protectedIds.has(id)))];
    if (memberIds.length < 2) continue;

    const members = memberIds.map(id => byId.get(id));
    const key = memberIds.slice().sort((a, b) => a - b).join(',');
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    const suggestedName = String(raw?.suggestedName || '').trim().replace(/\\s+/g, ' ').slice(0, 128);
    const exactTarget = members.find(item => normalizeName(item.name) === normalizeName(suggestedName));
    const target = exactTarget || members.slice().sort((a, b) =>
      (b.documentCount - a.documentCount) ||
      (a.name.length - b.name.length) ||
      a.name.localeCompare(b.name, 'de')
    )[0];

    out.push({
      target,
      sources: members.filter(item => Number(item.id) !== Number(target.id)),
      suggestedName: suggestedName || target.name,
      confidence: Math.max(0, Math.min(1, Number(raw?.confidence || 0))),
      semanticReason: String(raw?.reason || '').slice(0, 300),
      semantic: true,
      totalDocuments: members.reduce((sum, item) => sum + Number(item.documentCount || 0), 0)
    });
  }

  return out;
}

function combineAuditGroups(primary, fallback) {
  const result = [];
  const used = new Set();

  const add = group => {
    const ids = [group?.target?.id, ...(group?.sources || []).map(item => item.id)]
      .map(Number)
      .filter(id => Number.isInteger(id) && id > 0);
    if (ids.length < 2) return;
    const key = ids.slice().sort((a, b) => a - b).join(',');
    if (used.has(key)) return;
    used.add(key);
    result.push(group);
  };

  for (const group of primary || []) add(group);
  for (const group of fallback || []) {
    const ids = [group?.target?.id, ...(group?.sources || []).map(item => item.id)].map(Number);
    if (ids.some(id => [...used].some(key => key.split(',').map(Number).includes(id)))) continue;
    add(group);
  }

  return result.slice(0, 100);
}

async function metadataAudit() {
  const taxonomy = await getTaxonomy();
  const deterministic = {
    correspondents: duplicateGroups(taxonomy.correspondents, 0.88).slice(0, 100),
    documentTypes: duplicateGroups(taxonomy.documentTypes, 0.9).slice(0, 100),
    tags: duplicateGroups(taxonomy.tags.filter(tag => !tag.is_inbox_tag), 0.93).slice(0, 100)
  };

  const status = await codexStatus();
  if (!status.connected) {
    return {
      generatedAt: new Date().toISOString(),
      semantic: false,
      semanticError: 'Codex is not logged in.',
      counts: { correspondents: taxonomy.correspondents.length, documentTypes: taxonomy.documentTypes.length, tags: taxonomy.tags.length },
      ...deterministic
    };
  }

  const correspondents = metadataAuditItems(taxonomy.correspondents);
  const documentTypes = metadataAuditItems(taxonomy.documentTypes);
  const tags = metadataAuditItems(taxonomy.tags.filter(tag => !tag.is_inbox_tag));
  const prompt = [
    'Du pflegst die Metadaten-Taxonomie einer deutschen Paperless-ngx-Instanz.',
    'Finde NUR echte Dubletten oder semantisch gleichbedeutende Einträge. Breitere und engere Begriffe NICHT zusammenführen.',
    'WICHTIG: Dokumenttypen und thematische Tags sollen einen natürlichen, klaren DEUTSCHEN kanonischen Namen bekommen.',
    'Beispiele: "Terms and Service", "Terms & Conditions", "AGB" -> "Allgemeine Geschäftsbedingungen"; "Invoice" -> "Rechnung"; "Payslip" -> "Gehaltsabrechnung".',
    'Bei Korrespondenten/Firmen/Marken Eigennamen NICHT übersetzen. Dort nur Schreibvarianten, Abkürzungen oder offensichtliche Doppelanlagen gruppieren und als suggestedName den offiziellen bzw. saubersten vorhandenen Namen wählen.',
    'Keine bloß verwandten Begriffe gruppieren: "Steuern" ist nicht dasselbe wie "Steuererklärung"; "Versicherung" ist nicht dasselbe wie "Haftpflichtversicherung".',
    'memberIds dürfen ausschließlich IDs aus den gelieferten Listen enthalten. Jede Gruppe braucht mindestens zwei verschiedene IDs.',
    '',
    'KORRESPONDENTEN:',
    JSON.stringify(correspondents),
    '',
    'DOKUMENTTYPEN:',
    JSON.stringify(documentTypes),
    '',
    'TAGS:',
    JSON.stringify(tags)
  ].join('\\n');

  try {
    const semantic = await runCodexAssistantStructured(prompt, semanticAuditSchema(), Math.max(codexTimeoutMs, 240000));
    const inboxIds = new Set(taxonomy.tags.filter(tag => tag.is_inbox_tag).map(tag => Number(tag.id)));
    const semanticCorrespondents = normalizeSemanticAuditGroups(semantic.correspondents, taxonomy.correspondents);
    const semanticDocumentTypes = normalizeSemanticAuditGroups(semantic.documentTypes, taxonomy.documentTypes);
    const semanticTags = normalizeSemanticAuditGroups(semantic.tags, taxonomy.tags, inboxIds);

    return {
      generatedAt: new Date().toISOString(),
      semantic: true,
      counts: { correspondents: taxonomy.correspondents.length, documentTypes: taxonomy.documentTypes.length, tags: taxonomy.tags.length },
      correspondents: combineAuditGroups(semanticCorrespondents, deterministic.correspondents),
      documentTypes: combineAuditGroups(semanticDocumentTypes, deterministic.documentTypes),
      tags: combineAuditGroups(semanticTags, deterministic.tags)
    };
  } catch (error) {
    return {
      generatedAt: new Date().toISOString(),
      semantic: false,
      semanticError: String(error?.message || error),
      counts: { correspondents: taxonomy.correspondents.length, documentTypes: taxonomy.documentTypes.length, tags: taxonomy.tags.length },
      ...deterministic
    };
  }
}`
);

replaceOnce(
  'German cleanup assistant rule',
  "    'In diesem Chat führst du KEINE Änderungen selbst aus. Für Löschungen/Merges gibt es eine separate bestätigte Aktion in der UI.',",
  "    'In diesem Chat führst du KEINE Änderungen selbst aus. Für Löschungen/Merges gibt es eine separate bestätigte Aktion in der UI.',\n    'Bei Metadaten-Aufräumvorschlägen bevorzuge für Dokumenttypen und thematische Tags natürliche deutsche kanonische Namen; englische Synonyme sollen zu passenden deutschen Namen normalisiert werden. Eigennamen von Firmen/Marken nicht übersetzen.',"
);

await writeFile(file, source);
