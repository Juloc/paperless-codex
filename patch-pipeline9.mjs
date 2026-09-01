import { readFile, writeFile } from 'node:fs/promises';

const file = '/app/server.mjs';
let source = await readFile(file, 'utf8');

function block(lines) {
  return lines.join('\n');
}

function replaceOnce(label, before, after) {
  if (!source.includes(before)) throw new Error(`Pipeline 9 patch failed: ${label} anchor not found`);
  source = source.replace(before, after);
}

function replaceRange(label, start, end, replacement) {
  const from = source.indexOf(start);
  if (from < 0) throw new Error(`Pipeline 9 patch failed: ${label} start anchor not found`);
  const toStart = source.indexOf(end, from);
  if (toStart < 0) throw new Error(`Pipeline 9 patch failed: ${label} end anchor not found`);
  const to = toStart + end.length;
  source = source.slice(0, from) + replacement + source.slice(to);
}

replaceOnce(
  'new semantic tag setting',
  "const maxSemanticTags = Math.max(0, Math.min(8, Number(process.env.MAX_SEMANTIC_TAGS || 6)));",
  "const maxSemanticTags = Math.max(0, Math.min(8, Number(process.env.MAX_SEMANTIC_TAGS || 6)));\nconst maxNewSemanticTags = Math.max(0, Math.min(3, Number(process.env.MAX_NEW_SEMANTIC_TAGS || 2)));"
);

replaceOnce(
  'semantic tag prompt allow guarded creation',
  '- Für Tags ausschließlich bereits vorhandene Paperless-Tags per existingId verwenden. Niemals neue Tags erfinden oder aus einzelnen OCR-Wörtern erzeugen.',
  '- Vorhandene passende Tags haben immer Vorrang. Wenn wirklich kein vorhandener Tag passt, darfst du mit existingId=null einen neuen, kurzen und allgemein wiederverwendbaren Themen-Tag vorschlagen. Maximal 2 neue Tag-Vorschläge pro Dokument. Keine spontanen Synonyme und keine Tags aus einzelnen OCR-Wörtern.'
);

replaceOnce(
  'semantic tag prompt reuse wording',
  '- Gleiche Dokumentarten und gleiche Themen sollen dieselben vorhandenen Tags wiederverwenden. Bevorzuge stabile, breite Begriffe statt wechselnder Synonyme.',
  '- Gleiche Dokumentarten und gleiche Themen müssen dieselben Tags wiederverwenden. Bevorzuge stabile, breite Begriffe statt wechselnder Synonyme. Neue Tags nur dann, wenn der Begriff voraussichtlich auch bei weiteren Dokumenten sinnvoll wiederverwendet wird.'
);

replaceOnce(
  'semantic tag prompt final wording',
  '- Wenn kein zusätzlicher sinnvoller vorhandener Themen-Tag passt, tags=[] zurückgeben. Der Server ergänzt bei Bedarf deterministisch einen bereits existierenden Tag, dessen Name exakt dem Dokumenttyp entspricht.',
  '- Wenn kein sinnvoller Themen-Tag passt, tags=[] zurückgeben. Der Server ergänzt für konkrete Dokumentarten deterministisch einen Tag mit dem Namen des Dokumenttyps und darf diesen einmalig neu anlegen, falls er noch fehlt.'
);

replaceRange(
  'guarded semantic tag resolution',
  '  const normalizedCurrentType = normalizeName(documentType?.name);',
  '  run.semanticTagIds = [...semanticTagIds];',
  block([
    '  const normalizedCurrentType = normalizeName(documentType?.name);',
    '  const blockedTagNames = new Set([',
    '    normalizeName(correspondent?.name),',
    '    ...taxonomy.correspondents.map(item => normalizeName(item.name))',
    '  ].filter(Boolean));',
    '  const semanticTagIds = new Set();',
    '  const createdSemanticTags = [];',
    '  let newSemanticTagCount = 0;',
    "  const genericDocumentTypes = new Set(['dokument', 'schreiben', 'sonstiges', 'unbekannt']);",
    '  const dateLikeTag = /^(?:januar|februar|maerz|marz|april|mai|juni|juli|august|september|oktober|november|dezember)(?:[ -]?\\d{2,4})?$|^\\d{4}$|^\\d{4}[ -]?(?:0?[1-9]|1[0-2])$|^\\d{1,2}[./-]\\d{1,2}[./-]\\d{2,4}$/i;',
    '  const scalarLikeTag = /^(?:\\d+[.,]?\\d*\\s?(?:eur|€|usd|chf)?|[a-z]{0,4}\\d{5,})$/i;',
    '  const companyLikeTag = /\\b(?:gmbh|ag|kg|ug|gbr|se|ltd|inc|corp|co\\.?\\s*&?\\s*kg)\\b/i;',
    '  const unsafeTagName = value => {',
    '    const raw = String(value || "").trim();',
    '    const normalized = normalizeName(raw);',
    '    if (!normalized || normalized.length < 3 || normalized.length > 48) return true;',
    '    const words = normalized.split(/\\s+/).filter(Boolean);',
    '    if (words.length > 4) return true;',
    '    if (blockedTagNames.has(normalized) || dateLikeTag.test(normalized) || scalarLikeTag.test(normalized)) return true;',
    '    if (/https?:|www\\.|@|[<>\\[\\]{}]/i.test(raw) || companyLikeTag.test(normalized)) return true;',
    '    if (/^\\d/.test(normalized) || /\\d{5,}/.test(normalized)) return true;',
    '    return false;',
    '  };',
    '  const resolveSemanticTag = async (selection, { canonical = false } = {}) => {',
    '    const byId = itemById(taxonomy.tags, selection?.existingId);',
    '    if (byId) return byId;',
    '    const name = String(selection?.name || "").trim();',
    '    if (!name || unsafeTagName(name)) return null;',
    '    const best = findBestNamed(taxonomy.tags, name);',
    '    if (best.item && best.score >= existingMatchThreshold) return best.item;',
    '    if (!createMissingMetadata || newSemanticTagCount >= maxNewSemanticTags) return null;',
    '    const created = await paperlessJson("/api/tags/", { method: "POST", body: JSON.stringify({ name: name.slice(0, 128), color: canonical ? "#607d8b" : "#a6cee3" }) });',
    '    taxonomy.tags.push(created);',
    '    newSemanticTagCount++;',
    '    createdSemanticTags.push({ id: Number(created.id), name: created.name, canonical });',
    '    log("metadata", "Created guarded semantic tag.", { name: created.name, id: created.id, canonical });',
    '    return created;',
    '  };',
    '  if (normalizedCurrentType && !genericDocumentTypes.has(normalizedCurrentType) && semanticTagIds.size < maxSemanticTags) {',
    '    const canonical = await resolveSemanticTag({ existingId: null, name: documentType?.name }, { canonical: true });',
    '    if (canonical) semanticTagIds.add(Number(canonical.id));',
    '  }',
    '  for (const selection of Array.isArray(result.tags) ? result.tags : []) {',
    '    if (semanticTagIds.size >= maxSemanticTags) break;',
    '    const tag = await resolveSemanticTag(selection);',
    '    if (!tag) continue;',
    '    semanticTagIds.add(Number(tag.id));',
    '  }',
    '  run.semanticTagIds = [...semanticTagIds];',
    '  run.createdSemanticTags = createdSemanticTags;'
  ])
);

await writeFile(file, source);
