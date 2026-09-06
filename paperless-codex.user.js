// ==UserScript==
// @name         Paperless Codex
// @namespace    https://github.com/Juloc/paperless-codex
// @version      0.3.0
// @description  Integriert Paperless Codex direkt in die Paperless-ngx-Oberfläche.
// @match        https://paperless.juloc.de/*
// @match        https://www.paperless.juloc.de/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const KEY = 'paperlessCodexUrl';
  const DEFAULT_URL = 'http://192.168.1.26:8484/';
  const previousUrl = GM_getValue(KEY, '');
  if (/^http:\/\/(?:127\.0\.0\.1|localhost):8484\/?$/i.test(previousUrl)) GM_setValue(KEY, DEFAULT_URL);
  let refreshTimer = null;
  let authTimer = null;
  const assistantHistory = [];

  function icon() {
    return `<svg class="me-2" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0a.75.75 0 0 1 .72.54l.72 2.47a4.25 4.25 0 0 0 2.89 2.89l2.47.72a.75.75 0 0 1 0 1.44l-2.47.72a4.25 4.25 0 0 0-2.89 2.89l-.72 2.47a.75.75 0 0 1-1.44 0l-.72-2.47a4.25 4.25 0 0 0-2.89-2.89L.54 8.06a.75.75 0 0 1 0-1.44l2.47-.72A4.25 4.25 0 0 0 5.9 3.01L6.62.54A.75.75 0 0 1 8 0Z"/>
    </svg>`;
  }

  function normalizedUrl(value) {
    try {
      const url = new URL(String(value || '').trim());
      if (!/^https?:$/.test(url.protocol)) return null;
      url.pathname = url.pathname.replace(/\/+$/, '') + '/';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      return null;
    }
  }

  function getBaseUrl() {
    return normalizedUrl(GM_getValue(KEY, ''));
  }

  function request(path, { method = 'GET', body = null, timeout = 20000 } = {}) {
    const base = getBaseUrl();
    if (!base) return Promise.reject(new Error('Codex-URL ist noch nicht eingerichtet.'));
    const url = new URL(path.replace(/^\//, ''), base).toString();
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        data: body ? JSON.stringify(body) : undefined,
        timeout,
        onload(response) {
          let value = {};
          try { value = JSON.parse(response.responseText || '{}'); } catch {}
          if (response.status >= 200 && response.status < 300) resolve(value);
          else reject(new Error(value.error || `HTTP ${response.status}`));
        },
        ontimeout() { reject(new Error('Zeitüberschreitung beim Codex-Dienst.')); },
        onerror() { reject(new Error('Codex-Dienst nicht erreichbar.')); }
      });
    });
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  }

  function currentPaperlessDocumentId() {
    const match = location.pathname.match(/\/documents\/(\d+)(?:\/|$)/i);
    return match ? Number(match[1]) : null;
  }

  function ensureStyles() {
    if (document.getElementById('paperless-codex-style')) return;
    const style = document.createElement('style');
    style.id = 'paperless-codex-style';
    style.textContent = `
      #paperless-codex-panel{position:fixed;right:0;bottom:0;z-index:1025;overflow:auto;background:var(--bs-body-bg,#fff);color:var(--bs-body-color,#212529);padding:24px;display:none}
      #paperless-codex-panel.pc-open{display:block}
      .pc-wrap{max-width:1100px;margin:0 auto}.pc-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:20px}
      .pc-title{font-size:1.6rem;font-weight:500;margin:0}.pc-sub{color:var(--bs-secondary-color,#6c757d);margin-top:4px}
      .pc-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.pc-card{border:1px solid var(--bs-border-color,#dee2e6);border-radius:.375rem;background:var(--bs-tertiary-bg,var(--bs-body-bg,#fff));overflow:hidden}.pc-card.pc-full{grid-column:1/-1}
      .pc-card-h{padding:12px 16px;border-bottom:1px solid var(--bs-border-color,#dee2e6);display:flex;align-items:center;justify-content:space-between;gap:12px;font-weight:600}.pc-card-b{padding:16px}
      .pc-row{display:flex;justify-content:space-between;gap:16px;padding:8px 0}.pc-row+.pc-row{border-top:1px solid var(--bs-border-color,#dee2e6)}.pc-muted{color:var(--bs-secondary-color,#6c757d);text-align:right;overflow-wrap:anywhere}
      .pc-badge{display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border:1px solid var(--bs-border-color,#dee2e6);border-radius:999px;font-size:.8rem}.pc-dot{width:8px;height:8px;border-radius:50%;background:#6c757d}.pc-ok .pc-dot{background:#198754}.pc-warn .pc-dot{background:#f0ad4e}.pc-bad .pc-dot{background:#dc3545}
      .pc-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}.pc-btn{border:1px solid var(--bs-border-color,#ced4da);border-radius:.375rem;padding:7px 11px;background:var(--bs-body-bg,#fff);color:inherit;cursor:pointer}.pc-btn:hover{filter:brightness(.96)}.pc-btn:disabled{opacity:.5;cursor:not-allowed}.pc-btn-primary{background:var(--bs-primary,#0d6efd);border-color:var(--bs-primary,#0d6efd);color:#fff}
      .pc-progress{height:8px;background:var(--bs-secondary-bg,#e9ecef);border-radius:999px;overflow:hidden;margin-top:12px}.pc-progress>span{display:block;height:100%;width:0;background:var(--bs-primary,#0d6efd);transition:width .2s}.pc-stats{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-top:12px}.pc-stat{border:1px solid var(--bs-border-color,#dee2e6);border-radius:.375rem;padding:9px}.pc-stat strong{display:block;font-size:1.05rem}.pc-stat small{color:var(--bs-secondary-color,#6c757d)}
      .pc-config input,.pc-manual input{width:100%;padding:8px 10px;border:1px solid var(--bs-border-color,#ced4da);border-radius:.375rem;background:var(--bs-body-bg,#fff);color:inherit}.pc-manual-form{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:end}.pc-manual-result{margin-top:8px;text-align:left}
      .pc-error{margin-top:12px;padding:10px 12px;border:1px solid rgba(220,53,69,.35);border-radius:.375rem;color:#dc3545;display:none}.pc-auth{margin-top:12px;padding:12px;border:1px solid var(--bs-border-color,#dee2e6);border-radius:.375rem;display:none}.pc-code{font:600 1.35rem ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:1px;margin:8px 0}
      .pc-table{width:100%;border-collapse:collapse}.pc-table th,.pc-table td{padding:8px;border-bottom:1px solid var(--bs-border-color,#dee2e6);text-align:left}.pc-table th{font-size:.8rem;color:var(--bs-secondary-color,#6c757d)}
      .pc-chat-log{min-height:190px;max-height:420px;overflow:auto;border:1px solid var(--bs-border-color,#dee2e6);border-radius:.375rem;padding:12px;background:var(--bs-body-bg,#fff)}
      .pc-chat-empty{color:var(--bs-secondary-color,#6c757d)}.pc-msg{max-width:88%;padding:9px 11px;border-radius:.7rem;margin:7px 0;white-space:pre-wrap;overflow-wrap:anywhere}.pc-msg-user{margin-left:auto;background:var(--bs-primary,#0d6efd);color:#fff}.pc-msg-assistant{background:var(--bs-secondary-bg,#e9ecef)}
      .pc-chat-form{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;margin-top:10px;align-items:end}.pc-chat-form textarea{width:100%;min-height:76px;max-height:180px;resize:vertical;padding:9px 10px;border:1px solid var(--bs-border-color,#ced4da);border-radius:.375rem;background:var(--bs-body-bg,#fff);color:inherit}
      .pc-cleanup-summary{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px}.pc-cleanup-group{border:1px solid var(--bs-border-color,#dee2e6);border-radius:.375rem;padding:11px;margin-top:8px}.pc-cleanup-title{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}.pc-cleanup-names{margin-top:6px;color:var(--bs-secondary-color,#6c757d)}.pc-cleanup-empty{color:var(--bs-secondary-color,#6c757d)}
      @media(max-width:800px){.pc-grid{grid-template-columns:1fr}.pc-card.pc-full{grid-column:auto}.pc-stats{grid-template-columns:repeat(2,1fr)}.pc-manual-form{grid-template-columns:1fr}#paperless-codex-panel{padding:14px}}
    `;
    document.head.appendChild(style);
  }

  function panel() {
    let root = document.getElementById('paperless-codex-panel');
    if (root) return root;
    ensureStyles();
    root = document.createElement('section');
    root.id = 'paperless-codex-panel';
    root.setAttribute('aria-label', 'Paperless Codex');
    root.innerHTML = `
      <div class="pc-wrap">
        <div class="pc-head"><div><h1 class="pc-title">Codex</h1><div class="pc-sub">OCR, Metadaten und automatische Dokumentenanalyse</div></div><button class="pc-btn" id="pc-close">Schließen</button></div>
        <div class="pc-grid">
          <div class="pc-card"><div class="pc-card-h"><span>Codex</span><span class="pc-badge" id="pc-codex-badge"><span class="pc-dot"></span><span>–</span></span></div><div class="pc-card-b">
            <div class="pc-row"><span>Verbindung</span><span class="pc-muted" id="pc-codex-text">–</span></div>
            <div class="pc-row"><span>Version</span><span class="pc-muted" id="pc-codex-version">–</span></div>
            <div class="pc-row"><span>Nutzung</span><span class="pc-muted" id="pc-usage">–</span></div>
            <div class="pc-actions"><button class="pc-btn pc-btn-primary" id="pc-login">Mit ChatGPT anmelden</button><button class="pc-btn" id="pc-refresh">Aktualisieren</button></div>
            <div class="pc-auth" id="pc-auth"><div>Gerätecode</div><div class="pc-code" id="pc-auth-code">–</div><div class="pc-actions"><button class="pc-btn pc-btn-primary" id="pc-auth-open">Anmeldeseite öffnen</button><button class="pc-btn" id="pc-auth-copy">Code kopieren</button></div><div class="pc-muted" id="pc-auth-state" style="margin-top:8px;text-align:left">Warte…</div></div>
          </div>
          <div class="pc-card"><div class="pc-card-h"><span>Paperless</span><span class="pc-badge" id="pc-paperless-badge"><span class="pc-dot"></span><span>–</span></span></div><div class="pc-card-b">
            <div class="pc-row"><span>API</span><span class="pc-muted" id="pc-paperless-text">–</span></div>
            <div class="pc-row"><span>Queue</span><span class="pc-muted" id="pc-queue">–</span></div>
            <div class="pc-row"><span>Pipeline</span><span class="pc-muted" id="pc-pipeline">–</span></div>
            <div class="pc-row"><span>Neue Dokumente</span><span class="pc-muted" id="pc-discovery">–</span></div>
            <div class="pc-row"><span>Provenienz</span><span class="pc-muted" id="pc-provenance">–</span></div>
            <div class="pc-row"><span>Schreibtest</span><span class="pc-muted" id="pc-selftest-state">Noch nicht ausgeführt</span></div>
            <div class="pc-actions"><button class="pc-btn" id="pc-selftest">Paperless-Selbsttest</button></div>
          </div>
          <div class="pc-card pc-full pc-assistant"><div class="pc-card-h"><span>Codex Chat</span><span class="pc-badge" id="pc-assistant-badge"><span class="pc-dot"></span><span>Bereit</span></span></div><div class="pc-card-b">
            <div class="pc-row"><span>Kontext</span><span class="pc-muted" id="pc-chat-context">Gesamtes Paperless</span></div>
            <div class="pc-chat-log" id="pc-chat-log"><div class="pc-chat-empty">Frag z. B. nach einem Dokument, einer Rechnung oder bitte Codex, deine Korrespondenten und Dokumenttypen aufzuräumen.</div></div>
            <div class="pc-chat-form"><textarea id="pc-chat-input" placeholder="Nach Dokumenten fragen oder Metadaten aufräumen…"></textarea><button class="pc-btn pc-btn-primary" id="pc-chat-send">Senden</button></div>
            <div class="pc-actions"><button class="pc-btn" id="pc-chat-clean-correspondents">Korrespondenten aufräumen</button><button class="pc-btn" id="pc-chat-clean-types">Dokumenttypen aufräumen</button><button class="pc-btn" id="pc-chat-clean-tags">Tags aufräumen</button></div>
          </div></div>
          <div class="pc-card pc-full"><div class="pc-card-h"><span>Metadaten-Duplikate</span><span class="pc-badge" id="pc-cleanup-badge"><span class="pc-dot"></span><span>Nicht geprüft</span></span></div><div class="pc-card-b">
            <div class="pc-muted" style="text-align:left">Codex erkennt ähnlich benannte Korrespondenten, Dokumenttypen und Tags. Zusammenführen passiert nur nach deiner Bestätigung.</div>
            <div class="pc-actions"><button class="pc-btn pc-btn-primary" id="pc-cleanup-scan">Duplikate prüfen</button></div>
            <div id="pc-cleanup-results" style="margin-top:12px"><div class="pc-cleanup-empty">Noch keine Prüfung durchgeführt.</div></div>
          </div></div>
          <div class="pc-card pc-full pc-manual"><div class="pc-card-h"><span>Dokument erneut scannen</span><span class="pc-badge" id="pc-manual-badge"><span class="pc-dot"></span><span>Bereit</span></span></div><div class="pc-card-b">
            <div class="pc-manual-form"><label for="pc-document-id">Dokument-ID<input id="pc-document-id" type="number" min="1" step="1" inputmode="numeric" placeholder="z. B. 123"></label><button class="pc-btn pc-btn-primary" id="pc-rescan">Erneut scannen</button></div>
            <div class="pc-muted pc-manual-result" id="pc-manual-result">Öffnest du Codex auf einer Dokumentseite, wird die ID automatisch übernommen.</div>
          </div>
          <div class="pc-card pc-full"><div class="pc-card-h"><span>Alle bestehenden Dokumente scannen</span><span class="pc-badge" id="pc-bulk-badge"><span class="pc-dot"></span><span>Bereit</span></span></div><div class="pc-card-b">
            <div class="pc-row"><span>Reihenfolge</span><span class="pc-muted">Neueste zuerst</span></div><div class="pc-row"><span>Aktuell</span><span class="pc-muted" id="pc-bulk-current">–</span></div>
            <label style="display:flex;gap:8px;align-items:center;margin-top:8px"><input type="checkbox" id="pc-skip" checked> Bereits mit aktueller Pipeline verarbeitete überspringen</label>
            <div class="pc-progress"><span id="pc-progress"></span></div><div class="pc-muted" id="pc-progress-text" style="text-align:left;margin-top:6px">Noch nicht gestartet.</div>
            <div class="pc-stats"><div class="pc-stat"><strong id="pc-done">0</strong><small>Verarbeitet</small></div><div class="pc-stat"><strong id="pc-ok">0</strong><small>Automatisch</small></div><div class="pc-stat"><strong id="pc-review">0</strong><small>Review</small></div><div class="pc-stat"><strong id="pc-fail">0</strong><small>Fehler</small></div><div class="pc-stat"><strong id="pc-skip-count">0</strong><small>Übersprungen</small></div></div>
            <div class="pc-actions"><button class="pc-btn pc-btn-primary" id="pc-bulk-start">Alle scannen</button><button class="pc-btn" id="pc-bulk-pause">Pausieren</button><button class="pc-btn" id="pc-bulk-resume">Fortsetzen</button><button class="pc-btn" id="pc-bulk-cancel">Abbrechen</button></div>
          </div>
          <div class="pc-card pc-full"><div class="pc-card-h"><span>Letzte Jobs</span></div><div class="pc-card-b"><div id="pc-jobs-empty" class="pc-muted" style="text-align:left">Keine Jobs.</div><table class="pc-table" id="pc-jobs" hidden><thead><tr><th>Dokument</th><th>Status</th><th>Versuch</th><th>Quelle</th></tr></thead><tbody></tbody></table></div></div>
          <div class="pc-card pc-full pc-config"><div class="pc-card-h"><span>Verbindungseinstellung</span></div><div class="pc-card-b"><label for="pc-url">Codex-URL</label><input id="pc-url" type="url" placeholder="http://192.168.1.26:8484/" autocomplete="off"><div class="pc-actions"><button class="pc-btn pc-btn-primary" id="pc-save-url">Speichern & testen</button></div><div class="pc-muted" style="text-align:left;margin-top:8px">Die URL wird nur lokal in Tampermonkey gespeichert. Kein Browser-Prompt und kein separates Codex-Fenster.</div></div></div>
        </div>
        <div class="pc-error" id="pc-error"></div>
      </div>`;
    document.body.appendChild(root);
    bindPanel(root);
    updatePanelBounds();
    return root;
  }

  function q(id) { return document.getElementById(id); }

  function setBadge(id, state, text) {
    const el = q(id); if (!el) return;
    el.className = `pc-badge ${state ? `pc-${state}` : ''}`;
    const label = el.querySelector('span:last-child'); if (label) label.textContent = text;
  }

  function showError(error) {
    const el = q('pc-error'); if (!el) return;
    if (!error) { el.style.display = 'none'; el.textContent = ''; return; }
    el.textContent = String(error.message || error); el.style.display = 'block';
  }

  function updatePanelBounds() {
    const root = document.getElementById('paperless-codex-panel'); if (!root) return;
    const sidebar = document.querySelector('#sidebarMenu');
    const navbar = document.querySelector('nav.navbar, .navbar.fixed-top, header .navbar');
    const sideRect = sidebar?.getBoundingClientRect();
    const navRect = navbar?.getBoundingClientRect();
    root.style.left = `${sideRect && sideRect.width > 20 ? Math.max(0, sideRect.right) : 0}px`;
    root.style.top = `${navRect && navRect.height > 20 ? Math.max(0, navRect.bottom) : 0}px`;
  }

  function renderBulk(b = {}) {
    const status = b.status || 'idle';
    const active = status === 'running', paused = status === 'paused';
    setBadge('pc-bulk-badge', active || paused ? 'warn' : status === 'completed' ? 'ok' : status === 'cancelled' ? 'bad' : '', ({ idle: 'Bereit', running: 'Läuft', paused: 'Pausiert', completed: 'Fertig', cancelled: 'Abgebrochen' }[status] || status));
    const total = Number(b.total || 0), processed = Number(b.processed || 0), skipped = Number(b.skipped || 0);
    const pct = total ? Math.min(100, Math.round(((processed + skipped) / total) * 100)) : 0;
    q('pc-progress').style.width = `${pct}%`;
    q('pc-progress-text').textContent = total ? `${processed + skipped} / ${total} · ${pct}% · ${b.remaining ?? Math.max(0, total - processed - skipped)} verbleibend` : 'Noch nicht gestartet.';
    q('pc-bulk-current').textContent = b.currentDocumentId ? `#${b.currentDocumentId}` : '–';
    q('pc-done').textContent = processed; q('pc-ok').textContent = b.completed || 0; q('pc-review').textContent = b.review || 0; q('pc-fail').textContent = b.failed || 0; q('pc-skip-count').textContent = skipped;
    q('pc-bulk-start').disabled = active || paused; q('pc-bulk-pause').disabled = !active; q('pc-bulk-resume').disabled = !paused; q('pc-bulk-cancel').disabled = !(active || paused);
  }

  function renderJobs(data = {}) {
    const jobs = Array.isArray(data.jobs) ? data.jobs.slice(-12).reverse() : [];
    const table = q('pc-jobs'), empty = q('pc-jobs-empty'), tbody = table.querySelector('tbody');
    if (!jobs.length) { table.hidden = true; empty.hidden = false; return; }
    empty.hidden = true; table.hidden = false;
    tbody.innerHTML = jobs.map(job => `<tr><td>#${esc(job.documentId)}</td><td>${esc(job.status || '–')}</td><td>${esc(job.attempt || 0)}</td><td>${esc(job.source || (job.bulk ? 'bulk' : 'manuell'))}</td></tr>`).join('');
  }

  function renderProvenance(provenance = {}) {
    const name = provenance.customField || 'AI Provenienz';
    q('pc-provenance').textContent = provenance.fieldExists ? `${name} · vorhanden ✓` : `${name} · fehlt ✗${provenance.error ? ' · API-Fehler' : ''}`;
    const test = provenance.lastSelfTest;
    if (!test) {
      q('pc-selftest-state').textContent = 'Noch nicht ausgeführt';
      return;
    }
    q('pc-selftest-state').textContent = test.ok
      ? `OK ✓ · Content ${test.contentWrite ? '✓' : '✗'} · Zusatzfeld ${test.customFieldWrite ? '✓' : '✗'}`
      : `Fehler ✗ · Content ${test.contentWrite ? '✓' : '✗'} · Zusatzfeld ${test.customFieldWrite ? '✓' : '✗'}`;
  }

  function updateAssistantContext() {
    const id = currentPaperlessDocumentId();
    const el = q('pc-chat-context');
    if (el) el.textContent = id ? `Aktuelles Dokument #${id}` : 'Gesamtes Paperless';
  }

  function appendChat(role, content) {
    const log = q('pc-chat-log');
    if (!log) return;
    log.querySelector('.pc-chat-empty')?.remove();
    const item = document.createElement('div');
    item.className = `pc-msg pc-msg-${role === 'user' ? 'user' : 'assistant'}`;
    item.textContent = String(content || '');
    log.appendChild(item);
    log.scrollTop = log.scrollHeight;
  }

  async function sendAssistantChat(preset = null) {
    const input = q('pc-chat-input');
    const message = String(preset || input?.value || '').trim();
    if (!message) return;
    if (input && !preset) input.value = '';
    appendChat('user', message);
    assistantHistory.push({ role: 'user', content: message });
    while (assistantHistory.length > 12) assistantHistory.shift();
    const button = q('pc-chat-send');
    if (button) button.disabled = true;
    setBadge('pc-assistant-badge', 'warn', 'Denkt…');
    try {
      const result = await request('ui-api/assistant/chat', {
        method: 'POST',
        timeout: 190000,
        body: { message, documentId: currentPaperlessDocumentId(), history: assistantHistory.slice(0, -1) }
      });
      const suffix = Array.isArray(result.sources) && result.sources.length
        ? `\n\nQuellen: ${result.sources.map(source => `#${source.id} ${source.title || ''}`).join(' · ')}`
        : '';
      appendChat('assistant', `${result.reply || 'Keine Antwort.'}${suffix}`);
      assistantHistory.push({ role: 'assistant', content: result.reply || '' });
      while (assistantHistory.length > 12) assistantHistory.shift();
      setBadge('pc-assistant-badge', 'ok', 'Bereit');
    } catch (error) {
      appendChat('assistant', `Fehler: ${String(error.message || error)}`);
      setBadge('pc-assistant-badge', 'bad', 'Fehler');
      showError(error);
    } finally {
      if (button) button.disabled = false;
    }
  }

  function cleanupKindLabel(kind) {
    return ({ correspondent: 'Korrespondent', documentType: 'Dokumenttyp', tag: 'Tag' })[kind] || kind;
  }

  function cleanupSection(title, kind, groups) {
    if (!groups.length) return `<div class="pc-cleanup-group"><strong>${esc(title)}</strong><div class="pc-cleanup-names">Keine offensichtlichen Duplikate.</div></div>`;
    return `<div class="pc-cleanup-group"><strong>${esc(title)}</strong>${groups.map(group => {
      const sources = group.sources || [];
      return `<div class="pc-cleanup-group">
        <div class="pc-cleanup-title"><div><strong>${esc(group.target?.name || '–')}</strong><div class="pc-cleanup-names">← ${sources.map(source => esc(source.name)).join(' · ')}</div><div class="pc-cleanup-names">${Number(group.totalDocuments || 0)} Dokumente · Ähnlichkeit ${Math.round(Number(group.confidence || 0) * 100)}%</div></div>
        <button class="pc-btn pc-cleanup-merge" data-kind="${esc(kind)}" data-target="${esc(group.target?.id)}" data-sources="${esc(sources.map(source => source.id).join(','))}">Zusammenführen</button></div>
      </div>`;
    }).join('')}</div>`;
  }

  function renderMetadataAudit(audit = {}) {
    const root = q('pc-cleanup-results');
    if (!root) return;
    const counts = audit.counts || {};
    root.innerHTML = `<div class="pc-cleanup-summary"><span class="pc-badge">Korrespondenten ${esc(counts.correspondents || 0)}</span><span class="pc-badge">Typen ${esc(counts.documentTypes || 0)}</span><span class="pc-badge">Tags ${esc(counts.tags || 0)}</span></div>
      ${cleanupSection('Korrespondenten', 'correspondent', audit.correspondents || [])}
      ${cleanupSection('Dokumenttypen', 'documentType', audit.documentTypes || [])}
      ${cleanupSection('Tags', 'tag', audit.tags || [])}`;
    root.querySelectorAll('.pc-cleanup-merge').forEach(button => button.addEventListener('click', () => mergeMetadataGroup(button)));
  }

  async function loadMetadataAudit() {
    const button = q('pc-cleanup-scan');
    if (button) button.disabled = true;
    setBadge('pc-cleanup-badge', 'warn', 'Prüft…');
    try {
      const audit = await request('ui-api/assistant/metadata/audit', { timeout: 60000 });
      renderMetadataAudit(audit);
      const total = (audit.correspondents?.length || 0) + (audit.documentTypes?.length || 0) + (audit.tags?.length || 0);
      setBadge('pc-cleanup-badge', total ? 'warn' : 'ok', total ? `${total} Gruppen` : 'Sauber');
    } catch (error) {
      setBadge('pc-cleanup-badge', 'bad', 'Fehler');
      showError(error);
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function mergeMetadataGroup(button) {
    const kind = button.dataset.kind;
    const targetId = Number(button.dataset.target);
    const sourceIds = String(button.dataset.sources || '').split(',').map(Number).filter(Number.isInteger);
    if (!targetId || !sourceIds.length) return;
    const label = cleanupKindLabel(kind);
    if (!window.confirm(`${label}-Duplikate wirklich zusammenführen? Dokumente werden auf den Ziel-Eintrag umgestellt und die alten Einträge danach gelöscht.`)) return;
    button.disabled = true;
    button.textContent = 'Wird zusammengeführt…';
    try {
      const result = await request('ui-api/assistant/metadata/merge', { method: 'POST', timeout: 180000, body: { kind, targetId, sourceIds, confirm: true } });
      if (!result.ok) showError('Dokumente wurden umgestellt, aber mindestens ein alter Metadaten-Eintrag konnte nicht gelöscht werden.');
      await loadMetadataAudit();
    } catch (error) {
      showError(error);
      button.disabled = false;
      button.textContent = 'Zusammenführen';
    }
  }

  async function refresh() {
    if (!getBaseUrl()) { q('pc-url').value = ''; showError('Bitte zuerst die Codex-URL unten eintragen.'); return; }
    q('pc-url').value = getBaseUrl();
    try {
      const [status, bulk, jobs] = await Promise.all([request('ui-api/status'), request('ui-api/bulk/status'), request('ui-api/jobs')]);
      showError(null);
      const codex = status.codex || {};
      setBadge('pc-codex-badge', codex.connected ? 'ok' : 'bad', codex.connected ? 'Verbunden' : 'Nicht verbunden');
      q('pc-codex-text').textContent = codex.statusText || (codex.connected ? 'Angemeldet' : 'Nicht angemeldet');
      q('pc-codex-version').textContent = codex.codexVersion || '–';
      const usage = status.usage || {};
      q('pc-usage').textContent = usage.paused ? `Limit erreicht · Retry ${usage.retryAt ? new Date(usage.retryAt).toLocaleTimeString() : ''}` : 'Bereit';
      setBadge('pc-paperless-badge', status.paperless?.connected ? 'ok' : 'bad', status.paperless?.connected ? 'Verbunden' : 'Fehler');
      q('pc-paperless-text').textContent = status.paperless?.connected ? 'API erreichbar' : (status.paperless?.error || 'Nicht erreichbar');
      q('pc-queue').textContent = `${status.queued ?? 0}${status.active ? ' · verarbeitet' : ''}`;
      q('pc-pipeline').textContent = `${status.toolVersion || '–'} / Pipeline ${status.pipelineVersion || '–'}`;
      const discovery = status.discovery || {};
      q('pc-discovery').textContent = discovery.enabled ? `Automatisch · alle ${Math.round((discovery.intervalMs || 60000) / 1000)} s${discovery.lastError ? ' · Fehler' : ''}` : 'Aus';
      renderProvenance(status.provenance || {});
      renderBulk(bulk); renderJobs(jobs);
    } catch (error) { showError(error); }
  }

  async function startAuth() {
    try {
      const auth = await request('ui-api/auth/start', { method: 'POST', body: {} });
      q('pc-auth').style.display = 'block'; q('pc-auth-code').textContent = auth.userCode || '–'; q('pc-auth-state').textContent = 'Warte auf Anmeldung…';
      q('pc-auth-open').dataset.url = auth.verificationUrl || '';
      clearInterval(authTimer);
      if (auth.id) authTimer = setInterval(async () => {
        try {
          const state = await request(`ui-api/auth/${auth.id}`);
          q('pc-auth-code').textContent = state.userCode || q('pc-auth-code').textContent;
          q('pc-auth-open').dataset.url = state.verificationUrl || q('pc-auth-open').dataset.url;
          q('pc-auth-state').textContent = state.status === 'connected' ? 'Angemeldet.' : state.status === 'error' ? (state.error || 'Fehler') : 'Warte auf Anmeldung…';
          if (state.status !== 'waiting') { clearInterval(authTimer); authTimer = null; refresh(); }
        } catch {}
      }, 1500);
    } catch (error) { showError(error); }
  }

  async function runSelfTest() {
    const button = q('pc-selftest');
    button.disabled = true;
    q('pc-selftest-state').textContent = 'Läuft…';
    try {
      const result = await request('ui-api/selftest', { method: 'POST', body: {} });
      q('pc-selftest-state').textContent = result.ok
        ? `OK ✓ · Content ${result.contentWrite ? '✓' : '✗'} · Zusatzfeld ${result.customFieldWrite ? '✓' : '✗'}`
        : `Fehler ✗ · Content ${result.contentWrite ? '✓' : '✗'} · Zusatzfeld ${result.customFieldWrite ? '✓' : '✗'}`;
      await refresh();
    } catch (error) {
      q('pc-selftest-state').textContent = `Fehler: ${String(error.message || error)}`;
      showError(error);
    } finally {
      button.disabled = false;
    }
  }

  async function rescanDocument() {
    const documentId = Number(q('pc-document-id').value);
    if (!Number.isInteger(documentId) || documentId <= 0) {
      setBadge('pc-manual-badge', 'bad', 'Ungültige ID');
      q('pc-manual-result').textContent = 'Bitte eine gültige Paperless-Dokument-ID eingeben.';
      return;
    }
    const button = q('pc-rescan');
    button.disabled = true;
    setBadge('pc-manual-badge', 'warn', 'Wird eingereiht');
    q('pc-manual-result').textContent = `Dokument #${documentId} wird erneut gescannt…`;
    try {
      const result = await request(`ui-api/documents/${documentId}/scan`, { method: 'POST', body: {} });
      setBadge('pc-manual-badge', 'ok', 'In Queue');
      q('pc-manual-result').textContent = `Dokument #${result.documentId || documentId} wurde zur Scan-Queue hinzugefügt.`;
      await refresh();
    } catch (error) {
      setBadge('pc-manual-badge', 'bad', 'Fehler');
      q('pc-manual-result').textContent = String(error.message || error);
      showError(error);
    } finally {
      button.disabled = false;
    }
  }

  function bindPanel(root) {
    q('pc-close').onclick = closePanel;
    q('pc-refresh').onclick = refresh;
    q('pc-login').onclick = startAuth;
    q('pc-selftest').onclick = runSelfTest;
    q('pc-save-url').onclick = () => {
      const value = normalizedUrl(q('pc-url').value);
      if (!value) return showError('Ungültige Codex-URL.');
      GM_setValue(KEY, value); showError(null); refresh();
    };
    q('pc-auth-open').onclick = () => { const url = q('pc-auth-open').dataset.url; if (url) window.open(url, '_blank', 'noopener,noreferrer'); };
    q('pc-auth-copy').onclick = () => navigator.clipboard?.writeText(q('pc-auth-code').textContent || '');
    q('pc-rescan').onclick = rescanDocument;
    q('pc-chat-send').onclick = () => sendAssistantChat();
    q('pc-chat-input').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendAssistantChat(); } });
    q('pc-chat-clean-correspondents').onclick = () => sendAssistantChat('Prüfe meine Korrespondenten auf Duplikate und erkläre mir die auffälligsten Gruppen.');
    q('pc-chat-clean-types').onclick = () => sendAssistantChat('Prüfe meine Dokumenttypen auf Duplikate und unnötige Varianten und erkläre mir die auffälligsten Gruppen.');
    q('pc-chat-clean-tags').onclick = () => sendAssistantChat('Prüfe meine Tags auf Duplikate, Synonyme und unnötige Varianten und erkläre mir die auffälligsten Gruppen.');
    q('pc-cleanup-scan').onclick = loadMetadataAudit;
    q('pc-document-id').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); rescanDocument(); } });
    q('pc-bulk-start').onclick = async () => { try { renderBulk(await request('ui-api/bulk/start', { method: 'POST', body: { skipCurrent: q('pc-skip').checked } })); } catch (e) { showError(e); } };
    q('pc-bulk-pause').onclick = async () => { try { renderBulk(await request('ui-api/bulk/pause', { method: 'POST', body: {} })); } catch (e) { showError(e); } };
    q('pc-bulk-resume').onclick = async () => { try { renderBulk(await request('ui-api/bulk/resume', { method: 'POST', body: {} })); } catch (e) { showError(e); } };
    q('pc-bulk-cancel').onclick = async () => { try { renderBulk(await request('ui-api/bulk/cancel', { method: 'POST', body: {} })); } catch (e) { showError(e); } };
    if (getBaseUrl()) q('pc-url').value = getBaseUrl(); else q('pc-url').value = DEFAULT_URL;
    const currentId = currentPaperlessDocumentId(); if (currentId) q('pc-document-id').value = String(currentId);
  }

  function openPanel(event) {
    event?.preventDefault(); event?.stopPropagation();
    const root = panel(); updatePanelBounds(); root.classList.add('pc-open');
    const currentId = currentPaperlessDocumentId(); if (currentId) q('pc-document-id').value = String(currentId);
    updateAssistantContext();
    document.getElementById('paperless-codex-menu-item')?.querySelector('a')?.classList.add('active');
    clearInterval(refreshTimer); refresh(); refreshTimer = setInterval(refresh, 10000);
  }

  function closePanel() {
    document.getElementById('paperless-codex-panel')?.classList.remove('pc-open');
    document.getElementById('paperless-codex-menu-item')?.querySelector('a')?.classList.remove('active');
    clearInterval(refreshTimer); refreshTimer = null;
  }

  function installMenuItem() {
    if (document.getElementById('paperless-codex-menu-item')) return;
    const sidebar = document.querySelector('#sidebarMenu .sidebar-sticky > ul.nav.flex-column');
    if (!sidebar) return;
    const items = [...sidebar.querySelectorAll(':scope > li.nav-item')];
    const documentsItem = items.find(li => /Documents|Dokumente/i.test(li.textContent || ''));
    const li = document.createElement('li'); li.id = 'paperless-codex-menu-item'; li.className = 'nav-item app-link';
    const a = document.createElement('a'); a.className = 'nav-link'; a.href = '#'; a.title = 'Codex'; a.innerHTML = `${icon()}<span class="nav-link-label">Codex</span>`; a.addEventListener('click', openPanel); li.appendChild(a);
    if (documentsItem?.nextSibling) sidebar.insertBefore(li, documentsItem.nextSibling); else sidebar.appendChild(li);
  }

  GM_registerMenuCommand('Codex anzeigen', openPanel);
  GM_registerMenuCommand('Codex Verbindung zurücksetzen', () => { GM_setValue(KEY, ''); const input = q('pc-url'); if (input) input.value = DEFAULT_URL; });

  installMenuItem();
  window.addEventListener('resize', updatePanelBounds);
  const observer = new MutationObserver(() => { installMenuItem(); if (document.getElementById('paperless-codex-panel')?.classList.contains('pc-open')) updatePanelBounds(); });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();