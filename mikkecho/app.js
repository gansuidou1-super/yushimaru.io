(() => {
  'use strict';

  const STORAGE_KEY = 'mikkecho_state_v1';

  function defaultState() {
    return {
      customCategories: [],   // { id, name, icon, type:'free', entries: [] } (legacy field, unused for new entries)
      founds: {},             // entryId -> { photo, haiku, date, ts, categoryId }  (preset checklist finds)
      unlocked: [],
      userEntries: {},        // categoryId -> [ {id,name,photo,haiku,date,ts} ]  (user-added, works for any category)
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

  function playStamp() {
    const el = document.getElementById('stampOverlay');
    el.classList.remove('play');
    void el.offsetWidth; // restart animation
    el.classList.add('play');
    setTimeout(() => el.classList.remove('play'), 700);
  }

  /* ============================================================
     TOP BAR
  ============================================================ */
  const totalFoundCountEl = document.getElementById('totalFoundCount');
  function renderTopbar() {
    totalFoundCountEl.textContent = totalFoundAll();
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
    zukanHomeEl.style.display = 'none';
    zukanDetailEl.style.display = 'block';
    renderCategoryDetail();
  }
  document.getElementById('backToZukanHome').addEventListener('click', () => {
    zukanDetailEl.style.display = 'none';
    zukanHomeEl.style.display = 'block';
    renderCategoryList();
  });

  const detailCategoryNameEl = document.getElementById('detailCategoryName');
  const detailProgressHintEl = document.getElementById('detailProgressHint');
  const spotGridEl = document.getElementById('spotGrid');

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

    if (cat.type === 'checklist') {
      cat.entries.forEach(entry => {
        const rec = state.founds[entry.id];
        const card = document.createElement('div');
        card.className = 'spot-card ' + (rec ? 'found' : 'undiscovered');
        if (rec) {
          card.innerHTML = `
             ${rec.photos && rec.photos[0] ? `<img class="thumb" src="${rec.photos[0]}">` : `<div class="thumb">🀆</div>`}
             <span class="stamp-badge">✓</span>
             <div class="spot-name">${escapeHtml(entry.name)}</div>`;
          card.addEventListener('click', () => openSpotDetail(entry.id, cat.id, 'preset'));
        } else {
          card.innerHTML = `
             <div class="thumb">❔</div>
             ${entry.hint ? `<button class="hint-btn" style="position:absolute;top:4px;left:4px;width:22px;height:22px;border-radius:50%;border:none;background:rgba(43,58,85,0.85);color:#fff;font-size:11px;cursor:pointer;">📍</button>` : ''}
             <div class="spot-name">${escapeHtml(entry.name)}</div>`;
          card.addEventListener('click', () => openFindModal({ mode: 'checklist', entryId: entry.id, categoryId: cat.id, name: entry.name, hint: entry.hint }));
          const hintBtn = card.querySelector('.hint-btn');
          if (hintBtn) hintBtn.addEventListener('click', (ev) => { ev.stopPropagation(); showHintToast(entry.hint); });
        }
        spotGridEl.appendChild(card);
      });
    }

    // user-added entries (works for both checklist "found more than the preset list" and free-type categories)
    getUserEntries(cat.id).slice().reverse().forEach(entry => {
      const card = document.createElement('div');
      card.className = 'spot-card found';
      card.innerHTML = `
        ${entry.photos && entry.photos[0] ? `<img class="thumb" src="${entry.photos[0]}">` : `<div class="thumb">🀆</div>`}
        <span class="stamp-badge">✓</span>
        <div class="spot-name">${escapeHtml(entry.name)}</div>`;
      card.addEventListener('click', () => openSpotDetail(entry.id, cat.id, 'user'));
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

  function renderKushu() {
    const finds = buildAllFinds();
    kushuListEl.innerHTML = '';
    kushuCountHintEl.textContent = finds.length ? `${finds.length} 句` : '';
    kushuEmptyEl.style.display = finds.length ? 'none' : 'block';
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
  document.getElementById('exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mikkecho_${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('データを書き出しました');
  });
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
    }
  }
  tabButtons.forEach(b => b.addEventListener('click', () => switchView(b.dataset.view)));

  /* ============================================================
     INIT
  ============================================================ */
  function renderAll() {
    renderTopbar();
    renderCategoryList();
    if (zukanDetailEl.style.display !== 'none' && currentCategoryId) renderCategoryDetail();
    if (document.getElementById('view-kushu').classList.contains('active')) renderKushu();
    if (document.getElementById('view-jisseki').classList.contains('active')) renderBadges();
  }

  checkAchievements();
  renderAll();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }

})();
