import { readFile, writeFile } from 'node:fs/promises';

const file = '/app/server.mjs';
let source = await readFile(file, 'utf8');

function replaceOnce(label, before, after) {
  if (!source.includes(before)) throw new Error(`Pipeline 23 patch failed: ${label} anchor not found`);
  source = source.replace(before, after);
}

replaceOnce(
  'smart scan state paths',
  "const backupDir = path.join(stateDir, 'ocr-backups');",
  "const backupDir = path.join(stateDir, 'ocr-backups');\nconst analysisCacheDir = path.join(stateDir, 'analysis-cache');\nconst scanModesPath = path.join(stateDir, 'scan-modes.json');"
);

replaceOnce(
  'smart scan settings',
  "const configuredModel = String(process.env.CODEX_MODEL || '').trim();",
  "const configuredModel = String(process.env.CODEX_MODEL || '').trim();\nconst smartPrimaryModel = String(process.env.SMART_PRIMARY_MODEL || 'gpt-5.6-luna').trim();\nconst smartStrongModel = String(process.env.SMART_STRONG_MODEL || configuredModel || 'gpt-5.6-sol').trim();\nconst smartEscalateConfidence = Math.max(0.55, Math.min(0.95, Number(process.env.SMART_ESCALATE_CONFIDENCE || 0.68)));\nconst smartTextMinChars = Math.max(80, Number(process.env.SMART_TEXT_MIN_CHARS || 300));\nconst smartTextMaxChars = Math.max(4000, Math.min(80000, Number(process.env.SMART_TEXT_MAX_CHARS || 24000)));\nconst smartVisionPages = Math.max(1, Math.min(5, Number(process.env.SMART_VISION_PAGES || 3)));\nconst smartVisionDpi = Math.max(96, Math.min(180, Number(process.env.SMART_VISION_DPI || 110)));\nconst fullScanMaxPages = Math.max(1, Math.min(100, Number(process.env.FULL_SCAN_MAX_PAGES || 50)));\nconst fullScanDpi = Math.max(110, Math.min(220, Number(process.env.FULL_SCAN_DPI || 150)));\nconst analysisCacheVersion = String(process.env.ANALYSIS_CACHE_VERSION || 'smart-v1').trim();"
);

replaceOnce(
  'smart scan dirs',
  "await mkdir(backupDir, { recursive: true });",
  "await mkdir(backupDir, { recursive: true });\nawait mkdir(analysisCacheDir, { recursive: true });"
);

replaceOnce(
  'load scan modes',
  "const provenance = await loadJson(provenancePath, {});",
  "const provenance = await loadJson(provenancePath, {});\nlet scanModes = await loadJson(scanModesPath, {});"
);

replaceOnce(
  'save scan modes',
  "async function saveDiscoveryState() {",
  "async function saveScanModes() {\n  await atomicWriteJson(scanModesPath, scanModes);\n}\n\nasync function saveDiscoveryState() {"
);

const extractionStart = source.indexOf('async function runExtraction(');
const extractionEnd = source.indexOf('\n\nasync function resolveMetadata(', extractionStart);
if (extractionStart < 0 || extractionEnd < 0) throw new Error('Pipeline 23 patch failed: runExtraction range not found');
const extractionReplacement = `async function runExtraction(runDir, images, prompt, { model = configuredModel || null } = {}) {
  const schemaPath = path.join(runDir, 'schema.json');
  const outputPath = path.join(runDir, 'result.json');
  await writeFile(schemaPath, JSON.stringify(extractionSchema()), { mode: 0o600 });
  const args = ['exec', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--json', '--sandbox', 'read-only'];
  for (const image of images || []) args.push('--image', image);
  args.push('--output-schema', schemaPath, '--output-last-message', outputPath);
  if (model) args.push('--model', model);
  args.push('-');
  const execution = await spawnCapture('codex', args, {
    cwd: runDir,
    timeoutMs: codexTimeoutMs,
    env: { ...process.env, CODEX_HOME: codexHome },
    stdinData: prompt
  });
  if (execution.code !== 0) throw new Error(\`Codex scan failed: \${execution.stderr.slice(-2000) || execution.stdout.slice(-2000)}\`);
  const raw = await readFile(outputPath, 'utf8');
  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) result = JSON.parse(raw.slice(start, end + 1));
    else throw new Error('Codex returned no valid structured JSON.');
  }
  return { result, resolvedModel: detectResolvedModel(execution.stdout) || model || 'account-default' };
}`;
source = source.slice(0, extractionStart) + extractionReplacement + source.slice(extractionEnd);

replaceOnce(
  'disable automatic OCR replacement',
  "function decideOcrReplacement(existingText, candidateText, ocrConfidence, run = null) {",
  "function decideOcrReplacement(existingText, candidateText, ocrConfidence, run = null) {\n  if (run?.scanMode !== 'full') { const oldMetrics = textMetrics(existingText); const newMetrics = textMetrics(candidateText); return { replace: false, reason: 'Smart scan: OCR content is preserved; use manual full OCR scan to replace it', oldMetrics, newMetrics }; }"
);

const scanStart = source.indexOf('async function scanPaperlessDocument(documentId) {');
const scanEnd = source.indexOf('\n\nfunction parseAuthHints', scanStart);
if (scanStart < 0 || scanEnd < 0) throw new Error('Pipeline 23 patch failed: scanPaperlessDocument range not found');

const smartHelpersAndScan = `function namedCandidateScore(item, evidenceNormalized, currentIds = new Set()) {
  const id = Number(item?.id);
  if (currentIds.has(id)) return 100000;
  const name = normalizeName(item?.name);
  if (!name) return 0;
  let score = 0;
  if (evidenceNormalized && evidenceNormalized.includes(name)) score += 5000 + Math.min(500, name.length * 5);
  const tokens = name.split(' ').filter(token => token.length >= 3);
  for (const token of tokens) if (evidenceNormalized.includes(token)) score += 120;
  score += Math.min(80, Math.log2(Number(item?.document_count || item?.documentCount || 0) + 1) * 10);
  return score;
}

function selectNamedCandidates(items, evidence, currentIds, limit) {
  const normalized = normalizeName(String(evidence || '').slice(0, smartTextMaxChars));
  const ids = new Set((currentIds || []).map(Number).filter(Number.isInteger));
  const ranked = items
    .map(item => ({ item, score: namedCandidateScore(item, normalized, ids) }))
    .sort((a, b) => b.score - a.score || Number(b.item?.document_count || 0) - Number(a.item?.document_count || 0));
  const chosen = [];
  const used = new Set();
  for (const entry of ranked) {
    const id = Number(entry.item?.id);
    if (!Number.isInteger(id) || used.has(id)) continue;
    if (chosen.length >= limit && !ids.has(id)) continue;
    chosen.push(entry.item);
    used.add(id);
    if (chosen.length >= limit && [...ids].every(currentId => used.has(currentId))) break;
  }
  return chosen;
}

function smartTaxonomy(taxonomy, current, evidence) {
  const tagIds = Array.isArray(current?.tags) ? current.tags.map(Number) : [];
  const customFieldIds = Array.isArray(current?.custom_fields) ? current.custom_fields.map(item => Number(item?.field)).filter(Number.isInteger) : [];
  return {
    correspondents: selectNamedCandidates(taxonomy.correspondents, evidence, [current?.correspondent], 40),
    documentTypes: selectNamedCandidates(taxonomy.documentTypes, evidence, [current?.document_type], 30),
    tags: selectNamedCandidates(taxonomy.tags, evidence, tagIds, 50),
    storagePaths: selectNamedCandidates(taxonomy.storagePaths, evidence, [current?.storage_path], 20),
    customFields: taxonomy.customFields
      .filter(field => customFieldIds.includes(Number(field.id)) || taxonomy.customFields.length <= 100)
      .slice(0, 100)
  };
}

function pageKeywordScore(text) {
  const value = String(text || '').toLocaleLowerCase('de-DE');
  const hits = value.match(/rechnung|rechnungsnummer|kundennummer|vertragsnummer|aktenzeichen|betrag|gesamt|summe|iban|bic|steuer|steuerjahr|brutto|netto|zahlung|kündigung|vertrag|beleg|kassenbon|bestellung|lieferung|datum|fälligkeit/gi) || [];
  return hits.length;
}

function selectEvidenceText(pages) {
  const cleanPages = (pages || []).map((text, index) => ({ index, text: String(text || '').trim() })).filter(page => page.text);
  if (!cleanPages.length) return { text: '', selectedPages: [] };
  const selected = new Set([0]);
  if (cleanPages.length > 1) selected.add(1);
  selected.add(cleanPages.length - 1);
  for (const page of cleanPages.slice().sort((a, b) => pageKeywordScore(b.text) - pageKeywordScore(a.text))) {
    if (selected.size >= 5) break;
    selected.add(page.index);
  }
  const ordered = [...selected].sort((a, b) => a - b);
  let remaining = smartTextMaxChars;
  const chunks = [];
  for (const index of ordered) {
    const text = String(pages[index] || '').trim();
    if (!text || remaining <= 0) continue;
    const piece = text.slice(0, remaining);
    chunks.push(\`--- Seite \${index + 1} ---\n\${piece}\`);
    remaining -= piece.length;
  }
  return { text: chunks.join('\n\n'), selectedPages: ordered.map(index => index + 1) };
}

async function pdfPageCount(input, runDir) {
  const info = await spawnCapture('pdfinfo', [input], { cwd: runDir, timeoutMs: 20000 });
  const match = info.stdout.match(/^Pages:\\s+(\\d+)/mi);
  return match ? Number(match[1]) : null;
}

async function renderSelectedPdfPages(input, runDir, pages, dpi, prefix = 'smart') {
  const images = [];
  for (const page of [...new Set(pages)].filter(page => Number.isInteger(page) && page > 0)) {
    const base = path.join(runDir, \`\${prefix}-\${page}\`);
    const rendered = await spawnCapture('pdftoppm', ['-f', String(page), '-l', String(page), '-singlefile', '-jpeg', '-jpegopt', 'quality=82', '-r', String(dpi), input, base], { cwd: runDir, timeoutMs: 90000 });
    if (rendered.code !== 0) throw new Error(\`PDF sample rendering failed on page \${page}: \${rendered.stderr.slice(0, 800)}\`);
    images.push(\`\${base}.jpg\`);
  }
  return images;
}

async function prepareSmartScan(runDir, document, documentId) {
  const input = path.join(runDir, \`document\${document.ext}\`);
  await writeFile(input, document.bytes, { mode: 0o600 });
  if (document.ext !== '.pdf') {
    return { images: [input], textEvidence: '', selectedPages: [1], pages: 1, truncated: false, inputMode: 'vision-image' };
  }

  const pages = await pdfPageCount(input, runDir);
  const textResult = await spawnCapture('pdftotext', ['-layout', input, '-'], { cwd: runDir, timeoutMs: 60000 });
  const rawText = textResult.code === 0 ? textResult.stdout : '';
  const textPages = rawText.split('\\f');
  const metrics = textMetrics(rawText);
  if (metrics.length >= smartTextMinChars && metrics.words >= 30 && metrics.suspiciousRatio <= 0.08) {
    const evidence = selectEvidenceText(textPages);
    log('scan', 'Smart scan uses embedded PDF text without vision.', { documentId, sourcePages: pages, evidencePages: evidence.selectedPages, evidenceChars: evidence.text.length });
    return { images: [], textEvidence: evidence.text, selectedPages: evidence.selectedPages, pages: pages || textPages.length, truncated: false, inputMode: 'embedded-text' };
  }

  const count = pages || 1;
  const candidates = [1, 2, count].filter(page => page <= count);
  for (let page = 3; candidates.length < smartVisionPages && page < count; page++) candidates.push(page);
  const selectedPages = [...new Set(candidates)].slice(0, smartVisionPages);
  const images = await renderSelectedPdfPages(input, runDir, selectedPages, smartVisionDpi, 'smart');
  log('scan', 'Smart scan uses sampled vision pages.', { documentId, sourcePages: pages, selectedPages, dpi: smartVisionDpi });
  return { images, textEvidence: '', selectedPages, pages: count, truncated: count > selectedPages.length, inputMode: 'vision-sample' };
}

async function prepareFullScan(runDir, document, documentId) {
  const input = path.join(runDir, \`document\${document.ext}\`);
  await writeFile(input, document.bytes, { mode: 0o600 });
  if (document.ext !== '.pdf') return { images: [input], textEvidence: '', selectedPages: [1], pages: 1, truncated: false, inputMode: 'full-vision' };
  const pages = await pdfPageCount(input, runDir);
  const last = Math.min(pages || fullScanMaxPages, fullScanMaxPages);
  const selectedPages = Array.from({ length: last }, (_, index) => index + 1);
  const images = await renderSelectedPdfPages(input, runDir, selectedPages, fullScanDpi, 'full');
  log('scan', 'Manual full OCR scan rendered pages.', { documentId, sourcePages: pages, pages: images.length, dpi: fullScanDpi });
  return { images, textEvidence: '', selectedPages, pages: pages || images.length, truncated: Boolean(pages && pages > images.length), inputMode: 'full-vision' };
}

function buildSmartPrompt(taxonomy, pageInfo) {
  const evidence = pageInfo.textEvidence
    ? \`\\n\\nLOKAL AUS DEM ORIGINAL-PDF EXTRAHIERTER TEXT (kein Paperless-OCR):\\n\${pageInfo.textEvidence}\`
    : '';
  return \`Du analysierst genau EIN Dokument für Paperless-ngx. Dieser Lauf ist isoliert und darf keine Annahmen aus anderen Dokumenten übernehmen.\\n\\nZIEL:\\n- Metadaten so vollständig und präzise wie möglich pflegen: Titel, Dokumentdatum, Korrespondent, Empfänger, Dokumenttyp, sinnvolle Tags, Storage Path und passende vorhandene Custom Fields.\\n- Nutze ausschließlich das Originaldokument bzw. den lokal aus dem Original-PDF extrahierten Text.\\n- Dieser automatische Smart-Scan ist KEIN OCR-Lauf. Setze fullText immer auf \"\" und ocrConfidence auf 0. Der bestehende Paperless-Volltext wird nicht ersetzt.\\n- Erfinde nichts. IDs/Nummern/Beträge/Datumswerte nur übernehmen, wenn sie im Dokument eindeutig vorhanden sind.\\n- Vorhandene Kandidaten bevorzugen und existingId verwenden. Wenn wirklich kein Kandidat passt, existingId=null und einen sauberen Namen vorschlagen.\\n- Tags sind dauerhafte semantische Themen, keine Einzelwerte. Datumswerte, Beträge, Rechnungsnummern, Kunden-/Vertragsnummern und Aktenzeichen gehören in passende Custom Fields, nicht in Tags.\\n- Nutze alle eindeutig passenden Custom Fields aus der Kandidatenliste.\\n- confidence bewertet die Sicherheit der gesamten Metadatenanalyse.\\n\\nVORSELEKTIERTE PAPERLESS-KANDIDATEN (lokal per normalem Code reduziert):\\n\${JSON.stringify(compactTaxonomy(taxonomy))}\\n\\nEINGABE: Modus=\${pageInfo.inputMode}, Gesamtseiten=\${pageInfo.pages}, berücksichtigte Seiten=\${pageInfo.selectedPages.join(',') || 'Textauswahl'}.\${evidence}\\n\\nAntworte ausschließlich entsprechend dem JSON-Schema.\`;
}

function analysisCacheFile(documentBytes, mode) {
  const sha = crypto.createHash('sha256').update(documentBytes).digest('hex');
  const key = crypto.createHash('sha256').update(\`\${analysisCacheVersion}|\${mode}|\${sha}|\${smartPrimaryModel}|\${smartStrongModel}\`).digest('hex');
  return { sha, file: path.join(analysisCacheDir, \`\${key}.json\`) };
}

async function loadAnalysisCache(cache) {
  try {
    const value = JSON.parse(await readFile(cache.file, 'utf8'));
    return value?.result ? value : null;
  } catch {
    return null;
  }
}

async function saveAnalysisCache(cache, value) {
  await atomicWriteJson(cache.file, value);
}

async function enqueueScanMode(documentId, mode) {
  scanModes[String(documentId)] = mode === 'full' ? 'full' : 'smart';
  await saveScanModes();
  await enqueue(documentId);
}

async function scanPaperlessDocument(documentId) {
  const status = await codexStatus();
  if (!status.connected) throw new Error(\`Codex is not logged in. \${status.statusText || ''}\`.trim());
  const scanMode = scanModes[String(documentId)] === 'full' ? 'full' : 'smart';
  const runDir = path.join(workRoot, \`\${documentId}-\${crypto.randomUUID()}\`);
  await mkdir(runDir, { recursive: true });
  const startedAt = new Date().toISOString();
  try {
    const [current, taxonomy, document] = await Promise.all([
      paperlessJson(\`/api/documents/\${documentId}/\`),
      getTaxonomy(),
      downloadDocument(documentId)
    ]);

    const pageInfo = scanMode === 'full'
      ? await prepareFullScan(runDir, document, documentId)
      : await prepareSmartScan(runDir, document, documentId);

    const reducedTaxonomy = smartTaxonomy(taxonomy, current, pageInfo.textEvidence || current.title || '');
    const prompt = scanMode === 'full'
      ? buildPrompt(reducedTaxonomy, pageInfo)
      : buildSmartPrompt(reducedTaxonomy, pageInfo);

    const cache = analysisCacheFile(document.bytes, scanMode);
    let cacheHit = false;
    let escalated = false;
    let extraction = null;

    if (scanMode === 'smart') {
      const cached = await loadAnalysisCache(cache);
      if (cached) {
        extraction = { result: cached.result, resolvedModel: cached.resolvedModel || smartPrimaryModel };
        escalated = Boolean(cached.escalated);
        cacheHit = true;
        log('scan', 'Reused cached AI analysis; no Codex call needed.', { documentId, scanMode, model: extraction.resolvedModel });
      }
    }

    if (!extraction) {
      try {
        extraction = await runExtraction(runDir, pageInfo.images, prompt, { model: smartPrimaryModel });
      } catch (error) {
        if (typeof isUsageLimitError === 'function' && isUsageLimitError(error)) throw error;
        if (!smartStrongModel || smartStrongModel === smartPrimaryModel) throw error;
        escalated = true;
        log('scan', 'Luna scan failed; escalating once to strong model.', { documentId, error: String(error?.message || error), model: smartStrongModel });
        extraction = await runExtraction(runDir, pageInfo.images, prompt, { model: smartStrongModel });
      }

      if (Number(extraction.result?.confidence) < smartEscalateConfidence && smartStrongModel && smartStrongModel !== extraction.resolvedModel) {
        escalated = true;
        log('scan', 'Smart scan confidence low; escalating once.', { documentId, confidence: extraction.result?.confidence, threshold: smartEscalateConfidence, from: extraction.resolvedModel, to: smartStrongModel });
        extraction = await runExtraction(runDir, pageInfo.images, prompt, { model: smartStrongModel });
      }

      if (scanMode === 'smart') {
        await saveAnalysisCache(cache, { savedAt: new Date().toISOString(), result: extraction.result, resolvedModel: extraction.resolvedModel, escalated }).catch(() => {});
      }
    }

    const result = extraction.result;
    if (!Number.isFinite(result.confidence) || result.confidence < minConfidence) {
      throw new Error(\`Codex confidence \${result.confidence ?? 'unknown'} is below MIN_CONFIDENCE=\${minConfidence}.\`);
    }
    if (pageInfo.truncated && scanMode === 'full') {
      result.warnings ||= [];
      result.warnings.push(\`Full scan was limited to \${pageInfo.images.length} of \${pageInfo.pages} pages.\`);
    }

    const run = {
      runId: crypto.randomUUID(),
      startedAt,
      finishedAt: null,
      tool: 'paperless-codex',
      toolVersion,
      pipelineVersion,
      scanMode,
      inputMode: pageInfo.inputMode,
      model: extraction.resolvedModel,
      primaryModel: smartPrimaryModel,
      escalated,
      cacheHit,
      codexVersion: status.codexVersion || null,
      confidence: Number(result.confidence),
      pagesScanned: pageInfo.images.length,
      selectedPages: pageInfo.selectedPages,
      totalPages: pageInfo.pages,
      inputSha256: cache.sha,
      ocrReplaced: false,
      ocrConfidence: Number(result.ocrConfidence),
      ocrDecision: null,
      warnings: result.warnings || []
    };

    const reviewRequired = Number(result.confidence) < autoApplyConfidence;
    const reviewSuggestions = reviewRequired ? { title: result.title, created: result.created, correspondent: result.correspondent, recipient: result.recipient, documentType: result.documentType, tags: result.tags, storagePath: result.storagePath, customFields: result.customFields, summary: result.summary } : null;
    if (reviewRequired) {
      result.warnings ||= [];
      result.warnings.push(\`Automatic metadata write-back skipped because confidence \${Number(result.confidence).toFixed(3)} is below AUTO_APPLY_CONFIDENCE=\${autoApplyConfidence}.\`);
      result.title = null; result.created = null; result.correspondent = null; result.documentType = null; result.tags = []; result.storagePath = null; result.customFields = [];
    }
    run.reviewRequired = reviewRequired;
    run.reviewSuggestions = reviewSuggestions;

    const applied = await applyResult(documentId, current, taxonomy, result, run);
    run.finishedAt = new Date().toISOString();
    run.appliedCustomFields = applied.appliedCustomFields.map(x => x.fieldName);
    run.provenanceTags = applied.provenanceTags.map(x => x.name);
    await recordProvenance(documentId, run);

    delete scanModes[String(documentId)];
    await saveScanModes().catch(() => {});

    log('scan', 'Document scanned and updated.', {
      documentId,
      scanMode,
      inputMode: pageInfo.inputMode,
      confidence: result.confidence,
      pagesSentToModel: pageInfo.images.length,
      selectedPages: pageInfo.selectedPages,
      model: run.model,
      escalated,
      cacheHit,
      pipelineVersion,
      ocrReplaced: run.ocrReplaced,
      ocrDecision: run.ocrDecision
    });

    return {
      confidence: result.confidence,
      ocrConfidence: result.ocrConfidence,
      ocrReplaced: run.ocrReplaced,
      ocrDecision: run.ocrDecision,
      scanMode,
      inputMode: pageInfo.inputMode,
      model: run.model,
      primaryModel: smartPrimaryModel,
      escalated,
      cacheHit,
      toolVersion,
      pipelineVersion,
      codexVersion: run.codexVersion,
      pagesScanned: pageInfo.images.length,
      selectedPages: pageInfo.selectedPages,
      totalPages: pageInfo.pages,
      warnings: result.warnings || [],
      recipient: result.recipient || null,
      appliedCustomFields: applied.appliedCustomFields,
      provenanceTags: applied.provenanceTags,
      patch: applied.patch
    };
  } finally {
    await rm(runDir, { recursive: true, force: true }).catch(() => {});
  }
}`;

source = source.slice(0, scanStart) + smartHelpersAndScan + source.slice(scanEnd);

replaceOnce(
  'manual smart and full scan routes',
  "    const scanMatch = url.pathname.match(/^\\/documents\\/(\\d+)\\/scan$/); if (req.method === 'POST' && scanMatch) { const documentId = Number(scanMatch[1]); await enqueue(documentId); return send(res, 202, { accepted: true, documentId }); }",
  "    const fullScanMatch = url.pathname.match(/^\\/documents\\/(\\d+)\\/scan-full$/); if (req.method === 'POST' && fullScanMatch) { const documentId = Number(fullScanMatch[1]); await enqueueScanMode(documentId, 'full'); return send(res, 202, { accepted: true, documentId, mode: 'full' }); }\n    const scanMatch = url.pathname.match(/^\\/documents\\/(\\d+)\\/scan$/); if (req.method === 'POST' && scanMatch) { const documentId = Number(scanMatch[1]); await enqueueScanMode(documentId, 'smart'); return send(res, 202, { accepted: true, documentId, mode: 'smart' }); }"
);

await writeFile(file, source);
