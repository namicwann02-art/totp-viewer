const STORAGE_KEY = 'totpAccounts';

function loadAccounts() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveAccounts(accounts) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(accounts));
}

// Saves locally and, if the cloud vault is unlocked, pushes the encrypted
// update to Telegram Cloud Storage so other devices see it too.
function persistAccounts(accounts) {
  saveAccounts(accounts);
  if (currentPassphrase) {
    window.Sync.pushAccounts(accounts, currentPassphrase)
      .then(() => {
        showStatus('Bulutla senkronize edildi.');
        setTimeout(() => showStatus(''), 1200);
      })
      .catch(err => showStatus('Senkron hatası: ' + (err.message || err), true));
  }
}

function mergeAccounts(existing, incoming) {
  const key = (a) => `${a.issuer}::${a.name}::${a.secretB64}`;
  const seen = new Set(existing.map(key));
  const merged = [...existing];
  let added = 0;
  for (const acc of incoming) {
    if (!seen.has(key(acc))) {
      merged.push(acc);
      seen.add(key(acc));
      added++;
    }
  }
  return { merged, added };
}

async function decodeQrFromFile(file) {
  const img = new Image();
  const url = URL.createObjectURL(file);
  try {
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('Görsel yüklenemedi.'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const result = jsQR(data, width, height);
    if (!result) {
      throw new Error('Görselde QR kodu bulunamadı. Daha net bir ekran görüntüsü deneyin.');
    }
    return result.data;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// --- UI wiring ---

const els = {};
const SWIPE_WIDTH = 112; // px revealed by the edit+delete swipe actions
let openSwipeLi = null;
let activeContextMenu = null;
let currentPassphrase = null; // kept in memory only, never persisted

function qs(id) {
  return document.getElementById(id);
}

function showStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.classList.toggle('error', isError);
  els.status.classList.toggle('hidden', !message);
}

function renderAccountList(accounts) {
  openSwipeLi = null;
  removeContextMenu();
  els.emptyState.classList.toggle('hidden', accounts.length > 0);
  els.list.innerHTML = '';
  for (const account of accounts) {
    const li = document.createElement('li');
    li.className = 'account';
    li.dataset.id = account.id;
    li.dataset.swipeX = '0';
    const { issuer, name } = displayLabel(account);
    li.innerHTML = `
      <div class="account-actions">
        <button class="action-btn action-edit" data-role="edit" title="Düzenle">✎</button>
        <button class="action-btn action-remove" data-role="remove" title="Sil">✕</button>
      </div>
      <div class="account-view">
        <div class="account-info">
          <div class="account-issuer">${escapeHtml(issuer)}</div>
          <div class="account-name">${escapeHtml(name)}</div>
        </div>
        <div class="account-code" data-role="code" title="Kopyalamak için dokunun">------</div>
      </div>
      <div class="account-edit hidden">
        <input type="text" data-role="edit-issuer" placeholder="Servis adı (ör. Google)" value="${escapeHtml(account.issuer || '')}">
        <input type="text" data-role="edit-name" placeholder="Hesap adı (ör. kullanici@ornek.com)" value="${escapeHtml(account.name || '')}">
        <div class="edit-actions">
          <button data-role="save-edit">Kaydet</button>
          <button data-role="cancel-edit">Vazgeç</button>
        </div>
      </div>
    `;
    els.list.appendChild(li);
    attachSwipeHandlers(li);
    attachContextMenu(li);
  }
}

function closeSwipe(li) {
  const view = li.querySelector('.account-view');
  view.style.transform = '';
  li.dataset.swipeX = '0';
  if (openSwipeLi === li) openSwipeLi = null;
}

function openSwipe(li) {
  if (openSwipeLi && openSwipeLi !== li) closeSwipe(openSwipeLi);
  const view = li.querySelector('.account-view');
  view.style.transform = `translateX(-${SWIPE_WIDTH}px)`;
  li.dataset.swipeX = String(-SWIPE_WIDTH);
  openSwipeLi = li;
}

function attachSwipeHandlers(li) {
  const view = li.querySelector('.account-view');
  let startX = 0;
  let startY = 0;
  let baseX = 0;
  let dragging = false;
  let moved = false;

  view.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    baseX = parseFloat(li.dataset.swipeX || '0');
    dragging = true;
    moved = false;
  }, { passive: true });

  view.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    if (Math.abs(dx) < Math.abs(dy)) return; // vertical scroll, let the page handle it
    moved = true;
    const next = Math.max(-SWIPE_WIDTH, Math.min(0, baseX + dx));
    view.style.transform = `translateX(${next}px)`;
  }, { passive: true });

  view.addEventListener('touchend', () => {
    if (!dragging) return;
    dragging = false;
    const match = view.style.transform.match(/-?\d+(\.\d+)?/);
    const current = match ? parseFloat(match[0]) : 0;
    if (current < -SWIPE_WIDTH / 2) {
      openSwipe(li);
    } else {
      closeSwipe(li);
    }
    if (moved) {
      li.dataset.suppressClick = '1';
      setTimeout(() => { delete li.dataset.suppressClick; }, 50);
    }
  });
}

function attachContextMenu(li) {
  li.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, li);
  });
}

function showContextMenu(x, y, li) {
  removeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.innerHTML = `
    <button data-role="edit">✎ Düzenle</button>
    <button data-role="remove">✕ Sil</button>
  `;
  document.body.appendChild(menu);
  const menuWidth = menu.offsetWidth;
  const menuHeight = menu.offsetHeight;
  menu.style.left = Math.min(x, window.innerWidth - menuWidth - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - menuHeight - 8) + 'px';
  menu.addEventListener('click', (e) => {
    const role = e.target.dataset.role;
    if (role === 'edit') startEdit(li);
    else if (role === 'remove') removeAccountById(li.dataset.id);
    removeContextMenu();
  });
  activeContextMenu = menu;
  setTimeout(() => {
    document.addEventListener('click', removeContextMenu, { once: true });
    document.addEventListener('contextmenu', removeContextMenu, { once: true });
  }, 0);
}

function removeContextMenu() {
  if (activeContextMenu) {
    activeContextMenu.remove();
    activeContextMenu = null;
  }
}

// Some accounts have no separate "issuer" field — Google Authenticator
// often packs it into name as "Issuer:account" instead. Fall back to
// splitting that, so accounts don't just show up as "Bilinmeyen".
function displayLabel(account) {
  if (account.issuer) {
    return { issuer: account.issuer, name: account.name || '' };
  }
  const raw = account.name || '';
  const sepIndex = raw.indexOf(':');
  if (sepIndex > -1) {
    return { issuer: raw.slice(0, sepIndex).trim(), name: raw.slice(sepIndex + 1).trim() };
  }
  return { issuer: raw || 'Bilinmeyen', name: '' };
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function refreshAllCodes() {
  const accounts = loadAccounts();
  const now = Date.now();
  for (const account of accounts) {
    const li = els.list.querySelector(`li[data-id="${account.id}"]`);
    if (!li) continue;
    const codeEl = li.querySelector('[data-role="code"]');
    try {
      const code = await window.TOTP.computeTOTPForAccount(account, now);
      codeEl.textContent = code.match(/.{1,3}/g).join(' ');
      codeEl.dataset.rawCode = code;
    } catch {
      codeEl.textContent = 'HATA';
    }
  }
}

function updateProgressBar() {
  const remaining = window.TOTP.secondsRemaining(30);
  const pct = (remaining / 30) * 100;
  els.progressBar.style.width = pct + '%';
  els.progressBar.classList.toggle('low', remaining <= 5);
}

function tick() {
  const remaining = window.TOTP.secondsRemaining(30);
  updateProgressBar();
  if (remaining === 30 || !tick.initialized) {
    tick.initialized = true;
    refreshAllCodes();
  }
}

function startEdit(li) {
  closeSwipe(li);
  li.querySelector('.account-view').classList.add('hidden');
  li.querySelector('.account-edit').classList.remove('hidden');
  li.querySelector('[data-role="edit-issuer"]').focus();
}

function cancelEdit(li) {
  li.querySelector('.account-edit').classList.add('hidden');
  li.querySelector('.account-view').classList.remove('hidden');
}

function saveEdit(li, id) {
  const issuerVal = li.querySelector('[data-role="edit-issuer"]').value.trim();
  const nameVal = li.querySelector('[data-role="edit-name"]').value.trim();
  const accounts = loadAccounts();
  const account = accounts.find(a => a.id === id);
  if (account) {
    account.issuer = issuerVal;
    account.name = nameVal;
    persistAccounts(accounts);
  }
  renderAccountList(accounts);
  refreshAllCodes();
}

function removeAccountById(id) {
  const accounts = loadAccounts().filter(a => a.id !== id);
  persistAccounts(accounts);
  renderAccountList(accounts);
  refreshAllCodes();
}

function copyCode(li) {
  const codeEl = li.querySelector('[data-role="code"]');
  const raw = codeEl.dataset.rawCode;
  if (raw) {
    navigator.clipboard?.writeText(raw);
    showStatus('Kopyalandı.');
    setTimeout(() => showStatus(''), 1500);
  }
}

function handleListClick(e) {
  const li = e.target.closest('li.account');
  if (!li) return;
  if (li.dataset.suppressClick) return; // this click was the tail end of a swipe drag
  const id = li.dataset.id;
  const role = e.target.dataset.role;

  if (role === 'code') {
    copyCode(li);
  } else if (role === 'remove') {
    removeAccountById(id);
  } else if (role === 'edit') {
    startEdit(li);
  } else if (role === 'cancel-edit') {
    cancelEdit(li);
  } else if (role === 'save-edit') {
    saveEdit(li, id);
  }
}

async function handleFileImport(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  showStatus('QR kod okunuyor...');
  try {
    const uri = await decodeQrFromFile(file);
    const incoming = window.MigrationParser.parseMigrationUri(uri);
    if (incoming.length === 0) {
      showStatus('QR kodda TOTP hesabı bulunamadı.', true);
      return;
    }
    const existing = loadAccounts();
    const { merged, added } = mergeAccounts(existing, incoming);
    persistAccounts(merged);
    renderAccountList(merged);
    await refreshAllCodes();
    showStatus(`${added} hesap eklendi (toplam ${merged.length}).`);
  } catch (err) {
    showStatus(err.message || 'QR kod okunamadı.', true);
  }
}

function applyTelegramTheme(theme) {
  if (!theme) return;
  const root = document.documentElement.style;
  const map = {
    '--tg-bg': theme.bg_color,
    '--tg-text': theme.text_color,
    '--tg-hint': theme.hint_color,
    '--tg-link': theme.link_color,
    '--tg-button': theme.button_color,
    '--tg-button-text': theme.button_text_color,
    '--tg-secondary-bg': theme.secondary_bg_color,
  };
  for (const [cssVar, value] of Object.entries(map)) {
    if (value) root.setProperty(cssVar, value);
  }
}

function hideSyncModal() {
  els.syncOverlay.classList.add('hidden');
}

function showUnlockModal(errorMsg) {
  els.syncModalContent.innerHTML = `
    <h2>Kasa Kilidini Aç</h2>
    <p class="hint">Hesaplarınız Telegram Cloud'da şifreli olarak saklanıyor. Devam etmek için parolanızı girin.</p>
    ${errorMsg ? `<p class="modal-error">${escapeHtml(errorMsg)}</p>` : ''}
    <input type="password" id="sync-passphrase" placeholder="Parola">
    <button id="sync-unlock-btn" class="import-btn">Kilidi Aç</button>
    <button id="sync-skip-btn" class="link-btn">Şimdilik atla, sadece bu cihazda kullan</button>
  `;
  els.syncOverlay.classList.remove('hidden');
  const passInput = qs('sync-passphrase');
  const submit = async () => {
    const pass = passInput.value;
    const btn = qs('sync-unlock-btn');
    btn.disabled = true;
    btn.textContent = 'Açılıyor...';
    try {
      const remoteAccounts = await window.Sync.pullAccounts(pass);
      currentPassphrase = pass;
      const accounts = remoteAccounts || [];
      saveAccounts(accounts);
      hideSyncModal();
      renderAccountList(accounts);
      await refreshAllCodes();
    } catch {
      showUnlockModal('Parola yanlış ya da veri okunamadı. Tekrar deneyin.');
    }
  };
  qs('sync-unlock-btn').addEventListener('click', submit);
  qs('sync-skip-btn').addEventListener('click', hideSyncModal);
  passInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  passInput.focus();
}

function showSetupModal() {
  els.syncModalContent.innerHTML = `
    <h2>Bulut Senkronunu Kur</h2>
    <p class="hint">Bu cihazdaki hesapları Telegram hesabınıza bağlı, şifreli bir kasada saklayacağız —
    böylece başka bir cihazda da otomatik görünürler. Parolayı unutursanız veriler kurtarılamaz.</p>
    <input type="password" id="sync-pass1" placeholder="Yeni parola (en az 8 karakter)">
    <input type="password" id="sync-pass2" placeholder="Parolayı tekrar girin">
    <p class="modal-error hidden" id="sync-setup-error"></p>
    <button id="sync-setup-btn" class="import-btn">Parola Oluştur ve Senkronize Et</button>
    <button id="sync-setup-skip-btn" class="link-btn">Şimdilik atla, sadece bu cihazda kullan</button>
  `;
  els.syncOverlay.classList.remove('hidden');
  qs('sync-setup-skip-btn').addEventListener('click', hideSyncModal);
  const errEl = qs('sync-setup-error');
  const submit = async () => {
    const p1 = qs('sync-pass1').value;
    const p2 = qs('sync-pass2').value;
    if (p1.length < 8) {
      errEl.textContent = 'Parola en az 8 karakter olmalı.';
      errEl.classList.remove('hidden');
      return;
    }
    if (p1 !== p2) {
      errEl.textContent = 'Parolalar eşleşmiyor.';
      errEl.classList.remove('hidden');
      return;
    }
    const btn = qs('sync-setup-btn');
    btn.disabled = true;
    btn.textContent = 'Kuruluyor...';
    try {
      const accounts = loadAccounts();
      await window.Sync.pushAccounts(accounts, p1);
      currentPassphrase = p1;
      hideSyncModal();
      showStatus('Bulut senkronu kuruldu.');
      setTimeout(() => showStatus(''), 2000);
    } catch (err) {
      errEl.textContent = 'Senkronizasyon başarısız: ' + (err.message || err);
      errEl.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Parola Oluştur ve Senkronize Et';
    }
  };
  qs('sync-setup-btn').addEventListener('click', submit);
}

async function initCloudSync() {
  if (!window.Sync.hasCloudStorage()) return;
  try {
    const exists = await window.Sync.remoteVaultExists();
    if (exists) showUnlockModal();
    else showSetupModal();
  } catch (err) {
    showStatus('Bulut senkron kontrol edilemedi: ' + (err.message || err), true);
  }
}

function init() {
  els.list = qs('account-list');
  els.emptyState = qs('empty-state');
  els.status = qs('status');
  els.progressBar = qs('progress-bar');
  els.fileInput = qs('file-input');
  els.syncOverlay = qs('sync-overlay');
  els.syncModalContent = qs('sync-modal-content');

  els.list.addEventListener('click', handleListClick);
  els.fileInput.addEventListener('change', handleFileImport);
  qs('import-btn').addEventListener('click', () => els.fileInput.click());

  document.addEventListener('click', (e) => {
    if (openSwipeLi && !openSwipeLi.contains(e.target)) {
      closeSwipe(openSwipeLi);
    }
  });

  if (window.Telegram?.WebApp) {
    const tg = window.Telegram.WebApp;
    tg.ready();
    tg.expand();
    applyTelegramTheme(tg.themeParams);
    tg.onEvent('themeChanged', () => applyTelegramTheme(tg.themeParams));
  }

  const accounts = loadAccounts();
  renderAccountList(accounts);
  refreshAllCodes();
  setInterval(tick, 1000);

  initCloudSync();
}

document.addEventListener('DOMContentLoaded', init);
