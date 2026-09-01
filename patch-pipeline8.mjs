import { readFile, writeFile } from 'node:fs/promises';

const file = '/app/server.mjs';
let source = await readFile(file, 'utf8');

function block(lines) {
  return lines.join('\n');
}

function replaceOnce(label, before, after) {
  if (!source.includes(before)) throw new Error(`Pipeline 8 patch failed: ${label} anchor not found`);
  source = source.replace(before, after);
}

function replaceRange(label, start, end, replacement) {
  const from = source.indexOf(start);
  if (from < 0) throw new Error(`Pipeline 8 patch failed: ${label} start anchor not found`);
  const to = source.indexOf(end, from);
  if (to < 0) throw new Error(`Pipeline 8 patch failed: ${label} end anchor not found`);
  source = source.slice(0, from) + replacement + '\n\n' + source.slice(to);
}

function replaceInclusiveTextRange(label, startText, endText, replacement) {
  const startHit = source.indexOf(startText);
  if (startHit < 0) throw new Error(`Pipeline 8 patch failed: ${label} start text not found`);
  const from = Math.max(0, source.lastIndexOf('- ', startHit));
  const endHit = source.indexOf(endText, startHit);
  if (endHit < 0) throw new Error(`Pipeline 8 patch failed: ${label} end text not found`);
  const to = endHit + endText.length;
  source = source.slice(0, from) + replacement + source.slice(to);
}

replaceOnce(
  'semantic tag limit',
  "const maxSemanticTags = Math.max(0, Math.min(2, Number(process.env.MAX_SEMANTIC_TAGS || 2)));",
  "const maxSemanticTags = Math.max(0, Math.min(8, Number(process.env.MAX_SEMANTIC_TAGS || 6)));"
);

replaceInclusiveTextRange(
  'semantic tag prompt',
  'Tags sind optional und nur für wenige, breite, wiederverwendbare Querschnittskategorien gedacht.',
  'Wenn kein wirklich hilfreicher vorhandener Tag passt, tags=[] zurückgeben.',
  block([
    '- Tags sind dauerhafte semantische Klassifikation, keine Ablage für extrahierte Einzelwerte. Bis zu 6 sinnvolle Tags sind erlaubt; weniger ist besser.',
    '- Für Tags ausschließlich bereits vorhandene Paperless-Tags per existingId verwenden. Niemals neue Tags erfinden oder aus einzelnen OCR-Wörtern erzeugen.',
    '- Gleiche Dokumentarten und gleiche Themen sollen dieselben vorhandenen Tags wiederverwenden. Bevorzuge stabile, breite Begriffe statt wechselnder Synonyme.',
    '- Strukturierte Werte gehören bevorzugt in passende vorhandene customFields: Datum/Zeitraum/Steuerjahr, Rechnungs-/Kunden-/Vertragsnummer, Betrag, IBAN/BIC, Aktenzeichen und ähnliche Werte niemals als Tag ablegen.',
    '- Monat, Jahr, konkrete Datumswerte, Geldbeträge, Produktnamen, Marken, Korrespondent/Absender, Empfänger und der Dokumenttitel sind keine Tags.',
    '- documentType beschreibt die Art/Form des Dokuments, z.B. Gehaltsabrechnung, Rechnung, Kassenbon, Vertrag, Schreiben oder Bescheid.',
    '- tags beschreiben zusätzlich das dauerhafte Thema oder den Kontext. Beispiel: documentType=Schreiben und Thema=Steuererklärung darf Tags wie Steuererklärung/Steuern verwenden. Eine Gehaltsabrechnung soll dagegen bei wiederholten Scans dieselben vorhandenen Gehalts-/Arbeits-Tags bekommen und keine Monats-/Jahres-Tags.',
    '- Wenn kein zusätzlicher sinnvoller vorhandener Themen-Tag passt, tags=[] zurückgeben. Der Server ergänzt bei Bedarf deterministisch einen bereits existierenden Tag, dessen Name exakt dem Dokumenttyp entspricht.'
  ])
);

replaceRange(
  'stable semantic tag selection',
  '  const blockedTagNames = new Set([',
  '  const storagePath = await resolveMetadata(',
  block([
    '  const normalizedCurrentType = normalizeName(documentType?.name);',
    '  const blockedTagNames = new Set([',
    '    normalizeName(correspondent?.name),',
    '    ...taxonomy.correspondents.map(item => normalizeName(item.name))',
    '  ].filter(Boolean));',
    '  const otherDocumentTypeNames = new Set(taxonomy.documentTypes.map(item => normalizeName(item.name)).filter(name => name && name !== normalizedCurrentType));',
    '  const semanticTagIds = new Set();',
    '  if (normalizedCurrentType) {',
    '    const canonicalTypeTag = taxonomy.tags.find(tag => normalizeName(tag.name) === normalizedCurrentType);',
    '    if (canonicalTypeTag) semanticTagIds.add(Number(canonicalTypeTag.id));',
    '  }',
    '  const dateLikeTag = /^(?:januar|februar|maerz|marz|april|mai|juni|juli|august|september|oktober|november|dezember)(?:[ -]?\\d{2,4})?$|^\\d{4}$|^\\d{4}[ -]?(?:0?[1-9]|1[0-2])$|^\\d{1,2}[./-]\\d{1,2}[./-]\\d{2,4}$/i;',
    '  const scalarLikeTag = /^(?:\\d+[.,]?\\d*\\s?(?:eur|€|usd|chf)?|[a-z]{0,4}\\d{5,})$/i;',
    '  for (const selection of Array.isArray(result.tags) ? result.tags : []) {',
    '    if (semanticTagIds.size >= maxSemanticTags) break;',
    '    const tag = itemById(taxonomy.tags, selection?.existingId);',
    '    if (!tag) continue;',
    '    const normalized = normalizeName(tag.name);',
    '    if (!normalized || blockedTagNames.has(normalized) || otherDocumentTypeNames.has(normalized) || dateLikeTag.test(normalized) || scalarLikeTag.test(normalized)) continue;',
    '    semanticTagIds.add(Number(tag.id));',
    '  }',
    '  run.semanticTagIds = [...semanticTagIds];'
  ])
);

replaceRange(
  'preserve manual tags and replace only managed tags',
  'async function applyProvenanceTags(current, taxonomy, semanticTagIds, run) {',
  'function sameScalar(a, b) {',
  block([
    'async function applyProvenanceTags(current, taxonomy, semanticTagIds, run) {',
    '  const legacyIds = await cleanupLegacyToolTags(taxonomy);',
    '  const field = await ensureProvenanceCustomField(taxonomy);',
    '  const previousManagedIds = new Set((provenance[String(current.id)]?.latest?.semanticTagIds || []).map(Number).filter(Number.isInteger));',
    '  const existingIds = new Set();',
    '  for (const id of Array.isArray(current.tags) ? current.tags.map(Number) : []) {',
    '    if (legacyIds.has(id) || previousManagedIds.has(id)) continue;',
    '    existingIds.add(id);',
    '  }',
    '  for (const id of semanticTagIds) existingIds.add(Number(id));',
    '  return { ids: [...existingIds], tags: [], field, replacedManagedTags: previousManagedIds.size > 0 };',
    '}'
  ])
);

await writeFile(file, source);
