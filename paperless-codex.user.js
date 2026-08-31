// ==UserScript==
// @name         Paperless Codex Menu
// @namespace    https://github.com/Juloc/paperless-codex
// @version      0.1.0
// @description  Fügt Paperless-ngx einen Codex-Menüpunkt hinzu, ohne Paperless zu forken.
// @match        https://paperless.juloc.de/*
// @match        https://www.paperless.juloc.de/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const KEY = 'paperlessCodexUrl';

  function askUrl() {
    const current = GM_getValue(KEY, '');
    const value = prompt(
      'URL der Paperless-Codex-Oberfläche:',
      current || 'http://127.0.0.1:8484/'
    );
    if (!value) return null;
    let url;
    try {
      url = new URL(value);
    } catch {
      alert('Ungültige URL.');
      return null;
    }
    if (!/^https?:$/.test(url.protocol)) {
      alert('Nur http:// oder https:// ist erlaubt.');
      return null;
    }
    const normalized = url.toString();
    GM_setValue(KEY, normalized);
    return normalized;
  }

  function openCodex(event) {
    event?.preventDefault();
    event?.stopPropagation();
    const url = GM_getValue(KEY, '') || askUrl();
    if (url) GM_openInTab(url, { active: true, insert: true, setParent: true });
  }

  function icon() {
    return `<svg class="me-2" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0a.75.75 0 0 1 .72.54l.72 2.47a4.25 4.25 0 0 0 2.89 2.89l2.47.72a.75.75 0 0 1 0 1.44l-2.47.72a4.25 4.25 0 0 0-2.89 2.89l-.72 2.47a.75.75 0 0 1-1.44 0l-.72-2.47a4.25 4.25 0 0 0-2.89-2.89L.54 8.06a.75.75 0 0 1 0-1.44l2.47-.72A4.25 4.25 0 0 0 5.9 3.01L6.62.54A.75.75 0 0 1 8 0Z"/>
    </svg>`;
  }

  function installMenuItem() {
    if (document.getElementById('paperless-codex-menu-item')) return;

    const sidebar = document.querySelector('#sidebarMenu .sidebar-sticky > ul.nav.flex-column');
    if (!sidebar) return;

    const items = [...sidebar.querySelectorAll(':scope > li.nav-item')];
    const documentsItem = items.find(li => /Documents|Dokumente/i.test(li.textContent || ''));

    const li = document.createElement('li');
    li.id = 'paperless-codex-menu-item';
    li.className = 'nav-item app-link';

    const a = document.createElement('a');
    a.className = 'nav-link';
    a.href = '#';
    a.title = 'Codex';
    a.innerHTML = `${icon()}<span class="nav-link-label">Codex</span>`;
    a.addEventListener('click', openCodex);
    li.appendChild(a);

    if (documentsItem?.nextSibling) sidebar.insertBefore(li, documentsItem.nextSibling);
    else sidebar.appendChild(li);
  }

  GM_registerMenuCommand('Codex öffnen', () => openCodex());
  GM_registerMenuCommand('Codex URL ändern', askUrl);

  installMenuItem();
  const observer = new MutationObserver(() => installMenuItem());
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
