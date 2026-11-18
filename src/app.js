/* Amp Plan: interface. Depends on window.IPCore (core.js). */
(function () {
  'use strict';
  const C = window.IPCore;
  const LS_KEY = 'amp-ip-planner:v1';
  const LS_PREFS = 'amp-ip-planner:prefs';
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const esc = C.escHtml;
  const ip = C.ipToStr;
  const cssq = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^A-Za-z0-9_-]/g, '\\$&'));
  const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function safeJson(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, val) { try { window.localStorage.setItem(k, val); return true; } catch (e) { return false; } }

  const DEFAULT_COLS = { location: true, port: true, serial: false, notes: true };
  const prefs = Object.assign({ sep: '', last: '', devView: 'racks' }, safeJson(lsGet(LS_PREFS)) || {});
  // one look: the beige 90s office (styles under [data-skin="retro"])
  document.documentElement.dataset.skin = 'retro';
  prefs.cols = Object.assign({}, DEFAULT_COLS, prefs.cols || {});
  const savePrefs = () => lsSet(LS_PREFS, JSON.stringify(prefs));

  const S = {
    mode: 'init', db: null, user: null, canWrite: null, dl: undefined, unsub: null,
    readOnly: false, loaded: false, confirmed: false, slow: false, error: '', note: '', saveError: '',
    venues: [], cur: '', tab: 'speakers', open: {}, devView: prefs.devView === 'list' ? 'list' : 'racks', drag: null, zone: 'all', q: '', vq: '', sel: new Set(), mapNet: 'pri',
    dirty: new Set(), saving: {}, recent: {}, deleted: new Set(), undo: [], pendingRemote: false,
    acache: new WeakMap(), mapTips: [], modal: null,
  };

  // ---------------------------------------------------------------- icons
  const svg = (p) => '<svg class="i" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>';
  const ICON = {
    ok: svg('<path d="M3.5 8.5l3 3 6-7"/>'),
    warn: svg('<path d="M8 2.6l5.8 10.4H2.2z"/><path d="M8 6.8v3"/><path d="M8 11.6v.1"/>'),
    error: svg('<path d="M4.6 4.6l6.8 6.8M11.4 4.6l-6.8 6.8"/>'),
    info: svg('<circle cx="8" cy="8" r="6"/><path d="M8 7.4v4"/><path d="M8 4.9v.1"/>'),
    copy: svg('<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V3.8c0-.7-.6-1.3-1.3-1.3H3.8c-.7 0-1.3.6-1.3 1.3v5.4c0 .7.6 1.3 1.3 1.3h1.7"/>'),
    trash: svg('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2c.1.7.6 1.3 1.3 1.3h3.2c.7 0 1.2-.6 1.3-1.3l.6-8.2"/>'),
    x: svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
    plus: svg('<path d="M8 3v10M3 8h10"/>'),
    menu: svg('<path d="M2.5 4h11M2.5 8h11M2.5 12h11"/>'),
    up: svg('<path d="M8 12.5v-9M4.5 7L8 3.5 11.5 7"/>'),
    down: svg('<path d="M8 3.5v9M4.5 9L8 12.5 11.5 9"/>'),
  };
  const SEV_ICON = { error: ICON.error, warn: ICON.warn, info: ICON.info };

  const STATUS_UI = {
    planned: { label: 'Planned', hint: 'Planned. Click once the address is set on the unit.' },
    set: { label: 'Set', hint: 'Set on the unit. Click once LA Network Manager sees it online.' },
    ok: { label: 'Online', hint: 'Seen online in LA Network Manager. Click to start over.' },
  };
  const NEXT = { planned: 'set', set: 'ok', ok: 'planned' };

  // ---------------------------------------------------------------- capabilities & storage
  // The hosting runtime may attach window.claude a moment after this script runs; give it 1.5 s.
  let runtimeWait = null;
  function runtime() {
    if (!runtimeWait) {
      runtimeWait = new Promise((resolve) => {
        let n = 0;
        const look = () => {
          const c = window.claude;
          if (c && typeof c.use === 'function') resolve(c);
          else if (n++ >= 15) resolve(null);
          else setTimeout(look, 100);
        };
        look();
      });
    }
    return runtimeWait;
  }
  async function useCap(name) {
    const c = await runtime();
    if (!c) return null;
    return Promise.race([
      Promise.resolve().then(() => c.use(name)).catch(() => null),
      new Promise((r) => setTimeout(() => r(null), 12000)),
    ]);
  }
  async function getDownloads() {
    if (S.dl === undefined) S.dl = await useCap('downloads');
    return S.dl;
  }

  async function init() {
    bind();
    render();
    const both = await Promise.all([useCap('db'), useCap('user')]);
    const db = both[0];
    S.user = both[1];
    if (S.user) { try { S.canWrite = await S.user.can('data.write'); } catch (e) { S.canWrite = null; } }
    if (db) startDb(db); else startLocal();
    getDownloads();
  }

  function startDb(db) {
    S.mode = 'db';
    S.db = db;
    if (S.canWrite === false) S.readOnly = true;
    const timer = setTimeout(() => { if (!S.confirmed) { S.slow = true; render(); } }, 10000);
    try {
      S.unsub = db.collection('venues').onSnapshot((snap) => {
        if (!snap.metadata.fromCache) { clearTimeout(timer); S.confirmed = true; S.slow = false; }
        applySnapshot(snap);
      }, (err) => {
        clearTimeout(timer);
        S.error = (err && err.code) || 'unavailable';
        if (S.error === 'revoked') S.readOnly = true;
        if (!S.loaded) { S.loaded = true; pickVenue(); }
        render();
      });
    } catch (e) {
      clearTimeout(timer);
      startLocal('Your saved plans couldn’t be opened here, so this browser keeps them for now. Export a backup to be safe.');
    }
  }

  const busy = (id) => S.dirty.has(id) || !!(S.saving[id] && (S.saving[id].inflight || S.saving[id].timer));

  function applySnapshot(snap) {
    const seen = new Set();
    let curChanged = false;
    let any = false;
    for (const doc of snap.docs) {
      if (!doc.exists || !C.SAFE_ID.test(doc.id) || S.deleted.has(doc.id)) continue;
      seen.add(doc.id);
      if (busy(doc.id)) continue;
      const inc = C.sanitizeVenue(doc.id, doc.data());
      const i = S.venues.findIndex((v) => v.id === doc.id);
      if (i < 0) { S.venues.push(inc); any = true; continue; }
      if (C.stableStringify(C.serialize(S.venues[i])) !== C.stableStringify(C.serialize(inc))) {
        S.venues[i] = inc;
        any = true;
        if (doc.id === S.cur) curChanged = true;
      }
    }
    if (!snap.metadata.fromCache) {
      const now = Date.now();
      const keep = S.venues.filter((v) => seen.has(v.id) || busy(v.id) || now - (S.recent[v.id] || 0) < 15000);
      if (keep.length !== S.venues.length) {
        any = true;
        if (!keep.some((v) => v.id === S.cur)) curChanged = true;
        S.venues = keep;
      }
    }
    if (!S.loaded) { S.loaded = true; pickVenue(); render(); return; }
    if (!any) { setSaveStatus(); return; }
    if (curChanged && isEditing()) { S.pendingRemote = true; renderRail(); return; }
    if (curChanged) { if (!cur()) pickVenue(); render(); } else renderRail();
  }

  function startLocal(note) {
    if (S.unsub) { try { S.unsub(); } catch (e) { /* ignore */ } S.unsub = null; }
    S.mode = 'local';
    S.db = null;
    S.note = note || '';
    S.slow = false;
    const data = safeJson(lsGet(LS_KEY));
    S.venues = (data && Array.isArray(data.venues) ? data.venues : [])
      .filter((r) => r && typeof r === 'object')
      .map((r) => C.sanitizeVenue(C.SAFE_ID.test(r.id || '') ? r.id : C.uid('v'), r));
    S.loaded = true;
    pickVenue();
    render();
  }
  function saveLocalAll() {
    return lsSet(LS_KEY, JSON.stringify({ app: 'amp-ip-planner', venues: S.venues.map((v) => Object.assign({ id: v.id }, C.serialize(v))) }));
  }

  function touch(v, now) {
    v.updatedAt = Date.now();
    v._rev = (v._rev || 0) + 1;
    if (S.readOnly) return;
    S.dirty.add(v.id);
    const s = S.saving[v.id] || (S.saving[v.id] = {});
    clearTimeout(s.timer);
    s.timer = setTimeout(() => flush(v.id), now ? 0 : 650);
    setSaveStatus();
  }

  async function flush(id) {
    const s = S.saving[id] || (S.saving[id] = {});
    clearTimeout(s.timer);
    s.timer = null;
    if (s.inflight) { s.again = true; return; }
    const v = S.venues.find((x) => x.id === id);
    if (!v || S.readOnly) { S.dirty.delete(id); setSaveStatus(); return; }
    s.inflight = true;
    s.again = false;
    S.dirty.delete(id);
    setSaveStatus();
    try {
      if (S.mode === 'db') await S.db.collection('venues').doc(id).set(C.serialize(v));
      else if (S.mode === 'local' && !saveLocalAll()) throw { code: 'local_failed' };
      S.recent[id] = Date.now();
      s.fails = 0;
      S.saveError = '';
    } catch (e) {
      S.dirty.add(id);
      onWriteError(e, id);
    } finally {
      s.inflight = false;
      if (s.again) flush(id);
      setSaveStatus();
    }
  }

  function onWriteError(e, id) {
    const code = (e && e.code) || 'unknown';
    const s = S.saving[id];
    if (code === 'unavailable' && !s.fails) {
      s.fails = 1;
      setTimeout(() => { if (S.dirty.has(id)) flush(id); }, 700 + Math.random() * 1300);
      return;
    }
    if (code === 'revoked' || code === 'not_granted' || (code === 'invalid_argument' && S.canWrite !== true)) {
      S.readOnly = true;
      S.dirty.delete(id);
      render();
      toast('You can view these plans but not change them.');
      return;
    }
    S.saveError = 'Not saved';
    if (code === 'quota_exceeded') toast('Storage is full. Delete old venues or export a backup, then edit again to retry.');
    else if (code === 'local_failed') toast('This browser won’t store the plan. Export a backup so nothing is lost.');
    else toast('Couldn’t save just now. Your changes stay in this tab and the next edit tries again.');
  }

  function waitIdle(id) {
    return new Promise((resolve) => {
      let n = 0;
      const tick = () => { const s = S.saving[id]; if (!s || !s.inflight || n++ > 50) resolve(); else setTimeout(tick, 100); };
      tick();
    });
  }

  function setSaveStatus() {
    const el = $('#store-status');
    if (!el) return;
    const pending = S.dirty.size > 0 || Object.keys(S.saving).some((k) => S.saving[k].inflight);
    let dot = 'ok';
    let txt = 'All changes saved';
    if (S.mode === 'init') { dot = 'busy'; txt = 'Opening saved plans…'; }
    else if (S.readOnly) { dot = ''; txt = 'View only'; }
    else if (S.saveError && pending) { dot = 'bad'; txt = 'Not saved yet. Edit again to retry.'; }
    else if (pending) { dot = 'busy'; txt = 'Saving…'; }
    else if (S.mode === 'local') { dot = 'warn'; txt = 'Saved in this browser only'; }
    else if (S.error) { dot = 'bad'; txt = 'Saved plans unavailable'; }
    else if (S.slow) { dot = 'warn'; txt = 'Can’t reach saved plans yet'; }
    el.innerHTML = '<span class="dot ' + dot + '"></span><span>' + esc(txt) + '</span>';
    el.title = S.mode === 'db' ? 'Plans are stored with this planner. Anyone you share it with sees the same plans.' : S.mode === 'local' ? 'Only this browser keeps these plans. Use Export, then Backup, to keep a copy.' : '';
  }

  // ---------------------------------------------------------------- state helpers
  const cur = () => S.venues.find((v) => v.id === S.cur) || null;
  function analysis(v) {
    const c = S.acache.get(v);
    if (c && c.rev === (v._rev || 0)) return c.a;
    const a = C.analyze(v);
    S.acache.set(v, { rev: v._rev || 0, a });
    return a;
  }
  function todayIso() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function groupVenues(list) {
    const t = todayIso();
    const up = list.filter((v) => v.date && v.date >= t).sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
    const none = list.filter((v) => !v.date).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const past = list.filter((v) => v.date && v.date < t).sort((a, b) => b.date.localeCompare(a.date));
    return [{ label: 'Upcoming', list: up }, { label: 'No date', list: none }, { label: 'Past shows', list: past }].filter((g) => g.list.length);
  }
  function pickVenue() {
    const h = decodeURIComponent((location.hash || '').slice(1));
    const ids = new Set(S.venues.map((v) => v.id));
    if (h && ids.has(h)) S.cur = h;
    else if (S.cur && ids.has(S.cur)) { /* keep */ }
    else S.cur = '';
  }
  function isEditing() {
    const a = document.activeElement;
    return !!(a && a.closest && a.closest('#work-inner') && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName));
  }
  const isTyping = (el) => !!(el && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName));
  const rowId = (t) => { const tr = t.closest('tr[data-dev]'); return tr ? tr.dataset.dev : ''; };
  function nextIndex(v, prefix, rack) {
    const re = new RegExp('^' + reEsc(prefix) + ' (\\d+)' + (rack ? '(?: |$)' : '$'));
    let max = 0;
    for (const d of v.devices) { const m = re.exec(d.name || ''); if (m) max = Math.max(max, +m[1]); }
    return max + 1;
  }
  function slug(s) {
    return String(s || 'venue').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'venue';
  }
  function withFocus(fn) {
    const a = document.activeElement;
    let key = null;
    if (a && a !== document.body) {
      const tr = a.closest && a.closest('tr[data-dev]');
      if (tr && a.dataset.f) key = 'tr[data-dev="' + cssq(tr.dataset.dev) + '"] [data-f="' + a.dataset.f + '"]';
      else if (a.id) key = '#' + cssq(a.id);
    }
    let sel = null;
    try { if (a && typeof a.selectionStart === 'number') sel = [a.selectionStart, a.selectionEnd]; } catch (e) { sel = null; }
    fn();
    if (!key) return;
    const el = $(key);
    if (el && el !== document.activeElement) {
      el.focus({ preventScroll: true });
      if (sel && el.setSelectionRange) { try { el.setSelectionRange(sel[0], sel[1]); } catch (e) { /* not a text field */ } }
    }
  }

  // ---------------------------------------------------------------- rendering
  // Two pages: home (the venue list, where venues are created and opened) and a venue page with a Back button
  function render() {
    const home = S.loaded && !cur();
    document.body.classList.toggle('at-home', home);
    document.body.classList.toggle('in-venue', !home);
    renderRail();
    renderWork();
  }
  // ---- installing on a phone or computer (website version only; claude.ai has its own wrapper)
  const isWebsite = () => (location.protocol === 'https:' || location.hostname === 'localhost') && !/claude\.ai$|anthropic|claudeusercontent/.test(location.hostname);
  const isStandalone = () => (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let installEvt = null;
  if (isWebsite() && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
  }
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; if (!cur()) renderRail(); });
  window.addEventListener('appinstalled', () => { installEvt = null; toast('Amp Plan is installed. Open it from your home screen.'); if (!cur()) renderRail(); });
  function installHtml() {
    if (!isWebsite() || isStandalone()) return '';
    if (installEvt) return '<button class="btn install-btn" data-act="install-app">Install app on this device</button>';
    if (isIOS()) return '<p class="install-hint">To install on iPhone or iPad: tap <b>Share</b>, then <b>Add to Home Screen</b>.</p>';
    // the browser hasn't offered the install yet (it waits a little, or the app is already installed): say where its own menu has it
    const ua = navigator.userAgent;
    if (/Edg\//.test(ua)) return '<p class="install-hint">To install: Edge menu <b>…</b> → <b>Apps</b> → <b>Install this site as an app</b>.</p>';
    if (/Chrome\//.test(ua) && /Android/.test(ua)) return '<p class="install-hint">To install: Chrome menu <b>⋮</b> → <b>Add to Home screen</b> → <b>Install</b>.</p>';
    if (/Chrome\//.test(ua)) return '<p class="install-hint">To install: click the install icon at the right end of the address bar, or Chrome menu <b>⋮</b> → <b>Cast, save and share</b> → <b>Install page as app…</b></p>';
    if (/Safari\//.test(ua) && /Macintosh/.test(ua)) return '<p class="install-hint">To install: Safari menu <b>File</b> → <b>Add to Dock…</b></p>';
    return '';
  }
  async function installApp() {
    if (!installEvt) return;
    const e = installEvt;
    installEvt = null;
    try { e.prompt(); await e.userChoice; } catch (x) { /* dismissed */ }
    renderRail();
  }
  function goHome() {
    S.cur = '';
    document.body.classList.remove('rail-open');
    try { if (location.hash) history.replaceState(null, '', location.pathname + location.search); } catch (e) { try { location.hash = ''; } catch (x) { /* ignore */ } }
    render();
    try { window.scrollTo(0, 0); } catch (e) { /* ignore */ }
  }

  function renderRail() {
    const box = $('#venue-scroll');
    if (!box) return;
    const q = S.vq.trim().toLowerCase();
    const list = q ? S.venues.filter((v) => (v.name + ' ' + v.city + ' ' + v.date).toLowerCase().indexOf(q) >= 0) : S.venues;
    const top = box.scrollTop;
    if (!S.loaded) box.innerHTML = '';
    else if (!S.venues.length) box.innerHTML = '<p class="venue-group">No venues yet</p><p class="home-empty">Create your first venue, or open the example plan to look around.</p>' + (S.readOnly ? '' : '<button class="btn" data-act="load-example">Open the example plan</button>');
    else if (!list.length) box.innerHTML = '<p class="venue-group">No venue matches</p>';
    else box.innerHTML = groupVenues(list).map((g) => '<p class="venue-group">' + esc(g.label) + '</p><ul class="venue-list">' + g.list.map(venueItem).join('') + '</ul>').join('');
    box.scrollTop = top;
    const inst = $('#install-slot');
    if (inst) inst.innerHTML = installHtml();
    setSaveStatus();
  }
  function venueItem(v) {
    const s = analysis(v).stats;
    const isCur = v.id === S.cur;
    const flag = s.errors
      ? '<span class="vi-flag sev-error" title="' + esc(C.plural(s.errors, 'error')) + '">' + s.errors + '</span>'
      : s.warns ? '<span class="vi-flag sev-warn" title="' + esc(C.plural(s.warns, 'warning')) + '">' + s.warns + '</span>' : '';
    const meta = [C.formatDate(v.date), v.city, C.plural(v.devices.length, 'device')].filter(Boolean).join(' · ');
    return '<li><button class="venue-item' + (isCur ? ' is-cur' : '') + '" data-act="open-venue" data-id="' + esc(v.id) + '"' + (isCur ? ' aria-current="true"' : '') + '>' +
      '<span class="vi-name">' + esc(v.name) + '</span><span class="vi-meta">' + esc(meta) + '</span>' + flag + '</button></li>';
  }

  function renderWork() {
    const w = $('#work-inner');
    if (!w) return;
    $('#tip').hidden = true;
    if (!S.loaded) { w.innerHTML = loadingHtml(); return; }
    const v = cur();
    if (!v) { w.innerHTML = noteHtml() + emptyHtml(); return; }
    const a = analysis(v);
    withFocus(() => {
      w.innerHTML = noteHtml() + headHtml(v) + summaryHtml(v, a) + netHtml(v, a) + tabsHtml(v, a) +
        '<div id="tab-body" role="tabpanel">' + tabBody(v, a) + '</div>';
    });
    afterTab();
  }
  function renderTab() {
    const v = cur();
    if (!v) return;
    const tb = $('#tab-body');
    if (!tb) { renderWork(); return; }
    const a = analysis(v);
    $('#tip').hidden = true;
    withFocus(() => {
      tb.innerHTML = tabBody(v, a);
      const t = $('#tabs');
      if (t) t.outerHTML = tabsHtml(v, a);
    });
    afterTab();
  }
  function tabBody(v, a) {
    if (S.tab === 'checks') {
      // one tab for everything about getting the addresses right: the checks, then the IP map and the rules, folded
      const sec = (id, title, body) => '<details class="fold" data-sec="' + id + '"' + (S.open[id] ? ' open' : '') + '><summary>' + title + '</summary><div class="fold-body">' + body + '</div></details>';
      return checksHtml(v, a) + sec('map', 'IP map', mapHtml(v, a)) + sec('rules', 'L-Acoustics network rules', rulesHtml());
    }
    if (S.tab === 'speakers') return speakersHtml(v);
    return devicesHtml(v, a);
  }
  function afterTab() {
    if (S.tab === 'devices' && S.devView === 'racks') setTimeout(syncGridWidth, 0);
    if (S.tab === 'devices' && S.devView === 'list') { applyFilter(); updateBulk(); }
  }
  // Re-validate after a field edit without rebuilding inputs (keeps focus and caret).
  function refresh() {
    const v = cur();
    if (!v) return;
    const a = analysis(v);
    const sum = $('#summary');
    if (sum) sum.outerHTML = summaryHtml(v, a);
    const tabs = $('#tabs');
    if (tabs) tabs.outerHTML = tabsHtml(v, a);
    if (S.tab === 'devices' && S.devView === 'list') updateRows(v, a);
    else { const tb = $('#tab-body'); if (tb) tb.innerHTML = tabBody(v, a); }
    renderRail();
  }

  function noteHtml() {
    let msg = '';
    if (S.readOnly) msg = 'View only. You can look around and export, but not change these plans.';
    else if (S.mode === 'local') msg = S.note || 'Plans are saved in this browser only. Use Export, then Backup, to keep a copy.';
    else if (S.error) msg = 'Your saved plans can’t be reached right now. Changes stay in this tab; reload the page to try again.';
    else if (S.slow) msg = 'Still waiting for your saved plans. What you see may be out of date.';
    return msg ? '<div class="note-bar" role="status">' + ICON.info + '<span>' + esc(msg) + '</span></div>' : '';
  }
  function loadingHtml() {
    return '<div class="loading"><span class="dot busy"></span><span>' + (S.slow ? 'Still waiting for your saved plans. This page keeps trying.' : 'Opening your saved plans…') + '</span>' +
      (S.slow ? '<button class="btn" data-act="local-mode">Work in this browser instead</button>' : '') + '</div>';
  }
  function emptyHtml() {
    return '<div class="empty"><h1>Plan the IP addresses for your next show</h1>' +
      '<p>Pick the speakers for each zone. The planner adds the amplified controllers L-Acoustics specifies for them, shows how many amps and racks you need, gives every unit an IP address and exports a patch sheet for the crew.</p>' +
      '<ul class="empty-steps">' +
      '<li><span class="lcd">1</span><span>Create a venue. It starts on 192.168.1.0/24 with the LA Network Manager computer on .254.</span></li>' +
      '<li><span class="lcd">2</span><span>Add speakers: K2, Kara II, KS28, L2, A15, X8 and more. The amps are added for you.</span></li>' +
      '<li><span class="lcd">3</span><span>Check the amps and racks you need, fix anything flagged, then set the addresses on the units.</span></li></ul>' +
      (S.readOnly ? '' : '<div class="row"><button class="btn btn-primary" data-act="new-venue">New venue</button><button class="btn" data-act="load-example">Open an example plan</button><button class="btn btn-quiet" data-act="import">Import a backup</button></div>') +
      '</div>';
  }

  function headHtml(v) {
    const ro = S.readOnly ? ' disabled' : '';
    return '<button type="button" class="btn back-btn" data-act="go-home"><svg class="i" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5"/></svg>All venues</button>' +
      '<header class="vhead"><div class="vhead-main">' +
      '<label class="sr-only" for="v-name">Venue name</label><input id="v-name" class="vname" data-vf="name" value="' + esc(v.name) + '" maxlength="120" autocomplete="off"' + ro + '>' +
      '<div class="vmeta"><label class="vmeta-field" for="v-date"><span>Show date</span><input id="v-date" type="date" data-vf="date" value="' + esc(v.date) + '"' + ro + '></label>' +
      '<label class="vmeta-field grow" for="v-city"><span>Venue</span><input id="v-city" data-vf="city" value="' + esc(v.city) + '" maxlength="120" placeholder="Hall, city" autocomplete="off"' + ro + '></label></div></div>' +
      // Export, Duplicate and Delete live in one ⋮ menu
      '<div class="vhead-actions"><details class="add-menu more-menu"><summary class="btn more-btn" aria-label="More actions for this venue" title="More">' +
      '<svg viewBox="0 0 4 16" aria-hidden="true"><circle cx="2" cy="2.5" r="1.6"/><circle cx="2" cy="8" r="1.6"/><circle cx="2" cy="13.5" r="1.6"/></svg></summary><div class="add-pop" role="menu">' +
      '<button type="button" role="menuitem" data-act="export">Export…</button>' +
      (S.readOnly ? '' : '<button type="button" role="menuitem" data-act="dup-venue">Duplicate venue</button><button type="button" role="menuitem" class="danger" data-act="del-venue">Delete venue</button>') +
      '</div></details></div></header>';
  }

  // ---------------------------------------------------------------- LCD digits (digital-watch style)
  // 7-segment glyphs drawn as SVG, with faint "ghost" segments like a real LCD. Text stays readable
  // to screen readers through a hidden copy.
  const SEG_PATH = {
    a: '2,1 3,0 9,0 10,1 9,2 3,2', g: '2,10 3,9 9,9 10,10 9,11 3,11', d: '2,19 3,18 9,18 10,19 9,20 3,20',
    f: '1,2 2,3 2,8 1,9 0,8 0,3', b: '11,2 12,3 12,8 11,9 10,8 10,3', e: '1,11 2,12 2,17 1,18 0,17 0,12', c: '11,11 12,12 12,17 11,18 10,17 10,12',
  };
  const SEG_ON = { 0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg', '-': 'g' };
  function lcd(text, cls) {
    let x = 0;
    let out = '';
    for (const ch of String(text)) {
      if (ch === '.') { out += '<rect class="on" x="' + (x + 0.5) + '" y="18" width="2" height="2"/>'; x += 4; continue; }
      if (ch === ' ') { x += 6; continue; }
      if (ch === '/') { out += '<polygon class="on" points="' + (x + 6) + ',2 ' + (x + 7.6) + ',2 ' + (x + 1.6) + ',20 ' + x + ',20"/>'; x += 9; continue; }
      const on = SEG_ON[ch];
      if (on == null) continue;
      out += '<g transform="translate(' + x + ' 0)">' + Object.keys(SEG_PATH).map((k) => '<polygon class="' + (on.indexOf(k) >= 0 ? 'on' : 'off') + '" points="' + SEG_PATH[k] + '"/>').join('') + '</g>';
      x += 15;
    }
    const w = Math.max(1, x - 3);
    return '<span class="lcdnum' + (cls ? ' ' + cls : '') + '"><svg viewBox="-0.5 -0.5 ' + (w + 1) + ' 21" style="aspect-ratio:' + (w + 1) + '/21" aria-hidden="true">' + out + '</svg><span class="sr-only">' + esc(text) + '</span></span>';
  }
  function summaryHtml(v, a) {
    const s = a.stats;
    const sev = s.errors ? 'error' : s.warns ? 'warn' : 'ok';
    const main = s.errors ? C.plural(s.errors, 'error') + (s.warns ? ' · ' + C.plural(s.warns, 'warning') : '') : s.warns ? C.plural(s.warns, 'warning') : 'No conflicts';
    const sub = s.infos ? C.plural(s.infos, 'note') + ' · open checks' : sev === 'ok' ? 'Ready to set on the units' : 'Open checks';
    const scan = s.scanFrom != null ? ip(s.scanFrom) + ' – ' + ip(s.scanTo) : 'No unit addresses yet';
    const cp = C.countPlan(v);
    const sp = C.speakerPlan(v);
    return '<section class="summary" id="summary" aria-label="Plan summary">' +
      '<button class="pill sev-' + sev + '" data-act="tab" data-tab="checks"><span class="pill-ico">' + (sev === 'ok' ? ICON.ok : SEV_ICON[sev]) + '</span><span>' + esc(main) + '<span class="pill-sub">' + esc(sub) + '</span></span></button>' +
      '<button class="fact fact-btn" data-act="tab" data-tab="speakers"><span>Speakers</span><b>' + lcd(sp.enclosures) + '</b></button>' +
      '<button class="fact fact-btn" data-act="tab" data-tab="speakers"><span>Amps</span><b>' + lcd(cp.ampTotal) + (cp.ampTotal ? '<small>' + esc(C.rackSummary(cp)) + '</small>' : '') + '</b></button>' +
      '</section>';
  }

  function netHtml(v, a) {
    const n = v.net;
    const i = a.info;
    const ro = S.readOnly ? ' disabled' : '';
    let prefixOpts = '';
    for (let p = 8; p <= 24; p++) prefixOpts += '<option value="' + p + '"' + (p === i.prefix ? ' selected' : '') + '>/' + p + '</option>';
    const blockField = i.prefix < 24
      ? '<div class="field"><label for="n-block">Unit range (first three numbers)</label><input id="n-block" class="mono" data-nf="block" value="' + esc(i.blockStr) + '" spellcheck="false" autocomplete="off"' + ro + '><small>Every L-Acoustics unit shares these</small></div>'
      : '';
    const secTxt = n.redundancy
      ? (i.secNetwork != null ? 'Secondary network <b class="mono">' + esc(ip(i.secNetwork) + '/' + i.prefix) + '</b>' : 'No room for a secondary network')
      : 'Adds a secondary network: subnet + 1, same last numbers';
    // folded by default; opens by itself when the network itself needs fixing
    const open = !!prefs.netOpen || !i.ok;
    const brief = i.ok
      ? [ip(i.network) + '/' + i.prefix, 'computer ' + (n.computer || '—'), n.gateway ? 'gateway ' + n.gateway : '', n.dhcpFrom && n.dhcpTo ? 'DHCP ' + n.dhcpFrom.split('.').pop() + '–' + n.dhcpTo.split('.').pop() : '', n.redundancy ? 'Milan redundancy on' : ''].filter(Boolean).join(' · ')
      : 'Needs a network';
    return '<section class="card net' + (open ? ' is-open' : '') + '" id="net-card" aria-labelledby="net-h"><button type="button" class="card-h net-toggle" data-act="net-toggle" aria-expanded="' + open + '" aria-controls="net-body">' +
      '<svg class="i chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>' +
      '<h2 id="net-h">Network</h2><span class="muted mono net-brief">' + esc(brief) + '</span><span class="net-edit">' + (open ? 'Hide' : 'Edit') + '</span></button><div class="net-grid" id="net-body"' + (open ? '' : ' hidden') + '>' +
      '<div class="field"><label for="n-network">Primary network</label><div class="join"><input id="n-network" class="mono" data-nf="network" value="' + esc(n.network) + '" inputmode="decimal" spellcheck="false" autocomplete="off"' + ro + '>' +
      '<select id="n-prefix" data-nf="prefix" aria-label="Subnet mask"' + ro + '>' + prefixOpts + '</select></div><small>' + (i.ok ? 'Mask ' + esc(i.mask) + ' · broadcast .' + C.host(i.broadcast) : 'Enter a network such as 192.168.1.0') + '</small></div>' +
      blockField +
      '<div class="field"><label for="n-computer">Control computer (LA NWM)</label><input id="n-computer" class="mono" data-nf="computer" value="' + esc(n.computer) + '" placeholder="' + esc((i.blockStr || '192.168.1') + '.254') + '" inputmode="decimal" spellcheck="false" autocomplete="off"' + ro + '><small>L-Acoustics suggests .254</small></div>' +
      '<div class="field"><label for="n-gateway">Gateway <em>optional</em></label><input id="n-gateway" class="mono" data-nf="gateway" value="' + esc(n.gateway) + '" placeholder="none" inputmode="decimal" spellcheck="false" autocomplete="off"' + ro + '><small>Only for supervision on another subnet</small></div>' +
      '<div class="field"><span class="lbl">DHCP pool on this network <em>optional</em></span><div class="join"><input id="n-dhcp-from" class="mono" data-nf="dhcpFrom" value="' + esc(n.dhcpFrom) + '" placeholder="from" aria-label="DHCP pool start" inputmode="decimal" spellcheck="false" autocomplete="off"' + ro + '>' +
      '<input id="n-dhcp-to" class="mono" data-nf="dhcpTo" value="' + esc(n.dhcpTo) + '" placeholder="to" aria-label="DHCP pool end" inputmode="decimal" spellcheck="false" autocomplete="off"' + ro + '></div><small>Auto-assign stays out of it</small></div>' +
      '<div class="field toggle-field"><label class="switch" for="n-red"><input type="checkbox" id="n-red" data-nf="redundancy"' + (n.redundancy ? ' checked' : '') + ro + '><span class="switch-ui" aria-hidden="true"></span><span>Milan redundancy</span></label><small>' + secTxt + '</small></div>' +
      '</div></section>';
  }

  function tabsHtml(v, a) {
    const s = a.stats;
    const n = s.errors + s.warns;
    const tab = (id, label) => '<button class="tab" role="tab" id="tab-' + id + '" data-act="tab" data-tab="' + id + '" aria-selected="' + (S.tab === id) + '">' + label + '</button>';
    return '<nav class="tabs" id="tabs" role="tablist" aria-label="Plan views">' +
      tab('speakers', 'Speakers & amps <span class="count">' + C.speakerPlan(v).enclosures + '</span>') +
      tab('devices', 'Devices & IPs <span class="count">' + s.devices + '</span>') +
      tab('checks', 'Checks <span class="count' + (s.errors ? ' sev-error' : s.warns ? ' sev-warn' : '') + '">' + n + '</span>') + '</nav>';
  }

  // ---------------------------------------------------------------- devices tab
  function modelOptions(sel) {
    return C.GROUPS.map((g) => '<optgroup label="' + esc(g[1]) + '">' + C.MODELS.filter((m) => m.group === g[0]).map((m) => '<option value="' + esc(m.id) + '"' + (m.id === sel ? ' selected' : '') + '>' + esc(m.label) + '</option>').join('') + '</optgroup>').join('');
  }
  function zoneOptions(v, sel, none) {
    return (none ? '<option value=""' + (sel === '' ? ' selected' : '') + '>No zone</option>' : '') + v.zones.map((z) => '<option value="' + esc(z.id) + '"' + (z.id === sel ? ' selected' : '') + '>' + esc(z.name) + '</option>').join('');
  }
  function chipHtml(st) {
    const u = STATUS_UI[st] || STATUS_UI.planned;
    return '<button class="chip st-' + esc(st) + '" data-act="status" title="' + esc(u.hint) + '"' + (S.readOnly ? ' disabled' : '') + '><span class="ci" aria-hidden="true"></span>' + u.label + '</button>';
  }
  function lcdHtml(dn) {
    if (dn.m.group !== 'amp') return '<span class="lcd" style="visibility:hidden" aria-hidden="true"></span>';
    const has = dn.ip != null;
    return '<span class="lcd' + (has ? '' : ' empty') + '" data-lcd title="The amplifier’s screen shows only this last number">' + (has ? C.host(dn.ip) : '—') + '</span>';
  }
  function flagHtml(sev, n) {
    return '<button class="flag' + (sev ? ' sev-' + sev : '') + '" data-act="issues" data-flag aria-label="Show ' + esc(C.plural(n, 'issue')) + '" title="Show issues"' + (n ? '' : ' hidden') + '>' + (sev ? SEV_ICON[sev] : '') + '</button>';
  }
  function secHtml(dn) {
    if (dn.dual) return dn.sec != null ? esc(ip(dn.sec)) : '<span class="muted">—</span>';
    if (dn.m.unit) return '<span class="tag">no redundancy</span>';
    if (dn.onSec) return '<span class="tag">secondary side</span>';
    return '<span class="muted">—</span>';
  }
  function rowHtml(v, a, d) {
    const dn = a.nets.get(d.id) || C.devNets(v, d, a.info);
    const iss = a.byDev.get(d.id) || [];
    const sev = C.worst(iss);
    const m = dn.m;
    const red = !!v.net.redundancy;
    const ro = S.readOnly ? ' disabled' : '';
    const nm = d.name || m.label;
    const ph = (dn.onSec ? a.info.secBlockStr : a.info.blockStr) || '192.168.1';
    const netSel = red && !m.red
      ? '<select class="cell netsel" data-f="net" aria-label="Network for ' + esc(nm) + '" title="Which network this device sits on"' + ro + '><option value="pri"' + (d.net !== 'sec' ? ' selected' : '') + '>Pri</option><option value="sec"' + (d.net === 'sec' ? ' selected' : '') + '>Sec</option></select>'
      : '';
    const selected = S.sel.has(d.id);
    return '<tr class="dev' + (sev === 'error' || sev === 'warn' ? ' sev-' + sev : '') + (selected ? ' is-sel' : '') + '" data-dev="' + esc(d.id) + '">' +
      '<td class="c-sel"><input type="checkbox" data-act="sel" aria-label="Select ' + esc(nm) + '"' + (selected ? ' checked' : '') + ro + '></td>' +
      '<td class="c-st" data-label="Status">' + chipHtml(d.status) + '</td>' +
      '<td class="c-name" data-label="Name"><input class="cell" data-f="name" value="' + esc(d.name) + '" placeholder="' + esc(m.label) + '" aria-label="Name" maxlength="80" autocomplete="off"' + ro + '></td>' +
      '<td class="c-model" data-label="Model"><select class="cell" data-f="model" aria-label="Model of ' + esc(nm) + '" title="' + esc(m.info) + '"' + ro + '>' + modelOptions(d.model) + '</select></td>' +
      '<td class="c-ip" data-label="IP address"><div class="ipcell">' + lcdHtml(dn) + netSel +
      '<input class="cell ip" data-f="ip" value="' + esc(d.ip) + '" placeholder="' + esc(ph) + '.—" inputmode="decimal" spellcheck="false" autocomplete="off" aria-label="IP address of ' + esc(nm) + '"' + ro + '>' + flagHtml(sev, iss.length) + '</div></td>' +
      (red ? '<td class="c-sec mono" data-label="Secondary" data-sec>' + secHtml(dn) + '</td>' : '') +
      '<td data-col="location" data-label="Location"><input class="cell" data-f="location" value="' + esc(d.location) + '" aria-label="Location of ' + esc(nm) + '" maxlength="80" autocomplete="off"' + ro + '></td>' +
      '<td data-col="port" data-label="Switch / port"><input class="cell" data-f="port" value="' + esc(d.port) + '" aria-label="Switch and port for ' + esc(nm) + '" maxlength="80" autocomplete="off"' + ro + '></td>' +
      '<td data-col="serial" data-label="Serial / asset"><input class="cell mono" data-f="serial" value="' + esc(d.serial) + '" aria-label="Serial or asset number of ' + esc(nm) + '" maxlength="80" autocomplete="off"' + ro + '></td>' +
      '<td data-col="notes" data-label="Notes"><input class="cell" data-f="notes" value="' + esc(d.notes) + '" aria-label="Notes for ' + esc(nm) + '" maxlength="300" autocomplete="off"' + ro + '></td>' +
      '<td class="c-act">' + (S.readOnly ? '' : '<button class="icon-btn" data-act="dup-dev" aria-label="Duplicate ' + esc(nm) + '" title="Duplicate">' + ICON.copy + '</button><button class="icon-btn" data-act="del-dev" aria-label="Delete ' + esc(nm) + '" title="Delete">' + ICON.trash + '</button>') + '</td></tr>';
  }
  function toolbarHtml(v) {
    const ro = S.readOnly;
    return '<div class="toolbar"><div class="tb-left">' + viewSwitch() +
      (ro ? '' : '<button class="btn btn-primary" data-act="add-devices">' + ICON.plus + 'Add devices</button><button class="btn" data-act="add-rack">Add rack</button><button class="btn" data-act="auto-assign">Auto-assign IPs</button><button class="btn btn-quiet" data-act="zones">Edit zones</button>') +
      '<button class="btn btn-quiet" data-act="columns">Columns</button></div>' +
      '<div class="tb-right"><label class="sr-only" for="f-zone">Show zone</label><select id="f-zone" data-ui="zone"><option value="all">All zones</option>' +
      v.zones.map((z) => '<option value="' + esc(z.id) + '"' + (S.zone === z.id ? ' selected' : '') + '>' + esc(z.name) + '</option>').join('') + '</select>' +
      '<label class="sr-only" for="f-q">Filter devices</label><input id="f-q" type="search" data-ui="q" placeholder="Filter by name, IP, serial…" value="' + esc(S.q) + '" autocomplete="off"></div></div>';
  }
  const emptyRacks = (v) => (v.racks || []).filter((r) => !v.devices.some((d) => d.rack === r.id));
  // delete a rack; with amps: true its amps (and LS10s) go too, otherwise they move to "Not in a rack"
  function deleteRack(v, r, withAmps) {
    if (!v || !r || S.readOnly) return;
    pushUndo(v, 'rack');
    const inside = v.devices.filter((d) => d.rack === r.id);
    let msg;
    if (withAmps) {
      const ids = new Set(inside.map((d) => d.id));
      C.removeRack(v, r.id);
      v.devices = v.devices.filter((d) => !ids.has(d.id));
      const linked = inside.some((d) => d.drives);
      msg = 'Deleted ' + r.name + (inside.length ? ' and its ' + C.plural(inside.length, 'device') : '') + '.' + (linked ? ' Speaker groups that used them are now short; see Speakers & amps.' : '');
    } else {
      const out = C.removeRack(v, r.id);
      msg = 'Deleted ' + r.name + (out.length ? '. ' + C.plural(out.length, 'amp') + ' moved to Not in a rack.' : '.');
    }
    touch(v);
    render();
    toast(msg, undoAction());
  }
  function viewSwitch() {
    return '<div class="seg" role="group" aria-label="Show devices as"><button type="button" data-act="dev-view" data-view="racks" aria-pressed="' + (S.devView === 'racks') + '">Racks</button>' +
      '<button type="button" data-act="dev-view" data-view="list" aria-pressed="' + (S.devView === 'list') + '">List</button></div>';
  }
  function devicesHtml(v, a) {
    if (S.devView === 'racks') {
      const tools = '<div class="toolbar"><div class="tb-left">' + viewSwitch() +
        (S.readOnly ? '' : (v.devices.some((d) => C.isAmpModel(d.model) && !C.rackById(v, d.rack)) && (v.racks || []).length ? '<button class="btn" data-act="rack-pack">Pack single amps into racks</button>' : '') + (emptyRacks(v).length ? '<button class="btn btn-quiet danger" data-act="rack-del-empty">Delete ' + C.plural(emptyRacks(v).length, 'empty rack') + '</button>' : '') + '<button class="btn btn-quiet" data-act="zones">Edit zones</button>') +
        '</div></div>';
      return tools + planHtml(v, a);
    }
    return listHtml(v, a);
  }
  function listHtml(v, a) {
    const red = !!v.net.redundancy;
    const loose = v.devices.some((d) => !v.zones.some((z) => z.id === d.zone));
    const zones = (S.zone === 'all' ? v.zones : v.zones.filter((z) => z.id === S.zone)).concat(S.zone === 'all' && loose ? [{ id: '', name: 'No zone', color: 8, none: true }] : []);
    const blocks = C.zoneBlocks(v);
    const bmap = new Map((blocks || []).map((b) => [b.zone, b]));
    const cols = 10 + (red ? 1 : 0);
    const hide = Object.keys(prefs.cols).filter((k) => !prefs.cols[k]).map((k) => ' hide-' + k).join('');
    let rows = '';
    for (const z of zones) {
      const list = z.none ? v.devices.filter((d) => !v.zones.some((x) => x.id === d.zone)) : v.devices.filter((d) => d.zone === z.id);
      const b = z.none ? null : bmap.get(z.id);
      rows += '<tr class="zone-row" data-zone="' + esc(z.id) + '"><td colspan="' + cols + '"><div class="zone-head"><span class="sw" style="background:var(--z' + z.color + ')"></span><strong>' + esc(z.name) + '</strong><span class="muted">' + esc(C.plural(list.length, 'device')) + '</span>' +
        (b ? '<span class="blk mono" title="Auto-assign block for this zone">' + (b.full ? 'no block left' : '.' + b.lo + '–.' + b.hi) + '</span>' : '') +
        (S.readOnly || z.none ? '' : '<button class="btn-mini" data-act="add-to-zone" data-zone="' + esc(z.id) + '">+ Add to ' + esc(z.name) + '</button>') + '</div></td></tr>';
      if (!list.length) rows += '<tr class="zempty"><td colspan="' + cols + '">No devices in this zone yet.</td></tr>';
      for (const d of list) rows += rowHtml(v, a, d);
    }
    return toolbarHtml(v) + '<div class="bulk" id="bulk" hidden></div>' +
      '<div class="tbl-wrap"><table class="tbl' + hide + '" id="dev-table"><thead><tr>' +
      '<th class="c-sel"><input type="checkbox" data-act="sel-all" aria-label="Select all shown devices"' + (S.readOnly ? ' disabled' : '') + '></th>' +
      '<th>Status</th><th>Name</th><th>Model</th><th>IP address</th>' + (red ? '<th>Secondary</th>' : '') +
      '<th data-col="location">Location</th><th data-col="port">Switch / port</th><th data-col="serial">Serial / asset</th><th data-col="notes">Notes</th><th class="c-act"><span class="sr-only">Actions</span></th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }
  function updateRows(v, a) {
    const byId = new Map(v.devices.map((d) => [d.id, d]));
    for (const tr of $$('#dev-table tr.dev')) {
      const d = byId.get(tr.dataset.dev);
      if (!d) continue;
      const dn = a.nets.get(d.id);
      const iss = a.byDev.get(d.id) || [];
      const sev = C.worst(iss);
      tr.classList.toggle('sev-error', sev === 'error');
      tr.classList.toggle('sev-warn', sev === 'warn');
      const lcd = tr.querySelector('[data-lcd]');
      if (lcd) { const has = dn && dn.ip != null; lcd.textContent = has ? C.host(dn.ip) : '—'; lcd.classList.toggle('empty', !has); }
      const fl = tr.querySelector('[data-flag]');
      if (fl) {
        fl.hidden = !iss.length;
        fl.className = 'flag' + (sev ? ' sev-' + sev : '');
        fl.innerHTML = sev ? SEV_ICON[sev] : '';
        fl.setAttribute('aria-label', 'Show ' + C.plural(iss.length, 'issue'));
      }
      const sc = tr.querySelector('[data-sec]');
      if (sc && dn) sc.innerHTML = secHtml(dn);
    }
  }
  function applyFilter() {
    const v = cur();
    if (!v) return;
    const q = S.q.trim().toLowerCase();
    const byId = new Map(v.devices.map((d) => [d.id, d]));
    const shown = new Map();
    for (const tr of $$('#dev-table tr.dev')) {
      const d = byId.get(tr.dataset.dev);
      const hay = d ? [d.name, d.model, d.ip, d.location, d.port, d.serial, d.notes].join(' ').toLowerCase() : '';
      const show = !q || hay.indexOf(q) >= 0;
      tr.hidden = !show;
      if (show && d) shown.set(d.zone, (shown.get(d.zone) || 0) + 1);
    }
    for (const zr of $$('#dev-table tr.zone-row')) zr.hidden = !!q && !shown.get(zr.dataset.zone);
    for (const ze of $$('#dev-table tr.zempty')) ze.hidden = !!q;
  }
  function updateBulk() {
    const b = $('#bulk');
    if (!b) return;
    const v = cur();
    for (const id of Array.from(S.sel)) if (!v || !v.devices.some((d) => d.id === id)) S.sel.delete(id);
    const all = $('[data-act="sel-all"]');
    if (!S.sel.size || S.readOnly) { b.hidden = true; b.innerHTML = ''; if (all) all.checked = false; return; }
    b.hidden = false;
    b.innerHTML = '<b>' + S.sel.size + ' selected</b>' +
      '<label>Move to <select data-bulk="zone"><option value="" disabled selected>Zone…</option><option value="__none">No zone</option>' + zoneOptions(v, '-') + '</select></label>' +
      '<label>Status <select data-bulk="status"><option value="">Set…</option><option value="planned">Planned</option><option value="set">Set</option><option value="ok">Online</option></select></label>' +
      '<button class="btn btn-quiet" data-act="bulk-clear">Clear IPs</button><button class="btn btn-quiet danger" data-act="bulk-del">Delete</button><button class="btn-mini" data-act="bulk-none">Done</button>';
  }

  // ---------------------------------------------------------------- speakers & amps tab
  const range = (n) => Array.from({ length: Math.max(0, n) }, (_, i) => i);
  function speakerOptions(sel, customLabel) {
    return C.SPEAKER_SERIES.map((sr) => '<optgroup label="' + esc(sr) + '">' + C.SPEAKERS.filter((x) => x.series === sr).map((x) => '<option value="' + esc(x.id) + '"' + (x.id === sel ? ' selected' : '') + '>' + esc(x.id) + '</option>').join('') + '</optgroup>').join('') +
      '<optgroup label="Other"><option value="Custom"' + (sel === 'Custom' ? ' selected' : '') + '>' + esc(customLabel || 'Other speaker (your own numbers)') + '</option></optgroup>';
  }
  function qtyStepper(g) {
    const ro = S.readOnly ? ' disabled' : '';
    return '<div class="stepper"><button type="button" data-act="spk-step" data-step="-1" aria-label="One less"' + (g.qty > 1 ? '' : ' disabled') + ro + '>−</button>' +
      '<input id="q-' + esc(g.id) + '" type="number" min="1" max="999" inputmode="numeric" data-sf="qty" value="' + g.qty + '" aria-label="How many ' + esc(C.speakerLabel(g)) + '"' + ro + '>' +
      '<button type="button" data-act="spk-step" data-step="1" aria-label="One more"' + ro + '>+</button></div>';
  }
  // a slot in the "What you need" racks reads like the amp plan: "L2 - 11", "L2D - 18", in its zone's colour
  function slotHtml(sl) {
    const v = cur();
    const d = sl.dev;
    if (!v || !d) return sl.type ? '<span class="slot" style="background:var(--z' + sl.type.color + ')">' + esc(sl.type.label) + '</span>' : '<span class="slot other">other</span>';
    const c = zoneColorOf(v, d);
    const lab = C.slotLabel(v, d, analysis(v).info);
    return '<span class="slot' + (sl.type ? '' : ' other') + '" style="background:var(--z' + c + ');color:var(--z' + (c === 3 ? '3' : '') + '-ink)" title="' + esc(d.name + (sl.type ? '' : ' · not linked to speakers')) + '">' + esc(lab) + '</span>';
  }
  function speakersHtml(v) {
    const sp = C.speakerPlan(v);
    const ro = S.readOnly ? ' disabled' : '';
    const colorOf = new Map(sp.types.map((t) => [t.key, t.color]));
    const tools = '<div class="toolbar"><div class="tb-left">' + (S.readOnly ? '' : '<button class="btn btn-primary" data-act="add-speakers">' + ICON.plus + 'Add speakers</button><button class="btn btn-quiet" data-act="zones">Edit zones</button>') + '</div></div>';
    if (!sp.groups.length) {
      return tools + '<div class="card spk-empty"><h3>Start with the speakers</h3><p>Pick a speaker type, how many and which zone. The planner adds the amplified controllers L-Acoustics specifies for it, gives them IP addresses and shows how many amps and racks you need.</p>' +
        (S.readOnly ? '' : '<div><button class="btn btn-primary" data-act="add-speakers">' + ICON.plus + 'Add speakers</button></div>') + '</div>' + needHtml(v, sp);
    }
    const rows = sp.groups.map((x) => {
      const g = x.g;
      const custom = !C.SPEAKER_MAP[g.model];
      const ampOpts = C.driveOptions(g.model).map((a) => '<option value="' + esc(a) + '"' + (a === g.amp ? ' selected' : '') + '>' + esc(a) + (custom ? '' : ' · max ' + C.driveMax(g.model, a)) + '</option>').join('');
      const off = x.linked !== x.need;
      return '<tr data-spk="' + esc(g.id) + '">' +
        '<td><select class="cell" id="z-' + esc(g.id) + '" data-sf="zone" aria-label="Zone of ' + esc(x.label) + '"' + ro + '>' + zoneOptions(v, g.zone) + '</select></td>' +
        '<td><div class="spk-name"><span class="sw" style="background:var(--z' + colorOf.get(x.label + '|' + g.amp) + ')"></span><b>' + esc(x.label) + '</b>' + (C.ARRAY_BOTTOM[g.model] ? '<small class="spk-arr">Hang: ' + esc(C.arrayText(g)) + '</small>' : '') + '</div></td>' +
        '<td>' + qtyStepper(g) + '</td>' +
        '<td><select class="cell" id="a-' + esc(g.id) + '" data-sf="amp" aria-label="Amplifier for ' + esc(x.label) + '"' + ro + '>' + ampOpts + '</select></td>' +
        '<td><div class="per"><input class="cell num-in" id="p-' + esc(g.id) + '" type="number" min="1" max="' + (custom ? 64 : x.max) + '" inputmode="numeric" data-sf="per" value="' + x.per + '" aria-label="' + esc(x.label) + ' per amp"' + ro + '>' +
        '<small>' + (custom ? 'your value' : 'max ' + x.max + ' · ' + x.perOut + ' per output') + '</small></div></td>' +
        '<td class="num"><b class="big">' + x.need + '</b> × ' + esc(g.amp) + (off ? '<button type="button" class="chip-warn" data-act="spk-fix" title="The linked amps don’t match">' + x.linked + ' linked · Fix</button>' : '') + '</td>' +
        '<td class="eqcell">' + esc(x.e ? C.rackText(x.e, C.rackSizeOf(v, g.amp)) : x.need ? 'Not packed in racks' : '—') + '</td>' +
        '<td class="c-act">' + (S.readOnly ? '' : '<button type="button" class="icon-btn" data-act="spk-del" aria-label="Remove ' + esc(x.label) + ' and its amps" title="Remove with its amps">' + ICON.trash + '</button>') + '</td></tr>';
    }).join('');
    const totAmps = sp.groups.reduce((n, x) => n + x.need, 0);
    return tools + '<div class="tbl-wrap"><table class="stbl"><thead><tr><th>Zone</th><th>Speaker</th><th>How many</th><th>Amplifier</th><th>Speakers per amp</th><th class="num">Amps needed</th><th>As racks</th><th><span class="sr-only">Remove</span></th></tr></thead>' +
      '<tbody>' + rows + '</tbody><tfoot><tr><th colspan="2">Total</th><td><b>' + sp.enclosures + '</b> speakers</td><td colspan="2"></td><td class="num"><b>' + totAmps + '</b> amps</td><td colspan="2"></td></tr></tfoot></table></div>' + needHtml(v, sp);
  }
  function needHtml(v, sp) {
    if (!sp.ampModels.length) return '';
    const ro = S.readOnly ? ' disabled' : '';
    const types = sp.types.length ? '<ul class="type-list">' + sp.types.map((t) => '<li><span class="sw" style="background:var(--z' + t.color + ')"></span><div><b>' + t.qty + ' × ' + esc(t.label) + '</b><span>' + t.amps + ' × ' + esc(t.amp) +
      (t.e ? ' · ' + esc(C.rackText(t.e, C.rackSizeOf(v, t.amp))) : '') + '</span></div></li>').join('') + '</ul>' : '';
    const models = sp.ampModels.map((m) => {
      const racks = m.size
        ? '<div class="racks">' + m.racks.map((r, i) => '<div class="rack" role="img" aria-label="' + esc((C.RACK_FOR[m.id] || 'Rack') + ' ' + (i + 1) + ': ' + r.map((x) => (x.dev ? C.slotLabel(cur(), x.dev, analysis(cur()).info) : x.type ? x.type.label : 'other')).join(', ') + (m.size - r.length ? ', ' + (m.size - r.length) + ' free' : '')) + '">' +
            '<span class="rack-cap">RACK ' + (i + 1) + '</span>' + r.map(slotHtml).join('') + range(m.size - r.length).map(() => '<span class="slot free">free</span>').join('') + '</div>').join('') + '</div>'
        : '<div class="loose">' + m.slots.map(slotHtml).join('') + '</div>';
      return '<div class="need-model"><div class="nm-head"><div class="nm-total"><b>' + m.total + '</b><span>× ' + esc(m.id) + '</span></div>' +
        '<div class="nm-eq">' + esc(m.e ? C.rackText(m.e, m.size) + (C.RACK_FOR[m.id] ? ' · ' + C.RACK_FOR[m.id] : '') : 'Not packed in racks. Set a rack size to count them as racks.') + '</div>' +
        '<label class="nm-size" for="rs-' + esc(m.id) + '">Amps per rack<input id="rs-' + esc(m.id) + '" type="number" min="0" max="12" inputmode="numeric" data-racksize data-model="' + esc(m.id) + '" value="' + (m.size || '') + '" placeholder="none"' + ro + '></label></div>' +
        (m.other ? '<p class="nm-note">Includes ' + esc(C.plural(m.other, 'amp')) + ' not linked to speakers, such as spares or units added by hand.</p>' : '') + racks + '</div>';
    }).join('');
    return '<section class="need" aria-labelledby="need-h"><div class="need-h"><h2 id="need-h">What you need</h2><span class="muted">Amps per speaker type, packed into racks</span></div>' + types + models +
      '<p class="need-note">Speakers per amp come from L-Acoustics’ Amplification Reference: the most enclosures one amplified controller may drive. LA7.16 figures assume nominal use; on 100 V mains drive fewer. Each speaker type gets its own amps here, and an LA7.16 can mix types, so a mixed plan may need fewer.</p></section>';
  }
  function readSpeaker(m) {
    const model = $('#sp-model', m).value;
    const known = !!C.SPEAKER_MAP[model];
    const amp = $('#sp-amp', m).value;
    const max = C.driveMax(model, amp);
    let per = C.clampInt($('#sp-per', m).value, 1, 64, known ? max : 1);
    if (known && per >= max) per = 0;
    return { id: '', model: known ? model : 'Custom', custom: known ? '' : $('#sp-custom', m).value.trim(), qty: C.clampInt($('#sp-qty', m).value, 1, 999, 1), zone: $('#sp-zone', m).value, amp, per };
  }
  // starting value for "Speakers per amp": your own default where set (K2 → 2), otherwise the L-Acoustics maximum
  const DEFAULT_PER = { K2: 2 };
  const defaultPer = (id, amp) => Math.min(DEFAULT_PER[id] || C.driveMax(id, amp), C.driveMax(id, amp));
  function openAddSpeakers() {
    const v = cur();
    if (!v || S.readOnly) return;
    const z0 = v.zones[0].id;
    openModal({
      title: 'Add speakers',
      body: '<div class="form-grid">' +
        '<div class="field"><label for="sp-model">Speaker</label><select id="sp-model">' + speakerOptions('K2') + '</select></div>' +
        '<div class="field"><label for="sp-qty">How many</label><input id="sp-qty" type="number" min="1" max="999" value="12" inputmode="numeric"></div>' +
        '<div class="field span2" id="sp-custom-f" hidden><label for="sp-custom">Speaker name</label><input id="sp-custom" maxlength="40" placeholder="e.g. SB218" autocomplete="off"></div>' +
        '<div class="field"><label for="sp-zone">Zone</label><select id="sp-zone">' + zoneOptions(v, z0) + '</select></div>' +
        '<div class="field"><label for="sp-amp">Amplifier</label><select id="sp-amp"></select></div>' +
        '<div class="field span2"><label for="sp-per">Speakers per amp</label><input id="sp-per" type="number" min="1" max="64" inputmode="numeric"><small id="sp-per-hint"></small></div>' +
        '</div><div class="calc" id="sp-calc" aria-live="polite"></div>',
      actions: [{ label: 'Cancel' }, { label: 'Add speakers', kind: 'primary', onClick: (m) => addSpeakersFromModal(v, m) }],
      onOpen: (m) => {
        const model = $('#sp-model', m);
        const amp = $('#sp-amp', m);
        const per = $('#sp-per', m);
        const fillAmps = () => {
          const id = model.value;
          const known = !!C.SPEAKER_MAP[id];
          const opts = C.driveOptions(id);
          const keep = opts.indexOf(amp.value) >= 0 ? amp.value : opts[0];
          amp.innerHTML = opts.map((x) => '<option value="' + esc(x) + '"' + (x === keep ? ' selected' : '') + '>' + esc(x) + (known ? ' · up to ' + C.driveMax(id, x) + ' per amp' : '') + '</option>').join('');
          $('#sp-custom-f', m).hidden = known;
          if (known) { per.max = C.driveMax(id, amp.value); per.value = defaultPer(id, amp.value); } else { per.max = 64; if (!+per.value) per.value = 4; }
        };
        const calc = () => {
          const g = readSpeaker(m);
          const need = C.ampsNeeded(g);
          const e = C.rackEquivalent(need, C.rackSizeOf(v, g.amp));
          $('#sp-per-hint', m).textContent = C.SPEAKER_MAP[g.model]
            ? 'L-Acoustics maximum: ' + C.driveMax(g.model, g.amp) + ' per ' + g.amp + ', ' + C.drivePerOutput(g.model, g.amp) + ' per output. Lower it to leave headroom.'
            : 'Check the speaker’s documentation for how many one amp may drive.';
          $('#sp-calc', m).innerHTML = '<div class="calc-line"><span class="calc-in">' + esc(C.arrayText(g)) + '</span><span class="arrow">→</span><span class="calc-out"><b>' + need + '</b> × ' + esc(g.amp) + '</span></div>' +
            '<div class="calc-sub">' + (C.ARRAY_BOTTOM[g.model] ? 'The last box of the hang is always an ' + C.ARRAY_BOTTOM[g.model] + '; its amp gets the ' + C.ARRAY_BOTTOM[g.model] + ' preset. ' : '') + esc(e ? 'As racks: ' + C.rackText(e, C.rackSizeOf(v, g.amp)) + '.' : need ? 'Not packed in racks.' : '') + ' The amps get IP addresses straight away.</div>';
        };
        model.addEventListener('change', () => { fillAmps(); calc(); });
        amp.addEventListener('change', () => { if (C.SPEAKER_MAP[model.value]) { per.max = C.driveMax(model.value, amp.value); per.value = defaultPer(model.value, amp.value); } calc(); });
        m.addEventListener('input', calc);
        fillAmps();
        calc();
      },
    });
  }
  function addSpeakersFromModal(v, m) {
    const g = readSpeaker(m);
    if (g.model === 'Custom' && !g.custom) { toast('Give the speaker a name.'); $('#sp-custom', m).focus(); return false; }
    if (v.devices.length + C.ampsNeeded(g) > C.MAX_DEVICES) { toast('A venue holds up to ' + C.MAX_DEVICES + ' devices.'); return false; }
    pushUndo(v, 'speaker');
    let tgt = v.speakers.find((x) => x.model === g.model && x.custom === g.custom && x.zone === g.zone && x.amp === g.amp && (x.per || 0) === g.per);
    if (tgt) tgt.qty = Math.min(999, tgt.qty + g.qty);
    else { g.id = C.uid('s'); v.speakers.push(g); tgt = g; }
    S.tab = 'speakers';
    applySync(v, tgt, 'Added ' + C.arrayText(g));
  }
  function applySync(v, g, lead) {
    const r = C.syncGroup(v, g);
    const toPack = r.added.concat(r.unracked || []).map((d) => d.id);
    if (toPack.length) C.packRacks(v, { onlyIds: toPack });
    let extra = '';
    if (r.added.length) {
      const a = v.net.assign;
      const plan = C.planAutoAssign(v, { scheme: a.scheme, start: a.start, size: a.size, avoidDefaults: a.avoidDefaults, scope: 'empty', onlyIds: r.added.map((d) => d.id) });
      C.applyChanges(v, plan.changes);
      if (plan.unplaced.length) extra = ' ' + C.plural(plan.unplaced.length, 'amp') + ' got no IP (' + plan.unplaced[0].reason.toLowerCase() + ').';
    }
    touch(v);
    render();
    const parts = [];
    if (r.added.length) parts.push(r.added.length + ' × ' + g.amp + ' added');
    if (r.removed.length) parts.push(r.removed.length + ' × ' + g.amp + ' removed');
    const msg = (lead || C.speakerLabel(g)) + (parts.length ? ': ' + parts.join(', ') : '') + '.' + extra;
    toast(msg, undoAction());
  }
  function speakerField(el) {
    const v = cur();
    if (!v || S.readOnly) return;
    const tr = el.closest('tr[data-spk]');
    const g = tr && v.speakers.find((x) => x.id === tr.dataset.spk);
    if (!g) return;
    const f = el.dataset.sf;
    const before = JSON.stringify(g);
    const undoBody = JSON.stringify(C.serialize(v));
    let lead = '';
    if (f === 'qty') { g.qty = C.clampInt(el.value, 1, 999, g.qty); lead = g.qty + ' × ' + C.speakerLabel(g); }
    else if (f === 'amp') { if (C.driveOptions(g.model).indexOf(el.value) < 0) return; g.amp = el.value; if (C.SPEAKER_MAP[g.model]) g.per = 0; lead = C.speakerLabel(g) + ' now on ' + g.amp; }
    else if (f === 'per') {
      const p = C.clampInt(el.value, 1, 64, C.perAmp(g));
      g.per = C.SPEAKER_MAP[g.model] && p >= C.driveMax(g.model, g.amp) ? 0 : p;
      lead = C.perAmp(g) + ' ' + C.speakerLabel(g) + ' per ' + g.amp;
    } else if (f === 'zone') {
      const z = v.zones.find((x) => x.id === el.value);
      if (!z) return;
      g.zone = z.id;
      lead = C.speakerLabel(g) + ' and its amps moved to ' + z.name;
    } else return;
    if (JSON.stringify(g) === before) { render(); return; }
    S.undo.push({ id: v.id, body: undoBody, label: 'speaker' });
    applySync(v, g, lead);
  }
  function rackSizeField(el) {
    const v = cur();
    if (!v || S.readOnly) return;
    const model = el.dataset.model;
    if (!C.MODEL_MAP[model]) return;
    const n = el.value === '' ? 0 : C.clampInt(el.value, 0, 12, 0);
    if (C.rackSizeOf(v, model) === n) return;
    pushUndo(v, 'racksize');
    v.rackSize = Object.assign({}, v.rackSize || {}, { [model]: n });
    touch(v);
    render();
  }
  function deleteSpeakerGroup(t) {
    const v = cur();
    if (!v || S.readOnly) return;
    const tr = t.closest('tr[data-spk]');
    const g = tr && v.speakers.find((x) => x.id === tr.dataset.spk);
    if (!g) return;
    pushUndo(v, 'speaker');
    const removed = C.removeGroup(v, g.id);
    touch(v);
    render();
    toast('Removed ' + g.qty + ' × ' + C.speakerLabel(g) + ' and ' + C.plural(removed.length, 'amp') + '.', undoAction());
  }

  // ---------------------------------------------------------------- rack view (Devices & IPs)
  function zoneColorOf(v, d) { const z = v.zones.find((x) => x.id === d.zone); return z ? z.color : 8; }
  // ---- layouts of the rack view; every layout keeps click-to-edit and drag between slots
  const LAYOUTS = [['monitors', 'Monitors'], ['stage', 'Stage plot'], ['fronts', 'Rack fronts'], ['lanes', 'Lanes'], ['ipgrid', 'IP grid'], ['night', 'Show night']];
  // one layout now: the stage plot on the free grid (the layout picker was removed)
  const layoutOf = () => 'stage';
  const hostOf = (d) => { const p = C.parseIp(d.ip); return p != null ? C.host(p) : null; };
  function slotInner(v, a, d, L) {
    const pre = C.presetOf(v, d) || C.modelOf(d.model).label;
    const h = hostOf(d);
    if (L === 'fronts') return '<i class="pf-stripe" aria-hidden="true"></i><span class="pf-txt"><b>' + esc(pre) + '</b><small>' + esc(C.modelOf(d.model).label) + '</small></span><span class="pf-lcd">' + (h != null ? '.' + h : '--') + '</span>';
    if (L === 'night') return '<i class="pf-stripe" aria-hidden="true"></i><span class="pn-top"><b>' + esc(pre) + '</b><span class="pn-st st-' + esc(d.status) + '"><i aria-hidden="true"></i>' + esc(C.STATUS_LABEL[d.status] || '') + '</span></span><span class="pn-ip">' + (h != null ? '.' + h : '—') + '</span>';
    return esc(C.slotLabel(v, d, a.info));
  }
  function ampChip(v, a, d, extra) {
    const L = layoutOf();
    const sev = C.worst(a.byDev.get(d.id) || []);
    const lab = C.slotLabel(v, d, a.info);
    const tip = [d.name, C.modelOf(d.model).label, d.ip || 'no IP yet'].filter(Boolean).join(' · ');
    const c = zoneColorOf(v, d);
    const vars = '--zc:var(--z' + c + ');--zi:var(--z' + (c === 3 ? '3' : '') + '-ink)';
    const paint = L === 'fronts' || L === 'night' ? vars : vars + ';background:var(--z' + c + ');color:var(--z' + (c === 3 ? '3' : '') + '-ink)';
    return '<div class="pslot' + (sev === 'error' ? ' p-err' : sev === 'warn' ? ' p-warn' : '') + '" role="button" tabindex="0"' + (S.readOnly ? '' : ' draggable="true"') +
      ' data-act="amp-edit" data-dev="' + esc(d.id) + '"' + (extra || '') + ' style="' + paint + '" title="' + esc(tip) + '" aria-label="' + esc(lab + '. ' + tip) + '">' + slotInner(v, a, d, L) + '</div>';
  }
  const rackAttrs = (r) => ' data-rid="' + esc(r.id) + '"' + (S.readOnly ? '' : ' draggable="true" title="Drag to move ' + esc(r.name) + '"');
  function rackBoxHtml(v, a, r) {
    const ro = S.readOnly;
    const inner = C.rackSlots(v, r).map((d, k) => (d
      ? ampChip(v, a, d, ' data-rack="' + esc(r.id) + '" data-slot="' + k + '"')
      : '<div class="pslot p-empty" role="button" tabindex="0" data-act="' + (ro ? '' : 'amp-new') + '" data-rack="' + esc(r.id) + '" data-slot="' + k + '" aria-label="Empty slot ' + (k + 1) + ' in ' + esc(r.name) + '">' + (ro ? '' : 'free') + '</div>')).join('');
    const sw = v.devices.filter((d) => d.rack === r.id && !C.isAmpModel(d.model));
    const foot = sw.length ? '<div class="prack-foot">' + esc(sw.map((d) => d.model + (C.parseIp(d.ip) != null ? ' .' + C.host(C.parseIp(d.ip)) : '')).join(' · ')) + '</div>' : '';
    const del = ro ? '' : '<button type="button" class="prack-del" data-act="rack-del" data-rack="' + esc(r.id) + '" title="Delete ' + esc(r.name) + '" aria-label="Delete ' + esc(r.name) + '"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>';
    const name = '<button type="button" class="prack-name" data-act="rack-edit" data-rack="' + esc(r.id) + '"' + (ro ? ' disabled' : '') + ' title="' + esc((r.type || 'Custom rack') + (ro ? '' : ' · click to edit')) + '"><span>' + esc(r.name) + '</span>' + (r.type ? '<small>' + esc(r.type) + '</small>' : '') + '</button>';
    const L = layoutOf();
    if (L === 'fronts') {
      const ls = sw.map((d) => '<div class="pfr-ls"><span>' + esc(d.model) + '</span><span>' + (hostOf(d) != null ? '.' + hostOf(d) : '') + '</span></div>').join('');
      return '<div class="prack pfr""' + rackAttrs(r) + '>' + del + name + '<div class="pfr-body"><i class="pfr-ear" aria-hidden="true"></i><div class="pfr-slots">' + inner + ls + '</div><i class="pfr-ear" aria-hidden="true"></i></div></div>';
    }
    if (L === 'lanes' || L === 'ipgrid') return '<div class="prack plane""' + rackAttrs(r) + '>' + del + name + '<div class="plane-slots">' + inner + '</div>' + (sw.length ? '<span class="plane-foot">' + esc(sw.map((d) => d.model).join(' · ')) + '</span>' : '') + '</div>';
    if (L === 'night') return '<div class="prack pnr""' + rackAttrs(r) + '>' + del + name + '<div class="pnr-grid">' + inner + '</div></div>';
    return '<div class="prack""' + rackAttrs(r) + '>' + del + '<div class="prack-box" style="--n:' + r.size + '">' + name + inner + foot + '</div></div>';
  }
  // an amp outside the racks, drawn as its own one-amp case
  // a single amp's case: drag it anywhere (like a rack), × deletes the amp
  const singleAttrs = (d) => ' data-did="' + esc(d.id) + '"' + (S.readOnly ? '' : ' draggable="true" title="Drag to move ' + esc(d.name || d.model) + '"');
  const singleDel = (d) => (S.readOnly ? '' : '<button type="button" class="prack-del" data-act="amp-del" data-dev="' + esc(d.id) + '" title="Delete ' + esc(d.name || d.model) + '" aria-label="Delete ' + esc(d.name || d.model) + '"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>');
  function singleHtml(v, a, d) {
    const m = C.modelOf(d.model).label;
    const L = layoutOf();
    if (L === 'lanes' || L === 'ipgrid') return '<div class="prack psingle plane"' + singleAttrs(d) + '>' + singleDel(d) + '<div class="prack-name is-static"><span>Single</span><small>' + esc(m) + '</small></div><div class="plane-slots">' + ampChip(v, a, d, '') + '</div></div>';
    if (L === 'fronts' || L === 'night') return '<div class="prack psingle ' + (L === 'fronts' ? 'pfr-single' : 'pnr-single') + '"' + singleAttrs(d) + '>' + singleDel(d) + '<div class="prack-name is-static"><span>' + esc((d.name || m).slice(0, 22)) + '</span><small>single</small></div>' + ampChip(v, a, d, '') + '</div>';
    return '<div class="prack psingle"' + singleAttrs(d) + '>' + singleDel(d) + '<div class="prack-box" style="--n:1"><div class="prack-name is-static" title="' + esc(m) + '"><span>' + esc((d.name || m).slice(0, 18)) + '</span><small>' + esc(m) + '</small></div>' + ampChip(v, a, d, '') + '</div></div>';
  }
  function planHtml(v, a) {
    const ro = S.readOnly;
    const racks = v.racks || [];
    const amps = v.devices.filter((d) => C.isAmpModel(d.model));
    const loose = amps.filter((d) => !C.rackById(v, d.rack));
    const noZone = amps.some((d) => !v.zones.some((z) => z.id === d.zone));
    const legend = '<ul class="plan-legend" aria-label="Zones">' + v.zones.map((z) => '<li><span class="sw" style="background:var(--z' + z.color + ')"></span>' + esc(z.name) + '</li>').join('') +
      (noZone ? '<li><span class="sw" style="background:var(--z8)"></span>No zone</li>' : '') + '</ul>';
    const sub = [a.info.blockStr ? a.info.blockStr + '.x' : '', C.plural(racks.length, 'rack'), C.plural(amps.length, 'amp')].filter(Boolean).join(' · ');
    const head = '<div class="plan-head"><p class="plan-sub">' + esc(sub) + '</p></div>';
    // amps outside the racks sit on their zone's side of the stage, after that side's racks
    const sides = C.SIDES.map((sd) => {
      const items = C.planItems(v, sd);
      const n = items.length;
      const label = C.SIDE_LABEL[sd];
      return '<section class="pside pside-' + sd + '" aria-label="' + label + '" data-side="' + sd + '"><div class="pside-tag">' + label + '</div>' +
        (n ? '<div class="pgrid" style="--cols:' + Math.max(1, Math.ceil(n / 3)) + '">' + items.map((it) => (it.rack ? rackBoxHtml(v, a, it.rack) : singleHtml(v, a, it.dev))).join('') + '</div>' : '<p class="pside-empty">No racks</p>') +
        (ro ? '' : '<div class="pside-add"><button type="button" class="btn-mini" data-act="amp-new" data-side="' + sd + '">+ Amp in rack</button><button type="button" class="btn-mini" data-act="amp-new" data-loose="1" data-side="' + sd + '">+ Single amp</button><button type="button" class="btn-mini" data-act="rack-add" data-side="' + sd + '">+ Rack</button></div>') + '</section>';
    }).join('');
    const hint = ro ? '' : '<p class="plan-hint">Click an amp to change it. Drag racks and amps to move them; hold Ctrl to copy.</p>';
    const callout = !ro && !racks.length && loose.length
      ? '<div class="plan-callout"><div><b>' + esc(C.plural(loose.length, 'amp')) + ' not in racks yet</b><span>Pack into racks puts each zone’s amps on its side of the stage, filling L-Acoustics racks of 3. You can move them afterwards.</span></div><button type="button" class="btn btn-primary" data-act="rack-pack">Pack into racks</button></div>'
      : '';
    const L = layoutOf();
    const pick = '';
    const deck = L === 'stage'
      ? '<div class="pdeck" aria-hidden="true">STAGE</div><div class="pdeck pdeck-foh" aria-hidden="true">FOH</div>'
      : '';
    const top = L === 'ipgrid' ? ipGridHtml(v, a) : '';
    const body = GRID_LAYOUTS[L] ? gridHtml(v, a, L, deck) : '<div class="pstage">' + deck + sides + '</div>';
    return '<div class="card plan" data-layout="' + L + '">' + pick + head + hint + callout + top + body + legend.replace('class="plan-legend"', 'class="plan-legend at-bottom"') + '</div>';
  }
  // ---- the free grid (Monitors and Stage plot): one cell = one amp; racks and single amps snap to cells
  const GRID_LAYOUTS = { monitors: 1, stage: 1 };
  // zoom of the grid, remembered per browser: 30%–150%
  const ZOOM_MIN = 0.3;
  const ZOOM_MAX = 1.5;
  const zoomOf = () => { const z = Number(prefs.planZoom); return Number.isFinite(z) && z >= ZOOM_MIN && z <= ZOOM_MAX ? z : 1; };
  function setZoom(z) {
    z = Math.round(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z)) * 100) / 100;
    const old = zoomOf();
    if (z === old) return;
    const cv = $('.pcanvas');
    const top = cv ? cv.scrollTop * (z / old) : 0;
    prefs.planZoom = z;
    savePrefs();
    renderTab();
    const nv = $('.pcanvas');
    if (nv) nv.scrollTop = top;
  }
  // the zoom at which every rack fits: across (both sides' used columns) and down (into the window)
  function fitZoom() {
    const v = cur();
    if (!v) return;
    const lay = C.gridLayout(v, 64);
    const used = { L: 0, R: 0 };
    let rows = 6;
    for (const it of lay) { used[it.side] = Math.max(used[it.side], it.c + 1); rows = Math.max(rows, it.r + it.h); }
    const colsNeeded = Math.max(2, used.L + used.R + 1);
    const W = gridWidth();
    const availH = Math.max(240, window.innerHeight - 170);
    setZoom(Math.min(ZOOM_MAX, (W + 14) / (colsNeeded * CELL_W), availH / ((rows + 1) * CELL_H)));
    const wrap = $('.pgridwrap');
    try { if (wrap) wrap.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (e) { /* ignore */ }
  }

  const CELL_W = 142;
  const CANVAS_H = 660;
  const CELL_H = 30;
  // width the grid can use: the plan card's inner width (measured after each draw)
  const gridWidth = () => S.gridW || Math.max(320, Math.min(window.innerWidth - 120, 1600));
  function gridGeom() {
    const z = zoomOf();
    const cw = CELL_W * z;
    const ch = CELL_H * z;
    const W = gridWidth();
    const cols = Math.max(2, Math.floor((W + 14 * z) / cw));
    return { z, cw, ch, W, cols, half: Math.floor(cols / 2) };
  }
  function gridHtml(v, a, L, deck) {
    const ro = S.readOnly;
    const g = gridGeom();
    const lay = C.gridLayout(v, g.half);
    const rows = Math.max(18, ...lay.map((x) => x.r + x.h)) + 4;
    // left racks count from the left edge, right racks from the right edge (so each side hugs its edge)
    const leftPx = (it) => (it.side === 'L' ? it.c * g.cw : g.W - it.c * g.cw - 128 * g.z);
    // only racks and the squares scale; the work area keeps its width, so zooming out opens up columns
    const items = lay.map((it) => '<div class="pcell" data-key="' + esc(it.key) + '" style="left:' + leftPx(it) + 'px;top:' + it.r * g.ch + 'px;width:' + 128 * g.z + 'px;height:' + (it.h * CELL_H - 8) * g.z + 'px">' +
      '<div class="pcell-in" style="zoom:' + g.z + ';height:' + (it.h * CELL_H - 8) + 'px">' + (it.rack ? rackBoxHtml(v, a, it.rack) : singleHtml(v, a, it.dev)) + '</div></div>').join('');
    const adds = (sd) => (ro ? '' : '<details class="add-menu add-' + sd + '"><summary class="btn-mini">+ Add</summary><div class="add-pop" role="menu">' +
      '<button type="button" role="menuitem" data-act="amp-new" data-side="' + sd + '">Amp in a rack</button>' +
      '<button type="button" role="menuitem" data-act="amp-new" data-loose="1" data-side="' + sd + '">Single amp</button>' +
      '<button type="button" role="menuitem" data-act="rack-add" data-side="' + sd + '">Empty rack</button></div></details>');
    const zoomBar = '<div class="pzoom" role="group" aria-label="Zoom the racks"><button type="button" class="btn-mini" data-act="plan-zoom" data-z="-1" aria-label="Zoom out">−</button>' +
      '<button type="button" class="btn-mini pzoom-val" data-act="plan-zoom" data-z="1x" title="Back to 100%">' + Math.round(g.z * 100) + '%</button>' +
      '<button type="button" class="btn-mini" data-act="plan-zoom" data-z="+1" aria-label="Zoom in">+</button>' +
      '<button type="button" class="btn-mini" data-act="plan-zoom" data-z="fit" title="Make every rack fit on screen (Ctrl + mouse wheel zooms too)">Fit</button></div>';
    const halfW = g.half * g.cw;
    return '<div class="pgridwrap">' + zoomBar +
      '<div class="pgrid-head"><div class="pside-tag pside-tag-L">Left</div><div class="pside-tag pside-tag-R">Right</div></div>' +
      '<div class="pcanvas" data-cols="' + g.cols + '" data-half="' + g.half + '" data-cw="' + g.cw + '" data-ch="' + g.ch + '" data-w="' + g.W + '" data-z="' + g.z + '" style="height:' + CANVAS_H + 'px;--cw:' + g.cw + 'px;--ch:' + g.ch + 'px;--halfw:' + halfW + 'px">' +
      // the work area keeps one size whatever the zoom; only the racks and squares inside it scale.
      // If racks reach past the bottom, the area scrolls instead of growing.
      '<div class="psizer" style="height:' + Math.max(CANVAS_H - 2, (Math.max(0, ...lay.map((x) => x.r + x.h)) + 1) * g.ch) + 'px">' +
      '<div class="ptint ptint-L" style="width:' + halfW + 'px"></div><div class="ptint ptint-R" style="width:' + halfW + 'px"></div>' + deck + items + '<div class="pghost" hidden></div></div></div>' +
      '<div class="pgrid-foot">' + adds('L') + adds('R') + '</div></div>';
  }
  // after drawing: if the card's width changed, draw again with the right number of columns
  function syncGridWidth() {
    const wrap = $('.pgridwrap');
    if (!wrap) return;
    // the canvas's inside width (no border, no scrollbar), so the last column fits fully
    const cv = $('.pcanvas');
    const w = (cv ? cv.clientWidth : wrap.clientWidth) - 4;
    if (w && Math.abs(w - (S.gridW || 0)) > 2) { S.gridW = w; renderTab(); }
  }
  // every address of the network block in rows of ten; used numbers coloured by zone, free ones add an amp there
  function ipGridHtml(v, a) {
    const i = a.info;
    if (!i.ok) return '<p class="muted">Set the network first.</p>';
    let maxUsed = 0;
    for (let h = 1; h <= C.MAX_HOST; h++) if (a.occ.has(i.block + h)) maxUsed = h;
    const as = v.net.assign;
    const zoneEnd = as.scheme === 'zones' ? as.start + v.zones.length * as.size - 1 : 0;
    const last = Math.min(C.MAX_HOST, Math.max(60, Math.ceil((Math.max(maxUsed, zoneEnd) + 1) / 10) * 10));
    let rows = '';
    let used = 0;
    for (let r0 = 1; r0 <= last; r0 += 10) {
      const zk = as.scheme === 'zones' ? v.zones.findIndex((z, k) => as.start + k * as.size >= r0 && as.start + k * as.size < r0 + 10) : -1;
      const label = zk >= 0 ? v.zones[zk].name : r0 === 1 ? 'Infrastructure' : '';
      let cells = '';
      for (let h = r0; h < r0 + 10 && h <= last; h++) {
        const occ = a.occ.get(i.block + h) || [];
        const o = occ.find((x) => x.type === 'dev');
        const d = o ? v.devices.find((x) => x.id === o.id) : null;
        if (occ.length) used++;
        if (d) {
          const c = zoneColorOf(v, d);
          const amp = C.isAmpModel(d.model);
          cells += '<button type="button" class="ipc2' + (occ.length > 1 ? ' p-err' : '') + '"' + (amp && !S.readOnly ? ' data-act="amp-edit" data-dev="' + esc(d.id) + '"' : ' disabled') + ' style="background:var(--z' + c + ');color:var(--z' + (c === 3 ? '3' : '') + '-ink)" title="' + esc(d.name + ' · ' + d.ip) + '"><b>.' + h + '</b><span>' + esc(C.presetOf(v, d) || C.modelOf(d.model).label) + '</span></button>';
        } else if (occ.length) {
          cells += '<button type="button" class="ipc2 is-sys" disabled title="' + esc(occ[0].type === 'pc' ? 'Control computer' : 'Gateway') + '"><b>.' + h + '</b><span>' + (occ[0].type === 'pc' ? 'NWM' : 'GW') + '</span></button>';
        } else {
          cells += '<button type="button" class="ipc2 is-free"' + (S.readOnly ? ' disabled' : ' data-act="amp-new" data-loose="1" data-host="' + h + '"') + ' title="Add an amp on .' + h + '"><b>.' + h + '</b></button>';
        }
      }
      rows += '<div class="ipg-row"><div class="ipg-lab">' + esc(label) + '<small>.' + r0 + '–.' + Math.min(r0 + 9, last) + '</small></div><div class="ipg-cells">' + cells + '</div></div>';
    }
    return '<section class="ipg" aria-label="Addresses"><div class="ipg-head mono">' + esc(i.blockStr) + '.x · click a free number to add an amp there</div>' + rows + '</section>';
  }
  // which block an amp's number lives in: the primary one, or the secondary one for a
  // single-port unit that was put on the secondary network
  function ampBlock(v, i, d, model) {
    const onSec = !!(v.net.redundancy && !C.modelOf(model).red && d && d.net === 'sec' && i.secBlock != null);
    return { onSec, block: onSec ? i.secBlock : i.block, str: onSec ? i.secBlockStr : i.blockStr };
  }
  function hostOptions(v, a, d, host0, model) {
    const i = a.info;
    const b = ampBlock(v, i, d, model);
    const dual = !!(v.net.redundancy && C.modelOf(model).red && i.secBlock != null);
    const others = (list) => (list || []).filter((o) => !(o.type === 'dev' && d && o.id === d.id));
    const nameOf = (o) => (o.type === 'pc' ? 'control computer' : o.type === 'gw' ? 'gateway' : (v.devices.find((x) => x.id === o.id) || {}).name || 'device');
    let html = '<option value="">No IP yet</option>';
    if (!i.ok || b.block == null) return html;
    for (let h = 1; h <= C.MAX_HOST; h++) {
      const p = b.block + h;
      const used = others(a.occ.get(p));
      const usedSec = dual ? others(a.occ.get(i.secBlock + h)) : [];
      let note = '';
      if (used.length) note = nameOf(used[0]);
      else if (usedSec.length) note = nameOf(usedSec[0]) + ' (secondary)';
      else if (a.dhcp && p >= a.dhcp.from && p <= a.dhcp.to) note = 'DHCP pool';
      else if (b.str === '192.168.1' && (p === C.FD_UNIT || p === C.FD_LS10)) note = 'factory address';
      // a number held by another device can be taken: the two swap addresses on save.
      // Only the control computer and the gateway are off limits.
      const all = used.concat(usedSec);
      const fixed = all.some((o) => o.type !== 'dev');
      if (all.length && !fixed) note += ' (swap)';
      html += '<option value="' + h + '"' + (h === host0 ? ' selected' : '') + (fixed && h !== host0 ? ' disabled' : '') + '>' + h + (note ? ' · ' + esc(note) : '') + '</option>';
    }
    return html;
  }
  function firstFreeHost(v, a, zoneId, model) {
    const i = a.info;
    if (!i.ok) return '';
    const dual = !!(v.net.redundancy && C.modelOf(model).red && i.secBlock != null);
    const zk = v.zones.findIndex((z) => z.id === zoneId);
    const k = zk < 0 ? v.zones.length : zk;
    const as = v.net.assign;
    const lo = Math.min(C.MAX_HOST, as.scheme === 'zones' ? as.start + k * as.size : as.start);
    for (let pass = 0; pass < 2; pass++) {
      for (let h = pass ? 1 : lo; h <= C.MAX_HOST; h++) {
        const p = i.block + h;
        if (a.occ.has(p) || (dual && a.occ.has(i.secBlock + h))) continue;
        if (a.dhcp && p >= a.dhcp.from && p <= a.dhcp.to) continue;
        if (as.avoidDefaults && i.blockStr === '192.168.1' && (p === C.FD_UNIT || p === C.FD_LS10)) continue;
        return h;
      }
    }
    return '';
  }
  function positionOptions(v, a, d, rack0, slot0) {
    let html = '<option value=""' + (!rack0 ? ' selected' : '') + '>Not in a rack</option>';
    for (const sd of C.SIDES) {
      for (const r of (v.racks || []).filter((x) => x.side === sd)) {
        html += '<optgroup label="' + esc(r.name + ' · ' + C.SIDE_LABEL[r.side] + (r.type ? ' · ' + r.type : '')) + '">';
        C.rackSlots(v, r).forEach((o, k) => {
          const mine = d && o && o.id === d.id;
          html += '<option value="' + esc(r.id) + ':' + k + '"' + (r.id === rack0 && k === slot0 ? ' selected' : '') + '>' + esc(r.name) + ' · slot ' + (k + 1) + (mine ? ' · this amp' : o ? ' · ' + esc(C.slotLabel(v, o, a.info)) + ' (swap)' : ' · empty') + '</option>';
        });
        html += '</optgroup>';
      }
    }
    return html;
  }
  function openAmpEditor(o) {
    const v = cur();
    if (!v || S.readOnly) return;
    const a = analysis(v);
    const i = a.info;
    const d = o.dev ? v.devices.find((x) => x.id === o.dev) : null;
    if (o.dev && !d) return;
    const isNew = !d;
    const g = d && d.drives ? v.speakers.find((x) => x.id === d.drives) : null;
    const rack0 = d ? (C.rackById(v, d.rack) ? d.rack : '') : o.rack || '';
    const slot0 = d ? d.slot : o.slot != null ? o.slot : -1;
    const rackObj = C.rackById(v, rack0);
    const side0 = rackObj ? rackObj.side : o.side || '';
    const zone0 = d ? d.zone : o.noZone ? '' : (v.zones.find((z) => side0 && z.side === side0) || v.zones[0]).id;
    const model0 = d ? d.model : (rackObj && C.rackModel(v, rackObj)) || 'LA12X';
    const b0 = ampBlock(v, i, d, model0);
    const ip0 = d ? C.parseIp(d.ip) : null;
    const inBlock = ip0 != null && b0.block != null && C.blockOf(ip0) === b0.block;
    const host0 = inBlock ? C.host(ip0) : isNew ? (o.host || firstFreeHost(v, a, zone0, model0)) : '';
    const preset0 = g ? g.model : d ? d.preset || '' : '';
    const presetSel = C.SPEAKER_MAP[preset0] ? preset0 : preset0 ? 'Custom' : '';
    const zname = g ? (v.zones.find((z) => z.id === g.zone) || {}).name || '' : '';
    const custom0 = g ? (g.model === 'Custom' ? C.speakerLabel(g) : '') : presetSel === 'Custom' ? preset0 : '';
    const presetPick = '<select id="ae-preset"' + (g ? ' hidden' : '') + '><option value="">No preset</option>' + speakerOptions(presetSel, 'Other (type a name)') + '</select>' +
      '<input id="ae-custom" maxlength="40" placeholder="Preset name" autocomplete="off" aria-label="Preset name" value="' + esc(custom0) + '"' + (presetSel === 'Custom' && !g ? '' : ' hidden') + '>';
    const locked = g ? '<div class="locked" id="ae-locked"><b>' + esc(C.speakerLabel(g)) + '</b><span>Set by Speakers & amps: ' + g.qty + ' × ' + esc(C.speakerLabel(g)) + (zname ? ' in ' + esc(zname) : '') + ' on ' + esc(g.amp) + '.</span>' +
      '<button type="button" class="btn-mini" id="ae-unlock">Use another preset on this amp</button></div>' : '';
    const outside = ip0 != null && !inBlock ? '<small class="warn-text">Now ' + esc(d.ip) + (b0.str ? ', outside ' + esc(b0.str) + '.x. Picking a number replaces it.' : '.') + '</small>' : '';
    const ampOpts = C.MODELS.filter((m) => m.group === 'amp').map((m) => '<option value="' + esc(m.id) + '"' + (m.id === model0 ? ' selected' : '') + '>' + esc(m.label) + '</option>').join('');
    openModal({
      title: isNew ? 'Add amp' : (d.preset || d.drives || C.parseIp(d.ip) != null || !d.name ? C.slotLabel(v, d, i) : d.name),
      body: '<div class="form-grid">' +
        '<div class="field"><label for="ae-preset">Preset (speaker)</label>' + locked + presetPick + '<small id="ae-preset-hint"></small></div>' +
        '<div class="field"><label for="ae-ip">IP address, last number</label><div class="join"><span class="prefix mono" id="ae-prefix">' + esc((b0.str || i.blockStr || '192.168.1') + '.') + '</span><select id="ae-ip" class="mono">' + hostOptions(v, a, d, host0, model0) + '</select></div>' + outside + '<small id="ae-ip-hint"></small></div>' +
        '<div class="field"><label for="ae-zone">Zone (colour)</label><select id="ae-zone"' + (g ? ' disabled' : '') + '>' + zoneOptions(v, zone0, true) + '</select></div>' +
        '</div><details class="fold fold-sm"' + (S.open.ampMore ? ' open' : '') + ' data-sec="ampMore"><summary>More: amplifier, rack, name' + (isNew ? '' : ', delete') + '</summary><div class="form-grid">' +
        '<div class="field"><label for="ae-model">Amplifier</label><select id="ae-model"' + (g ? ' disabled' : '') + '>' + ampOpts + '</select></div>' +
        '<div class="field"><label for="ae-pos">Rack and slot</label><select id="ae-pos">' + positionOptions(v, a, d, rack0, slot0) + '</select></div>' +
        '<div class="field"><label for="ae-name">Name</label><input id="ae-name" maxlength="80" value="' + esc(d ? d.name : '') + '" placeholder="Named automatically" autocomplete="off"></div>' +
        '</div>' + (isNew ? '' : '<button type="button" class="btn btn-quiet danger" id="ae-del">Delete this amp</button>') + '</details>',
      actions: [{ label: 'Cancel' }, { label: isNew ? 'Add amp' : 'Save', kind: 'primary', onClick: (m) => saveAmp(v, d, m, g, host0) }],
      onOpen: (m) => {
        const ps = $('#ae-preset', m);
        const cu = $('#ae-custom', m);
        const mo = $('#ae-model', m);
        const ipSel = $('#ae-ip', m);
        const linked = () => g && !m._unlink;
        const del = $('#ae-del', m);
        if (del) del.addEventListener('click', () => { closeModal(); deleteDevices([d.id]); });
        const hint = () => {
          const p = linked() ? g.model : ps.value !== 'Custom' ? ps.value : '';
          const am = linked() ? g.amp : mo.value;
          $('#ae-preset-hint', m).textContent = m._unlink
            ? 'This amp leaves the ' + C.speakerLabel(g) + ' group, which will be one amp short until you fix it on Speakers & amps.'
            : p && C.SPEAKER_MAP[p]
              ? (C.driveMax(p, am) ? 'Up to ' + C.driveMax(p, am) + ' × ' + p + ' per ' + am + '.' : am + ' isn’t listed for ' + p + '. Use ' + C.driveOptions(p).join(' or ') + '.')
              : '';
          const h = ipSel.value;
          const b = ampBlock(v, i, d, am);
          const dual = v.net.redundancy && C.modelOf(am).red && i.secBlockStr;
          $('#ae-prefix', m).textContent = (b.str || i.blockStr || '192.168.1') + '.';
          $('#ae-ip-hint', m).textContent = h
            ? b.str + '.' + h + (dual ? ' and ' + i.secBlockStr + '.' + h + ' on the secondary network' : '') + '.'
            : i.ok ? 'Numbers marked “swap” belong to another device; picking one swaps the two addresses.' : 'Fix the network on the Venue panel first.';
        };
        const refillIp = () => {
          const keep = ipSel.value;
          ipSel.innerHTML = hostOptions(v, a, d, keep === '' ? '' : +keep, linked() ? g.amp : mo.value);
          const opt = ipSel.querySelector('option[value="' + keep + '"]');
          if (!opt || opt.disabled) ipSel.value = '';
          hint();
        };
        ps.addEventListener('change', () => { cu.hidden = ps.value !== 'Custom'; if (!cu.hidden) cu.focus(); hint(); });
        mo.addEventListener('change', refillIp);
        ipSel.addEventListener('change', hint);
        const un = $('#ae-unlock', m);
        if (un) un.addEventListener('click', () => {
          m._unlink = true;
          $('#ae-locked', m).hidden = true;
          ps.hidden = false;
          cu.hidden = ps.value !== 'Custom';
          mo.disabled = false;
          $('#ae-zone', m).disabled = false;
          ps.focus();
          hint();
        });
        hint();
      },
    });
  }
  function saveAmp(v, d, m, g, host0) {
    const i = C.netInfo(v);
    const isNew = !d;
    const unlink = !!(g && m._unlink);
    const keepGroup = g && !unlink;
    const zone = $('#ae-zone', m).value;
    const model = keepGroup ? g.amp : $('#ae-model', m).value;
    let preset = '';
    if (!keepGroup) {
      const ps = $('#ae-preset', m).value;
      preset = ps === 'Custom' ? $('#ae-custom', m).value.trim() : ps;
    }
    if (isNew && v.devices.length >= C.MAX_DEVICES) { toast('A venue holds up to ' + C.MAX_DEVICES + ' devices.'); return false; }
    pushUndo(v, isNew ? 'amp-new' : 'amp');
    if (isNew) {
      const z = v.zones.find((x) => x.id === zone);
      const base = (z ? z.name + ' ' : '') + (preset || C.modelOf(model).label);
      d = C.newDevice({ name: base + ' ' + C.nextIndex(v, base), model, zone });
      v.devices.push(d);
    }
    if (!keepGroup) { d.drives = ''; d.model = model; d.preset = preset; d.zone = zone; }
    const h = $('#ae-ip', m).value;
    const b = ampBlock(v, i, d, d.model);
    const oldIp = d.ip;
    const swapped = [];
    if (h && b.str) {
      d.ip = b.str + '.' + h;
      if (d.ip !== oldIp) {
        // whoever held this number (or its secondary twin) gets this amp's old address
        const twin = i.secBlockStr ? i.secBlockStr + '.' + h : '';
        const dual = v.net.redundancy && C.modelOf(d.model).red;
        for (const x of v.devices) {
          if (x === d || !x.ip) continue;
          const xDual = v.net.redundancy && C.modelOf(x.model).red && i.secBlockStr;
          const xHost = C.parseIp(x.ip) != null ? C.host(C.parseIp(x.ip)) : -1;
          const hit = x.ip === d.ip || (dual && x.ip === twin) || (xDual && x.ip.indexOf(i.blockStr + '.') === 0 && xHost === +h && b.str === i.secBlockStr);
          if (hit) { x.ip = oldIp && C.parseIp(oldIp) != null ? oldIp : ''; swapped.push(x); }
        }
      }
    } else if (!h && host0 !== '') d.ip = '';
    const nm = $('#ae-name', m).value.trim();
    if (nm) d.name = nm;
    const pos = $('#ae-pos', m).value;
    if (pos) { const parts = pos.split(':'); C.placeDevice(v, d.id, parts[0], +parts[1]); } else C.placeDevice(v, d.id, '', -1);
    touch(v);
    render();
    let left = unlink ? ' It now runs on its own, so ' + C.speakerLabel(g) + ' is one amp short. Fix it on Speakers & amps.' : '';
    if (swapped.length) left += ' ' + swapped.map((x) => x.name).join(', ') + (swapped[0].ip ? ' moved to ' + swapped[0].ip : ' now has no IP') + '.';
    toast((isNew ? 'Added ' : 'Saved ') + C.slotLabel(v, d, C.netInfo(v)) + '.' + left, undoAction());
  }
  // a new empty rack: name, side, type and slots; amps go in afterwards through its free slots
  function openNewRack(side0) {
    const v = cur();
    if (!v || S.readOnly) return;
    const side = C.SIDES.indexOf(side0) >= 0 ? side0 : 'L';
    openModal({
      title: 'Add empty rack',
      body: '<div class="form-grid">' +
        '<div class="field"><label for="nr-name">Name</label><input id="nr-name" maxlength="40" value="' + esc(C.nextRackName(v)) + '" autocomplete="off"></div>' +
        '<div class="field"><label for="nr-side">Side of the stage</label><select id="nr-side">' + C.SIDES.map((sd) => '<option value="' + sd + '"' + (sd === side ? ' selected' : '') + '>' + C.SIDE_LABEL[sd] + '</option>').join('') + '</select></div>' +
        '<div class="field"><label for="nr-type">Rack type</label><select id="nr-type"><option value="">Custom rack</option>' + C.RACKS.map((x) => '<option value="' + esc(x.id) + '"' + (x.id === 'LA-RAK II AVB' ? ' selected' : '') + '>' + esc(x.id + ' · ' + x.info) + '</option>').join('') + '</select></div>' +
        '<div class="field"><label for="nr-size">Amp slots</label><input id="nr-size" type="number" min="1" max="8" value="3" inputmode="numeric"></div></div>' +
        '<p class="muted">The rack starts empty. Click a free slot afterwards to add an amp to it.</p>',
      actions: [
        { label: 'Cancel' },
        { label: 'Add rack and an amp', onClick: (m) => { const r = createRack(v, m); if (r) setTimeout(() => openAmpEditor({ rack: r.id, slot: 0 }), 0); } },
        { label: 'Add empty rack', kind: 'primary', onClick: (m) => { createRack(v, m); } },
      ],
      onOpen: (m) => {
        const ty = $('#nr-type', m);
        ty.addEventListener('change', () => { const r = C.RACK_MAP[ty.value]; if (r) $('#nr-size', m).value = r.amps.length; });
      },
    });
  }
  function createRack(v, m) {
    pushUndo(v, 'rack');
    const type = C.RACK_MAP[$('#nr-type', m).value] ? $('#nr-type', m).value : '';
    const r = C.addRack(v, { name: $('#nr-name', m).value.trim() || C.nextRackName(v), side: $('#nr-side', m).value, size: C.clampInt($('#nr-size', m).value, 1, 8, 3), type });
    touch(v);
    render();
    toast('Added empty ' + r.name + ' on the ' + C.SIDE_LABEL[r.side].toLowerCase() + '. Click a free slot to add an amp.', { label: 'Add amp', onClick: () => openAmpEditor({ rack: r.id, slot: 0 }) });
    return r;
  }
  function openRackEditor(id) {
    const v = cur();
    const r = v && C.rackById(v, id);
    if (!r || S.readOnly) return;
    openModal({
      title: r.name,
      body: '<div class="form-grid">' +
        '<div class="field"><label for="re-name">Name</label><input id="re-name" maxlength="40" value="' + esc(r.name) + '" autocomplete="off"></div>' +
        '<div class="field"><label for="re-side">Side of the stage</label><select id="re-side">' + C.SIDES.map((sd) => '<option value="' + sd + '"' + (sd === r.side ? ' selected' : '') + '>' + C.SIDE_LABEL[sd] + '</option>').join('') + '</select></div>' +
        '<div class="field"><label for="re-type">Rack type</label><select id="re-type"><option value="">Custom rack</option>' + C.RACKS.map((x) => '<option value="' + esc(x.id) + '"' + (x.id === r.type ? ' selected' : '') + '>' + esc(x.id + ' · ' + x.info) + '</option>').join('') + '</select></div>' +
        '<div class="field"><label for="re-size">Amp slots</label><input id="re-size" type="number" min="1" max="8" value="' + r.size + '" inputmode="numeric"></div></div>' +
        '<p class="muted" id="re-note"></p>',
      actions: [
        { label: 'Delete rack', kind: 'quiet danger', left: true, onClick: () => deleteRack(v, r, false) },
        { label: 'Delete with amps', kind: 'quiet danger', onClick: () => deleteRack(v, r, true) },
        { label: 'Cancel' },
        { label: 'Save', kind: 'primary', onClick: (m) => {
          pushUndo(v, 'rack');
          r.name = $('#re-name', m).value.trim() || r.name;
          r.side = C.SIDES.indexOf($('#re-side', m).value) >= 0 ? $('#re-side', m).value : r.side;
          r.type = C.RACK_MAP[$('#re-type', m).value] ? $('#re-type', m).value : '';
          const out = C.resizeRack(v, r, C.clampInt($('#re-size', m).value, 1, 8, r.size));
          touch(v);
          render();
          toast('Saved ' + r.name + (out.length ? '. ' + C.plural(out.length, 'amp') + ' moved to Not in a rack' : '') + '.', undoAction());
        } },
      ],
      onOpen: (m) => {
        const upd = () => {
          const n = C.clampInt($('#re-size', m).value, 1, 8, r.size);
          const lost = C.rackSlots(v, r).slice(n).filter(Boolean).length;
          $('#re-note', m).textContent = lost ? C.plural(lost, 'amp') + ' would move to Not in a rack.' : '';
        };
        m.addEventListener('input', upd);
        upd();
      },
    });
  }
  function svgToPng(svg) {
    return new Promise((resolve, reject) => {
      const mm = /width="(\d+)" height="(\d+)"/.exec(svg);
      const w = mm ? +mm[1] : 1200;
      const h = mm ? +mm[2] : 800;
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = w * 2;
          c.height = h * 2;
          const ctx = c.getContext('2d');
          ctx.scale(2, 2);
          ctx.drawImage(img, 0, 0, w, h);
          c.toBlob((b) => (b ? resolve(b) : reject(new Error('png'))), 'image/png');
        } catch (e) { reject(e); }
      };
      img.onerror = () => reject(new Error('image'));
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    });
  }
  const ITEM_SEL = '.prack[data-rid], .psingle[data-did]';
  const itemKey = (el) => (el.dataset.rid ? 'r:' + el.dataset.rid : el.dataset.did ? 'd:' + el.dataset.did : '');
  // an amp can land in a rack slot, next to a rack or single amp, or at the end of a side
  function dropTarget(el) {
    if (!el || !el.closest) return null;
    return el.closest('.prack:not(.psingle) .pslot') || el.closest(ITEM_SEL) || el.closest('.pside');
  }
  function rackDropTarget(el) {
    if (!el || !el.closest) return null;
    return el.closest(ITEM_SEL) || el.closest('.pside');
  }
  function clearRackMarks() { $$('.rk-before, .rk-after, .rk-end, .rk-dragging').forEach((x) => x.classList.remove('rk-before', 'rk-after', 'rk-end', 'rk-dragging')); }
  // before or after the rack under the pointer: by the horizontal half in a row of racks, vertical half in a column (lanes)
  function rackSide(t, e) {
    const b = t.getBoundingClientRect();
    const lanes = t.classList.contains('plane');
    return lanes ? e.clientY > b.top + b.height / 2 : e.clientX > b.left + b.width / 2;
  }
  function onDragStart(e) {
    const one = e.target.closest && !e.target.closest('.pslot') && e.target.closest('.psingle[data-did]');
    const sl = one ? one.querySelector('.pslot[data-dev]') : e.target.closest && e.target.closest('.pslot[data-dev]');
    const rk = !sl && e.target.closest && e.target.closest('.prack[data-rid]');
    S.grab = null;
    const holder = (rk || one || (sl && sl.closest('.psingle'))) ;
    if (holder) { const b = holder.getBoundingClientRect(); S.grab = { dx: e.clientX - b.left, dy: e.clientY - b.top }; }
    else if (sl) { const b = sl.getBoundingClientRect(); S.grab = { dx: Math.min(60 * zoomOf(), e.clientX - b.left), dy: e.clientY - b.top + 2 * CELL_H * zoomOf() }; }
    if (rk && !S.readOnly) {
      S.dragRack = rk.dataset.rid;
      try { e.dataTransfer.effectAllowed = 'copyMove'; e.dataTransfer.setData('text/plain', 'rack'); } catch (x) { /* older browsers */ }
      rk.classList.add('rk-dragging');
      $('#tip').hidden = true;
      return;
    }
    if (!sl || S.readOnly) return;
    S.drag = sl.dataset.dev;
    try { e.dataTransfer.effectAllowed = 'copyMove'; e.dataTransfer.setData('text/plain', sl.dataset.dev); } catch (x) { /* older browsers */ }
    sl.classList.add('dragging');
    $('#tip').hidden = true;
  }
  const wantsCopy = (e) => !!(e.ctrlKey || e.metaKey || e.altKey);
  // a drop on the free grid (not on a rack slot, and not Ctrl onto another amp to copy its preset)
  function gridTarget(e) {
    const canvas = e.target.closest && e.target.closest('.pcanvas');
    if (!canvas || !(S.dragRack || S.drag)) return null;
    if (S.drag && e.target.closest('.prack:not(.psingle) .pslot')) return null;
    if (S.drag && wantsCopy(e) && e.target.closest('.pslot[data-dev]')) return null;
    return canvas;
  }
  function gridCell(e, canvas) {
    const b = canvas.getBoundingClientRect();
    const g = S.grab || { dx: 20, dy: 20 };
    const cols = +canvas.dataset.cols;
    const half = +canvas.dataset.half;
    const cw = +canvas.dataset.cw;
    const ch = +canvas.dataset.ch;
    const W = +canvas.dataset.w;
    const z = +canvas.dataset.z;
    const x = e.clientX - b.left - g.dx; // where the item's left edge would be
    const side = x + 64 * z < W / 2 ? 'L' : 'R';
    const raw = side === 'L' ? x / cw : (W - x - 128 * z) / cw;
    const c = Math.max(0, Math.min(half - 1, Math.round(raw)));
    const left = side === 'L' ? c * cw : W - c * cw - 128 * z;
    return { side, c, r: Math.max(0, Math.round((e.clientY - b.top + canvas.scrollTop - g.dy) / ch)), left, cw, ch, half, cols };
  }
  function dragRows() {
    const v = cur();
    if (S.dragRack) { const r = v && C.rackById(v, S.dragRack); return r ? r.size + 2 : 5; }
    return 3;
  }
  function gridDrop(e, canvas) {
    const cell = gridCell(e, canvas);
    const copy = !!(S.dragCopy || wantsCopy(e));
    const rackId = S.dragRack;
    const devId = S.drag;
    onDragEnd();
    const v = cur();
    if (!v || S.readOnly) return;
    if (rackId) {
      const src = C.rackById(v, rackId);
      if (!src) return;
      pushUndo(v, copy ? 'rack-copy' : 'rack-move');
      const key = copy ? 'r:' + copyRack(v, src).id : 'r:' + rackId;
      C.placeOnGrid(v, key, cell.side, cell.c, cell.r, cell.half);
      touch(v);
      render();
      if (copy) toast('Copied ' + src.name + '.', undoAction());
      return;
    }
    const d = v.devices.find((x) => x.id === devId);
    if (!d) return;
    pushUndo(v, copy ? 'amp-copy' : 'move');
    let id = d.id;
    if (copy) id = copyAmp(v, d).id;
    else if (C.rackById(v, d.rack)) C.placeDevice(v, d.id, '', -1);
    C.placeOnGrid(v, 'd:' + id, cell.side, cell.c, cell.r, cell.half);
    touch(v);
    render();
    if (copy) toast('Copied ' + (C.presetOf(v, d) || C.modelOf(d.model).label) + '.', undoAction());
  }
  function onDragOver(e) {
    const canvas = gridTarget(e);
    if (canvas) {
      e.preventDefault();
      S.dragCopy = wantsCopy(e);
      document.body.classList.toggle('drag-copy', S.dragCopy);
      try { e.dataTransfer.dropEffect = S.dragCopy ? 'copy' : 'move'; } catch (x) { /* ignore */ }
      $$('.drop-hover, .rk-before, .rk-after, .rk-end').forEach((x) => x.classList.remove('drop-hover', 'rk-before', 'rk-after', 'rk-end'));
      const cell = gridCell(e, canvas);
      const gh = canvas.querySelector('.pghost');
      if (gh) { gh.hidden = false; gh.style.left = cell.left + 'px'; gh.style.top = cell.r * cell.ch + 'px'; gh.style.width = 128 * (cell.cw / CELL_W) + 'px'; gh.style.height = (dragRows() * CELL_H - 8) * (cell.ch / CELL_H) + 'px'; }
      return;
    }
    $$('.pghost').forEach((g) => { g.hidden = true; });
    if (S.dragRack || S.drag) {
      S.dragCopy = wantsCopy(e);
      document.body.classList.toggle('drag-copy', S.dragCopy);
    }
    if (S.dragRack) {
      const t = rackDropTarget(e.target);
      if (!t) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = S.dragCopy ? 'copy' : 'move'; } catch (x) { /* ignore */ }
      $$('.rk-before, .rk-after, .rk-end').forEach((x) => x.classList.remove('rk-before', 'rk-after', 'rk-end'));
      if (t.classList.contains('pside')) t.classList.add('rk-end');
      else if (t.dataset.rid !== S.dragRack) t.classList.add(rackSide(t, e) ? 'rk-after' : 'rk-before');
      return;
    }
    if (!S.drag) return;
    const t = dropTarget(e.target);
    if (!t) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = S.dragCopy ? 'copy' : 'move'; } catch (x) { /* ignore */ }
    $$('.rk-before, .rk-after, .rk-end').forEach((x) => x.classList.remove('rk-before', 'rk-after', 'rk-end'));
    if (t.matches(ITEM_SEL)) { if (t.dataset.did !== S.drag) t.classList.add(rackSide(t, e) ? 'rk-after' : 'rk-before'); return; }
    if (t.classList.contains('pside')) { t.classList.add('rk-end'); return; }
    if (!t.classList.contains('drop-hover')) { $$('.drop-hover').forEach((x) => x.classList.remove('drop-hover')); t.classList.add('drop-hover'); }
  }
  function onDragLeave(e) {
    const t = dropTarget(e.target);
    if (t && !(e.relatedTarget && t.contains(e.relatedTarget))) t.classList.remove('drop-hover');
  }
  function onDragEnd() {
    S.drag = null;
    S.dragRack = null;
    S.dragCopy = false;
    document.body.classList.remove('drag-copy');
    $$('.pghost').forEach((g) => { g.hidden = true; });
    clearRackMarks();
    $$('.dragging, .drop-hover').forEach((x) => x.classList.remove('dragging', 'drop-hover'));
  }
  // Ctrl + drag: a copy of the amp (same preset, model and zone, next free IP), or of a whole rack with its amps.
  // Ctrl + drop on another amp copies just the preset onto it.
  function copyAmp(v, src) {
    const pre = C.presetOf(v, src);
    const i = C.netInfo(v);
    const host = firstFreeHost(v, C.analyze(v), src.zone, src.model);
    const z = v.zones.find((x) => x.id === src.zone);
    const base = (z ? z.name + ' ' : '') + (pre || C.modelOf(src.model).label);
    const d = C.newDevice({ name: base + ' ' + C.nextIndex(v, base), model: src.model, zone: src.zone, preset: pre, location: src.location, net: src.net });
    if (host && i.blockStr) d.ip = i.blockStr + '.' + host;
    v.devices.push(d);
    return d;
  }
  function copyRack(v, r) {
    const nr = C.addRack(v, { name: C.nextRackName(v), side: r.side, size: r.size, type: r.type });
    C.rackSlots(v, r).forEach((d, k) => { if (d) { const c = copyAmp(v, d); C.placeDevice(v, c.id, nr.id, k); } });
    return nr;
  }
  function onDrop(e) {
    const canvas = gridTarget(e);
    if (canvas) { e.preventDefault(); gridDrop(e, canvas); return; }
    const copy = !!(S.dragCopy || wantsCopy(e));
    if (S.dragRack) {
      const t = rackDropTarget(e.target);
      const id = S.dragRack;
      const after = t && !t.classList.contains('pside') ? rackSide(t, e) : false;
      onDragEnd();
      if (!t) return;
      e.preventDefault();
      const v = cur();
      if (!v || S.readOnly) return;
      const sideEl = t.closest('.pside');
      const side = sideEl ? sideEl.dataset.side : '';
      const tgt = t.classList.contains('pside') ? '' : itemKey(t);
      if (copy) {
        const src = C.rackById(v, id);
        if (!src) return;
        const n = v.devices.filter((d) => d.rack === id && C.isAmpModel(d.model)).length;
        if (v.devices.length + n > C.MAX_DEVICES) { toast('A venue holds up to ' + C.MAX_DEVICES + ' devices.'); return; }
        pushUndo(v, 'rack-copy');
        const nr = copyRack(v, src);
        C.moveItem(v, 'r:' + nr.id, side || src.side, tgt, after);
        touch(v);
        render();
        toast('Copied ' + src.name + ' as ' + nr.name + (n ? ' with ' + C.plural(n, 'amp') : '') + '.', undoAction());
        return;
      }
      const snap = JSON.stringify({ r: v.racks, o: v.planOrder });
      pushUndo(v, 'rack-move');
      if (!C.moveItem(v, 'r:' + id, side, tgt, after)) { const o = JSON.parse(snap); v.racks = o.r; v.planOrder = o.o; S.undo.pop(); return; }
      touch(v);
      render();
      return;
    }
    if (!S.drag) return;
    const t = dropTarget(e.target);
    if (!t) return;
    e.preventDefault();
    const id = S.drag;
    onDragEnd();
    const v = cur();
    if (!v || S.readOnly) return;
    const d = v.devices.find((x) => x.id === id);
    if (!d) return;
    if (copy) {
      const hit = e.target.closest && e.target.closest('.pslot[data-dev]');
      const target = hit ? v.devices.find((x) => x.id === hit.dataset.dev) : null;
      const pre = C.presetOf(v, d);
      if (target) {
        // onto another amp: copy the preset only
        if (target.id === d.id) return;
        if (target.drives) { toast((target.name || 'That amp') + ' takes its preset from Speakers & amps. Open it and pick “Use another preset on this amp” first.'); return; }
        if (!pre) { toast('That amp has no preset to copy.'); return; }
        pushUndo(v, 'preset-copy');
        target.preset = pre;
        touch(v);
        render();
        toast('Copied preset ' + pre + ' to ' + C.slotLabel(v, target, C.netInfo(v)) + '.', undoAction());
        return;
      }
      if (v.devices.length >= C.MAX_DEVICES) { toast('A venue holds up to ' + C.MAX_DEVICES + ' devices.'); return; }
      pushUndo(v, 'amp-copy');
      const c = copyAmp(v, d);
      if (t.classList.contains('pslot')) C.placeDevice(v, c.id, t.dataset.rack || '', t.dataset.slot != null ? +t.dataset.slot : -1);
      else {
        const sideEl = t.closest('.pside');
        C.moveItem(v, 'd:' + c.id, sideEl ? sideEl.dataset.side : C.singleSide(v, d), t.classList.contains('pside') ? '' : itemKey(t), t.classList.contains('pside') ? false : rackSide(t, e));
      }
      touch(v);
      render();
      toast('Copied ' + (pre || C.modelOf(d.model).label) + ' as ' + C.slotLabel(v, c, C.netInfo(v)) + '.', undoAction());
      return;
    }
    if (t.classList.contains('pslot')) {
      const rid = t.dataset.rack || '';
      const k = t.dataset.slot != null ? +t.dataset.slot : -1;
      if ((C.rackById(v, d.rack) ? d.rack : '') === rid && d.slot === k) return;
      pushUndo(v, 'move');
      C.placeDevice(v, id, rid, k);
    } else {
      // out of its rack (if it was in one) and into the plan as a single amp, where it was dropped
      const sideEl = t.closest('.pside');
      const side = sideEl ? sideEl.dataset.side : C.singleSide(v, d);
      const tgt = t.classList.contains('pside') ? '' : itemKey(t);
      if (tgt === 'd:' + id) return;
      pushUndo(v, 'move');
      if (C.rackById(v, d.rack)) C.placeDevice(v, id, '', -1);
      C.moveItem(v, 'd:' + id, side, tgt, t.classList.contains('pside') ? false : rackSide(t, e));
    }
    touch(v);
    render();
  }

  // ---------------------------------------------------------------- IP map tab
  function mapHtml(v, a) {
    const i = a.info;
    if (!i.ok) return '<div class="card map-card"><p>Fix the primary network in the Network card to see the address map.</p></div>';
    const sec = S.mapNet === 'sec' && !!v.net.redundancy && i.secBlock != null;
    const base = sec ? i.secBlock : i.block;
    const zones = new Map(v.zones.map((z) => [z.id, z]));
    const byId = new Map(v.devices.map((d) => [d.id, d]));
    const fdOn = !sec && i.blockStr === '192.168.1';
    const tips = [];
    const cells = [];
    let used = 0;
    let free = 0;
    let conflicts = 0;
    const zoneCount = new Map();
    const describe = (o) => {
      if (o.type === 'pc') return 'Control computer (LA Network Manager)';
      if (o.type === 'gw') return 'Gateway';
      const d = byId.get(o.id);
      if (!d) return 'Device';
      const z = zones.get(d.zone);
      return (d.name || C.modelOf(d.model).label) + ' · ' + C.modelOf(d.model).label + (z ? ' · ' + z.name : '') + (o.role === 'sec' ? ' · secondary' : '');
    };
    for (let h = 0; h < 256; h++) {
      const addr = base + h;
      const occ = a.occ.get(addr) || [];
      const inDhcp = !sec && a.dhcp && addr >= a.dhcp.from && addr <= a.dhcp.to;
      let cls = 'ipc';
      let lines;
      if (occ.length) {
        used++;
        lines = occ.map(describe);
        const first = occ[0];
        if (first.type === 'pc') cls += ' pc';
        else if (first.type === 'gw') cls += ' gw';
        else {
          const d = byId.get(first.id);
          const z = d && zones.get(d.zone);
          cls += ' used z' + (z ? z.color : 8);
          if (z) zoneCount.set(z.id, (zoneCount.get(z.id) || 0) + 1);
        }
        if (occ.length > 1) { cls += ' conflict'; conflicts++; lines.push('Conflict: ' + occ.length + ' devices share this address'); }
        else if (first.type === 'dev') {
          const w = C.worst(a.byDev.get(first.id) || []);
          if (w === 'error' || w === 'warn') { cls += ' mark'; lines.push('Has a ' + (w === 'error' ? 'problem' : 'warning') + ', see Checks'); }
        }
        if (inDhcp) lines.push('Inside the DHCP pool');
      } else if (h === 0 || h === 255) {
        cls += ' cx';
        lines = [i.prefix === 24 ? (h === 0 ? 'Network address' : 'Broadcast address') : 'Kept out of the unit range'];
      } else if (inDhcp) {
        cls += ' res';
        lines = ['DHCP pool (' + ip(a.dhcp.from) + ' to ' + ip(a.dhcp.to) + ')'];
      } else if (fdOn && (addr === C.FD_UNIT || addr === C.FD_LS10)) {
        cls += ' fd';
        free++;
        lines = ['Free. Factory address of new ' + (addr === C.FD_LS10 ? 'LS10 switches' : 'L-Acoustics units') + ', best kept free'];
      } else {
        cls += ' free';
        free++;
        lines = [h === 254 ? 'Free. L-Acoustics suggests .254 for the control computer' : 'Free'];
      }
      tips[h] = { title: ip(addr), lines };
      cells.push('<button class="' + cls + '" data-act="cell" data-h="' + h + '" aria-label="' + esc(ip(addr) + ': ' + lines.join('; ')) + '">' + h + '</button>');
    }
    S.mapTips = tips;
    let outside = 0;
    for (const d of v.devices) {
      const dn = a.nets.get(d.id);
      if (!dn) continue;
      const x = sec ? dn.sec : dn.pri;
      if (x != null && C.blockOf(x) !== base) outside++;
    }
    const legendZones = v.zones.filter((z) => zoneCount.get(z.id)).map((z) => '<span><i style="background:var(--z' + z.color + ')"></i>' + esc(z.name) + ' <span class="muted">' + zoneCount.get(z.id) + '</span></span>').join('');
    const seg = v.net.redundancy && i.secBlock != null
      ? '<div class="seg" role="group" aria-label="Which network"><button data-act="map-net" data-net="pri" aria-pressed="' + !sec + '">Primary</button><button data-act="map-net" data-net="sec" aria-pressed="' + sec + '">Secondary</button></div>'
      : '';
    return '<div class="card map-card"><div class="map-head"><div class="map-title"><strong>' + esc((sec ? i.secBlockStr : i.blockStr) + '.x') + '</strong><span class="map-stats">' + (sec ? 'Secondary network' : 'Primary network') + ' · ' + used + ' used · ' + free + ' free' +
      (conflicts ? ' · <b style="color:var(--bad-ink)">' + esc(C.plural(conflicts, 'conflict')) + '</b>' : '') + '</span></div>' + seg + '</div>' +
      '<div class="ipgrid">' + cells.join('') + '</div>' +
      '<div class="legend">' + legendZones +
      '<span><i class="lg-pc"></i>Control computer</span>' + (i.gateway != null && !sec ? '<span><i class="lg-gw"></i>Gateway</span>' : '') +
      (a.dhcp && !sec ? '<span><i class="lg-dhcp"></i>DHCP pool</span>' : '') + '<span><i class="lg-free"></i>Free</span>' +
      (fdOn ? '<span><i class="lg-fd"></i>Factory address, kept free</span>' : '') + '<span><i class="lg-conf"></i>Conflict</span><span><i class="lg-mark"></i>Has a warning</span></div>' +
      '<p class="map-note">' + (outside ? esc(C.plural(outside, 'device')) + ' sit outside this range and only show in the device list. ' : '') + (S.readOnly ? 'Hover a square to see who uses it.' : 'Hover a square to see who uses it. Click a free one to give it to a device.') + '</p></div>';
  }

  // ---------------------------------------------------------------- checks & rules tabs
  function checksHtml(v, a) {
    const byId = new Map(v.devices.map((d) => [d.id, d]));
    const groups = [['error', 'error', 'errors'], ['warn', 'warning', 'warnings'], ['info', 'note', 'notes']];
    const parts = [];
    for (const g of groups) {
      const list = a.issues.filter((x) => x.sev === g[0]);
      if (!list.length) continue;
      parts.push('<section class="check-group sev-' + g[0] + '"><h3>' + SEV_ICON[g[0]] + esc(C.plural(list.length, g[1], g[2])) + '</h3><ul class="check-list">' + list.map((it) => {
        const d = it.dev && byId.get(it.dev);
        const who = d
          ? esc(d.name || C.modelOf(d.model).label) + ' <span class="mono">' + esc(d.ip || 'no address') + '</span> <span class="tag">' + esc(C.modelOf(d.model).label) + '</span>'
          : it.tab === 'speakers' ? 'Speakers & amps' : 'Network settings';
        const btn = d ? '<button class="btn-mini" data-act="goto" data-dev="' + esc(d.id) + '">Show</button>'
          : it.tab ? '<button class="btn-mini" data-act="tab" data-tab="' + esc(it.tab) + '">Open</button>' : '<button class="btn-mini" data-act="goto-net">Show</button>';
        return '<li><div class="check-who">' + who + '</div><p class="check-msg">' + esc(it.msg) + '</p>' + btn + '</li>';
      }).join('') + '</ul></section>');
    }
    if (!parts.length) {
      return '<div class="all-clear"><span class="pill-ico">' + ICON.ok + '</span><div><b>No problems found.</b><br>' + esc(C.plural(v.devices.length, 'device')) + ' checked against L-Acoustics addressing rules.</div></div>';
    }
    return '<div class="checks">' + parts.join('') + '</div>';
  }

  function rulesHtml() {
    return '<div class="rules">' +
      '<section><h3>Addresses</h3><ul>' +
      '<li><b>Factory address</b> of amplified controllers, P1 and LC16D: <code>192.168.1.100</code>, mask <code>255.255.255.0</code>. LS10 switches ship on <code>192.168.1.200</code>.</li>' +
      '<li><b>Recommended plan:</b> keep 192.168.1.0/24, give every unit its own address from .1 to .253 and put the LA Network Manager computer on .254.</li>' +
      '<li><b>All units share the first three numbers</b> (for example 192.168.1.x) so LA Network Manager can control them.</li>' +
      '<li><b>Mask</b> from 255.0.0.0 to 255.255.255.0. Smaller subnets such as /25 aren’t supported.</li>' +
      '<li><b>Private ranges only:</b> 10.x, 100.64–127.x, 172.16–31.x and 192.168.x. 169.254.x is accepted but not recommended.</li>' +
      '<li><b>Gateway</b> is optional and works on the primary network only, for supervision systems such as Q-SYS, Crestron or SNMP on another subnet. It must sit inside the subnet or stay 0.0.0.0.</li>' +
      '<li><b>A factory reset keeps the IP address.</b></li>' +
      '<li><b>Up to 253 units</b> on one LA Network Manager network.</li></ul></section>' +
      '<section><h3>Milan redundancy</h3><ul>' +
      '<li>Each redundant unit gets two addresses with the same last number. The secondary subnet is the primary subnet + 1: 192.168.1.21 pairs with 192.168.2.21, and with a /16 mask 172.16.1.21 pairs with 172.17.1.21.</li>' +
      '<li>Port 1 is the primary network, port 2 the secondary. Redundant mode needs a star layout through AVB switches such as LS10, with no daisy-chaining.</li>' +
      '<li>Turn RSTP on before switching redundancy on or off, to avoid a broadcast storm. Changing the mode restarts the unit.</li>' +
      '<li>LA4X, LA4 and LA8 can’t run redundant. LA-RAK II AVB and LA-RAK III each carry two LS10 switches, one per network.</li></ul></section>' +
      '<section><h3>Cabling</h3><ul>' +
      '<li>Daisy-chain, star or a mix of both in normal mode. Never build a loop unless RSTP is on.</li>' +
      '<li>Up to 12 units per daisy-chain in one AVB domain, P1 included (LA12X owner’s manual).</li>' +
      '<li>LA4 and LA8 have 100 Mb/s ports: put them at the end of a chain, after LA2Xi, LA4X and LA12X. They only accept 192.168.1.1 to .253.</li>' +
      '<li>Run the same firmware on every unit, matched to your LA Network Manager version.</li></ul></section>' +
      '<section><h3>Control computer</h3><ul>' +
      '<li>Same subnet and mask as the units, with only one network card on that subnet.</li>' +
      '<li>Keep unit addresses consecutive and set the scan range in LA Network Manager (Options, IP range to scan) to match. Checks lists any address outside the plan.</li>' +
      '<li>Don’t reach the units over Wi-Fi for firmware updates.</li></ul></section>' +
      '<section><h3>Speakers per amp</h3><ul>' +
      '<li>Amps needed = speakers ÷ the most enclosures one amplified controller may drive, from L-Acoustics’ Amplification Reference and Preset Guide. For example 3 K2 per LA12X, 4 per LA7.16 and 1 per LA4X; 4 KS28 per LA12X; 1 L2 per LA7.16.</li>' +
      '<li>LA7.16 figures assume nominal use. On 100 V mains, drive fewer so the power gauge stays at or below 75%.</li>' +
      '<li>Each speaker type gets its own amps here. An LA7.16 can mix speaker types on one unit, so a mixed plan may need fewer.</li>' +
      '<li>Racks hold 3 amps: LA-RAK II AVB (LA12X), LA-RAK III (LA7.16), LA-RAK (LA8). Set your own rack size for other amps.</li></ul></section>' +
      '<section><h3>Setting the address on a unit</h3><ol>' +
      '<li>Front panel: open <b>IP SETTINGS</b>. The main screen only shows the last number (1 to 254).</li>' +
      '<li>Select the byte to change and turn the encoder. Press while turning for steps of 10, then confirm with OK.</li>' +
      '<li>Or use L-Acoustics Device Scanner, or the USB terminal in LA Network Manager, to set address, mask and gateway.</li>' +
      '<li>Plug units in one at a time when they all still sit on the factory address.</li></ol></section>' +
      '<p class="src">Sources: L-Acoustics owner’s manuals for LA4X, LA12X, LA7.16 and LC16D (IP settings and network chapters), LA Network Manager release notes and L-Acoustics product pages. Check the manual for your firmware in the <a href="https://www.l-acoustics.com/documentation-center/" target="_blank" rel="noopener">L-Acoustics documentation center</a>. This planner is an independent tool, not made or endorsed by L-Acoustics.</p>' +
      '</div>';
  }

  // ---------------------------------------------------------------- events
  function bind() {
    document.addEventListener('click', onClick);
    document.addEventListener('input', onInput);
    document.addEventListener('change', onChange);
    document.addEventListener('keydown', onKey);
    document.addEventListener('focusout', () => {
      if (!S.pendingRemote) return;
      setTimeout(() => { if (S.pendingRemote && !isEditing()) { S.pendingRemote = false; render(); } }, 0);
    });
    document.addEventListener('mouseover', onTipOver);
    document.addEventListener('mouseout', onTipOut);
    document.addEventListener('mousemove', onTipMove);
    document.addEventListener('dragstart', onDragStart);
    // remember which folded sections are open, so a redraw keeps them open
    document.addEventListener('toggle', (e) => { const d = e.target; if (d && d.dataset && d.dataset.sec) S.open[d.dataset.sec] = d.open; }, true);
    let rsz = null;
    window.addEventListener('resize', () => { clearTimeout(rsz); rsz = setTimeout(syncGridWidth, 150); });
    // Ctrl + wheel over the plan grid zooms it instead of the page
    document.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey) || !e.target.closest || !e.target.closest('.pgridwrap')) return;
      e.preventDefault();
      setZoom(zoomOf() * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    }, { passive: false });
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('dragleave', onDragLeave);
    document.addEventListener('drop', onDrop);
    document.addEventListener('dragend', onDragEnd);
    window.addEventListener('hashchange', () => {
      const h = decodeURIComponent(location.hash.slice(1));
      if (h && h !== S.cur && S.venues.some((v) => v.id === h)) openVenue(h, true);
      else if (!h && S.cur) goHome();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') Array.from(S.dirty).forEach((id) => flush(id));
    });
    $('#import-file').addEventListener('change', onImportFile);
    $('#venue-q').addEventListener('input', (e) => { S.vq = e.target.value; renderRail(); });
  }

  const ACT = {
    'open-venue': (t) => openVenue(t.dataset.id),
    'new-venue': () => openNewVenue(),
    'load-example': () => createVenue(C.makeExample()),
    'import': () => { if (S.readOnly) return toast('You can view these plans but not change them.'); $('#import-file').click(); },
    'export': () => openExport(),
    'dup-venue': () => duplicateVenue(),
    'del-venue': () => confirmDeleteVenue(),
    'tab': (t) => setTab(t.dataset.tab),
    'add-devices': () => openAddDevices(),
    'add-speakers': () => openAddSpeakers(),
    'plan-zoom': (t) => {
      const k = t.dataset.z;
      if (k === 'fit') return fitZoom();
      if (k === '1x') return setZoom(1);
      const steps = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5];
      const z = zoomOf();
      setZoom(k === '+1' ? steps.find((x) => x > z + 0.001) || ZOOM_MAX : steps.slice().reverse().find((x) => x < z - 0.001) || ZOOM_MIN);
    },
    'plan-layout': (t) => { prefs.planLayout = t.dataset.layout; savePrefs(); renderTab(); },
    'net-toggle': () => { prefs.netOpen = !prefs.netOpen; savePrefs(); render(); },
    'dev-view': (t) => { S.devView = t.dataset.view === 'list' ? 'list' : 'racks'; prefs.devView = S.devView; savePrefs(); renderTab(); },
    'amp-edit': (t) => openAmpEditor({ dev: t.dataset.dev }),
    'amp-new': (t) => {
      if (t.dataset.rack) return openAmpEditor({ rack: t.dataset.rack, slot: +t.dataset.slot });
      if (t.dataset.loose) return openAmpEditor({ rack: '', slot: -1, side: t.dataset.side || '', host: t.dataset.host ? +t.dataset.host : 0 });
      if (t.dataset.nozone) return openAmpEditor({ rack: '', slot: -1, noZone: true });
      const v = cur();
      if (!v) return;
      const side = t.dataset.side || '';
      // first free slot, on that side when one is given; otherwise the amp starts outside the racks
      for (const r of (v.racks || []).filter((x) => !side || x.side === side)) {
        const k = C.rackSlots(v, r).indexOf(null);
        if (k >= 0) return openAmpEditor({ rack: r.id, slot: k, side });
      }
      openAmpEditor({ rack: '', slot: -1, side });
    },
    'rack-add': (t) => openNewRack(t.dataset.side || ''),
    'rack-edit': (t) => openRackEditor(t.dataset.rack),
    'amp-del': (t) => deleteDevices([t.dataset.dev]),
    'rack-del': (t) => {
      const v = cur();
      const r = v && C.rackById(v, t.dataset.rack);
      if (!r) return;
      const n = v.devices.filter((d) => d.rack === r.id).length;
      if (!n) return deleteRack(v, r, false);
      openModal({
        title: 'Delete ' + r.name + '?',
        body: '<p>' + esc(r.name) + ' holds ' + esc(C.plural(n, 'device')) + '.</p>',
        actions: [{ label: 'Cancel' }, { label: 'Delete rack and amps', kind: 'quiet danger', onClick: () => deleteRack(v, r, true) }, { label: 'Delete rack, keep amps', kind: 'primary', onClick: () => deleteRack(v, r, false) }],
      });
    },
    'rack-del-empty': () => {
      const v = cur();
      if (!v || S.readOnly) return;
      const list = emptyRacks(v);
      if (!list.length) return;
      pushUndo(v, 'rack');
      list.forEach((r) => C.removeRack(v, r.id));
      touch(v);
      render();
      toast('Deleted ' + C.plural(list.length, 'empty rack') + '.', undoAction());
    },
    'rack-pack': () => {
      const v = cur();
      if (!v || S.readOnly) return;
      pushUndo(v, 'pack');
      const res = C.packRacks(v);
      touch(v);
      render();
      toast('Placed ' + C.plural(res.placed, 'amp') + (res.created.length ? ' and added ' + C.plural(res.created.length, 'rack') : '') + '.', undoAction());
    },
    'spk-step': (t) => { const tr = t.closest('tr[data-spk]'); const inp = tr && tr.querySelector('[data-sf="qty"]'); if (!inp) return; inp.value = Math.max(1, (+inp.value || 0) + (+t.dataset.step)); speakerField(inp); },
    'spk-del': (t) => deleteSpeakerGroup(t),
    'spk-fix': (t) => { const v = cur(); const tr = t.closest('tr[data-spk]'); const g = v && tr && v.speakers.find((x) => x.id === tr.dataset.spk); if (!g || S.readOnly) return; pushUndo(v, 'speaker'); applySync(v, g, 'Fixed ' + C.speakerLabel(g)); },
    'add-to-zone': (t) => openAddDevices(t.dataset.zone),
    'add-rack': () => openAddRack(),
    'auto-assign': () => openAutoAssign(),
    'zones': () => openZones(),
    'columns': () => openColumns(),
    'status': (t) => cycleStatus(t),
    'issues': (t) => showDeviceIssues(t),
    'dup-dev': (t) => duplicateDevice(t),
    'del-dev': (t) => deleteDevices([rowId(t)]),
    'bulk-clear': () => bulkClearIps(),
    'bulk-del': () => deleteDevices(Array.from(S.sel)),
    'bulk-none': () => { S.sel.clear(); $$('#dev-table tr.is-sel').forEach((tr) => { tr.classList.remove('is-sel'); const cb = tr.querySelector('[data-act="sel"]'); if (cb) cb.checked = false; }); updateBulk(); },
    'map-net': (t) => { S.mapNet = t.dataset.net === 'sec' ? 'sec' : 'pri'; renderTab(); },
    'cell': (t) => openCell(t),
    'goto': (t) => gotoDevice(t.dataset.dev),
    'goto-net': () => { const n = $('#net-card'); if (n) { n.scrollIntoView({ block: 'start' }); const f = n.querySelector('input, select'); if (f) f.focus({ preventScroll: true }); } },
    'copy-scan': () => { const v = cur(); const s = v && analysis(v).stats; if (s && s.scanFrom != null) copyText(ip(s.scanFrom) + ' - ' + ip(s.scanTo), 'Scan range copied.'); },
    'rail-open': () => document.body.classList.add('rail-open'),
    'go-home': () => goHome(),
    'install-app': () => installApp(),
    'rail-close': () => document.body.classList.remove('rail-open'),
    'local-mode': () => startLocal('Working in this browser only, because your saved plans weren’t reachable. Export a backup before you close the page.'),
  };

  function onClick(e) {
    // the + Add menus close when an item is picked or anything else is clicked
    document.querySelectorAll('details.add-menu[open]').forEach((d) => { if (!d.contains(e.target) || (e.target.closest && e.target.closest('.add-pop button'))) d.open = false; });
    if (e.target.closest('#modal-root')) return;
    const t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    if (t.tagName === 'INPUT' && t.type === 'checkbox') return; // handled on change
    const fn = ACT[t.dataset.act];
    if (fn) fn(t, e);
  }
  function onInput(e) {
    const el = e.target;
    if (el.closest('#modal-root')) return;
    if (el.dataset.f) { if (el.tagName !== 'SELECT') devField(el, false); return; }
    if (el.dataset.vf) { venueField(el, false); return; }
    if (el.dataset.ui === 'q') { S.q = el.value; applyFilter(); }
  }
  function onChange(e) {
    const el = e.target;
    if (el.closest('#modal-root') || el.id === 'import-file') return;
    if (el.dataset.f) { devField(el, true); return; }
    if (el.dataset.nf) { netField(el); return; }
    if (el.dataset.sf) { speakerField(el); return; }
    if (el.dataset.racksize !== undefined) { rackSizeField(el); return; }
    if (el.dataset.vf) { venueField(el, true); return; }
    if (el.dataset.ui === 'zone') { S.zone = el.value; renderTab(); return; }
    if (el.dataset.act === 'sel') { toggleSel(el); return; }
    if (el.dataset.act === 'sel-all') { toggleSelAll(el); return; }
    if (el.dataset.bulk) bulkApply(el);
  }
  function onKey(e) {
    if (e.key === 'Escape') {
      if (S.modal) { closeModal(); return; }
      document.body.classList.remove('rail-open');
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z') && !isTyping(e.target) && !S.modal) {
      e.preventDefault();
      undoLast();
      return;
    }
    const el = e.target;
    if ((e.key === 'Enter' || e.key === ' ') && el.matches && el.matches('[role="button"][data-act]')) { e.preventDefault(); el.click(); return; }
    if (e.key !== 'Enter' || !el.matches) return;
    if (el.matches('#dev-table input.cell[data-f]')) {
      e.preventDefault();
      devField(el, true);
      const tr = el.closest('tr');
      const rows = $$('#dev-table tr.dev').filter((r) => !r.hidden);
      const next = rows[rows.indexOf(tr) + (e.shiftKey ? -1 : 1)];
      const target = next && next.querySelector('[data-f="' + el.dataset.f + '"]');
      if (target) { target.focus(); if (target.select) target.select(); } else el.blur();
    } else if (el.matches('#work-inner input[data-vf], #work-inner input[data-nf]')) {
      e.preventDefault();
      el.blur();
    }
  }

  // ---------------------------------------------------------------- field edits
  function expandHost(blockStr, s) {
    const m = /^\.?(\d{1,3})$/.exec(String(s || '').trim());
    if (!m || +m[1] > 255 || !blockStr) return String(s || '').trim();
    return blockStr + '.' + (+m[1]);
  }
  function devField(el, committed) {
    const v = cur();
    if (!v || S.readOnly) return;
    const tr = el.closest('tr[data-dev]');
    if (!tr) return;
    const d = v.devices.find((x) => x.id === tr.dataset.dev);
    if (!d) return;
    const f = el.dataset.f;
    if (f === 'model') {
      d.model = C.MODEL_MAP[el.value] ? el.value : 'Other';
      const info = C.netInfo(v);
      const dn = C.devNets(v, d, info);
      if (dn.dual && dn.ip != null && info.secBlock != null && C.blockOf(dn.ip) === info.secBlock) d.ip = ip(info.block + C.host(dn.ip));
      touch(v);
      render();
      return;
    }
    if (f === 'net') {
      const info = C.netInfo(v);
      const prev = C.parseIp(d.ip);
      d.net = el.value === 'sec' ? 'sec' : 'pri';
      if (prev != null && info.secBlock != null) {
        if (d.net === 'sec' && C.blockOf(prev) === info.block) d.ip = ip(info.secBlock + C.host(prev));
        if (d.net === 'pri' && C.blockOf(prev) === info.secBlock) d.ip = ip(info.block + C.host(prev));
      }
      touch(v);
      render();
      return;
    }
    if (f === 'ip') {
      if (committed) {
        const info = C.netInfo(v);
        const dn = C.devNets(v, d, info);
        const x = expandHost(dn.onSec ? info.secBlockStr : info.blockStr, el.value);
        if (x !== el.value) el.value = x;
      }
      const nv = el.value.trim();
      if (nv === d.ip) return;
      d.ip = nv;
      touch(v);
      refresh();
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(d, f) || d[f] === el.value) return;
    d[f] = el.value;
    touch(v);
    if (f === 'name' && committed) refresh();
  }
  function venueField(el, committed) {
    const v = cur();
    if (!v || S.readOnly) return;
    const k = el.dataset.vf;
    let val = el.value;
    if (k === 'name' && committed && !val.trim()) { val = 'Untitled venue'; el.value = val; }
    if (k === 'date' && val && !/^\d{4}-\d{2}-\d{2}$/.test(val)) return;
    if (v[k] === val) return;
    v[k] = val;
    touch(v);
    renderRail();
  }
  function netField(el) {
    const v = cur();
    if (!v || S.readOnly) return;
    const k = el.dataset.nf;
    const n = v.net;
    const before = C.netInfo(v);
    if (k === 'redundancy') { setRedundancy(v, el.checked, before); return; }
    if (k === 'prefix') {
      const p = C.clampInt(el.value, 8, 24, 24);
      if (p === 24) { if (before.ok) n.network = ip(before.block); }
      else {
        const base = C.parseIp(n.network);
        if (base != null) n.network = ip(C.netOf(base, p));
        if (before.ok) n.block = before.blockStr;
      }
      n.prefix = p;
    } else if (k === 'network') {
      const raw = el.value.trim();
      const base = C.parseIp(raw);
      n.network = base != null ? ip(C.netOf(base, n.prefix)) : raw;
    } else if (k === 'block') {
      n.block = el.value.trim().replace(/\.+$/, '');
    } else if (k === 'computer' || k === 'gateway' || k === 'dhcpFrom' || k === 'dhcpTo') {
      n[k] = expandHost(before.ok ? before.blockStr : '', el.value);
    } else return;
    const after = C.netInfo(v);
    touch(v);
    render();
    if (before.ok && after.ok && before.block !== after.block) offerRebase(v, before, after);
  }
  function setRedundancy(v, on, before) {
    pushUndo(v, 'redundancy');
    v.net.redundancy = on;
    const after = C.netInfo(v);
    let moved = 0;
    const strand = [];
    for (const d of v.devices) {
      if (C.modelOf(d.model).red || d.net !== 'sec') continue;
      const x = C.parseIp(d.ip);
      if (x == null) continue;
      if (on && after.secBlock != null && C.blockOf(x) === after.block) { d.ip = ip(after.secBlock + C.host(x)); moved++; }
      if (!on && before.secBlock != null && C.blockOf(x) === before.secBlock) { d.ip = ''; strand.push(d.id); }
    }
    if (strand.length) {
      const a = v.net.assign;
      const plan = C.planAutoAssign(v, { scheme: a.scheme, start: a.start, size: a.size, avoidDefaults: a.avoidDefaults, scope: 'empty', onlyIds: strand });
      C.applyChanges(v, plan.changes);
    }
    touch(v);
    render();
    if (moved) toast('Moved ' + C.plural(moved, 'secondary-side device') + ' to ' + after.secBlockStr + '.x.', undoAction());
    else if (strand.length) toast('Gave ' + C.plural(strand.length, 'secondary-side device') + ' new primary addresses.', undoAction());
  }
  function offerRebase(v, before, after) {
    const inOld = (x) => x != null && (C.blockOf(x) === before.block || (before.secBlock != null && C.blockOf(x) === before.secBlock));
    const count = v.devices.filter((d) => inOld(C.parseIp(d.ip))).length;
    const extras = ['computer', 'gateway', 'dhcpFrom', 'dhcpTo'].filter((k) => inOld(C.parseIp(v.net[k]))).length;
    if (!count && !extras) return;
    if (!count) {
      C.rebase(v, before, after);
      touch(v);
      render();
      toast('Moved the control computer and other network settings to ' + after.blockStr + '.x.');
      return;
    }
    openModal({
      title: 'Move the addresses too?',
      body: '<p>' + esc(C.plural(count, 'device')) + ' still ' + (count === 1 ? 'uses' : 'use') + ' <b class="mono">' + esc(before.blockStr) + '.x</b>. Move ' + (count === 1 ? 'it' : 'them') + ' to <b class="mono">' + esc(after.blockStr) + '.x</b> and keep each last number? ' +
        esc(before.blockStr) + '.21 would become ' + esc(after.blockStr) + '.21. The control computer, gateway and DHCP pool move the same way.</p>',
      actions: [
        { label: 'Keep addresses' },
        { label: 'Move addresses', kind: 'primary', onClick: () => { pushUndo(v, 'move'); const moved = C.rebase(v, before, after); touch(v); render(); toast('Moved ' + C.plural(moved, 'address', 'addresses') + '.', undoAction()); } },
      ],
    });
  }

  // ---------------------------------------------------------------- venue actions
  function openVenue(id, fromHash) {
    if (!S.venues.some((v) => v.id === id)) return;
    S.cur = id;
    prefs.last = id;
    savePrefs();
    S.sel.clear();
    S.zone = 'all';
    S.q = '';
    if (!fromHash && decodeURIComponent(location.hash.slice(1)) !== id) { try { location.hash = id; } catch (e) { /* frame may refuse */ } }
    document.body.classList.remove('rail-open');
    render();
    const w = $('#work');
    if (w) w.scrollTop = 0;
  }
  function createVenue(v) {
    if (S.readOnly) { toast('You can view these plans but not change them.'); return; }
    S.venues.push(v);
    touch(v, true);
    openVenue(v.id);
  }
  function openNewVenue() {
    if (S.readOnly) return;
    const others = S.venues.slice().sort((a, b) => a.name.localeCompare(b.name));
    openModal({
      title: 'New venue',
      body: '<div class="form-grid">' +
        '<div class="field span2"><label for="nv-name">Show or venue name</label><input id="nv-name" maxlength="120" placeholder="e.g. Summer festival, main stage" autocomplete="off" autofocus></div>' +
        '<div class="field"><label for="nv-date">Show date <em>optional</em></label><input id="nv-date" type="date"></div>' +
        '<div class="field"><label for="nv-city">Venue <em>optional</em></label><input id="nv-city" maxlength="120" placeholder="Hall, city" autocomplete="off"></div></div>' +
        '<fieldset><legend>Start from</legend>' +
        '<label class="radio"><input type="radio" name="nv-from" value="blank" checked><span><b>Empty plan</b>192.168.1.0/24, computer on .254, zones Main L, Main R, Subs, Front fill, Out fill, Delays, Monitors and Control.</span></label>' +
        (others.length
          ? '<label class="radio"><input type="radio" name="nv-from" value="copy"><span><b>Copy of another venue</b>Same network, zones, devices and addresses. Statuses go back to Planned.</span></label>' +
            '<div class="field"><label class="sr-only" for="nv-src">Venue to copy</label><select id="nv-src">' + others.map((o) => '<option value="' + esc(o.id) + '"' + (o.id === S.cur ? ' selected' : '') + '>' + esc(o.name) + '</option>').join('') + '</select></div>'
          : '') +
        '</fieldset>',
      actions: [
        { label: 'Cancel' },
        { label: 'Create venue', kind: 'primary', onClick: (m) => {
          const name = $('#nv-name', m).value.trim() || 'New venue';
          const from = ($('input[name="nv-from"]:checked', m) || {}).value;
          let v;
          if (from === 'copy') {
            const src = S.venues.find((x) => x.id === $('#nv-src', m).value);
            v = src ? C.cloneVenue(src, name) : C.makeVenue({ name });
          } else v = C.makeVenue({ name });
          v.name = name;
          v.date = /^\d{4}-\d{2}-\d{2}$/.test($('#nv-date', m).value) ? $('#nv-date', m).value : '';
          v.city = $('#nv-city', m).value.trim();
          createVenue(v);
        } },
      ],
      onOpen: (m) => {
        const src = $('#nv-src', m);
        if (src) src.addEventListener('change', () => { const r = $('input[value="copy"]', m); if (r) r.checked = true; });
      },
    });
  }
  function duplicateVenue() {
    const v = cur();
    if (!v || S.readOnly) return;
    createVenue(C.cloneVenue(v));
    toast('Duplicated. Statuses are back to Planned.');
  }
  function confirmDeleteVenue() {
    const v = cur();
    if (!v || S.readOnly) return;
    openModal({
      title: 'Delete this venue?',
      body: '<p><b>' + esc(v.name) + '</b> and its ' + esc(C.plural(v.devices.length, 'device')) + ' will be removed' + (S.mode === 'db' ? ' for everyone who can open this planner' : '') + '. You can undo right after.</p>',
      actions: [{ label: 'Cancel' }, { label: 'Delete venue', kind: 'danger', onClick: () => { deleteVenue(v); } }],
    });
  }
  async function deleteVenue(v) {
    const body = JSON.stringify(C.serialize(v));
    const s = S.saving[v.id];
    if (s) { clearTimeout(s.timer); s.timer = null; }
    S.dirty.delete(v.id);
    S.deleted.add(v.id);
    S.venues = S.venues.filter((x) => x.id !== v.id);
    S.undo.push({ id: v.id, deletedBody: body });
    S.cur = '';
    pickVenue();
    if (S.cur) { try { location.hash = S.cur; } catch (e) { /* ignore */ } }
    render();
    toast('Deleted “' + v.name + '”.', undoAction());
    try {
      await waitIdle(v.id);
      if (S.mode === 'db') await S.db.collection('venues').doc(v.id).delete();
      else if (S.mode === 'local') saveLocalAll();
    } catch (e) {
      toast('Couldn’t remove it from your saved plans. It may come back after a reload.');
    } finally {
      setTimeout(() => S.deleted.delete(v.id), 20000);
    }
  }

  function pushUndo(v, label) {
    S.undo.push({ id: v.id, body: JSON.stringify(C.serialize(v)), label });
    if (S.undo.length > 30) S.undo.shift();
  }
  const undoAction = () => ({ label: 'Undo', onClick: undoLast });
  function undoLast() {
    if (S.readOnly) return;
    const u = S.undo.pop();
    if (!u) return;
    if (u.deletedBody) {
      const v = C.sanitizeVenue(u.id, JSON.parse(u.deletedBody));
      S.deleted.delete(u.id);
      S.venues.push(v);
      touch(v, true);
      openVenue(v.id);
      toast('Venue restored.');
      return;
    }
    const v = S.venues.find((x) => x.id === u.id);
    if (!v) return;
    Object.assign(v, C.sanitizeVenue(u.id, JSON.parse(u.body)));
    S.sel.clear();
    touch(v);
    if (S.cur !== v.id) openVenue(v.id); else render();
    toast('Undone.');
  }

  // ---------------------------------------------------------------- device actions
  function setTab(t) {
    if (['speakers', 'devices', 'map', 'checks', 'rules'].indexOf(t) < 0) return;
    // the IP map and the rules now live inside Checks
    if (t === 'map' || t === 'rules') { S.open[t] = true; t = 'checks'; }
    S.tab = t;
    renderTab();
    const tb = $('#tab-' + t);
    if (tb && document.activeElement && document.activeElement.closest && document.activeElement.closest('.summary')) tb.focus();
  }
  function cycleStatus(t) {
    const v = cur();
    if (!v || S.readOnly) return;
    const id = rowId(t);
    const d = v.devices.find((x) => x.id === id);
    if (!d) return;
    d.status = NEXT[d.status] || 'set';
    touch(v);
    const td = t.parentElement;
    td.innerHTML = chipHtml(d.status);
    const b = td.querySelector('button');
    if (b) b.focus();
  }
  function showDeviceIssues(t) {
    const v = cur();
    if (!v) return;
    const d = v.devices.find((x) => x.id === rowId(t));
    if (!d) return;
    const iss = analysis(v).byDev.get(d.id) || [];
    openModal({
      title: d.name || C.modelOf(d.model).label,
      body: '<ul class="issue-list">' + iss.map((i) => '<li><span class="flag sev-' + i.sev + '">' + SEV_ICON[i.sev] + '</span><span>' + esc(i.msg) + '</span></li>').join('') + '</ul>',
      actions: [{ label: 'Close', kind: 'primary' }],
    });
  }
  function nextName(v, name) {
    const used = new Set(v.devices.map((d) => d.name));
    const m = /^(.*?)(\d+)$/.exec(name || '');
    if (m) { let k = +m[2] + 1; while (used.has(m[1] + k)) k++; return m[1] + k; }
    let k = 2;
    while (used.has((name || 'Device') + ' ' + k)) k++;
    return (name || 'Device') + ' ' + k;
  }
  function duplicateDevice(t) {
    const v = cur();
    if (!v || S.readOnly) return;
    const i = v.devices.findIndex((d) => d.id === rowId(t));
    if (i < 0) return;
    if (v.devices.length >= C.MAX_DEVICES) { toast('A venue holds up to ' + C.MAX_DEVICES + ' devices.'); return; }
    const src = v.devices[i];
    const copy = C.newDevice(Object.assign({}, src, { id: '', ip: '', status: 'planned', name: nextName(v, src.name), drives: '', rack: '', slot: -1 }));
    v.devices.splice(i + 1, 0, copy);
    touch(v);
    render();
    focusField(copy.id, 'ip');
  }
  function focusField(id, f) {
    const el = $('#dev-table tr[data-dev="' + cssq(id) + '"] [data-f="' + f + '"]');
    if (el) { el.focus(); if (el.select) el.select(); }
  }
  function deleteDevices(ids) {
    const v = cur();
    if (!v || S.readOnly) return;
    const set = new Set(ids);
    const gone = v.devices.filter((d) => set.has(d.id));
    if (!gone.length) return;
    pushUndo(v, 'delete');
    v.devices = v.devices.filter((d) => !set.has(d.id));
    ids.forEach((id) => S.sel.delete(id));
    touch(v);
    render();
    toast(gone.length === 1 ? 'Deleted “' + (gone[0].name || gone[0].model) + '”.' : 'Deleted ' + C.plural(gone.length, 'device') + '.', undoAction());
  }
  function toggleSel(el) {
    const id = rowId(el);
    if (!id) return;
    if (el.checked) S.sel.add(id); else S.sel.delete(id);
    el.closest('tr').classList.toggle('is-sel', el.checked);
    updateBulk();
  }
  function toggleSelAll(el) {
    for (const tr of $$('#dev-table tr.dev')) {
      if (tr.hidden) continue;
      if (el.checked) S.sel.add(tr.dataset.dev); else S.sel.delete(tr.dataset.dev);
      tr.classList.toggle('is-sel', el.checked);
      const cb = tr.querySelector('[data-act="sel"]');
      if (cb) cb.checked = el.checked;
    }
    updateBulk();
    el.checked = S.sel.size > 0;
  }
  function bulkApply(el) {
    const v = cur();
    if (!v || S.readOnly || !el.value) return;
    const n = S.sel.size;
    pushUndo(v, 'bulk');
    for (const d of v.devices) {
      if (!S.sel.has(d.id)) continue;
      if (el.dataset.bulk === 'zone') d.zone = el.value === '__none' ? '' : el.value;
      if (el.dataset.bulk === 'status') d.status = el.value;
    }
    touch(v);
    render();
    toast((el.dataset.bulk === 'zone' ? 'Moved ' : 'Updated ') + C.plural(n, 'device') + '.', undoAction());
  }
  function bulkClearIps() {
    const v = cur();
    if (!v || S.readOnly) return;
    pushUndo(v, 'clear');
    let n = 0;
    for (const d of v.devices) if (S.sel.has(d.id) && d.ip) { d.ip = ''; n++; }
    touch(v);
    render();
    toast('Cleared ' + C.plural(n, 'address', 'addresses') + '.', undoAction());
  }
  function gotoDevice(id) {
    const v = cur();
    if (!v) return;
    const d = v.devices.find((x) => x.id === id);
    if (!d) return;
    S.tab = 'devices';
    S.devView = 'list';
    S.q = '';
    if (S.zone !== 'all' && S.zone !== d.zone) S.zone = 'all';
    render();
    const tr = $('#dev-table tr[data-dev="' + cssq(id) + '"]');
    if (!tr) return;
    const smooth = !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    tr.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
    tr.classList.add('flash');
    setTimeout(() => tr.classList.remove('flash'), 1700);
    const inp = tr.querySelector('[data-f="ip"]');
    if (inp) inp.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- map interactions
  function onTipOver(e) {
    const c = e.target.closest && e.target.closest('.ipc[data-h]');
    if (!c) return;
    const t = S.mapTips[+c.dataset.h];
    if (!t) return;
    const tip = $('#tip');
    tip.innerHTML = '<b>' + esc(t.title) + '</b><br>' + t.lines.map(esc).join('<br>');
    tip.hidden = false;
    placeTip(e);
  }
  function onTipOut(e) {
    const c = e.target.closest && e.target.closest('.ipc[data-h]');
    if (c && !(e.relatedTarget && c.contains(e.relatedTarget))) $('#tip').hidden = true;
  }
  function onTipMove(e) {
    const tip = $('#tip');
    if (!tip.hidden) placeTip(e);
  }
  function placeTip(e) {
    const tip = $('#tip');
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    let x = e.clientX + 14;
    let y = e.clientY + 16;
    if (x + w > window.innerWidth - 8) x = e.clientX - w - 14;
    if (y + h > window.innerHeight - 8) y = e.clientY - h - 14;
    tip.style.left = Math.max(8, x) + 'px';
    tip.style.top = Math.max(8, y) + 'px';
  }
  function openCell(t) {
    const v = cur();
    if (!v) return;
    $('#tip').hidden = true;
    const a = analysis(v);
    const i = a.info;
    const sec = S.mapNet === 'sec' && !!v.net.redundancy && i.secBlock != null;
    const h = +t.dataset.h;
    const addr = (sec ? i.secBlock : i.block) + h;
    const label = ip(addr);
    const occ = a.occ.get(addr) || [];
    const byId = new Map(v.devices.map((d) => [d.id, d]));
    const zname = new Map(v.zones.map((z) => [z.id, z.name]));
    if (occ.length) {
      const items = occ.map((o) => {
        if (o.type === 'pc') return '<div class="occ"><div><b>Control computer</b><small>LA Network Manager host. Change it in the Network card.</small></div></div>';
        if (o.type === 'gw') return '<div class="occ"><div><b>Gateway</b><small>Set in the Network card.</small></div></div>';
        const d = byId.get(o.id);
        if (!d) return '';
        const iss = (a.byDev.get(d.id) || []).filter((x) => x.sev !== 'info');
        return '<div class="occ"><div><b>' + esc(d.name || C.modelOf(d.model).label) + '</b><small>' + esc(C.modelOf(d.model).label + ' · ' + (zname.get(d.zone) || '') + (o.role === 'sec' ? ' · secondary address' : '')) + '</small>' +
          (iss.length ? '<small style="color:var(--bad-ink)">' + esc(iss[0].msg) + '</small>' : '') + '</div><button class="btn-mini" type="button" data-goto="' + esc(d.id) + '">Show in list</button></div>';
      }).join('');
      openModal({
        title: label,
        body: (occ.length > 1 ? '<p class="warn-line">' + occ.length + ' devices share this address. Give all but one of them another address.</p>' : '') + '<div class="occ-list">' + items + '</div>',
        actions: [{ label: 'Close', kind: 'primary' }],
        onOpen: (m) => m.addEventListener('click', (ev) => { const b = ev.target.closest('[data-goto]'); if (b) { closeModal(true); gotoDevice(b.dataset.goto); } }),
      });
      return;
    }
    if (h === 0 || h === 255) {
      openModal({ title: label, body: '<p>' + (i.prefix === 24 ? (h === 0 ? 'The network’s own address.' : 'The broadcast address.') + ' ' : '') + 'L-Acoustics units use .1 to .253.</p>', actions: [{ label: 'Close', kind: 'primary' }] });
      return;
    }
    if (S.readOnly) return;
    const cands = v.devices.filter((d) => { const dn = a.nets.get(d.id); return dn && (sec ? dn.onSec : !dn.onSec); });
    if (!cands.length) {
      openModal({ title: label, body: '<p>' + (sec ? 'No devices sit on the secondary network on their own. Amplifiers get their secondary address automatically from the primary one.' : 'No devices yet. Add some first.') + '</p>', actions: [{ label: 'Close', kind: 'primary' }] });
      return;
    }
    const noIp = cands.filter((d) => !String(d.ip).trim());
    const withIp = cands.filter((d) => String(d.ip).trim());
    const opt = (d) => '<option value="' + esc(d.id) + '">' + esc((d.name || d.model) + ' · ' + C.modelOf(d.model).label + (d.ip ? ' · now ' + d.ip : '')) + '</option>';
    const inDhcp = !sec && a.dhcp && addr >= a.dhcp.from && addr <= a.dhcp.to;
    const fd = !sec && i.blockStr === '192.168.1' && (addr === C.FD_UNIT || addr === C.FD_LS10);
    openModal({
      title: 'Assign ' + label,
      body: (inDhcp ? '<p class="warn-line">This address is inside the DHCP pool.</p>' : fd ? '<p class="warn-line">New units ship on this address. Better to keep it free.</p>' : '') +
        '<div class="field"><label for="as-dev">Device</label><select id="as-dev">' +
        (noIp.length ? '<optgroup label="No address yet">' + noIp.map(opt).join('') + '</optgroup>' : '') +
        (withIp.length ? '<optgroup label="Move from its current address">' + withIp.map(opt).join('') + '</optgroup>' : '') + '</select></div>',
      actions: [
        { label: 'Cancel' },
        { label: 'Assign', kind: 'primary', onClick: (m) => {
          const d = v.devices.find((x) => x.id === $('#as-dev', m).value);
          if (!d) return;
          pushUndo(v, 'assign');
          d.ip = label;
          touch(v);
          render();
          toast((d.name || d.model) + ' is now ' + label + '.', undoAction());
        } },
      ],
    });
  }

  // ---------------------------------------------------------------- dialogs
  function openAddDevices(zoneId) {
    const v = cur();
    if (!v || S.readOnly) return;
    const z0 = zoneId || (S.zone !== 'all' ? S.zone : v.zones[0].id);
    const info = C.netInfo(v);
    openModal({
      title: 'Add devices',
      body: '<div class="form-grid">' +
        '<div class="field"><label for="ad-model">Model</label><select id="ad-model">' + modelOptions('LA12X') + '</select><small id="ad-info"></small></div>' +
        '<div class="field"><label for="ad-qty">How many</label><input id="ad-qty" type="number" min="1" max="64" value="1"></div>' +
        '<div class="field"><label for="ad-zone">Zone</label><select id="ad-zone">' + zoneOptions(v, z0) + '</select></div>' +
        '<div class="field"><label for="ad-name">Name</label><input id="ad-name" maxlength="70" autocomplete="off"><small id="ad-hint"></small></div>' +
        '<div class="field span2"><label for="ad-loc">Location <em>optional</em></label><input id="ad-loc" maxlength="80" placeholder="e.g. SL wing, FOH, delay tower" autocomplete="off"></div>' +
        '<label class="check span2"><input type="checkbox" id="ad-assign" checked><span id="ad-assign-txt"></span></label></div>',
      actions: [{ label: 'Cancel' }, { label: 'Add', kind: 'primary', onClick: (m) => addDevicesFromModal(v, m) }],
      onOpen: (m) => {
        const nameEl = $('#ad-name', m);
        const upd = () => {
          const mod = C.modelOf($('#ad-model', m).value);
          const z = v.zones.find((x) => x.id === $('#ad-zone', m).value);
          if (!nameEl.dataset.touched) nameEl.value = z ? z.name : mod.label;
          const qty = C.clampInt($('#ad-qty', m).value, 1, 64, 1);
          const pre = nameEl.value.trim() || mod.label;
          const s = nextIndex(v, pre, false);
          $('#ad-hint', m).textContent = qty > 1 ? 'Named ' + pre + ' ' + s + ' to ' + pre + ' ' + (s + qty - 1) : 'Named ' + pre + ' ' + s;
          $('#ad-info', m).textContent = mod.info;
          const cb = $('#ad-assign', m);
          cb.disabled = !mod.auto;
          $('#ad-assign-txt', m).textContent = mod.auto
            ? 'Give ' + (qty > 1 ? 'them' : 'it') + ' addresses on ' + (info.blockStr || '192.168.1') + '.x now'
            : 'You set this device’s address by hand';
        };
        nameEl.addEventListener('input', () => { nameEl.dataset.touched = '1'; upd(); });
        ['#ad-model', '#ad-zone', '#ad-qty'].forEach((s) => { $(s, m).addEventListener('input', upd); $(s, m).addEventListener('change', upd); });
        upd();
      },
    });
  }
  function addDevicesFromModal(v, m) {
    const model = $('#ad-model', m).value;
    const qty = C.clampInt($('#ad-qty', m).value, 1, 64, 1);
    if (v.devices.length + qty > C.MAX_DEVICES) { toast('A venue holds up to ' + C.MAX_DEVICES + ' devices.'); return false; }
    const zone = $('#ad-zone', m).value;
    const pre = $('#ad-name', m).value.trim() || C.modelOf(model).label;
    const loc = $('#ad-loc', m).value.trim();
    const s = nextIndex(v, pre, false);
    const created = [];
    for (let k = 0; k < qty; k++) created.push(C.newDevice({ name: pre + ' ' + (s + k), model, zone, location: loc }));
    pushUndo(v, 'add');
    v.devices.push.apply(v.devices, created);
    const z = v.zones.find((x) => x.id === zone);
    finishAdd(v, created, $('#ad-assign', m).checked && C.modelOf(model).auto, 'Added ' + qty + ' × ' + C.modelOf(model).label + (z ? ' to ' + z.name : '') + '.');
  }
  function finishAdd(v, created, assign, msg) {
    let extra = '';
    if (assign) {
      const a = v.net.assign;
      const plan = C.planAutoAssign(v, { scheme: a.scheme, start: a.start, size: a.size, avoidDefaults: a.avoidDefaults, scope: 'empty', onlyIds: created.map((d) => d.id) });
      C.applyChanges(v, plan.changes);
      if (plan.unplaced.length) extra = ' ' + C.plural(plan.unplaced.length, 'device') + ' got no address (' + plan.unplaced[0].reason.toLowerCase() + ').';
    }
    touch(v);
    render();
    toast(msg + extra, undoAction());
  }
  // next free number for "<prefix> n", looking at rack names as well as device names
  function nextRackIndex(v, pre) {
    let n = nextIndex(v, pre, true);
    const re = new RegExp('^' + pre.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' (\\d+)$', 'i');
    for (const r of v.racks || []) { const m = re.exec(r.name); if (m) n = Math.max(n, +m[1] + 1); }
    return n;
  }
  function openAddRack() {
    const v = cur();
    if (!v || S.readOnly) return;
    const z0 = S.zone !== 'all' ? S.zone : v.zones[0].id;
    openModal({
      title: 'Add rack',
      body: '<div class="form-grid">' +
        '<div class="field span2"><label for="ar-type">Rack</label><select id="ar-type">' + C.RACKS.map((r) => '<option value="' + esc(r.id) + '">' + esc(r.id + ' · ' + r.info) + '</option>').join('') + '</select></div>' +
        '<div class="field"><label for="ar-qty">How many racks</label><input id="ar-qty" type="number" min="1" max="12" value="1"></div>' +
        '<div class="field"><label for="ar-zone">Zone</label><select id="ar-zone">' + zoneOptions(v, z0) + '</select></div>' +
        '<div class="field"><label for="ar-name">Rack name</label><input id="ar-name" value="RAK" maxlength="40" autocomplete="off"><small id="ar-hint"></small></div>' +
        '<div class="field"><label for="ar-loc">Location <em>optional</em></label><input id="ar-loc" maxlength="80" placeholder="Defaults to the rack name" autocomplete="off"></div>' +
        '<label class="check span2" id="ar-ls10-wrap"><input type="checkbox" id="ar-ls10" checked><span>Include the rack’s two LS10 switches. With redundancy on, one sits on each network.</span></label>' +
        '<label class="check span2"><input type="checkbox" id="ar-assign" checked><span>Give everything addresses now</span></label></div>',
      actions: [{ label: 'Cancel' }, { label: 'Add rack', kind: 'primary', onClick: (m) => addRackFromModal(v, m) }],
      onOpen: (m) => {
        const upd = () => {
          const r = C.RACK_MAP[$('#ar-type', m).value];
          $('#ar-ls10-wrap', m).hidden = !r.ls10;
          const qty = C.clampInt($('#ar-qty', m).value, 1, 12, 1);
          const pre = $('#ar-name', m).value.trim() || 'RAK';
          const s = nextRackIndex(v, pre);
          const each = r.amps.length + (r.ls10 && $('#ar-ls10', m).checked ? r.ls10 : 0);
          $('#ar-hint', m).textContent = (qty > 1 ? pre + ' ' + s + ' to ' + pre + ' ' + (s + qty - 1) : pre + ' ' + s) + ' · ' + C.plural(each * qty, 'device');
        };
        ['#ar-type', '#ar-qty', '#ar-name', '#ar-ls10'].forEach((s) => { $(s, m).addEventListener('input', upd); $(s, m).addEventListener('change', upd); });
        upd();
      },
    });
  }
  function addRackFromModal(v, m) {
    const r = C.RACK_MAP[$('#ar-type', m).value];
    if (!r) return false;
    const qty = C.clampInt($('#ar-qty', m).value, 1, 12, 1);
    const zone = $('#ar-zone', m).value;
    const pre = $('#ar-name', m).value.trim() || 'RAK';
    const loc = $('#ar-loc', m).value.trim();
    const withLs10 = !!r.ls10 && $('#ar-ls10', m).checked;
    const s = nextRackIndex(v, pre);
    const created = [];
    const per = r.amps.length + (withLs10 ? r.ls10 : 0);
    if (v.devices.length + per * qty > C.MAX_DEVICES) { toast('A venue holds up to ' + C.MAX_DEVICES + ' devices.'); return false; }
    pushUndo(v, 'rack');
    for (let k = 0; k < qty; k++) {
      const res = C.addRackWithDevices(v, r.id, pre + ' ' + (s + k), zone, { location: loc || undefined, ls10: withLs10 });
      if (res) created.push.apply(created, res.devices);
    }
    finishAdd(v, created, $('#ar-assign', m).checked, 'Added ' + qty + ' × ' + r.id + ' (' + C.plural(created.length, 'device') + ').');
  }

  function readAA(m) {
    const fd = $('#aa-fd', m);
    return {
      scheme: ($('input[name="aa-scheme"]:checked', m) || {}).value === 'sequential' ? 'sequential' : 'zones',
      start: C.clampInt($('#aa-start', m).value, 1, C.MAX_HOST, 11),
      size: C.clampInt($('#aa-size', m).value, 2, 100, 10),
      scope: ($('input[name="aa-scope"]:checked', m) || {}).value === 'all' ? 'all' : 'empty',
      avoidDefaults: fd ? fd.checked : true,
    };
  }
  function previewHtml(v, plan, o) {
    const byId = new Map(v.devices.map((d) => [d.id, d]));
    const zname = new Map(v.zones.map((z) => [z.id, z.name]));
    let blocks = '';
    if (o.scheme === 'zones') {
      const used = new Set(v.devices.filter((d) => C.modelOf(d.model).auto).map((d) => d.zone));
      blocks = v.zones.map((z, k) => ({ z, lo: o.start + k * o.size })).filter((x) => used.has(x.z.id))
        .map((x) => '<span class="tag">' + esc(x.z.name) + ' ' + (x.lo > C.MAX_HOST ? 'no room' : '.' + x.lo + '–.' + Math.min(x.lo + o.size - 1, C.MAX_HOST)) + '</span>').join(' ');
    }
    const n = plan.changes.length;
    const head = '<div class="preview-h"><span>' + (n ? esc(C.plural(n, 'device')) + (n === 1 ? ' gets' : ' get') + ' a new address' : 'No changes with these settings') + '</span>' + blocks + '</div>';
    const unpl = plan.unplaced.length
      ? '<div class="warn-line">' + esc(C.plural(plan.unplaced.length, 'device')) + ' can’t be placed. ' + esc(plan.unplaced[0].reason) + '. ' + (o.scheme === 'zones' ? 'Choose more addresses per zone or a lower start.' : 'Free up some addresses.') + '</div>'
      : '';
    const rows = plan.changes.slice(0, 300).map((c) => {
      const d = byId.get(c.id);
      return '<tr><td>' + esc(zname.get(d.zone) || '') + '</td><td>' + esc(d.name || d.model) + '</td><td>' + (c.from ? '<span class="old">' + esc(c.from) + '</span> <span class="arrow">→</span> ' : '') + '<span class="new">' + esc(c.to) + '</span></td></tr>';
    }).join('');
    return head + unpl + (rows ? '<div class="preview-scroll"><table>' + rows + '</table></div>' : '');
  }
  function openAutoAssign() {
    const v = cur();
    if (!v || S.readOnly) return;
    const info = C.netInfo(v);
    if (!info.ok) { toast('Fix the primary network first.'); return; }
    const a0 = v.net.assign;
    openModal({
      title: 'Auto-assign IP addresses',
      wide: true,
      body: '<fieldset><legend>Numbering</legend>' +
        '<label class="radio"><input type="radio" name="aa-scheme" value="zones"' + (a0.scheme === 'zones' ? ' checked' : '') + '><span><b>A block per zone</b>Each zone gets its own range, so an address tells you where a unit lives.</span></label>' +
        '<label class="radio"><input type="radio" name="aa-scheme" value="sequential"' + (a0.scheme === 'sequential' ? ' checked' : '') + '><span><b>One continuous run</b>Zone after zone with no gaps. Keeps the LA Network Manager scan range short.</span></label></fieldset>' +
        '<div class="form-grid"><div class="field"><label for="aa-start">Start at</label><div class="join"><span class="prefix mono">' + esc(info.blockStr) + '.</span><input id="aa-start" type="number" min="1" max="253" value="' + a0.start + '"></div></div>' +
        '<div class="field" id="aa-size-f"><label for="aa-size">Addresses per zone</label><select id="aa-size">' + [5, 10, 20, 25, 50].map((n) => '<option value="' + n + '"' + (n === a0.size ? ' selected' : '') + '>' + n + '</option>').join('') + '</select></div></div>' +
        '<fieldset><legend>Which devices</legend>' +
        '<label class="radio"><input type="radio" name="aa-scope" value="empty" checked><span>Only devices without an address</span></label>' +
        '<label class="radio"><input type="radio" name="aa-scope" value="all"><span>Renumber every L-Acoustics device. Consoles, routers and other devices keep their addresses.</span></label></fieldset>' +
        (info.blockStr === '192.168.1' ? '<label class="check"><input type="checkbox" id="aa-fd"' + (a0.avoidDefaults ? ' checked' : '') + '><span>Keep 192.168.1.100 and .200 free. New units ship on .100 and LS10 switches on .200, so a spare plugged in later won’t clash.</span></label>' : '') +
        '<div class="preview" id="aa-prev"></div>',
      actions: [
        { label: 'Cancel' },
        { label: 'Apply', kind: 'primary', onClick: (m) => {
          const o = readAA(m);
          const plan = C.planAutoAssign(v, o);
          if (!plan.changes.length) return false;
          pushUndo(v, 'auto');
          C.applyChanges(v, plan.changes);
          v.net.assign = { scheme: o.scheme, start: o.start, size: o.size, avoidDefaults: o.avoidDefaults };
          touch(v);
          render();
          toast('Assigned ' + C.plural(plan.changes.length, 'address', 'addresses') + '.' + (plan.unplaced.length ? ' ' + C.plural(plan.unplaced.length, 'device') + ' left without one.' : ''), undoAction());
        } },
      ],
      onOpen: (m) => {
        const upd = () => {
          const o = readAA(m);
          $('#aa-size-f', m).hidden = o.scheme !== 'zones';
          const plan = C.planAutoAssign(v, o);
          $('#aa-prev', m).innerHTML = previewHtml(v, plan, o);
          const btn = m.querySelector('[data-modal-act="1"]');
          if (btn) { btn.disabled = !plan.changes.length; btn.textContent = plan.changes.length ? 'Apply ' + C.plural(plan.changes.length, 'change') : 'Nothing to change'; }
        };
        m.addEventListener('input', upd);
        m.addEventListener('change', upd);
        upd();
      },
    });
  }

  function openZones() {
    const v = cur();
    if (!v || S.readOnly) return;
    const work = v.zones.map((z) => Object.assign({}, z));
    const counts = new Map();
    v.devices.forEach((d) => counts.set(d.zone, (counts.get(d.zone) || 0) + 1));
    const draw = (m) => {
      $('#ze-list', m).innerHTML = work.map((z, i) => '<div class="zone-line" data-i="' + i + '">' +
        '<button type="button" class="swatch-btn" data-cycle style="background:var(--z' + z.color + ')" aria-label="Change colour of ' + esc(z.name) + '" title="Change colour"></button>' +
        '<input value="' + esc(z.name) + '" data-zname maxlength="60" aria-label="Zone name" autocomplete="off">' +
        '<select data-zside aria-label="Side of the stage for ' + esc(z.name) + '">' + C.SIDES.map((sd) => '<option value="' + sd + '"' + (z.side === sd ? ' selected' : '') + '>' + C.SIDE_LABEL[sd] + '</option>').join('') + '</select>' +
        '<button type="button" class="icon-btn" data-move="-1" aria-label="Move ' + esc(z.name) + ' up"' + (i === 0 ? ' disabled' : '') + '>' + ICON.up + '</button>' +
        '<button type="button" class="icon-btn" data-move="1" aria-label="Move ' + esc(z.name) + ' down"' + (i === work.length - 1 ? ' disabled' : '') + '>' + ICON.down + '</button>' +
        '<button type="button" class="icon-btn" data-del aria-label="Delete ' + esc(z.name) + '"' + (work.length === 1 ? ' disabled' : '') + ' title="' + esc(counts.get(z.id) ? C.plural(counts.get(z.id), 'device') + ' move to the first zone' : 'Delete zone') + '">' + ICON.trash + '</button></div>').join('');
    };
    openModal({
      title: 'Edit zones',
      body: '<p>Zone order sets the auto-assign blocks: the first zone gets the first block. The side tells the rack view where that zone’s amps go.</p><div class="zone-edit" id="ze-list"></div><div><button type="button" class="btn" id="ze-add">' + ICON.plus + 'Add zone</button></div>',
      actions: [
        { label: 'Cancel' },
        { label: 'Save zones', kind: 'primary', onClick: () => {
          work.forEach((z) => { z.name = String(z.name || '').trim() || 'Zone'; delete z.sideSet; if (C.SIDES.indexOf(z.side) < 0) z.side = C.sideFor(z.name, 0); });
          const ids = new Set(work.map((z) => z.id));
          pushUndo(v, 'zones');
          v.devices.forEach((d) => { if (d.zone && !ids.has(d.zone)) d.zone = work[0].id; });
          v.zones = work;
          if (S.zone !== 'all' && !ids.has(S.zone)) S.zone = 'all';
          touch(v);
          render();
          toast('Zones saved.', undoAction());
        } },
      ],
      onOpen: (m) => {
        draw(m);
        m.addEventListener('click', (e) => {
          const line = e.target.closest('.zone-line');
          const i = line ? +line.dataset.i : -1;
          if (e.target.closest('#ze-add')) {
            if (work.length >= 40) return;
            work.push({ id: C.uid('z'), name: 'Zone ' + (work.length + 1), color: Math.min(work.length, 8), side: C.sideFor('', work.length) });
            draw(m);
            const inputs = $$('[data-zname]', m);
            if (inputs.length) { inputs[inputs.length - 1].focus(); inputs[inputs.length - 1].select(); }
            return;
          }
          if (i < 0) return;
          if (e.target.closest('[data-cycle]')) { work[i].color = (work[i].color + 1) % 9; draw(m); $('.zone-line[data-i="' + i + '"] [data-cycle]', m).focus(); return; }
          const mv = e.target.closest('[data-move]');
          if (mv && !mv.disabled) {
            const j = i + (+mv.dataset.move);
            const tmp = work[i]; work[i] = work[j]; work[j] = tmp;
            draw(m);
            const b = $('.zone-line[data-i="' + j + '"] [data-move="' + mv.dataset.move + '"]', m);
            if (b && !b.disabled) b.focus();
            return;
          }
          const del = e.target.closest('[data-del]');
          if (del && !del.disabled) { work.splice(i, 1); draw(m); }
        });
        m.addEventListener('input', (e) => {
          const inp = e.target.closest('[data-zname]');
          if (!inp) return;
          const z = work[+inp.closest('.zone-line').dataset.i];
          z.name = inp.value;
          const guess = C.inferSide(inp.value);
          if (!z.sideSet && guess) { z.side = guess; const sel = inp.parentElement.querySelector('[data-zside]'); if (sel) sel.value = z.side; }
        });
        m.addEventListener('change', (e) => {
          const sel = e.target.closest('[data-zside]');
          if (!sel) return;
          const z = work[+sel.closest('.zone-line').dataset.i];
          z.side = sel.value;
          z.sideSet = true;
        });
      },
    });
  }

  function openColumns() {
    const labels = { location: 'Location', port: 'Switch / port', serial: 'Serial / asset', notes: 'Notes' };
    openModal({
      title: 'Columns',
      body: '<p>Pick the optional columns to show. This only changes your own view.</p>' + Object.keys(labels).map((k) => '<label class="check"><input type="checkbox" data-colpick="' + k + '"' + (prefs.cols[k] ? ' checked' : '') + '><span>' + labels[k] + '</span></label>').join(''),
      actions: [{ label: 'Done', kind: 'primary' }],
      onOpen: (m) => m.addEventListener('change', (e) => {
        const k = e.target.dataset.colpick;
        if (!k) return;
        prefs.cols[k] = e.target.checked;
        savePrefs();
        const t = $('#dev-table');
        if (t) t.classList.toggle('hide-' + k, !e.target.checked);
      }),
    });
  }

  async function openExport() {
    const v = cur();
    if (!v) return;
    const dl = await getDownloads();
    const sep0 = prefs.sep || ((1.5).toLocaleString().indexOf(',') >= 0 ? ';' : ',');
    const dis = dl ? '' : ' disabled';
    openModal({
      title: 'Export',
      body: '<div class="export-list">' +
        '<button type="button" class="export-opt" data-x="sheet"' + dis + '><b>Patch sheet</b><span>Print-ready page for the crew, grouped by zone, with tick boxes. Open the .html file and print.</span></button>' +
        '<button type="button" class="export-opt" data-x="png"' + dis + '><b>Amp plan picture</b><span>The rack view as a .png image for WhatsApp, email or print</span></button>' +
        '<button type="button" class="export-opt" data-x="svg"' + dis + '><b>Amp plan picture you can edit</b><span>The same picture as .svg for Illustrator, Inkscape or Keynote</span></button>' +
        '<button type="button" class="export-opt" data-x="csv"' + dis + '><b>Spreadsheet</b><span>Every device and address as a .csv file</span></button>' +
        '<div class="field"><label for="x-sep">Spreadsheet separator</label><select id="x-sep"><option value=","' + (sep0 === ',' ? ' selected' : '') + '>Comma</option><option value=";"' + (sep0 === ';' ? ' selected' : '') + '>Semicolon, for Excel set to Czech, German, French…</option></select></div>' +
        '<button type="button" class="export-opt" data-x="copy"><b>Copy as table</b><span>Paste straight into Excel, Google Sheets, an email or a chat</span></button>' +
        '<button type="button" class="export-opt" data-x="json"' + dis + '><b>Backup of this venue</b><span>A .json file you can import again or send to a colleague</span></button>' +
        '<button type="button" class="export-opt" data-x="json-all"' + dis + '><b>Backup of all ' + esc(C.plural(S.venues.length, 'venue')) + '</b><span>One .json file</span></button>' +
        '</div>' + (dl ? '' : '<p class="muted">File downloads aren’t available in this view. Copy as table still works.</p>'),
      actions: [{ label: 'Close' }],
      onOpen: (m) => m.addEventListener('click', (e) => {
        const b = e.target.closest('[data-x]');
        if (!b || b.disabled) return;
        const sep = $('#x-sep', m).value;
        prefs.sep = sep;
        savePrefs();
        const base = slug(v.name);
        const kind = b.dataset.x;
        if (kind === 'copy') { copyText(C.toDelimited(v, '\t'), 'Table copied. Paste it into a spreadsheet or email.'); return; }
        if (kind === 'svg') { saveFile(base + '-amp-plan.svg', C.planSvg(v)); return; }
        if (kind === 'png') { svgToPng(C.planSvg(v)).then((blob) => saveFile(base + '-amp-plan.png', blob), () => toast('Couldn’t draw the picture here. Try the .svg version.')); return; }
        if (kind === 'sheet') saveFile(base + '-patch-sheet.html', C.patchSheet(v));
        else if (kind === 'csv') saveFile(base + '-ip-plan.csv', '﻿' + C.toDelimited(v, sep));
        else if (kind === 'json') saveFile(base + '-backup.json', C.bundle([v]));
        else if (kind === 'json-all') saveFile('amp-ip-planner-backup-' + todayIso() + '.json', C.bundle(S.venues));
      }),
    });
  }
  async function saveFile(name, data) {
    const dl = await getDownloads();
    if (!dl) { toast('Downloads aren’t available here.'); return; }
    try {
      await dl.save({ filename: name, data });
      toast('Saved ' + name + '.');
    } catch (e) {
      const c = e && e.code;
      if (c === 'declined') return;
      if (c === 'rate_limited') { toast('A save prompt is already open.'); return; }
      toast('Couldn’t save the file' + (c ? ' (' + c + ')' : '') + '.');
    }
  }
  function copyText(text, okMsg) {
    const fallback = () => openModal({
      title: 'Copy',
      body: '<p>Copy this text with Ctrl+C or ⌘C.</p><label class="sr-only" for="copybox">Text to copy</label><textarea id="copybox" class="copybox" readonly>' + esc(text) + '</textarea>',
      actions: [{ label: 'Close', kind: 'primary' }],
      onOpen: (m) => { const ta = $('textarea', m); ta.focus(); ta.select(); },
    });
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) { fallback(); return; }
      navigator.clipboard.writeText(text).then(() => toast(okMsg || 'Copied.'), fallback);
    } catch (e) { fallback(); }
  }
  function onImportFile(e) {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > 5e6) { toast('That file is too large for a planner backup.'); return; }
    const r = new FileReader();
    r.onload = () => {
      try {
        const list = C.parseBundle(String(r.result));
        const names = new Set(S.venues.map((v) => v.name));
        const added = [];
        for (const raw of list) {
          const v = C.sanitizeVenue(C.uid('v'), raw);
          if (names.has(v.name)) v.name = v.name + ' (imported)';
          if (!v.createdAt) v.createdAt = Date.now();
          S.venues.push(v);
          added.push(v);
          touch(v, true);
        }
        if (added.length) openVenue(added[0].id);
        toast('Imported ' + C.plural(added.length, 'venue') + '.');
      } catch (err) {
        toast((err && err.message) || 'Couldn’t read that file.');
      }
    };
    r.onerror = () => toast('Couldn’t read that file.');
    r.readAsText(f);
  }

  // ---------------------------------------------------------------- modal & toast
  function openModal(o) {
    closeModal(true);
    const root = $('#modal-root');
    root.innerHTML = '<div class="modal-bg"><div class="modal' + (o.wide ? ' wide' : '') + '" role="dialog" aria-modal="true" aria-labelledby="m-title">' +
      '<div class="modal-h"><h2 id="m-title">' + esc(o.title) + '</h2><button type="button" class="icon-btn" data-modal-close aria-label="Close">' + ICON.x + '</button></div>' +
      '<div class="modal-b">' + o.body + '</div>' +
      (o.actions && o.actions.length ? '<div class="modal-f">' + o.actions.map((x, i) => '<button type="button" class="btn' + (x.kind ? ' btn-' + x.kind : '') + (x.left ? ' push-left' : '') + '" data-modal-act="' + i + '">' + esc(x.label) + '</button>').join('') + '</div>' : '') +
      '</div></div>';
    const bg = root.firstElementChild;
    const box = bg.firstElementChild;
    const state = { o, prev: document.activeElement, downOnBg: false };
    S.modal = state;
    bg.addEventListener('mousedown', (e) => { state.downOnBg = e.target === bg; });
    bg.addEventListener('click', (e) => {
      if (e.target === bg) { if (state.downOnBg) closeModal(); return; }
      if (e.target.closest('[data-modal-close]')) { closeModal(); return; }
      const b = e.target.closest('[data-modal-act]');
      if (!b || b.disabled) return;
      const act = o.actions[+b.dataset.modalAct];
      if (act && act.onClick && act.onClick(box) === false) return;
      if (S.modal === state) closeModal();
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT' && ['checkbox', 'radio', 'file'].indexOf(e.target.type) < 0) {
        const p = box.querySelector('.modal-f .btn-primary:not(:disabled), .modal-f .btn-danger:not(:disabled)');
        if (p && o.actions.length > 1) { e.preventDefault(); p.click(); }
      }
      if (e.key === 'Tab') {
        const f = $$('button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea, a[href]', box).filter((x) => x.offsetParent !== null);
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    });
    if (o.onOpen) o.onOpen(box);
    const first = box.querySelector('[autofocus]') || box.querySelector('.modal-b input:not([type="hidden"]):not([disabled]), .modal-b select:not([disabled])') || box.querySelector('.modal-f .btn-primary') || box.querySelector('.modal-b button') || box.querySelector('button');
    if (first) first.focus();
  }
  function closeModal(silent) {
    const root = $('#modal-root');
    if (!root || !root.firstChild) { S.modal = null; return; }
    const prev = S.modal && S.modal.prev;
    root.innerHTML = '';
    S.modal = null;
    if (!silent && prev && document.contains(prev)) { try { prev.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
  }
  function toast(msg, action) {
    const root = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.innerHTML = '<span>' + esc(msg) + '</span>' + (action ? '<button type="button" class="btn-mini">' + esc(action.label) + '</button>' : '');
    if (action) el.querySelector('button').addEventListener('click', () => { el.remove(); action.onClick(); });
    root.appendChild(el);
    while (root.children.length > 3) root.firstElementChild.remove();
    const life = action ? 7000 : 3600;
    setTimeout(() => el.classList.add('out'), life);
    setTimeout(() => el.remove(), life + 400);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
