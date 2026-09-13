import { readFile, writeFile } from 'node:fs/promises';

const file = '/app/server.mjs';
let source = await readFile(file, 'utf8');

function replaceOnce(label, before, after) {
  if (!source.includes(before)) throw new Error(`Pipeline 24 patch failed: ${label} anchor not found`);
  source = source.replace(before, after);
}

// Pipeline 23 intentionally generates runtime source. Repair escaped newlines that
// became literal newlines inside a single-quoted runtime string.
source = source.replace("chunks.join('\n\n')", "chunks.join('\\n\\n')");

replaceOnce(
  'resolved model provenance',
  "  return { result, resolvedModel: detectResolvedModel(execution.stdout) || model || 'account-default' };",
  "  const detectedModel = detectResolvedModel(execution.stdout);\n  const resolvedModel = detectedModel === 'account-default' && model ? model : (detectedModel || model || 'account-default');\n  return { result, resolvedModel };"
);

replaceOnce(
  'broad custom field candidates',
  "  const customFieldIds = Array.isArray(current?.custom_fields) ? current.custom_fields.map(item => Number(item?.field)).filter(Number.isInteger) : [];\n  return {\n    correspondents: selectNamedCandidates(taxonomy.correspondents, evidence, [current?.correspondent], 40),\n    documentTypes: selectNamedCandidates(taxonomy.documentTypes, evidence, [current?.document_type], 30),\n    tags: selectNamedCandidates(taxonomy.tags, evidence, tagIds, 50),\n    storagePaths: selectNamedCandidates(taxonomy.storagePaths, evidence, [current?.storage_path], 20),\n    customFields: taxonomy.customFields\n      .filter(field => customFieldIds.includes(Number(field.id)) || taxonomy.customFields.length <= 100)\n      .slice(0, 100)\n  };",
  "  const currentFieldIds = new Set((Array.isArray(current?.custom_fields) ? current.custom_fields : []).map(item => Number(item?.field)).filter(Number.isInteger));\n  const customFields = [...taxonomy.customFields].sort((a, b) => Number(currentFieldIds.has(Number(b.id))) - Number(currentFieldIds.has(Number(a.id)))).slice(0, 100);\n  return {\n    correspondents: selectNamedCandidates(taxonomy.correspondents, evidence, [current?.correspondent], 40),\n    documentTypes: selectNamedCandidates(taxonomy.documentTypes, evidence, [current?.document_type], 30),\n    tags: selectNamedCandidates(taxonomy.tags, evidence, tagIds, 50),\n    storagePaths: selectNamedCandidates(taxonomy.storagePaths, evidence, [current?.storage_path], 20),\n    customFields\n  };"
);

replaceOnce(
  'local OCR helper insertion',
  "async function prepareSmartScan(runDir, document, documentId) {",
  `async function localOcrEvidence(images, runDir) {
  const chunks = [];
  for (let index = 0; index < images.length; index++) {
    const result = await spawnCapture('tesseract', [images[index], 'stdout', '-l', 'deu+eng', '--psm', '6'], { cwd: runDir, timeoutMs: 90000 });
    if (result.code === 0 && String(result.stdout || '').trim()) chunks.push(\`--- Seite \${index + 1} ---\\n\${String(result.stdout).trim()}\`);
  }
  const text = chunks.join('\\n\\n').slice(0, smartTextMaxChars);
  return { text, metrics: textMetrics(text) };
}

async function downscaleImage(input, runDir) {
  const output = path.join(runDir, 'smart-image.jpg');
  const result = await spawnCapture('convert', [input, '-auto-orient', '-resize', '1800x1800>', '-strip', '-quality', '82', output], { cwd: runDir, timeoutMs: 60000 });
  return result.code === 0 ? output : input;
}

async function prepareSmartScan(runDir, document, documentId) {`
);

replaceOnce(
  'smart image local OCR',
  "  if (document.ext !== '.pdf') {\n    return { images: [input], textEvidence: '', selectedPages: [1], pages: 1, truncated: false, inputMode: 'vision-image' };\n  }",
  `  if (document.ext !== '.pdf') {
    const optimized = await downscaleImage(input, runDir);
    const local = await localOcrEvidence([optimized], runDir);
    if (local.metrics.length >= 100 && local.metrics.words >= 15 && local.metrics.suspiciousRatio <= 0.10) {
      log('scan', 'Smart image scan uses local OCR text before AI.', { documentId, evidenceChars: local.text.length });
      return { images: [], fallbackImages: [optimized], textEvidence: local.text, selectedPages: [1], pages: 1, truncated: false, inputMode: 'local-ocr-text' };
    }
    return { images: [optimized], fallbackImages: [optimized], textEvidence: '', selectedPages: [1], pages: 1, truncated: false, inputMode: 'vision-image' };
  }`
);

replaceOnce(
  'smart scanned PDF local OCR',
  "  const images = await renderSelectedPdfPages(input, runDir, selectedPages, smartVisionDpi, 'smart');\n  log('scan', 'Smart scan uses sampled vision pages.', { documentId, sourcePages: pages, selectedPages, dpi: smartVisionDpi });\n  return { images, textEvidence: '', selectedPages, pages: count, truncated: count > selectedPages.length, inputMode: 'vision-sample' };",
  `  const images = await renderSelectedPdfPages(input, runDir, selectedPages, smartVisionDpi, 'smart');
  const local = await localOcrEvidence(images, runDir);
  if (local.metrics.length >= 180 && local.metrics.words >= 25 && local.metrics.suspiciousRatio <= 0.10) {
    log('scan', 'Smart scanned PDF uses local OCR text before AI.', { documentId, sourcePages: pages, selectedPages, evidenceChars: local.text.length });
    return { images: [], fallbackImages: images, textEvidence: local.text, selectedPages, pages: count, truncated: count > selectedPages.length, inputMode: 'local-ocr-text' };
  }
  log('scan', 'Local OCR was insufficient; Luna receives sampled vision pages.', { documentId, sourcePages: pages, selectedPages, dpi: smartVisionDpi });
  return { images, fallbackImages: images, textEvidence: '', selectedPages, pages: count, truncated: count > selectedPages.length, inputMode: 'vision-sample' };`
);

replaceOnce(
  'strong model visual fallback',
  "        extraction = await runExtraction(runDir, pageInfo.images, prompt, { model: smartStrongModel });",
  "        const strongImages = Array.isArray(pageInfo.fallbackImages) && pageInfo.fallbackImages.length ? pageInfo.fallbackImages : pageInfo.images;\n        extraction = await runExtraction(runDir, strongImages, prompt, { model: smartStrongModel });"
);

replaceOnce(
  'strong low-confidence visual fallback',
  "        extraction = await runExtraction(runDir, pageInfo.images, prompt, { model: smartStrongModel });\n      }\n\n      if (scanMode === 'smart') {",
  "        const strongImages = Array.isArray(pageInfo.fallbackImages) && pageInfo.fallbackImages.length ? pageInfo.fallbackImages : pageInfo.images;\n        extraction = await runExtraction(runDir, strongImages, prompt, { model: smartStrongModel });\n      }\n\n      if (scanMode === 'smart') {"
);

await writeFile(file, source);
