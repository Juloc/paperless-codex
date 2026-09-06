import { readFile, writeFile } from 'node:fs/promises';

const file = '/app/server.mjs';
let source = await readFile(file, 'utf8');

function replaceOnce(label, before, after) {
  if (!source.includes(before)) throw new Error(`Pipeline 18 patch failed: ${label} anchor not found`);
  source = source.replace(before, after);
}

replaceOnce(
  'protect nested tags from prune',
  "    const hasChildren = taxonomy.tags.some(tag => Number(tag.parent ?? tag.tn_parent ?? 0) === id);\n    if (hasChildren) return 'Eltern-Tag mit Untertags';",
  "    const hasChildren = (Array.isArray(item.children) && item.children.length > 0) || taxonomy.tags.some(tag => Number(tag.parent ?? tag.tn_parent ?? 0) === id);\n    if (hasChildren) return 'Eltern-Tag mit Untertags';"
);

replaceOnce(
  'isolate per-item live reference errors',
  [
    "      const referencePath = liveMetadataReferencePath(kind, id);",
    "      const referenceBody = await paperlessJson(referencePath);",
    "      const liveCount = responseDocumentCount(referenceBody);",
    "      if (liveCount !== 0) { results.push({ kind, id, name: item.name, deleted: false, skipped: true, reason: `Wird noch von ${liveCount} Dokument(en) verwendet`, liveCount }); continue; }",
    "      try {",
    "        await paperlessFetch(`${spec.endpoint}${id}/`, { method: 'DELETE' });",
    "        results.push({ kind, id, name: item.name, deleted: true, skipped: false, liveCount: 0 });",
    "      } catch (error) {",
    "        results.push({ kind, id, name: item.name, deleted: false, skipped: false, reason: String(error?.message || error), liveCount: 0 });",
    "      }"
  ].join('\n'),
  [
    "      const referencePath = liveMetadataReferencePath(kind, id);",
    "      let liveCount = null;",
    "      try {",
    "        const referenceBody = await paperlessJson(referencePath);",
    "        liveCount = responseDocumentCount(referenceBody);",
    "      } catch (error) {",
    "        results.push({ kind, id, name: item.name, deleted: false, skipped: true, reason: `Live-Prüfung fehlgeschlagen: ${String(error?.message || error)}` });",
    "        const done = pruneIndex + 1;",
    "        setMetadataProgress('prune', { current: done, percent: Math.round((done / requested.length) * 100), detail: `${item.name} · Live-Prüfung fehlgeschlagen` });",
    "        continue;",
    "      }",
    "      if (liveCount !== 0) {",
    "        results.push({ kind, id, name: item.name, deleted: false, skipped: true, reason: `Wird noch von ${liveCount} Dokument(en) verwendet`, liveCount });",
    "        const done = pruneIndex + 1;",
    "        setMetadataProgress('prune', { current: done, percent: Math.round((done / requested.length) * 100), detail: `${item.name} · noch verwendet` });",
    "        continue;",
    "      }",
    "      try {",
    "        await paperlessFetch(`${spec.endpoint}${id}/`, { method: 'DELETE' });",
    "        results.push({ kind, id, name: item.name, deleted: true, skipped: false, liveCount: 0 });",
    "      } catch (error) {",
    "        const message = String(error?.message || error);",
    "        const permissionDenied = /(?:403|forbidden|permission)/i.test(message);",
    "        results.push({ kind, id, name: item.name, deleted: false, skipped: permissionDenied, reason: permissionDenied ? `Keine Löschberechtigung: ${message}` : message, liveCount: 0 });",
    "      }"
  ].join('\n')
);

await writeFile(file, source);
