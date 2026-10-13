(() => {
  'use strict';
  window.__MIKKECHO_V2 = true;   // read by the watchdog in index.html

  /* ============================================================
     STATE SHAPE / SHARED HELPERS
  ============================================================ */
  const LEGACY_KEY = 'mikkecho_state_v1';   // v1 stored everything in localStorage under this key
  const SCHEMA_VERSION = 2;

  function defaultState() {
    return {
      customCategories: [],   // { id, name, icon, type:'free', entries: [] } (legacy field, unused for new entries)
      founds: {},             // entryId -> { photos, haiku, date, ts, updatedAt, categoryId }  (preset checklist finds)
      unlocked: [],
      userEntries: {},        // categoryId -> [ {id,name,photos,haiku,date,ts,updatedAt} ]  (user-added, works for any category)
      theme: 'day',           // 'day' | 'night' (行灯モード)
      onboarded: false,
      lastBackupPromptCount: 0, // totalFoundAll() value at the time of the last backup nudge/export
    };
  }

  let state = defaultState();   // replaced by boot() after storage has been read
  let blockSaves = false;       // true if loading failed: we must never overwrite what is stored
  let lastPersistedTotal = 0;   // record count at the last successful save (safety net against accidental wipes)

  function clone(obj) {
    return (typeof structuredClone === 'function') ? structuredClone(obj) : JSON.parse(JSON.stringify(obj));
  }
  function describeError(e) {
    if (!e) return 'unknown';
    return (e.name ? e.name + (e.message ? ': ' + e.message : '') : (e.message || String(e)));
  }
  function pickData(s) {
    return { customCategories: s.customCategories, founds: s.founds, userEntries: s.userEntries, unlocked: s.unlocked };
  }
  function pickPrefs(s) {
    return { theme: s.theme, onboarded: s.onboarded, lastBackupPromptCount: s.lastBackupPromptCount };
  }
  function migratePhotos(s) {
    // old records stored a single `photo` string; convert to `photos` array.
    Object.values(s.founds || {}).forEach(rec => {
      if (!rec.photos) rec.photos = rec.photo ? [rec.photo] : [];
      delete rec.photo;
    });
    Object.values(s.userEntries || {}).forEach(list => {
      (list || []).forEach(rec => {
        if (!rec.photos) rec.photos = rec.photo ? [rec.photo] : [];
        delete rec.photo;
      });
    });
  }
  function buildState(data, prefs) {
    const s = Object.assign(defaultState(), data || {}, prefs || {});
    delete s.schema; delete s.savedAt; delete s.app; delete s.exportedAt;
    if (!s.founds || typeof s.founds !== 'object') s.founds = {};
    if (!s.userEntries || typeof s.userEntries !== 'object') s.userEntries = {};
    if (!Array.isArray(s.customCategories)) s.customCategories = [];
    if (!Array.isArray(s.unlocked)) s.unlocked = [];
    migratePhotos(s);
    return s;
  }
  function splitLegacy(p) {
    return {
      data: { customCategories: p.customCategories || [], founds: p.founds || {}, userEntries: p.userEntries || {}, unlocked: p.unlocked || [] },
      prefs: { theme: p.theme || 'day', onboarded: !!p.onboarded, lastBackupPromptCount: p.lastBackupPromptCount || 0 },
    };
  }
  function countRecords(d) {
    const founds = Object.values((d && d.founds) || {});
    const photoCount = (r) => (r && r.photos && r.photos.length) || (r && r.photo ? 1 : 0) || 0;
    let photos = founds.reduce((n, r) => n + photoCount(r), 0);
    let user = 0;
    Object.values((d && d.userEntries) || {}).forEach(list => (list || []).forEach(r => { user++; photos += photoCount(r); }));
    return { found: founds.length, user, photos, total: founds.length + user };
  }

  // Merge `inc` (already normalised) into `cur` (mutates cur). Nothing in `cur` is ever dropped.
  function mergeData(cur, inc) {
    const stamp = (r) => (r && (r.updatedAt || r.ts)) || 0;
    let added = 0, updated = 0;
    Object.keys(inc.founds || {}).forEach(id => {
      const a = cur.founds[id], b = inc.founds[id];
      if (!a) { cur.founds[id] = b; added++; }
      else if (stamp(b) > stamp(a)) { cur.founds[id] = b; updated++; }
    });
    Object.keys(inc.userEntries || {}).forEach(catId => {
      const list = cur.userEntries[catId] || (cur.userEntries[catId] = []);
      (inc.userEntries[catId] || []).forEach(b => {
        const i = list.findIndex(x => x.id === b.id);
        if (i < 0) { list.push(b); added++; }
        else if (stamp(b) > stamp(list[i])) { list[i] = b; updated++; }
      });
    });
    (inc.customCategories || []).forEach(c => { if (!cur.customCategories.some(x => x.id === c.id)) cur.customCategories.push(c); });
    (inc.unlocked || []).forEach(u => { if (!cur.unlocked.includes(u)) cur.unlocked.push(u); });
    return { added, updated };
  }

  // Accepts both the v1 export (a flat state object) and the v2 export (flat state + app/schema/exportedAt).
  function normalizeIncoming(obj) {
    if (!obj || typeof obj !== 'object') throw new Error('ファイルの形式が正しくありません');
    const flat = (obj.data && typeof obj.data === 'object') ? Object.assign({}, obj.data, obj.prefs || {}) : obj;
    if (!('founds' in flat) && !('userEntries' in flat) && !('customCategories' in flat)) {
      throw new Error('駿府みっけ帖のバックアップファイルではないようです');
    }
    return buildState(splitLegacy(flat).data, null);
  }

  /* ============================================================
     STORAGE LAYER
     Primary: IndexedDB (large quota, atomic writes).
     v1 data in localStorage is migrated on first run and LEFT UNTOUCHED as a fallback copy.
  ============================================================ */
  const Store = (() => {
    const DB_NAME = 'mikkecho_db';
    let db = null;
    let mode = 'idb';            // 'idb' | 'localStorage'
    let lastSaveAt = null;
    let lastError = null;
    let queue = Promise.resolve();
    let lsCache = { data: null, prefs: null };   // only used in localStorage fallback mode

    function openDB() {
      return new Promise((resolve, reject) => {
        if (!('indexedDB' in window)) return reject(new Error('IndexedDB is not available'));
        let req;
        try { req = indexedDB.open(DB_NAME, 1); } catch (e) { return reject(e); }
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
          if (!d.objectStoreNames.contains('snapshots')) d.createObjectStore('snapshots');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
        req.onblocked = () => reject(new Error('IndexedDB is blocked'));
      });
    }

    function run(storeNames, rw, work) {
      return new Promise((resolve, reject) => {
        let t;
        try {
          t = db.transaction(storeNames, rw, rw === 'readwrite' ? { durability: 'strict' } : undefined);
        } catch (e) { return reject(e); }
        let result;
        try {
          const r = work(t);
          if (r && typeof r === 'object' && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
        } catch (e) { try { t.abort(); } catch (_) { /* ignore */ } return reject(e); }
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error || new Error('IndexedDB error'));
        t.onabort = () => reject(t.error || new Error('IndexedDB aborted'));
      });
    }
    const kvGet = (key) => run(['kv'], 'readonly', t => t.objectStore('kv').get(key));
    const kvPut = (key, val) => run(['kv'], 'readwrite', t => { t.objectStore('kv').put(val, key); });

    function readLegacyRaw() {
      try { return localStorage.getItem(LEGACY_KEY); } catch (_) { return null; }
    }
    function writeLegacyMerged() {
      const merged = Object.assign({}, lsCache.data || {}, lsCache.prefs || {});
      localStorage.setItem(LEGACY_KEY, JSON.stringify(merged));
    }
    // serialise every write so a later save can never be overtaken by an earlier one
    function enqueue(fn) {
      const p = queue.then(fn);
      queue = p.then(() => {}, () => {});
      return p;
    }

    async function init() {
      try {
        db = await openDB();
        mode = 'idb';
        db.onversionchange = () => { try { db.close(); } catch (_) { /* ignore */ } };
      } catch (e) {
        db = null; mode = 'localStorage'; lastError = 'IndexedDB: ' + describeError(e);
      }
      // ask the browser not to evict our data under storage pressure (best effort)
      try {
        if (navigator.storage && navigator.storage.persist) {
          const already = navigator.storage.persisted ? await navigator.storage.persisted() : false;
          if (!already) await navigator.storage.persist();
        }
      } catch (_) { /* ignore */ }
    }

    // Returns { data, prefs, source }. THROWS if stored data cannot be read — callers must then stop saving.
    async function load() {
      if (mode === 'idb') {
        let data = await kvGet('data');
        let prefs = await kvGet('prefs');
        let source = 'idb';
        if (!data) {
          const raw = readLegacyRaw();
          if (raw) {
            let parsed;
            try { parsed = JSON.parse(raw); } catch (e) { throw new Error('以前の保存データを読み取れませんでした（データ自体は消えていません）'); }
            const split = splitLegacy(parsed);
            await run(['kv'], 'readwrite', t => {
              const s = t.objectStore('kv');
              s.put(Object.assign({ schema: SCHEMA_VERSION, savedAt: Date.now() }, split.data), 'data');
              s.put(split.prefs, 'prefs');
              s.put({ migratedAt: Date.now(), from: 'localStorage' }, 'meta');
            });
            data = split.data; prefs = split.prefs; source = 'migrated';
          }
        }
        return { data: data || null, prefs: prefs || null, source };
      }
      const raw = readLegacyRaw();
      if (!raw) return { data: null, prefs: null, source: 'localStorage' };
      const split = splitLegacy(JSON.parse(raw));
      lsCache = { data: split.data, prefs: split.prefs };
      return { data: split.data, prefs: split.prefs, source: 'localStorage' };
    }

    function saveData(data) {
      return enqueue(async () => {
        try {
          if (mode === 'idb') {
            await kvPut('data', Object.assign({ schema: SCHEMA_VERSION, savedAt: Date.now() }, data));
          } else {
            lsCache.data = JSON.parse(JSON.stringify(data));
            writeLegacyMerged();
          }
          lastSaveAt = Date.now(); lastError = null;
        } catch (e) { lastError = describeError(e); throw e; }
      });
    }
    function savePrefs(prefs) {
      return enqueue(async () => {
        try {
          if (mode === 'idb') {
            await kvPut('prefs', prefs);
          } else {
            lsCache.prefs = Object.assign({}, prefs);
            writeLegacyMerged();
          }
          lastSaveAt = Date.now(); lastError = null;
        } catch (e) { lastError = describeError(e); throw e; }
      });
    }

    /* ---- internal snapshots (auto backups) ---- */
    async function writeSnapshot(slot, label, snapState) {
      if (mode !== 'idb') throw new Error('この環境では自動バックアップを使えません');
      const c = countRecords(snapState.data);
      const meta = { slot, label, createdAt: Date.now(), counts: c };
      await enqueue(() => run(['snapshots', 'kv'], 'readwrite', t => {
        t.objectStore('snapshots').put({ meta, state: snapState }, slot);
        const idxReq = t.objectStore('kv').get('snapIndex');
        idxReq.onsuccess = () => {
          const idx = idxReq.result || {};
          idx[slot] = meta;
          t.objectStore('kv').put(idx, 'snapIndex');
        };
      }));
      return meta;
    }
    async function listSnapshots() {
      if (mode !== 'idb') return [];
      try {
        const idx = (await kvGet('snapIndex')) || {};
        return Object.values(idx).sort((a, b) => b.createdAt - a.createdAt);
      } catch (_) { return []; }
    }
    async function readSnapshot(slot) {
      if (mode !== 'idb') return null;
      const rec = await run(['snapshots'], 'readonly', t => t.objectStore('snapshots').get(slot));
      return rec ? rec.state : null;
    }

    /* ---- drafts (work-in-progress modal input) ---- */
    async function saveDraft(d) { if (mode !== 'idb') return; try { await kvPut('draft', d); } catch (_) { /* best effort */ } }
    async function saveDraftPhotos(p) { if (mode !== 'idb') return; try { await kvPut('draftPhotos', p); } catch (_) { /* best effort */ } }
    async function loadDraft() {
      if (mode !== 'idb') return null;
      try {
        const d = await kvGet('draft');
        if (!d) return null;
        const photos = (await kvGet('draftPhotos')) || [];
        return Object.assign({}, d, { photos });
      } catch (_) { return null; }
    }
    async function clearDraft() {
      if (mode !== 'idb') return;
      try {
        await run(['kv'], 'readwrite', t => { const s = t.objectStore('kv'); s.delete('draft'); s.delete('draftPhotos'); });
      } catch (_) { /* best effort */ }
    }

    async function info() {
      const out = { mode, lastSaveAt, lastError, persisted: null, usage: null, quota: null };
      try { if (navigator.storage && navigator.storage.persisted) out.persisted = await navigator.storage.persisted(); } catch (_) { /* ignore */ }
      try {
        if (navigator.storage && navigator.storage.estimate) {
          const e = await navigator.storage.estimate();
          out.usage = e.usage; out.quota = e.quota;
        }
      } catch (_) { /* ignore */ }
      return out;
    }

    return {
      init, load, saveData, savePrefs, writeSnapshot, listSnapshots, readSnapshot,
      saveDraft, saveDraftPhotos, loadDraft, clearDraft, info, readLegacyRaw,
    };
  })();

  let lastAlertAt = 0;
  function reportSaveFailure(err) {
    console.error('[mikkecho] save failed', err);
    const now = Date.now();
    if (now - lastAlertAt < 8000) return;
    lastAlertAt = now;
    alert('⚠️ データを保存できませんでした。\n\n'
      + '端末の空き容量が少ない可能性があります。入力中の内容は一時保存を試みています。\n'
      + '不要な写真やアプリを整理するか、設定画面の「バックアップを書き出す」を実行してから、もう一度お試しください。\n\n'
      + '(' + describeError(err) + ')');
  }

  // Resolves to true when the data really reached storage, false otherwise (never throws).
  function saveState(opts) {
    opts = opts || {};
    if (blockSaves) return Promise.resolve(false);
    const cnt = countRecords(state).total;
    if (!opts.allowShrink && lastPersistedTotal >= 3 && cnt === 0) {
      reportSaveFailure({ name: '安全装置', message: '記録が0件になる保存を中止しました' });
      return Promise.resolve(false);
    }
    return Store.saveData(pickData(state))
      .then(() => Store.savePrefs(pickPrefs(state)))
      .then(() => { lastPersistedTotal = cnt; return true; }, (e) => { reportSaveFailure(e); return false; });
  }
  function savePrefs() {
    if (blockSaves) return Promise.resolve(false);
    return Store.savePrefs(pickPrefs(state)).then(() => true, (e) => { reportSaveFailure(e); return false; });
  }

  function uid(prefix) { return (prefix || 'id') + '_' + Math.random().toString(36).slice(2, 10); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str == null ? '' : str;
    return d.innerHTML;
  }

  function catIconHTML(cat, sizePx) {
    if (cat.iconImage) {
      return `<img src="${cat.iconImage}" alt="" style="width:${sizePx}px;height:${sizePx}px;object-fit:cover;border-radius:50%;vertical-align:middle;">`;
    }
    return `<span>${cat.icon}</span>`;
  }

  /* ============================================================
     CATEGORY HELPERS
  ============================================================ */
  function allCategories() {
    return PRESET_CATEGORIES.concat(state.customCategories);
  }
  function getCategory(id) {
    return allCategories().find(c => c.id === id);
  }
  function getUserEntries(catId) {
    return state.userEntries[catId] || [];
  }
  function categoryFoundCount(cat) {
    const extra = getUserEntries(cat.id).length;
    if (cat.type === 'checklist') {
      return cat.entries.filter(e => !!state.founds[e.id]).length + extra;
    }
    return extra;
  }
  function categoryTotal(cat) {
    return cat.type === 'checklist' ? cat.entries.length + getUserEntries(cat.id).length : null;
  }
  function categoryComplete(cat) {
    return cat.type === 'checklist' && cat.entries.length > 0 && cat.entries.every(e => !!state.founds[e.id]);
  }

  function totalFoundAll() {
    let n = 0;
    allCategories().forEach(cat => { n += categoryFoundCount(cat); });
    return n;
  }

  // Rank is based only on the fixed preset checklists (プラモニュメント + 町名碑),
  // so it reflects real-world completion rather than free-form extras.
  function presetTotalAll() {
    return PRESET_CATEGORIES.reduce((sum, cat) => sum + cat.entries.length, 0);
  }
  function presetFoundAll() {
    return PRESET_CATEGORIES.reduce((sum, cat) => sum + cat.entries.filter(e => !!state.founds[e.id]).length, 0);
  }

  const RANKS = [
    { pct: 0, name: '見習い探訪家' },
    { pct: 1 / 6, name: '中級探訪家' },
    { pct: 5 / 12, name: '上級探訪家' },
    { pct: 0.75, name: '駿府達人' },
    { pct: 1.0, name: '駿府マスター' },
  ];
  function getRank(count, total) {
    const ratio = total > 0 ? count / total : 0;
    let cur = RANKS[0];
    for (const r of RANKS) { if (ratio >= r.pct) cur = r; }
    return cur;
  }

  /* ============================================================
     ACHIEVEMENTS
  ============================================================ */
  const ACHIEVEMENTS = [
    { id: 'first', icon: '🖋️', name: 'はじめの一句', desc: '最初の一句を詠む',
      check: () => totalFoundAll() >= 1 },
    { id: 'three', icon: '📝', name: '三句詠んだ', desc: '3つ見つけて詠む',
      check: () => totalFoundAll() >= 3 },
    { id: 'ten', icon: '📚', name: '十句詠んだ', desc: '10個見つけて詠む',
      check: () => totalFoundAll() >= 10 },
    { id: 'thirty', icon: '🏯', name: '三十句詠んだ', desc: '30個見つけて詠む',
      check: () => totalFoundAll() >= 30 },
    { id: 'plamonument_complete', icon: '🧩', name: 'プラモニュメント制覇', desc: 'プラモニュメントを全て見つける',
      check: () => categoryComplete(getCategory('plamonument')) },
    { id: 'chomeihi_complete', icon: '🪧', name: '町名碑マスター', desc: '町名碑を全て見つける',
      check: () => categoryComplete(getCategory('chomeihi')) },
    { id: 'own_zukan', icon: '📔', name: '自分だけの図鑑', desc: '新しいテーマを作る',
      check: () => state.customCategories.length >= 1 },
    { id: 'kanzen', icon: '🏆', name: '完全制覇', desc: 'プリセット図鑑をすべて制覇する',
      check: () => categoryComplete(getCategory('plamonument')) && categoryComplete(getCategory('chomeihi')) },
  ];

  function checkAchievements() {
    const newly = [];
    ACHIEVEMENTS.forEach(a => {
      if (!state.unlocked.includes(a.id) && a.check()) {
        state.unlocked.push(a.id);
        newly.push(a);
      }
    });
    if (newly.length) saveState();
    return newly;
  }

  /* ============================================================
     TOAST
  ============================================================ */
  const toastEl = document.getElementById('toast');
  let toastTimer = null;
  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2400);
  }

  let audioCtx = null;
  function getAudioCtx() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) audioCtx = new Ctx();
    }
    return audioCtx;
  }

  function playStampSound() {
    try {
      const ctx = getAudioCtx();
      if (!ctx) return;
      if (ctx.state === 'suspended') ctx.resume();
      const now = ctx.currentTime;

      // low "thud" body
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(190, now);
      osc.frequency.exponentialRampToValueAtTime(55, now + 0.13);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.5, now + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.22);

      // brief noise burst for the "paper" texture
      const bufferSize = Math.floor(ctx.sampleRate * 0.05);
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
      const noise = ctx.createBufferSource();
      noise.buffer = buffer;
      const noiseFilter = ctx.createBiquadFilter();
      noiseFilter.type = 'bandpass';
      noiseFilter.frequency.value = 1300;
      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(0.22, now);
      noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
      noise.connect(noiseFilter).connect(noiseGain).connect(ctx.destination);
      noise.start(now);
    } catch (e) { /* audio unavailable; ignore */ }
  }

  function playHaptic() {
    if (navigator.vibrate) {
      try { navigator.vibrate([12, 20, 30]); } catch (e) { /* ignore */ }
    }
  }

  function playStamp() {
    const el = document.getElementById('stampOverlay');
    el.classList.remove('play');
    void el.offsetWidth; // restart animation
    el.classList.add('play');
    setTimeout(() => el.classList.remove('play'), 700);
    playStampSound();
    playHaptic();
  }

  /* ============================================================
     TOP BAR
  ============================================================ */
  const totalFoundCountEl = document.getElementById('totalFoundCount');
  function renderTopbar() {
    totalFoundCountEl.textContent = totalFoundAll();
  }

  /* ============================================================
     ZUKAN HOME EXTRAS (rank banner / recent find / backup nudge)
  ============================================================ */
  const rankTitleEl = document.getElementById('rankTitle');
  const rankBarFillEl = document.getElementById('rankBarFill');
  const rankCountEl = document.getElementById('rankCount');
  function renderRankBanner() {
    const total = presetTotalAll();
    const found = presetFoundAll();
    const rank = getRank(found, total);
    rankTitleEl.textContent = rank.name;
    rankBarFillEl.style.width = (total ? Math.min(100, (found / total) * 100) : 0) + '%';
    rankCountEl.textContent = `${found} / ${total}`;
  }

  const recentFindCardEl = document.getElementById('recentFindCard');
  function renderRecentFindCard() {
    const finds = buildAllFinds();
    if (!finds.length) {
      recentFindCardEl.style.display = 'none';
      recentFindCardEl.innerHTML = '';
      return;
    }
    const f = finds[0];
    const photo = f.photos && f.photos[0];
    recentFindCardEl.style.display = 'block';
    recentFindCardEl.innerHTML = `
      <div class="recent-card">
        ${photo ? `<img class="recent-thumb" src="${photo}">` : `<div class="recent-thumb">🀆</div>`}
        <div class="recent-body">
          <div class="recent-label">最近の一句・${escapeHtml(f.spotName)}</div>
          <div class="recent-haiku">${escapeHtml(f.haiku || '(一言なし)')}</div>
          <div class="recent-meta">${escapeHtml(f.categoryName)} ・ ${f.date}</div>
        </div>
      </div>
    `;
    recentFindCardEl.querySelector('.recent-card').addEventListener('click', () => openSpotDetail(f.entryId, f.categoryId, f.kind));
  }

  const backupBannerEl = document.getElementById('backupBanner');
  const BACKUP_PROMPT_INTERVAL = 15;
  function shouldShowBackupBanner() {
    return (totalFoundAll() - state.lastBackupPromptCount) >= BACKUP_PROMPT_INTERVAL;
  }
  function renderBackupBanner() {
    backupBannerEl.style.display = shouldShowBackupBanner() ? 'block' : 'none';
  }
  document.getElementById('backupLaterBtn').addEventListener('click', () => {
    state.lastBackupPromptCount = totalFoundAll();
    savePrefs();
    renderBackupBanner();
  });
  document.getElementById('backupDoBtn').addEventListener('click', () => {
    exportData();
  });

  function renderZukanHomeExtras() {
    renderRankBanner();
    renderRecentFindCard();
    renderBackupBanner();
    renderDraftBanner();
  }

  /* ============================================================
     ZUKAN HOME (category list)
  ============================================================ */
  const categoryListEl = document.getElementById('categoryList');
  const zukanHomeEl = document.getElementById('zukanHome');
  const zukanDetailEl = document.getElementById('zukanDetail');
  let currentCategoryId = null;

  function ringSVG(ratio, size) {
    size = size || 44;
    const r = size / 2 - 4;
    const c = 2 * Math.PI * r;
    const offset = c * (1 - ratio);
    return `
      <svg class="progress-ring-svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="var(--paper-200)" stroke-width="4"/>
        <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="var(--vermilion-600)" stroke-width="4"
          stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${offset}"
          transform="rotate(-90 ${size/2} ${size/2})"/>
      </svg>`;
  }

  function renderCategoryList() {
    categoryListEl.innerHTML = '';
    allCategories().forEach(cat => {
      const found = categoryFoundCount(cat);
      const total = categoryTotal(cat);
      const card = document.createElement('div');
      card.className = 'cat-card';
      const progressText = cat.type === 'checklist'
        ? `${found} / ${total} 発見`
        : `${found} 個 集めた`;
      const ring = cat.type === 'checklist' ? ringSVG(total ? found / total : 0) :
        `<div style="width:44px;height:44px;border-radius:50%;background:var(--paper-200);display:flex;align-items:center;justify-content:center;font-size:14px;color:var(--indigo-700);font-weight:700;">${found}</div>`;
      card.innerHTML = `
        <div class="cat-icon">${catIconHTML(cat, 44)}</div>
        <div class="cat-meta">
          <div class="cat-name">${escapeHtml(cat.name)}</div>
          <div class="cat-progress-text">${progressText}</div>
        </div>
        <div class="ring">${ring}</div>
        <div class="chev">›</div>
      `;
      card.addEventListener('click', () => openCategoryDetail(cat.id));
      categoryListEl.appendChild(card);
    });
  }

  function openCategoryDetail(catId) {
    currentCategoryId = catId;
    currentSpotQuery = '';
    spotSearchInput.value = '';
    zukanHomeEl.style.display = 'none';
    zukanDetailEl.style.display = 'block';
    renderCategoryDetail();
  }
  function goZukanHome() {
    zukanDetailEl.style.display = 'none';
    zukanHomeEl.style.display = 'block';
    renderCategoryList();
    renderZukanHomeExtras();
  }
  document.getElementById('backToZukanHome').addEventListener('click', goZukanHome);

  const detailCategoryNameEl = document.getElementById('detailCategoryName');
  const detailProgressHintEl = document.getElementById('detailProgressHint');
  const spotGridEl = document.getElementById('spotGrid');
  const sortToggleEl = document.getElementById('sortToggle');
  const spotSearchInput = document.getElementById('spotSearchInput');
  const spotSearchEmptyEl = document.getElementById('spotSearchEmpty');
  const spotSearchEmptyQueryEl = document.getElementById('spotSearchEmptyQuery');
  let currentSortMode = 'name'; // 'name' | 'found_date'
  let currentSpotQuery = '';

  sortToggleEl.querySelectorAll('.sort-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentSortMode = btn.dataset.sort;
      sortToggleEl.querySelectorAll('.sort-btn').forEach(b => b.classList.toggle('active', b === btn));
      renderCategoryDetail();
    });
  });
  spotSearchInput.addEventListener('input', () => {
    currentSpotQuery = spotSearchInput.value.trim();
    renderCategoryDetail();
  });

  function buildDisplayItems(cat) {
    const items = [];
    if (cat.type === 'checklist') {
      cat.entries.forEach(entry => {
        items.push({ kind: 'preset', entry, rec: state.founds[entry.id] || null });
      });
    }
    getUserEntries(cat.id).forEach(entry => {
      items.push({ kind: 'user', entry, rec: entry });
    });
    return items;
  }

  function filterDisplayItems(items, query) {
    if (!query) return items;
    const q = query.toLowerCase();
    return items.filter(item => item.entry.name.toLowerCase().includes(q));
  }

  function sortDisplayItems(items, mode) {
    const arr = items.slice();
    if (mode === 'found_date') {
      arr.sort((a, b) => {
        const at = a.rec ? (a.rec.ts || 0) : -1;
        const bt = b.rec ? (b.rec.ts || 0) : -1;
        return bt - at;
      });
    } else {
      arr.sort((a, b) => a.entry.name.localeCompare(b.entry.name, 'ja'));
    }
    return arr;
  }

  function renderCategoryDetail() {
    const cat = getCategory(currentCategoryId);
    if (!cat) return;
    detailCategoryNameEl.innerHTML = `${catIconHTML(cat, 22)} ${escapeHtml(cat.name)}`;
    const found = categoryFoundCount(cat);
    detailProgressHintEl.textContent = cat.type === 'checklist'
      ? `${found} / ${cat.entries.length} 発見`
      : `${found} 個のコレクション`;

    spotGridEl.innerHTML = '';

    function showHintToast(hint) {
      showToast(hint ? '📍 ' + hint : '住所の登録はありません');
    }

    const filtered = filterDisplayItems(buildDisplayItems(cat), currentSpotQuery);
    const items = sortDisplayItems(filtered, currentSortMode);

    spotSearchEmptyEl.style.display = (currentSpotQuery && items.length === 0) ? 'block' : 'none';
    spotGridEl.style.display = (currentSpotQuery && items.length === 0) ? 'none' : 'grid';
    if (spotSearchEmptyQueryEl) spotSearchEmptyQueryEl.textContent = currentSpotQuery;

    items.forEach(item => {
      const { kind, entry, rec } = item;
      const card = document.createElement('div');
      if (kind === 'preset' && !rec) {
        card.className = 'spot-card undiscovered';
        card.innerHTML = `
             <div class="thumb">❔</div>
             ${entry.hint ? `<button class="hint-btn" style="position:absolute;top:4px;left:4px;width:22px;height:22px;border-radius:50%;border:none;background:rgba(43,58,85,0.85);color:#fff;font-size:11px;cursor:pointer;">📍</button>` : ''}
             <div class="spot-name">${escapeHtml(entry.name)}</div>`;
        card.addEventListener('click', () => openFindModal({ mode: 'checklist', entryId: entry.id, categoryId: cat.id, name: entry.name, hint: entry.hint }));
        const hintBtn = card.querySelector('.hint-btn');
        if (hintBtn) hintBtn.addEventListener('click', (ev) => { ev.stopPropagation(); showHintToast(entry.hint); });
      } else {
        card.className = 'spot-card found';
        card.innerHTML = `
             ${rec.photos && rec.photos[0] ? `<img class="thumb" src="${rec.photos[0]}">` : `<div class="thumb">🀆</div>`}
             <span class="stamp-badge">✓</span>
             <div class="spot-name">${escapeHtml(entry.name)}</div>`;
        card.addEventListener('click', () => openSpotDetail(entry.id, cat.id, kind));
      }
      spotGridEl.appendChild(card);
    });

    const addCard = document.createElement('div');
    addCard.className = 'free-entry-add';
    addCard.textContent = '＋';
    addCard.title = cat.type === 'checklist' ? '見つけたものを追加' : '新しく見つけたものを追加';
    addCard.addEventListener('click', () => openFindModal({ mode: 'user_extra', categoryId: cat.id }));
    spotGridEl.appendChild(addCard);
  }

  /* ============================================================
     FIND / ADD MODAL
  ============================================================ */
  const findModalBackdrop = document.getElementById('findModalBackdrop');
  const findModalTitle = document.getElementById('findModalTitle');
  const findModalHint = document.getElementById('findModalHint');
  const freeNameField = document.getElementById('freeNameField');
  const freeNameInput = document.getElementById('freeNameInput');
  const photoGrid = document.getElementById('photoGrid');
  const photoInput = document.getElementById('photoInput');
  const haikuInput = document.getElementById('haikuInput');
  const findSaveBtn = document.getElementById('findSaveBtn');
  let findContext = null;
  let findSession = 0;            // bumps every time the modal opens, so late async work can tell it is stale
  let pendingPhotos = [];
  let photoJobs = 0;              // photos still being resized
  let photoBatches = [];          // promises of in-flight resize batches
  let savingFind = false;
  const MAX_PHOTOS = 6;

  /* ---- drafts: whatever is typed/attached is kept, so a killed or reloaded app does not lose it ---- */
  let currentDraft = null;        // { key, ctxMeta, haiku, name, photos, photosSaved, updatedAt }
  let draftTimer = null;
  let photosTouched = false;      // true once the photo list of this session was written to the draft

  function ctxKey(ctx) {
    return [ctx.mode, ctx.categoryId || '', ctx.entryId || '', (ctx.editRecord && ctx.editRecord.id) || '', ctx.editRecord ? 'e' : 'n'].join('|');
  }
  function ctxMetaOf(ctx) {
    return { mode: ctx.mode, categoryId: ctx.categoryId, entryId: ctx.entryId || null, editId: (ctx.editRecord && ctx.editRecord.id) || null, isEdit: !!ctx.editRecord };
  }
  function rebuildCtx(meta) {
    if (!meta) return null;
    const cat = getCategory(meta.categoryId);
    if (!cat) return null;
    if (meta.mode === 'checklist') {
      const entry = (cat.entries || []).find(e => e.id === meta.entryId);
      if (!entry) return null;
      return { mode: 'checklist', entryId: entry.id, categoryId: cat.id, name: entry.name, hint: entry.hint, editRecord: state.founds[entry.id] || null };
    }
    if (meta.isEdit && meta.editId) {
      const rec = getUserEntries(cat.id).find(e => e.id === meta.editId);
      if (!rec) return null;
      return { mode: 'user_extra', categoryId: cat.id, editRecord: rec };
    }
    return { mode: 'user_extra', categoryId: cat.id, editRecord: null };
  }
  function draftHasContent() {
    return !!(haikuInput.value.trim() || freeNameInput.value.trim() || pendingPhotos.length);
  }
  function flushDraft() {
    clearTimeout(draftTimer);
    if (!findContext) return;
    const key = ctxKey(findContext);
    const sameDraft = currentDraft && currentDraft.key === key;
    if (!draftHasContent() && !sameDraft) return;
    currentDraft = {
      key, ctxMeta: ctxMetaOf(findContext),
      haiku: haikuInput.value, name: freeNameInput.value,
      photos: pendingPhotos.slice(), photosSaved: photosTouched, updatedAt: Date.now(),
    };
    Store.saveDraft({ key, ctxMeta: currentDraft.ctxMeta, haiku: currentDraft.haiku, name: currentDraft.name, photosSaved: photosTouched, updatedAt: currentDraft.updatedAt });
  }
  function scheduleDraftSave() {
    if (!findContext) return;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(flushDraft, 400);
  }
  function savePhotosDraft() {
    if (!findContext) return;
    photosTouched = true;
    Store.saveDraftPhotos(pendingPhotos.slice());
    flushDraft();
  }
  function clearDraft() {
    clearTimeout(draftTimer);
    currentDraft = null;
    Store.clearDraft();
  }
  function discardDraftIfCurrent() {
    if (currentDraft && findContext && currentDraft.key === ctxKey(findContext)) clearDraft();
  }

  const draftBannerEl = document.getElementById('draftBanner');
  function renderDraftBanner() {
    const d = currentDraft;
    const fresh = d && (Date.now() - (d.updatedAt || 0) < 7 * 24 * 3600 * 1000);
    const hasContent = d && ((d.haiku || '').trim() || (d.name || '').trim() || (d.photosSaved && d.photos && d.photos.length));
    const ctx = (fresh && hasContent && !findContext) ? rebuildCtx(d.ctxMeta) : null;
    if (!ctx) { draftBannerEl.style.display = 'none'; return; }
    document.getElementById('draftBannerName').textContent = ctx.name || (ctx.editRecord && ctx.editRecord.name) || '新しい記録';
    draftBannerEl.style.display = 'block';
  }
  document.getElementById('draftResumeBtn').addEventListener('click', () => {
    if (!currentDraft) return;
    const ctx = rebuildCtx(currentDraft.ctxMeta);
    if (!ctx) { clearDraft(); renderDraftBanner(); return; }
    openFindModal(ctx);
  });
  document.getElementById('draftDiscardBtn').addEventListener('click', () => {
    if (!confirm('入力途中の内容を破棄しますか？')) return;
    clearDraft();
    renderDraftBanner();
  });

  function updateSaveBtnState() {
    const editing = !!(findContext && findContext.editRecord);
    findSaveBtn.disabled = photoJobs > 0 || savingFind;
    findSaveBtn.textContent = photoJobs > 0 ? '写真を処理中…' : (savingFind ? '保存中…' : (editing ? '更新する' : '記録する'));
  }

  function renderPhotoGrid() {
    photoGrid.innerHTML = '';
    pendingPhotos.forEach((src, idx) => {
      const tile = document.createElement('div');
      tile.className = 'photo-thumb';
      tile.innerHTML = `<img src="${src}"><button type="button" class="remove-btn">×</button>`;
      tile.querySelector('.remove-btn').addEventListener('click', () => {
        pendingPhotos.splice(idx, 1);
        renderPhotoGrid();
        savePhotosDraft();
      });
      photoGrid.appendChild(tile);
    });
    if (photoJobs > 0) {
      const busy = document.createElement('div');
      busy.className = 'photo-add-tile busy';
      busy.innerHTML = `<span class="icon">⏳</span><span>処理中…</span>`;
      photoGrid.appendChild(busy);
    }
    if (pendingPhotos.length + photoJobs < MAX_PHOTOS) {
      const addTile = document.createElement('button');
      addTile.type = 'button';
      addTile.className = 'photo-add-tile';
      addTile.innerHTML = `<span class="icon">📷</span><span>${pendingPhotos.length ? '追加' : '撮る・選ぶ'}</span>`;
      addTile.addEventListener('click', () => {
        savePhotosDraft();   // the OS may kill the app while the camera/gallery is open — keep what we have
        photoInput.click();
      });
      photoGrid.appendChild(addTile);
    }
  }

  function openFindModal(ctx) {
    findContext = ctx;
    findSession++;
    photoJobs = 0;
    photoBatches = [];
    savingFind = false;
    const key = ctxKey(ctx);
    const useDraft = !!(currentDraft && currentDraft.key === key);
    const rec = ctx.editRecord;
    haikuInput.value = useDraft ? (currentDraft.haiku || '') : (rec ? (rec.haiku || '') : '');
    freeNameInput.value = useDraft ? (currentDraft.name || '') : (rec ? (rec.name || '') : '');
    if (useDraft && currentDraft.photosSaved) {
      pendingPhotos = (currentDraft.photos || []).slice();
      photosTouched = true;
    } else {
      pendingPhotos = rec && rec.photos ? rec.photos.slice() : [];
      photosTouched = false;
    }
    renderPhotoGrid();

    if (ctx.mode === 'checklist') {
      findModalTitle.textContent = rec ? `${ctx.name} を編集` : ctx.name;
      findModalHint.textContent = ctx.hint ? '📍 ' + ctx.hint : '';
      freeNameField.style.display = 'none';
    } else {
      findModalTitle.textContent = rec ? '記録を編集' : '新しく見つけた';
      findModalHint.textContent = rec ? '' : 'この図鑑に追加します';
      freeNameField.style.display = 'block';
    }
    updateSaveBtnState();
    findModalBackdrop.classList.add('open');
    renderDraftBanner();
    if (useDraft) showToast('入力途中の内容を復元しました');
  }
  function closeFindModal() {
    clearTimeout(draftTimer);
    findModalBackdrop.classList.remove('open');
    findContext = null;
    findSession++;               // anything still running for the old session is now ignored
    pendingPhotos = [];
    photoJobs = 0;
    photoBatches = [];
    savingFind = false;
    updateSaveBtnState();
    renderDraftBanner();
  }
  // "キャンセル" means "throw this input away"; the Android back button / app switch keep it as a draft.
  document.getElementById('findCancelBtn').addEventListener('click', () => {
    discardDraftIfCurrent();
    closeFindModal();
  });
  // Tapping the dim area must NOT close the form: a stray tap (e.g. when returning from the camera) used to wipe the input.
  haikuInput.addEventListener('input', scheduleDraftSave);
  freeNameInput.addEventListener('input', scheduleDraftSave);

  function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve({ img, url });
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
      img.src = url;
    });
  }
  async function readAndCompress(file, maxDim, quality) {
    const { img, url } = await loadImageFromFile(file);
    try {
      let width = img.naturalWidth, height = img.naturalHeight;
      if (width > maxDim || height > maxDim) {
        if (width > height) { height = Math.round(height * maxDim / width); width = maxDim; }
        else { width = Math.round(width * maxDim / height); height = maxDim; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      return canvas.toDataURL('image/jpeg', quality);
    } finally {
      URL.revokeObjectURL(url);
      img.src = '';
    }
  }

  photoInput.addEventListener('change', () => {
    const files = Array.from(photoInput.files || []);
    photoInput.value = '';
    if (!files.length || !findContext) return;
    const session = findSession;
    const room = Math.max(0, MAX_PHOTOS - pendingPhotos.length - photoJobs);
    const toProcess = files.slice(0, room);
    if (files.length > toProcess.length) showToast(`写真は1件につき最大${MAX_PHOTOS}枚までです`);
    if (!toProcess.length) return;
    photoJobs += toProcess.length;
    renderPhotoGrid();
    updateSaveBtnState();
    // one photo at a time keeps memory low (big camera photos used to crash low-memory phones)
    const batch = (async () => {
      for (const file of toProcess) {
        let dataUrl = null;
        try { dataUrl = await readAndCompress(file, 900, 0.72); }
        catch (e) { if (session === findSession) showToast('この写真は読み込めませんでした'); }
        if (session !== findSession) return;   // modal was closed meanwhile
        if (dataUrl) pendingPhotos.push(dataUrl);
        photoJobs--;
        renderPhotoGrid();
        updateSaveBtnState();
      }
      savePhotosDraft();
    })();
    photoBatches.push(batch);
  });

  findSaveBtn.addEventListener('click', async () => {
    if (!findContext || savingFind || photoJobs > 0) return;
    const ctx = findContext;
    const session = findSession;
    const haiku = haikuInput.value.trim();
    const isEdit = !!ctx.editRecord;
    const now = Date.now();
    let name = null;
    if (ctx.mode !== 'checklist') {
      name = freeNameInput.value.trim();
      if (!name) { freeNameInput.focus(); return; }
    }

    savingFind = true;
    updateSaveBtnState();
    let rollback = () => {};
    let saved = false;
    try {
      const photos = pendingPhotos.slice();
      if (ctx.mode === 'checklist') {
        const prev = state.founds[ctx.entryId];
        state.founds[ctx.entryId] = {
          photos, haiku,
          date: prev ? prev.date : todayStr(),
          ts: prev ? prev.ts : now,
          updatedAt: now,
          categoryId: ctx.categoryId,
        };
        rollback = () => { if (prev) state.founds[ctx.entryId] = prev; else delete state.founds[ctx.entryId]; };
      } else {
        const catId = ctx.categoryId;
        if (!state.userEntries[catId]) state.userEntries[catId] = [];
        const list = state.userEntries[catId];
        if (isEdit) {
          const rec = list.find(e => e.id === ctx.editRecord.id);
          if (rec) {
            const old = { name: rec.name, photos: rec.photos, haiku: rec.haiku, updatedAt: rec.updatedAt };
            rec.name = name; rec.photos = photos; rec.haiku = haiku; rec.updatedAt = now;
            rollback = () => { Object.assign(rec, old); if (old.updatedAt === undefined) delete rec.updatedAt; };
          }
        } else {
          const entry = { id: uid('ue'), name, photos, haiku, date: todayStr(), ts: now, updatedAt: now };
          list.push(entry);
          rollback = () => { const i = list.indexOf(entry); if (i >= 0) list.splice(i, 1); };
        }
      }
      saved = await saveState();
      if (!saved) {
        // not persisted → undo the in-memory change and KEEP the form open with everything still filled in
        rollback();
        renderAll();
        flushDraft();
        showToast('保存できなかったため、入力内容はそのまま残しています');
      }
    } finally {
      savingFind = false;
      updateSaveBtnState();
    }
    if (!saved) return;

    clearDraft();
    if (findContext === ctx && session === findSession) closeFindModal();
    if (!isEdit) playStamp();
    const newly = checkAchievements();
    renderAll();
    if (newly.length) {
      showToast(`称号「${newly[0].name}」を獲得しました 🎖️`);
    } else {
      showToast(isEdit ? '更新しました 🖋️' : '記録しました 🖋️');
    }
  });

  /* ============================================================
     SPOT DETAIL MODAL (view found)
  ============================================================ */
  const spotDetailBackdrop = document.getElementById('spotDetailBackdrop');
  const spotDetailName = document.getElementById('spotDetailName');
  const spotDetailHint = document.getElementById('spotDetailHint');
  const spotDetailBody = document.getElementById('spotDetailBody');
  const spotDeleteBtn = document.getElementById('spotDeleteBtn');
  const spotEditBtn = document.getElementById('spotEditBtn');
  let spotDetailCtx = null;

  function openSpotDetail(entryId, categoryId, kind) {
    // kind: 'preset' (checklist preset entry, found) | 'user' (user-added entry)
    const cat = getCategory(categoryId);
    let entry, rec;
    if (kind === 'user') {
      entry = getUserEntries(categoryId).find(e => e.id === entryId);
      rec = entry;
    } else {
      entry = cat.entries.find(e => e.id === entryId);
      rec = state.founds[entryId];
    }
    spotDetailCtx = { entryId, categoryId, kind, entry, rec };
    spotDetailName.textContent = entry.name;
    spotDetailHint.textContent = (kind === 'preset' && entry.hint) ? '📍 ' + entry.hint : '';
    const photos = rec.photos || [];
    spotDetailBody.innerHTML = `
      ${photos.length ? `<div class="detail-photo-scroll">${photos.map(p => `<img src="${p}">`).join('')}</div>` : ''}
      <div class="detail-haiku">${escapeHtml(rec.haiku || '(一言なし)')}</div>
      <div class="detail-meta">${rec.date} に記録</div>
    `;
    spotDetailBackdrop.classList.add('open');
  }
  document.getElementById('spotCloseBtn').addEventListener('click', () => spotDetailBackdrop.classList.remove('open'));
  spotDetailBackdrop.addEventListener('click', (e) => { if (e.target === spotDetailBackdrop) spotDetailBackdrop.classList.remove('open'); });

  spotEditBtn.addEventListener('click', () => {
    if (!spotDetailCtx) return;
    const { kind, categoryId, entryId, entry, rec } = spotDetailCtx;
    spotDetailBackdrop.classList.remove('open');
    if (kind === 'preset') {
      openFindModal({ mode: 'checklist', entryId, categoryId, name: entry.name, hint: entry.hint, editRecord: rec });
    } else {
      openFindModal({ mode: 'user_extra', categoryId, editRecord: rec });
    }
  });

  spotDeleteBtn.addEventListener('click', async () => {
    if (!spotDetailCtx) return;
    if (!confirm('この記録を削除しますか？（写真も一緒に消えます）')) return;
    const { entryId, categoryId, kind } = spotDetailCtx;
    let rollback;
    if (kind === 'user') {
      const prevList = getUserEntries(categoryId).slice();
      state.userEntries[categoryId] = prevList.filter(e => e.id !== entryId);
      rollback = () => { state.userEntries[categoryId] = prevList; };
    } else {
      const prev = state.founds[entryId];
      delete state.founds[entryId];
      rollback = () => { if (prev) state.founds[entryId] = prev; };
    }
    const ok = await saveState({ allowShrink: true });
    if (!ok) { rollback(); renderAll(); showToast('削除を保存できなかったため、元に戻しました'); return; }
    spotDetailBackdrop.classList.remove('open');
    renderAll();
    showToast('削除しました');
  });

  /* ============================================================
     ADD CATEGORY MODAL
  ============================================================ */
  const categoryModalBackdrop = document.getElementById('categoryModalBackdrop');
  const categoryNameInput = document.getElementById('categoryNameInput');
  const categoryEmojiRow = document.getElementById('categoryEmojiRow');
  let selectedCatEmoji = CATEGORY_EMOJIS[0];

  function buildCategoryEmojiRow() {
    categoryEmojiRow.innerHTML = '';
    CATEGORY_EMOJIS.forEach(em => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'emoji-swatch' + (em === selectedCatEmoji ? ' selected' : '');
      btn.style.cssText = 'width:38px;height:38px;border-radius:12px;border:1.5px solid var(--line);background:var(--bg);font-size:18px;cursor:pointer;';
      if (em === selectedCatEmoji) btn.style.borderColor = 'var(--indigo-700)';
      btn.textContent = em;
      btn.addEventListener('click', () => { selectedCatEmoji = em; buildCategoryEmojiRow(); });
      categoryEmojiRow.appendChild(btn);
    });
  }

  document.getElementById('openAddCategory').addEventListener('click', () => {
    categoryNameInput.value = '';
    selectedCatEmoji = CATEGORY_EMOJIS[state.customCategories.length % CATEGORY_EMOJIS.length];
    buildCategoryEmojiRow();
    categoryModalBackdrop.classList.add('open');
    setTimeout(() => categoryNameInput.focus(), 150);
  });
  document.getElementById('categoryCancelBtn').addEventListener('click', () => categoryModalBackdrop.classList.remove('open'));
  categoryModalBackdrop.addEventListener('click', (e) => { if (e.target === categoryModalBackdrop) categoryModalBackdrop.classList.remove('open'); });

  document.getElementById('categorySaveBtn').addEventListener('click', () => {
    const name = categoryNameInput.value.trim();
    if (!name) { categoryNameInput.focus(); return; }
    state.customCategories.push({ id: uid('cc'), name, icon: selectedCatEmoji, type: 'free', entries: [] });
    saveState();
    categoryModalBackdrop.classList.remove('open');
    const newly = checkAchievements();
    renderAll();
    showToast('新しい図鑑を作りました');
  });

  /* ============================================================
     句集 (ANTHOLOGY)
  ============================================================ */
  const kushuListEl = document.getElementById('kushuList');
  const kushuEmptyEl = document.getElementById('kushuEmpty');
  const kushuCountHintEl = document.getElementById('kushuCountHint');
  const kushuSearchInput = document.getElementById('kushuSearchInput');
  const kushuFilterRowEl = document.getElementById('kushuFilterRow');
  const kushuSearchEmptyEl = document.getElementById('kushuSearchEmpty');
  let kushuQuery = '';
  let kushuFilterCategoryId = 'all';

  kushuSearchInput.addEventListener('input', () => {
    kushuQuery = kushuSearchInput.value.trim();
    renderKushu();
  });

  function buildAllFinds() {
    const list = [];
    allCategories().forEach(cat => {
      if (cat.type === 'checklist') {
        cat.entries.forEach(entry => {
          const rec = state.founds[entry.id];
          if (rec) list.push({ spotName: entry.name, categoryName: cat.name, categoryId: cat.id, entryId: entry.id, kind: 'preset', ...rec });
        });
      }
      getUserEntries(cat.id).forEach(entry => {
        list.push({ spotName: entry.name, categoryName: cat.name, categoryId: cat.id, entryId: entry.id, kind: 'user', ...entry });
      });
    });
    list.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return list;
  }

  function renderKushuFilterRow() {
    const cats = allCategories().filter(cat => categoryFoundCount(cat) > 0);
    kushuFilterRowEl.innerHTML = '';
    if (!cats.length) { kushuFilterRowEl.style.display = 'none'; return; }
    kushuFilterRowEl.style.display = 'flex';
    const allBtn = document.createElement('button');
    allBtn.className = 'kushu-filter-btn' + (kushuFilterCategoryId === 'all' ? ' active' : '');
    allBtn.textContent = 'すべて';
    allBtn.addEventListener('click', () => { kushuFilterCategoryId = 'all'; renderKushu(); });
    kushuFilterRowEl.appendChild(allBtn);
    cats.forEach(cat => {
      const btn = document.createElement('button');
      btn.className = 'kushu-filter-btn' + (kushuFilterCategoryId === cat.id ? ' active' : '');
      btn.innerHTML = `${catIconHTML(cat, 16)} ${escapeHtml(cat.name)}`;
      btn.addEventListener('click', () => { kushuFilterCategoryId = cat.id; renderKushu(); });
      kushuFilterRowEl.appendChild(btn);
    });
  }

  function renderKushu() {
    renderKushuFilterRow();
    let finds = buildAllFinds();
    const totalCount = finds.length;

    if (kushuFilterCategoryId !== 'all') {
      finds = finds.filter(f => f.categoryId === kushuFilterCategoryId);
    }
    if (kushuQuery) {
      const q = kushuQuery.toLowerCase();
      finds = finds.filter(f =>
        (f.spotName || '').toLowerCase().includes(q) ||
        (f.haiku || '').toLowerCase().includes(q)
      );
    }

    kushuListEl.innerHTML = '';
    kushuCountHintEl.textContent = totalCount ? `${totalCount} 句` : '';
    kushuEmptyEl.style.display = totalCount ? 'none' : 'block';
    const noMatchButHasFinds = totalCount > 0 && finds.length === 0;
    kushuSearchEmptyEl.style.display = noMatchButHasFinds ? 'block' : 'none';
    kushuListEl.style.display = noMatchButHasFinds ? 'none' : 'block';

    finds.forEach(f => {
      const photos = f.photos || [];
      const card = document.createElement('div');
      card.className = 'haiku-card';
      card.innerHTML = `
        ${photos.length ? `<img class="photo" src="${photos[0]}">` : `<div class="photo-placeholder">🀆</div>`}
        ${photos.length > 1 ? `<span class="photo-count-badge">📷 ${photos.length}</span>` : ''}
        <div class="body">
          <div class="spot-name">${escapeHtml(f.spotName)}</div>
          <div class="haiku-text">${escapeHtml(f.haiku || '(一言なし)')}</div>
          <div class="meta-row">
            <span class="tag">${escapeHtml(f.categoryName)}</span>
            <span class="date">${f.date}</span>
          </div>
        </div>
      `;
      card.style.cursor = 'pointer';
      card.addEventListener('click', () => openSpotDetail(f.entryId, f.categoryId, f.kind));
      kushuListEl.appendChild(card);
    });
  }

  /* ============================================================
     実績 (BADGES)
  ============================================================ */
  const badgeGridEl = document.getElementById('badgeGrid');
  const badgeCountHintEl = document.getElementById('badgeCountHint');
  function renderBadges() {
    badgeGridEl.innerHTML = '';
    ACHIEVEMENTS.forEach(a => {
      const unlocked = state.unlocked.includes(a.id);
      const el = document.createElement('div');
      el.className = 'badge' + (unlocked ? ' unlocked' : '');
      el.innerHTML = `<div class="icon">${a.icon}</div><div class="name">${a.name}</div><div class="desc">${a.desc}</div>`;
      badgeGridEl.appendChild(el);
    });
    badgeCountHintEl.textContent = `${state.unlocked.length} / ${ACHIEVEMENTS.length}`;
  }

  /* ============================================================
     SETTINGS
  ============================================================ */
  function formatDateTime(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function exportData() {
    try {
      const payload = Object.assign({ app: 'mikkecho', schema: SCHEMA_VERSION, exportedAt: new Date().toISOString() }, state);
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `mikkecho_${todayStr()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) {
      alert('書き出しに失敗しました。\n(' + describeError(e) + ')');
      return;
    }
    state.lastBackupPromptCount = totalFoundAll();
    savePrefs();
    renderBackupBanner();
    showToast('バックアップを書き出しました');
  }
  document.getElementById('exportBtn').addEventListener('click', exportData);

  /* ---- import (restore) ---- */
  const importBackdrop = document.getElementById('importBackdrop');
  const importSummaryEl = document.getElementById('importSummary');
  const importFileInput = document.getElementById('importFileInput');
  importSummaryEl.style.whiteSpace = 'pre-line';
  let pendingImport = null;   // { incoming, label }

  function closeImportDialog() { importBackdrop.classList.remove('open'); }
  function openImportDialog(incoming, label) {
    pendingImport = { incoming, label };
    const c = countRecords(incoming);
    importSummaryEl.textContent = `${label}\n発見 ${c.found} 件 ・ 追加した記録 ${c.user} 件 ・ 写真 ${c.photos} 枚`;
    importBackdrop.classList.add('open');
  }
  document.getElementById('importBtn').addEventListener('click', () => importFileInput.click());
  importFileInput.addEventListener('change', async () => {
    const file = importFileInput.files && importFileInput.files[0];
    importFileInput.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      openImportDialog(normalizeIncoming(JSON.parse(text)), `ファイル: ${file.name}`);
    } catch (e) {
      alert('読み込めませんでした。\n' + (e && e.message ? e.message : describeError(e)));
    }
  });
  document.getElementById('importCancelBtn').addEventListener('click', () => { pendingImport = null; closeImportDialog(); });
  document.getElementById('importMergeBtn').addEventListener('click', () => applyImport('merge'));
  document.getElementById('importReplaceBtn').addEventListener('click', () => applyImport('replace'));

  async function applyImport(kind) {
    if (!pendingImport) return;
    const { incoming } = pendingImport;
    if (kind === 'replace' && !confirm('今のデータは、取り込む内容で置き換えられます。\n（直前の状態は自動で残ります）よろしいですか？')) return;
    pendingImport = null;
    closeImportDialog();
    try {
      await Store.writeSnapshot('pre-change', '操作直前の状態', { data: pickData(state), prefs: pickPrefs(state) });
    } catch (e) {
      alert('安全のための事前バックアップを作れなかったため、読み込みを中止しました。\n先に「バックアップを書き出す」を実行してください。\n(' + describeError(e) + ')');
      return;
    }
    const prev = state;
    let summary;
    if (kind === 'merge') {
      const next = clone(prev);
      const r = mergeData(next, incoming);
      state = next;
      summary = `${r.added}件を追加、${r.updated}件を更新しました`;
    } else {
      state = buildState(pickData(incoming), pickPrefs(prev));
      summary = 'バックアップの内容に置き換えました';
    }
    const ok = await saveState({ allowShrink: true });
    if (!ok) { state = prev; renderAll(); showToast('保存できなかったため、元の状態に戻しました'); return; }
    checkAchievements();
    renderAll();
    renderSettingsData();
    showToast(summary);
  }

  document.getElementById('legacyRestoreBtn').addEventListener('click', () => {
    try {
      const raw = Store.readLegacyRaw();
      if (!raw) { showToast('旧バージョンのデータは見つかりませんでした'); return; }
      openImportDialog(normalizeIncoming(JSON.parse(raw)), '旧バージョンの保存データ');
    } catch (e) {
      alert('読み込めませんでした。\n' + describeError(e));
    }
  });

  /* ---- internal snapshots (auto backups) ---- */
  async function restoreSnapshot(slot, label, createdAt) {
    if (!confirm(`「${label}」(${formatDateTime(createdAt)})の状態に戻します。\n今のデータは「操作直前の状態」として自動で残るので、あとから戻すこともできます。よろしいですか？`)) return;
    try {
      const snap = await Store.readSnapshot(slot);   // read BEFORE we overwrite the 'pre-change' slot
      if (!snap) throw new Error('バックアップを読み込めませんでした');
      await Store.writeSnapshot('pre-change', '操作直前の状態', { data: pickData(state), prefs: pickPrefs(state) });
      const prev = state;
      state = buildState(snap.data, pickPrefs(prev));
      const ok = await saveState({ allowShrink: true });
      if (!ok) { state = prev; renderAll(); throw new Error('保存に失敗しました'); }
      renderAll();
      renderSettingsData();
      showToast('バックアップから復元しました');
    } catch (e) {
      alert('復元できませんでした。\n' + describeError(e));
    }
  }

  async function renderSnapshotList() {
    const wrap = document.getElementById('snapshotList');
    const list = await Store.listSnapshots();
    wrap.innerHTML = '';
    if (!list.length) {
      wrap.innerHTML = '<div class="empty-state" style="padding:14px;">まだ自動バックアップはありません。アプリを開いてしばらくすると自動で作られます。</div>';
      return;
    }
    list.forEach(m => {
      const row = document.createElement('div');
      row.className = 'settings-row snap-row';
      row.innerHTML = `
        <div>
          <div class="label">${escapeHtml(m.label)}</div>
          <div class="desc">${formatDateTime(m.createdAt)} ・ 記録${m.counts.total}件 / 写真${m.counts.photos}枚</div>
        </div>
        <button class="snap-restore-btn">戻す</button>`;
      row.querySelector('button').addEventListener('click', () => restoreSnapshot(m.slot, m.label, m.createdAt));
      wrap.appendChild(row);
    });
  }

  async function renderStorageStatus() {
    const el = document.getElementById('storageStatus');
    const info = await Store.info();
    const c = countRecords(state);
    const mb = (n) => (n == null ? '不明' : (n / 1048576).toFixed(1) + ' MB');
    const rows = [
      ['保存方式', info.mode === 'idb' ? 'IndexedDB（大容量）' : 'localStorage（容量小・非推奨）', info.mode === 'idb' ? '' : 'warn'],
      ['データ保護', info.persisted == null ? '不明' : (info.persisted ? '有効' : '未許可（端末の空きが少ないと消える可能性）'), info.persisted === false ? 'warn' : ''],
      ['使用量', `${mb(info.usage)} / ${mb(info.quota)}`, ''],
      ['記録', `発見 ${c.found}件 + 追加 ${c.user}件 ／ 写真 ${c.photos}枚`, ''],
      ['最終保存', info.lastSaveAt ? formatDateTime(info.lastSaveAt) : '（この起動ではまだ保存していません）', ''],
      ['直近のエラー', info.lastError || 'なし', info.lastError ? 'warn' : ''],
    ];
    el.innerHTML = rows.map(r => `<div class="status-row"><span class="k">${r[0]}</span><span class="v ${r[2]}">${escapeHtml(r[1])}</span></div>`).join('');
  }

  function renderSettingsData() {
    renderStorageStatus();
    renderSnapshotList();
    let showLegacy = false;
    try {
      const raw = Store.readLegacyRaw();
      if (raw) showLegacy = countRecords(splitLegacy(JSON.parse(raw)).data).total > 0;
    } catch (_) { showLegacy = true; }
    document.getElementById('legacyRestoreWrap').style.display = showLegacy ? 'block' : 'none';
  }

  function scheduleAutoSnapshot() {
    setTimeout(async () => {
      try {
        if (blockSaves || countRecords(state).total === 0) return;
        const list = await Store.listSnapshots();
        const auto = list.find(s => s.slot === 'auto');
        if (auto && Date.now() - auto.createdAt < 24 * 3600 * 1000) return;
        await Store.writeSnapshot('auto', '自動バックアップ', { data: pickData(state), prefs: pickPrefs(state) });
      } catch (e) { console.warn('[mikkecho] auto snapshot failed', e); }
    }, 5000);
  }

  document.getElementById('resetBtn').addEventListener('click', async () => {
    if (!confirm('すべてのデータを削除します。\n（直前の状態は「操作直前の状態」として自動で残るので、あとから戻すこともできます）\nよろしいですか？')) return;
    try {
      await Store.writeSnapshot('pre-change', 'リセット直前の状態', { data: pickData(state), prefs: pickPrefs(state) });
    } catch (e) {
      alert('安全のための事前バックアップを作れなかったため、リセットを中止しました。\n先に「バックアップを書き出す」を実行してください。\n(' + describeError(e) + ')');
      return;
    }
    const prev = state;
    state = buildState(null, pickPrefs(prev));
    const ok = await saveState({ allowShrink: true });
    if (!ok) { state = prev; renderAll(); showToast('保存できなかったため、元の状態に戻しました'); return; }
    clearDraft();
    renderAll();
    renderSettingsData();
    showToast('データをリセットしました（「自動バックアップ」から戻せます）');
  });

  /* ============================================================
     TABS
  ============================================================ */
  const tabButtons = document.querySelectorAll('.tab-btn');
  const views = document.querySelectorAll('.view');
  function switchView(name) {
    views.forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
    tabButtons.forEach(b => b.classList.toggle('active', b.dataset.view === name));
    if (name === 'kushu') renderKushu();
    if (name === 'jisseki') renderBadges();
    if (name === 'settei') renderSettingsData();
    if (name === 'zukan') {
      zukanDetailEl.style.display = 'none';
      zukanHomeEl.style.display = 'block';
      renderCategoryList();
      renderZukanHomeExtras();
    }
  }
  tabButtons.forEach(b => b.addEventListener('click', () => switchView(b.dataset.view)));

  /* ============================================================
     THEME (行灯モード)
  ============================================================ */
  const themeToggleBtn = document.getElementById('themeToggle');
  function applyTheme() {
    document.documentElement.setAttribute('data-theme', state.theme);
    try { localStorage.setItem('mikkecho_theme', state.theme); } catch (_) { /* ignore */ }
    themeToggleBtn.textContent = state.theme === 'night' ? '🌙' : '🌤️';
  }
  function toggleTheme() {
    state.theme = state.theme === 'night' ? 'day' : 'night';
    savePrefs();
    applyTheme();
  }
  themeToggleBtn.addEventListener('click', toggleTheme);

  /* ============================================================
     ONBOARDING
  ============================================================ */
  const onboardBackdrop = document.getElementById('onboardBackdrop');
  function showOnboarding() {
    onboardBackdrop.classList.add('open');
  }
  function closeOnboarding(markSeen) {
    onboardBackdrop.classList.remove('open');
    if (markSeen && !state.onboarded) {
      state.onboarded = true;
      savePrefs();
    }
  }
  document.getElementById('onboardStartBtn').addEventListener('click', () => closeOnboarding(true));
  document.getElementById('showOnboardBtn').addEventListener('click', () => showOnboarding());

  /* ============================================================
     INIT
  ============================================================ */
  function renderAll() {
    renderTopbar();
    renderCategoryList();
    if (zukanHomeEl.style.display !== 'none') renderZukanHomeExtras();
    if (zukanDetailEl.style.display !== 'none' && currentCategoryId) renderCategoryDetail();
    if (document.getElementById('view-kushu').classList.contains('active')) renderKushu();
    if (document.getElementById('view-jisseki').classList.contains('active')) renderBadges();
  }

  /* ============================================================
     BACK BUTTON (Android): close the top-most layer instead of exiting the app
  ============================================================ */
  let sentinelPushed = false;
  function pushSentinel() {
    try { history.pushState({ mikkecho: 'sentinel' }, ''); sentinelPushed = true; } catch (_) { /* ignore */ }
  }
  function currentTabName() {
    const b = document.querySelector('.tab-btn.active');
    return b ? b.dataset.view : 'zukan';
  }
  function handleBack() {
    if (onboardBackdrop.classList.contains('open')) { closeOnboarding(true); return true; }
    if (importBackdrop.classList.contains('open')) { pendingImport = null; closeImportDialog(); return true; }
    if (categoryModalBackdrop.classList.contains('open')) { categoryModalBackdrop.classList.remove('open'); return true; }
    if (findModalBackdrop.classList.contains('open')) { flushDraft(); closeFindModal(); return true; }   // input stays as a draft
    if (spotDetailBackdrop.classList.contains('open')) { spotDetailBackdrop.classList.remove('open'); return true; }
    const tab = currentTabName();
    if (tab === 'zukan' && zukanDetailEl.style.display !== 'none') { goZukanHome(); return true; }
    if (tab !== 'zukan') { switchView('zukan'); return true; }
    return false;   // already at the top → let the app close normally
  }
  function setupBackHandling() {
    if (history.state && history.state.mikkecho === 'sentinel') sentinelPushed = true;
    // Chrome ignores history entries added before the first user gesture, so arm on the first touch.
    const arm = () => { if (!sentinelPushed) pushSentinel(); };
    ['pointerdown', 'touchstart', 'keydown'].forEach(evt => window.addEventListener(evt, arm, { passive: true }));
    window.addEventListener('popstate', () => {
      if (!sentinelPushed) return;
      sentinelPushed = false;
      if (handleBack()) pushSentinel();
      else history.back();
    });
  }

  // keep the in-progress form safe whenever the app goes to the background
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushDraft(); });
  window.addEventListener('pagehide', () => flushDraft());

  /* ============================================================
     BOOT
  ============================================================ */
  function showBootError(e) {
    const overlay = document.getElementById('bootOverlay');
    if (!overlay) return;
    overlay.innerHTML = '<div class="boot-spinner">⚠️</div>'
      + '<div class="boot-text">データの読み込みに失敗しました。<br>保存されているデータは消えていません（安全のため、この状態では保存を行いません）。<br><br>'
      + escapeHtml(describeError(e)) + '</div>'
      + '<button class="boot-btn" id="bootReloadBtn">もう一度読み込む</button>';
    document.getElementById('bootReloadBtn').addEventListener('click', () => location.reload());
  }

  async function boot() {
    let source = 'idb';
    try {
      await Store.init();
      const loaded = await Store.load();
      source = loaded.source;
      state = buildState(loaded.data, loaded.prefs);
      lastPersistedTotal = countRecords(state).total;
      currentDraft = await Store.loadDraft();
    } catch (e) {
      blockSaves = true;
      console.error('[mikkecho] boot failed', e);
      showBootError(e);
      return;
    }
    applyTheme();
    checkAchievements();
    renderAll();
    renderDraftBanner();
    if (!state.onboarded) showOnboarding();
    const overlay = document.getElementById('bootOverlay');
    if (overlay) overlay.remove();
    setupBackHandling();
    scheduleAutoSnapshot();
    if (source === 'migrated') showToast('データを新しい保存方式に引き継ぎました');
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }

  boot();

})();
