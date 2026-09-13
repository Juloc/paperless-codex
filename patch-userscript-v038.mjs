import { readFile, writeFile } from 'node:fs/promises';

const file = 'paperless-codex.user.js';
let source = await readFile(file, 'utf8');

function replaceOnce(label, before, after) {
  if (!source.includes(before)) throw new Error(`Userscript v0.3.8 patch failed: ${label}`);
  source = source.replace(before, after);
}

replaceOnce('version', '// @version      0.3.7', '// @version      0.3.8');

replaceOnce(
  'manual scan controls',
  '<div class="pc-manual-form"><label for="pc-document-id">Dokument-ID<input id="pc-document-id" type="number" min="1" step="1" inputmode="numeric" placeholder="z. B. 123"></label><button class="pc-btn pc-btn-primary" id="pc-rescan">Erneut scannen</button></div>\n            <div class="pc-muted pc-manual-result" id="pc-manual-result">Öffnest du Codex auf einer Dokumentseite, wird die ID automatisch übernommen.</div>',
  '<div class="pc-manual-form"><label for="pc-document-id">Dokument-ID<input id="pc-document-id" type="number" min="1" step="1" inputmode="numeric" placeholder="z. B. 123"></label><div class="pc-actions" style="margin-top:0"><button class="pc-btn pc-btn-primary" id="pc-rescan">Smart erneut scannen</button><button class="pc-btn" id="pc-fullscan">Vollständiger OCR-Scan</button></div></div>\n            <div class="pc-muted pc-manual-result" id="pc-manual-result">Smart: Metadaten mit Luna, lokalem PDF-Text/Tesseract und wenigen Seiten; bestehender OCR-Text bleibt erhalten. Vollständiger OCR-Scan: alle Seiten, deutlich teurer, OCR darf validiert ersetzt werden.</div>'
);

const fullFunction = `

  async function fullScanDocument() {
    const documentId = Number(q('pc-document-id').value);
    if (!Number.isInteger(documentId) || documentId <= 0) {
      setBadge('pc-manual-badge', 'bad', 'Ungültige ID');
      q('pc-manual-result').textContent = 'Bitte eine gültige Paperless-Dokument-ID eingeben.';
      return;
    }
    if (!window.confirm(\`Dokument #\${documentId} wirklich vollständig per OCR scannen?\\n\\nDabei werden alle Seiten bis zum Vollscan-Limit analysiert. Das verbraucht deutlich mehr Codex-Kontingent als Smart Scan und kann den Paperless-OCR-Text nach Validierung ersetzen.\`)) return;
    const smartButton = q('pc-rescan');
    const fullButton = q('pc-fullscan');
    smartButton.disabled = true;
    fullButton.disabled = true;
    setBadge('pc-manual-badge', 'warn', 'Vollscan eingereiht');
    q('pc-manual-result').textContent = \`Dokument #\${documentId} wird für vollständigen OCR-Scan eingereiht…\`;
    try {
      const result = await request(\`ui-api/documents/\${documentId}/scan-full\`, { method: 'POST', body: {} });
      setBadge('pc-manual-badge', 'ok', 'Vollscan in Queue');
      q('pc-manual-result').textContent = \`Dokument #\${result.documentId || documentId} wurde als vollständiger OCR-Scan zur Queue hinzugefügt.\`;
      await refresh();
    } catch (error) {
      setBadge('pc-manual-badge', 'bad', 'Fehler');
      q('pc-manual-result').textContent = String(error.message || error);
      showError(error);
    } finally {
      smartButton.disabled = false;
      fullButton.disabled = false;
    }
  }`;

replaceOnce('full scan function insertion', '\n\n  function bindPanel(root) {', fullFunction + '\n\n  function bindPanel(root) {');
replaceOnce("full scan bind", "    q('pc-rescan').onclick = rescanDocument;", "    q('pc-rescan').onclick = rescanDocument;\n    q('pc-fullscan').onclick = fullScanDocument;");

await writeFile(file, source);
