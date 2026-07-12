(() => {
  'use strict';

  const STORAGE_KEY = 'mikkecho_state_v1';

  function defaultState() {
    return {
      customCategories: [],   // { id, name, icon, type:'free', entries: [] } (legacy field, unused for new entries)
      founds: {},             // entryId -> { photo, haiku, date, ts, categoryId }  (preset checklist finds)
      unlocked: [],
      userEntries: {},        // categoryId -> [ {id,name,photo,haiku,date,ts} ]  (user-added, works for any category)
      theme: 'day',           // 'day' | 'night' (行灯モード)
      onboarded: false,
      lastBackupPromptCount: 0, // totalFoundAll() value at the time of the last backup nudge/export
    };
  }

  let state = loadState();

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const parsed = Object.assign(defaultState(), JSON.parse(raw));
      migratePhotos(parsed);
      return parsed;
    } catch (e) {
      return defaultState();
    }
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
  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      showToast('保存容量が上限に近いかもしれません。写真サイズを見直してください。');
    }
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
    saveState();
    renderBackupBanner();
  });
  document.getElementById('backupDoBtn').addEventListener('click', () => {
    exportData();
  });

  function renderZukanHomeExtras() {
    renderRankBanner();
    renderRecentFindCard();
    renderBackupBanner();
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
        <div class="cat-icon">${cat.icon}</div>
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
  document.getElementById('backToZukanHome').addEventListener('click', () => {
    zukanDetailEl.style.display = 'none';
    zukanHomeEl.style.display = 'block';
    renderCategoryList();
    renderZukanHomeExtras();
  });

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
    detailCategoryNameEl.textContent = cat.icon + ' ' + cat.name;
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
  let pendingPhotos = [];
  const MAX_PHOTOS = 6;

  function renderPhotoGrid() {
    photoGrid.innerHTML = '';
    pendingPhotos.forEach((src, idx) => {
      const tile = document.createElement('div');
      tile.className = 'photo-thumb';
      tile.innerHTML = `<img src="${src}"><button type="button" class="remove-btn">×</button>`;
      tile.querySelector('.remove-btn').addEventListener('click', () => {
        pendingPhotos.splice(idx, 1);
        renderPhotoGrid();
      });
      photoGrid.appendChild(tile);
    });
    if (pendingPhotos.length < MAX_PHOTOS) {
      const addTile = document.createElement('button');
      addTile.type = 'button';
      addTile.className = 'photo-add-tile';
      addTile.innerHTML = `<span class="icon">📷</span><span>${pendingPhotos.length ? '追加' : '撮る・選ぶ'}</span>`;
      addTile.addEventListener('click', () => photoInput.click());
      photoGrid.appendChild(addTile);
    }
  }

  function openFindModal(ctx) {
    findContext = ctx;
    haikuInput.value = ctx.editRecord ? (ctx.editRecord.haiku || '') : '';
    freeNameInput.value = ctx.editRecord ? (ctx.editRecord.name || '') : '';
    pendingPhotos = ctx.editRecord && ctx.editRecord.photos ? ctx.editRecord.photos.slice() : [];
    renderPhotoGrid();

    if (ctx.mode === 'checklist') {
      findModalTitle.textContent = ctx.editRecord ? `${ctx.name} を編集` : ctx.name;
      findModalHint.textContent = ctx.hint ? '📍 ' + ctx.hint : '';
      freeNameField.style.display = 'none';
    } else {
      findModalTitle.textContent = ctx.editRecord ? '記録を編集' : '新しく見つけた';
      findModalHint.textContent = ctx.editRecord ? '' : 'この図鑑に追加します';
      freeNameField.style.display = 'block';
    }
    findSaveBtn.textContent = ctx.editRecord ? '更新する' : '記録する';
    findModalBackdrop.classList.add('open');
  }
  function closeFindModal() {
    findModalBackdrop.classList.remove('open');
    findContext = null;
    pendingPhotos = [];
  }
  document.getElementById('findCancelBtn').addEventListener('click', closeFindModal);
  findModalBackdrop.addEventListener('click', (e) => { if (e.target === findModalBackdrop) closeFindModal(); });

  photoInput.addEventListener('change', () => {
    const files = Array.from(photoInput.files || []);
    if (!files.length) return;
    const room = MAX_PHOTOS - pendingPhotos.length;
    const toProcess = files.slice(0, Math.max(0, room));
    Promise.all(toProcess.map(file => new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        compressImage(e.target.result, 900, 0.72).then(resolve);
      };
      reader.readAsDataURL(file);
    }))).then(dataUrls => {
      pendingPhotos.push(...dataUrls);
      renderPhotoGrid();
    });
    photoInput.value = '';
  });

  function compressImage(srcDataUrl, maxDim, quality) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) { height = Math.round(height * maxDim / width); width = maxDim; }
          else { width = Math.round(width * maxDim / height); height = maxDim; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => resolve(srcDataUrl);
      img.src = srcDataUrl;
    });
  }

  findSaveBtn.addEventListener('click', () => {
    if (!findContext) return;
    const haiku = haikuInput.value.trim();
    const isEdit = !!findContext.editRecord;
    const now = new Date();

    if (findContext.mode === 'checklist') {
      const existing = state.founds[findContext.entryId];
      state.founds[findContext.entryId] = {
        photos: pendingPhotos.slice(),
        haiku: haiku,
        date: existing ? existing.date : todayStr(),
        ts: existing ? existing.ts : now.getTime(),
        categoryId: findContext.categoryId,
      };
    } else {
      const name = freeNameInput.value.trim();
      if (!name) { freeNameInput.focus(); return; }
      const catId = findContext.categoryId;
      if (!state.userEntries[catId]) state.userEntries[catId] = [];
      if (isEdit) {
        const rec = state.userEntries[catId].find(e => e.id === findContext.editRecord.id);
        if (rec) {
          rec.name = name;
          rec.photos = pendingPhotos.slice();
          rec.haiku = haiku;
        }
      } else {
        state.userEntries[catId].push({
          id: uid('ue'), name, photos: pendingPhotos.slice(), haiku, date: todayStr(), ts: now.getTime(),
        });
      }
    }
    saveState();
    closeFindModal();
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

  spotDeleteBtn.addEventListener('click', () => {
    if (!spotDetailCtx) return;
    if (!confirm('この記録を削除しますか？')) return;
    const { entryId, categoryId, kind } = spotDetailCtx;
    if (kind === 'user') {
      state.userEntries[categoryId] = getUserEntries(categoryId).filter(e => e.id !== entryId);
    } else {
      delete state.founds[entryId];
    }
    saveState();
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
      btn.textContent = cat.icon + ' ' + cat.name;
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
  function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mikkecho_${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    state.lastBackupPromptCount = totalFoundAll();
    saveState();
    renderBackupBanner();
    showToast('データを書き出しました');
  }
  document.getElementById('exportBtn').addEventListener('click', exportData);
  document.getElementById('resetBtn').addEventListener('click', () => {
    if (!confirm('すべてのデータを削除します。よろしいですか？この操作は取り消せません。')) return;
    state = defaultState();
    saveState();
    renderAll();
    showToast('データをリセットしました');
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
    themeToggleBtn.textContent = state.theme === 'night' ? '🌙' : '🌤️';
  }
  function toggleTheme() {
    state.theme = state.theme === 'night' ? 'day' : 'night';
    saveState();
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
      saveState();
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

  applyTheme();
  checkAchievements();
  renderAll();
  if (!state.onboarded) showOnboarding();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }

})();
