import { readFile, writeFile } from 'node:fs/promises';

const file = '/app/server.mjs';
let source = await readFile(file, 'utf8');

function replaceOnce(label, before, after) {
  if (!source.includes(before)) throw new Error(`Pipeline 13 patch failed: ${label} anchor not found`);
  source = source.replace(before, after);
}

replaceOnce(
  'flexible metadata merge target',
`async function mergeMetadata({ kind, targetId, sourceIds, confirm }) {
  if (confirm !== true) throw new Error('Merge requires confirm=true.');
  const spec = metadataMergeSpec(kind);
  if (!spec) throw new Error('Unsupported metadata kind.');
  const taxonomy = await getTaxonomy();
  const items = taxonomy[spec.collection] || [];
  const target = itemById(items, targetId);
  if (!target) throw new Error('Target metadata entry not found.');
  const uniqueSourceIds = [...new Set((Array.isArray(sourceIds) ? sourceIds : []).map(Number).filter(id => Number.isInteger(id) && id > 0 && id !== Number(target.id)))];
  if (!uniqueSourceIds.length) throw new Error('No source metadata entries supplied.');
  const details = [];
  for (const sourceId of uniqueSourceIds) {
    const source = itemById(items, sourceId);
    if (!source) { details.push({ sourceId, skipped: true, reason: 'not-found' }); continue; }
    if (kind === 'tag' && (source.is_inbox_tag || target.is_inbox_tag)) throw new Error('Inbox tags are protected and cannot be merged.');
    const documents = await listAll(`/api/documents/?${spec.filter}=${Number(source.id)}&ordering=id`);
    if (kind === 'tag') {
      await patchDocumentsInChunks(documents, document => {
        const tags = new Set((Array.isArray(document.tags) ? document.tags : []).map(Number));
        tags.delete(Number(source.id));
        tags.add(Number(target.id));
        return { tags: [...tags] };
      });
    } else {
      await patchDocumentsInChunks(documents, () => ({ [spec.field]: Number(target.id) }));
    }
    const remaining = await listAll(`/api/documents/?${spec.filter}=${Number(source.id)}&page_size=10`);
    if (remaining.length) throw new Error(`Verification failed for ${source.name}: ${remaining.length} documents still reference the source.`);
    let deleted = false;
    let deleteError = null;
    try { await paperlessFetch(`${spec.endpoint}${Number(source.id)}/`, { method: 'DELETE' }); deleted = true; }
    catch (error) { deleteError = String(error?.message || error); }
    details.push({ sourceId: Number(source.id), sourceName: source.name, targetId: Number(target.id), targetName: target.name, movedDocuments: documents.length, deleted, deleteError });
  }
  return { ok: details.every(item => item.skipped || item.deleted), kind, target: metadataEntitySummary(target), details };
}`,
`async function mergeMetadata({ kind, targetId, sourceIds, targetName, confirm }) {
  if (confirm !== true) throw new Error('Merge requires confirm=true.');
  const spec = metadataMergeSpec(kind);
  if (!spec) throw new Error('Unsupported metadata kind.');
  const taxonomy = await getTaxonomy();
  const items = taxonomy[spec.collection] || [];

  const requestedIds = [...new Set([Number(targetId), ...(Array.isArray(sourceIds) ? sourceIds : []).map(Number)]
    .filter(id => Number.isInteger(id) && id > 0))];
  if (requestedIds.length < 2) throw new Error('At least two metadata entries are required for a merge.');

  const requestedItems = requestedIds.map(id => itemById(items, id));
  if (requestedItems.some(item => !item)) throw new Error('One or more metadata entries no longer exist.');

  let target = itemById(items, Number(targetId));
  if (!target || !requestedIds.includes(Number(target.id))) throw new Error('Target metadata entry not found in merge group.');

  const customName = String(targetName || '').trim().replace(/\\s+/g, ' ').slice(0, 128);
  let renamed = false;
  let reusedExistingTarget = false;

  if (customName) {
    const exactExisting = items.find(item => normalizeName(item.name) === normalizeName(customName));
    if (exactExisting && Number(exactExisting.id) !== Number(target.id)) {
      target = exactExisting;
      reusedExistingTarget = true;
    } else if (normalizeName(target.name) !== normalizeName(customName) || String(target.name) !== customName) {
      const updated = await paperlessJson(`${spec.endpoint}${Number(target.id)}/`, {
        method: 'PATCH',
        body: JSON.stringify({ name: customName })
      });
      target = { ...target, ...updated, name: updated?.name || customName };
      renamed = true;
    }
  }

  if (kind === 'tag' && target.is_inbox_tag) throw new Error('Inbox tags are protected and cannot be merge targets.');

  const effectiveSourceIds = requestedIds.filter(id => id !== Number(target.id));
  if (!effectiveSourceIds.length) throw new Error('No source metadata entries supplied.');

  const details = [];
  for (const sourceId of effectiveSourceIds) {
    const source = itemById(items, sourceId);
    if (!source) { details.push({ sourceId, skipped: true, reason: 'not-found' }); continue; }
    if (kind === 'tag' && source.is_inbox_tag) throw new Error('Inbox tags are protected and cannot be merged.');

    const documents = await listAll(`/api/documents/?${spec.filter}=${Number(source.id)}&ordering=id`);
    if (kind === 'tag') {
      await patchDocumentsInChunks(documents, document => {
        const tags = new Set((Array.isArray(document.tags) ? document.tags : []).map(Number));
        tags.delete(Number(source.id));
        tags.add(Number(target.id));
        return { tags: [...tags] };
      });
    } else {
      await patchDocumentsInChunks(documents, () => ({ [spec.field]: Number(target.id) }));
    }

    const remaining = await listAll(`/api/documents/?${spec.filter}=${Number(source.id)}&page_size=10`);
    if (remaining.length) throw new Error(`Verification failed for ${source.name}: ${remaining.length} documents still reference the source.`);

    let deleted = false;
    let deleteError = null;
    try {
      await paperlessFetch(`${spec.endpoint}${Number(source.id)}/`, { method: 'DELETE' });
      deleted = true;
    } catch (error) {
      deleteError = String(error?.message || error);
    }

    details.push({
      sourceId: Number(source.id),
      sourceName: source.name,
      targetId: Number(target.id),
      targetName: target.name,
      movedDocuments: documents.length,
      deleted,
      deleteError
    });
  }

  return {
    ok: details.every(item => item.skipped || item.deleted),
    kind,
    target: metadataEntitySummary(target),
    renamed,
    reusedExistingTarget,
    requestedTargetId: Number(targetId),
    details
  };
}`
);

await writeFile(file, source);
