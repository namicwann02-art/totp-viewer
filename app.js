// Self-update: Telegram's WebView can cache this page aggressively, so on
// every load we check version.json (always cache-busted) against the
// version baked into this page. If a newer one is live, we redirect to a
// ?v=<n> URL the WebView has never cached, forcing a real fresh load —
// no manual BotFather URL changes or "Reload Page" needed anymore.
async function checkForUpdate() {
  try {
    const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    const latest = data.version;
    if (!latest || latest === window.APP_VERSION) return;
    const guardKey = 'totp_update_redirect_v' + latest;
    if (sessionStorage.getItem(guardKey)) return; // already tried this target once, avoid loops
    sessionStorage.setItem(guardKey, '1');
    const url = new URL(location.href);
    url.searchParams.set('v', latest);
    location.replace(url.toString());
  } catch {
    // offline or blocked — the next open will just retry
  }
}

checkForUpdate();

// Access gate: only this Telegram account may see the app's UI. Anyone
// else opening the mini app (or opening the bare GitHub Pages URL outside
// Telegram, where there's no Telegram user at all) gets a blank page.
// Note: initDataUnsafe is NOT cryptographically verified client-side (real
// verification needs the bot token server-side), so this is a convenience
// gate against casual/curious visitors, not a hard security boundary — the
// actual secrets are still protected separately by the passphrase-encrypted
// Telegram Cloud Storage vault.
const ALLOWED_TELEGRAM_USER_ID = 8588409246;

function isAuthorizedUser() {
  const id = window.Telegram?.WebApp?.initDataUnsafe?.user?.id;
  return Number(id) === ALLOWED_TELEGRAM_USER_ID;
}

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
// update to Telegram Cloud Storage so other devices see it too. Callers
// must await this — it used to fire-and-forget the cloud push, so closing
// the mini app right after an edit could kill the push mid-flight; the
// next open would then pull the still-stale cloud copy and silently
// revert the edit. Awaiting it doesn't make closing impossible, but it
// keeps the "syncing…" status up so there's a visible cue not to close yet.
async function persistAccounts(accounts) {
  saveAccounts(accounts);
  if (currentPassphrase) {
    showStatus('Senkronize ediliyor...');
    try {
      await window.Sync.pushAccounts(accounts, currentPassphrase);
      showStatus('Bulutla senkronize edildi.');
      setTimeout(() => showStatus(''), 1200);
    } catch (err) {
      showStatus('Senkron hatası: ' + (err.message || err), true);
    }
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
const RING_CIRCUMFERENCE = 2 * Math.PI * 15.9155;
let openSwipeLi = null;
let activeContextMenu = null;
let currentPassphrase = null; // kept in memory for the running session

// "Remember this device" for 30 minutes: after a successful unlock/setup,
// the passphrase is cached in this device's own localStorage (never sent
// anywhere) so re-opening the mini app within that window skips the
// passphrase prompt. Past 30 minutes it's cleared and the prompt returns.
const REMEMBER_DURATION_MS = 30 * 60 * 1000;
const REMEMBER_PASS_KEY = 'totp_remember_pass';
const REMEMBER_UNTIL_KEY = 'totp_remember_until';

function rememberPassphrase(pass) {
  localStorage.setItem(REMEMBER_PASS_KEY, pass);
  localStorage.setItem(REMEMBER_UNTIL_KEY, String(Date.now() + REMEMBER_DURATION_MS));
}

function clearRememberedPassphrase() {
  localStorage.removeItem(REMEMBER_PASS_KEY);
  localStorage.removeItem(REMEMBER_UNTIL_KEY);
}

function getRememberedPassphrase() {
  const until = Number(localStorage.getItem(REMEMBER_UNTIL_KEY) || 0);
  if (!until || Date.now() > until) {
    clearRememberedPassphrase();
    return null;
  }
  return localStorage.getItem(REMEMBER_PASS_KEY);
}

// Manual lock: cancels the remembered-for-30-minutes window immediately
// and re-prompts for the passphrase, same as if it had simply expired.
function lockNow() {
  clearRememberedPassphrase();
  currentPassphrase = null;
  els.list.innerHTML = '';
  els.emptyState.classList.add('hidden');
  initCloudSync();
}

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
        <div class="account-info" data-role="copy-code" title="Kopyalamak için dokunun">
          <div class="account-issuer">${escapeHtml(issuer)}</div>
          <div class="account-name">${escapeHtml(name)}</div>
        </div>
        <div class="code-wrap">
          <div class="account-code" data-role="code" title="Kopyalamak için dokunun">
            <span class="code-text" data-role="code-text">------</span>
          </div>
          <div class="ring-wrap">
            <svg class="ring" viewBox="0 0 36 36">
              <circle class="ring-bg" cx="18" cy="18" r="15.9155"></circle>
              <circle class="ring-fg" data-role="ring" cx="18" cy="18" r="15.9155"
                stroke-dasharray="${RING_CIRCUMFERENCE}" stroke-dashoffset="0"></circle>
            </svg>
            <span class="ring-label" data-role="ring-label">30</span>
          </div>
        </div>
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
  updateAllRings();
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
  let axisLocked = null; // 'x' or 'y', decided once the gesture is unambiguous

  view.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    baseX = parseFloat(li.dataset.swipeX || '0');
    dragging = true;
    moved = false;
    axisLocked = null;
  }, { passive: true });

  // Not passive: once we lock onto a horizontal swipe we need to call
  // preventDefault() so the browser's own vertical pan (touch-action: pan-y)
  // doesn't also kick in on the same gesture, which is what caused swipes
  // to visibly drift the page down at the same time.
  view.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;

    if (!axisLocked) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return; // too small to tell yet
      axisLocked = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    }

    if (axisLocked === 'y') return; // vertical scroll — let the page handle it

    e.preventDefault();
    moved = true;
    const next = Math.max(-SWIPE_WIDTH, Math.min(0, baseX + dx));
    view.style.transform = `translateX(${next}px)`;
  }, { passive: false });

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

function randomDigits(len) {
  let s = '';
  for (let i = 0; i < len; i++) s += Math.floor(Math.random() * 10);
  return s.match(/.{1,3}/g).join(' ');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Briefly cycles through random digits before settling on the real code —
// a short "rolling" transition for the moment the old code expires.
async function scrambleInto(codeEl, textEl, finalDisplay, digitCount) {
  codeEl.classList.add('scrambling');
  const frames = 9; // more cycles = more noticeable
  for (let i = 0; i < frames; i++) {
    textEl.textContent = randomDigits(digitCount);
    await sleep(26); // 35ms * 0.75 — 25% faster per frame
  }
  codeEl.classList.remove('scrambling');
  textEl.textContent = finalDisplay;
}

async function refreshAllCodes(animate = false) {
  try {
    const accounts = loadAccounts();
    const now = Date.now();
    await Promise.all(accounts.map(async (account) => {
      const li = els.list.querySelector(`li[data-id="${account.id}"]`);
      if (!li) return;
      const codeEl = li.querySelector('.account-code');
      const textEl = codeEl?.querySelector('[data-role="code-text"]');
      if (!codeEl || !textEl) return;
      try {
        const code = await window.TOTP.computeTOTPForAccount(account, now);
        const display = code.match(/.{1,3}/g).join(' ');
        if (animate) {
          await scrambleInto(codeEl, textEl, display, code.length);
        } else {
          textEl.textContent = display;
        }
        codeEl.dataset.rawCode = code;
        codeEl.classList.remove('flash');
        void codeEl.offsetWidth; // restart the animation on repeat refreshes
        codeEl.classList.add('flash');
      } catch (err) {
        textEl.textContent = 'HATA';
        console.error('TOTP hesaplanamadı:', account.issuer, account.name, err);
      }
    }));
  } catch (err) {
    // top-level failure (e.g. loadAccounts() returning something unexpected) used to
    // leave every code box stuck on its "------" placeholder with zero visible cause
    showStatus('Kodlar hesaplanamadı: ' + (err.message || err), true);
    console.error('refreshAllCodes failed:', err);
  }
}

function updateProgressBar() {
  const remaining = window.TOTP.secondsRemaining(30);
  const pct = (remaining / 30) * 100;
  els.progressBar.style.width = pct + '%';
  els.progressBar.classList.toggle('low', remaining <= 5);
}

function updateAllRings() {
  const remaining = window.TOTP.secondsRemaining(30);
  const fraction = remaining / 30;
  const offset = RING_CIRCUMFERENCE * (1 - fraction);
  els.list.querySelectorAll('.ring-wrap').forEach(wrap => {
    const ring = wrap.querySelector('[data-role="ring"]');
    const label = wrap.querySelector('[data-role="ring-label"]');
    ring.style.strokeDashoffset = offset;
    ring.classList.toggle('low', remaining <= 5);
    if (label) label.textContent = remaining;
  });
}

function tick() {
  const remaining = window.TOTP.secondsRemaining(30);
  updateProgressBar();
  updateAllRings();
  if (remaining === 30 || !tick.initialized) {
    const isFirstLoad = !tick.initialized;
    tick.initialized = true;
    refreshAllCodes(!isFirstLoad);
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

async function saveEdit(li, id) {
  const issuerVal = li.querySelector('[data-role="edit-issuer"]').value.trim();
  const nameVal = li.querySelector('[data-role="edit-name"]').value.trim();
  const accounts = loadAccounts();
  const account = accounts.find(a => a.id === id);
  if (account) {
    account.issuer = issuerVal;
    account.name = nameVal;
    await persistAccounts(accounts);
  }
  renderAccountList(accounts);
  refreshAllCodes();
}

async function removeAccountById(id) {
  const accounts = loadAccounts().filter(a => a.id !== id);
  await persistAccounts(accounts);
  renderAccountList(accounts);
  refreshAllCodes();
}

// Feedback is shown inline inside the tapped code chip itself (swapping its
// text briefly) rather than via the page-level status banner. On the
// Telegram mobile WebView, toggling that banner's visibility scrolled the
// whole mini app to the top on every copy; a purely local text swap inside
// an element that's already on screen can't move anything else on the page.
function copyCode(li) {
  const codeEl = li.querySelector('.account-code');
  const textEl = codeEl?.querySelector('[data-role="code-text"]');
  const raw = codeEl?.dataset.rawCode;
  if (!codeEl || !textEl || !raw) return;
  navigator.clipboard?.writeText(raw);
  const restoreText = textEl.textContent;
  clearTimeout(codeEl._copiedTimer);
  codeEl.classList.add('copied');
  textEl.textContent = 'Kopyalandı';
  codeEl._copiedTimer = setTimeout(() => {
    codeEl.classList.remove('copied');
    textEl.textContent = restoreText;
  }, 1200);
}

function handleListClick(e) {
  const li = e.target.closest('li.account');
  if (!li) return;
  if (li.dataset.suppressClick) return; // this click was the tail end of a swipe drag
  const id = li.dataset.id;
  const role = e.target.closest('[data-role]')?.dataset.role;

  if (role === 'code' || role === 'code-text' || role === 'copy-code') {
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
    await persistAccounts(merged);
    renderAccountList(merged);
    await refreshAllCodes();
    showStatus(`${added} hesap eklendi (toplam ${merged.length}).`);
  } catch (err) {
    showStatus(err.message || 'QR kod okunamadı.', true);
  }
}

function hideSyncModal() {
  els.syncOverlay.classList.add('hidden');
  document.body.classList.remove('modal-open');
}

function showSyncOverlay() {
  els.syncOverlay.classList.remove('hidden');
  document.body.classList.add('modal-open'); // blocks background scroll while the modal is up
}

// Lets the user see exactly what they typed before submitting — added
// after a report of "wrong password" on the Telegram mobile app despite
// the same password working on desktop, to rule out mobile keyboard
// autocapitalize/autocorrect mangling the input silently.
function wirePassToggle(toggleId, inputId) {
  const toggleBtn = qs(toggleId);
  const input = qs(inputId);
  toggleBtn.addEventListener('click', () => {
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    toggleBtn.textContent = showing ? '👁' : '🙈';
  });
}

function showUnlockModal(errorMsg) {
  els.syncModalContent.innerHTML = `
    <h2>Kasa Kilidini Aç</h2>
    <p class="hint">Hesaplarınız Telegram Cloud'da şifreli olarak saklanıyor. Devam etmek için parolanızı girin.</p>
    ${errorMsg ? `<p class="modal-error">${escapeHtml(errorMsg)}</p>` : ''}
    <div class="pass-field">
      <input type="password" id="sync-passphrase" placeholder="Parola" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false">
      <button type="button" class="pass-toggle" id="sync-passphrase-toggle" title="Parolayı göster">👁</button>
    </div>
    <button id="sync-unlock-btn" class="import-btn">Kilidi Aç</button>
    <button id="sync-view-local-btn" class="link-btn">Bu cihazdaki hesapları senkron olmadan görüntüle</button>
    ${loadAccounts().length > 0 ? '<button id="sync-reset-btn" class="link-btn">Parolamı unuttum — bu cihazdaki hesapları temel alarak sıfırla</button>' : ''}
  `;
  showSyncOverlay();
  const passInput = qs('sync-passphrase');
  wirePassToggle('sync-passphrase-toggle', 'sync-passphrase');
  qs('sync-view-local-btn').addEventListener('click', async () => {
    hideSyncModal();
    const accounts = loadAccounts();
    renderAccountList(accounts);
    await refreshAllCodes();
  });
  qs('sync-reset-btn')?.addEventListener('click', showResetModal);
  const submit = async () => {
    const pass = passInput.value;
    const btn = qs('sync-unlock-btn');
    btn.disabled = true;
    btn.textContent = 'Açılıyor...';
    try {
      const remoteAccounts = await window.Sync.pullAccounts(pass);
      currentPassphrase = pass;
      rememberPassphrase(pass);
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
  passInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  passInput.focus();
}

// Recovery path for a forgotten/mismatched cloud passphrase: re-encrypts
// THIS DEVICE's local account cache under a brand-new passphrase and
// overwrites the cloud vault with it. Only safe because the local cache
// (loadAccounts) already holds a plaintext copy independent of the cloud
// passphrase — see the "view local accounts" link in showUnlockModal.
// Other devices will need the new passphrase after this runs.
function showResetModal() {
  const localAccounts = loadAccounts();
  els.syncModalContent.innerHTML = `
    <h2>Parolayı Sıfırla</h2>
    <p class="hint">Bu cihazda kayıtlı ${localAccounts.length} hesabı, belirleyeceğiniz yeni bir parolayla
    buluta yeniden yükleyeceğiz. Bu işlem buluttaki mevcut kaydın <b>üzerine yazar</b> — eski parola artık
    işe yaramaz ve diğer cihazlar bundan sonra bu yeni parolayı kullanmalı.</p>
    <div class="pass-field">
      <input type="password" id="reset-pass1" placeholder="Yeni parola (en az 8 karakter)" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false">
      <button type="button" class="pass-toggle" id="reset-pass1-toggle" title="Parolayı göster">👁</button>
    </div>
    <div class="pass-field">
      <input type="password" id="reset-pass2" placeholder="Parolayı tekrar girin" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false">
      <button type="button" class="pass-toggle" id="reset-pass2-toggle" title="Parolayı göster">👁</button>
    </div>
    <p class="modal-error hidden" id="reset-error"></p>
    <button id="reset-submit-btn" class="import-btn">Parolayı Sıfırla ve Yükle</button>
    <button id="reset-cancel-btn" class="link-btn">Vazgeç, kilidi tekrar dene</button>
  `;
  showSyncOverlay();
  wirePassToggle('reset-pass1-toggle', 'reset-pass1');
  wirePassToggle('reset-pass2-toggle', 'reset-pass2');
  const errEl = qs('reset-error');
  qs('reset-cancel-btn').addEventListener('click', () => showUnlockModal());
  qs('reset-submit-btn').addEventListener('click', async () => {
    const p1 = qs('reset-pass1').value;
    const p2 = qs('reset-pass2').value;
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
    const btn = qs('reset-submit-btn');
    btn.disabled = true;
    btn.textContent = 'Yükleniyor...';
    try {
      await window.Sync.pushAccounts(localAccounts, p1);
      currentPassphrase = p1;
      rememberPassphrase(p1);
      hideSyncModal();
      renderAccountList(localAccounts);
      await refreshAllCodes();
      showStatus('Parola sıfırlandı, bulut güncellendi.');
      setTimeout(() => showStatus(''), 2000);
    } catch (err) {
      errEl.textContent = 'Yükleme başarısız: ' + (err.message || err);
      errEl.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Parolayı Sıfırla ve Yükle';
    }
  });
}

function showSetupModal() {
  els.syncModalContent.innerHTML = `
    <h2>Bulut Senkronunu Kur</h2>
    <p class="hint">Bu cihazdaki hesapları Telegram hesabınıza bağlı, şifreli bir kasada saklayacağız —
    böylece başka bir cihazda da otomatik görünürler. Parolayı unutursanız veriler kurtarılamaz.</p>
    <div class="pass-field">
      <input type="password" id="sync-pass1" placeholder="Yeni parola (en az 8 karakter)" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false">
      <button type="button" class="pass-toggle" id="sync-pass1-toggle" title="Parolayı göster">👁</button>
    </div>
    <div class="pass-field">
      <input type="password" id="sync-pass2" placeholder="Parolayı tekrar girin" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false">
      <button type="button" class="pass-toggle" id="sync-pass2-toggle" title="Parolayı göster">👁</button>
    </div>
    <p class="modal-error hidden" id="sync-setup-error"></p>
    <button id="sync-setup-btn" class="import-btn">Parola Oluştur ve Senkronize Et</button>
  `;
  showSyncOverlay();
  wirePassToggle('sync-pass1-toggle', 'sync-pass1');
  wirePassToggle('sync-pass2-toggle', 'sync-pass2');
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
      rememberPassphrase(p1);
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
    if (!exists) {
      showSetupModal();
      return;
    }
    const remembered = getRememberedPassphrase();
    if (remembered) {
      try {
        const remoteAccounts = await window.Sync.pullAccounts(remembered);
        currentPassphrase = remembered;
        const accounts = remoteAccounts || [];
        saveAccounts(accounts);
        renderAccountList(accounts);
        await refreshAllCodes();
        return; // unlocked silently — within this device's 30-minute window
      } catch {
        clearRememberedPassphrase(); // stale/wrong — fall through to prompting
      }
    }
    showUnlockModal();
  } catch (err) {
    showStatus('Bulut senkron kontrol edilemedi: ' + (err.message || err), true);
  }
}

// Keeps --app-height matched to Telegram's real visible viewport instead of
// the browser's 100vh (which on mobile WebViews can include area covered by
// Telegram's own UI chrome, making the page look zoomed in / not fitting).
function syncViewportHeight(tg) {
  const height = tg?.viewportStableHeight || tg?.viewportHeight || window.innerHeight;
  document.documentElement.style.setProperty('--app-height', height + 'px');
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

  if (window.Sync.hasCloudStorage()) {
    const lockBtn = qs('lock-btn');
    lockBtn.classList.remove('hidden');
    lockBtn.addEventListener('click', lockNow);
  }

  document.addEventListener('click', (e) => {
    if (openSwipeLi && !openSwipeLi.contains(e.target)) {
      closeSwipe(openSwipeLi);
    }
  });

  if (window.Telegram?.WebApp) {
    const tg = window.Telegram.WebApp;
    tg.ready();
    tg.expand();
    try {
      tg.requestFullscreen?.();
    } catch {
      // older Telegram client without this API — expand() above still applies
    }
    // Intentionally not adopting tg.themeParams — this app keeps its own
    // fixed black/green look regardless of the user's Telegram theme.
    try {
      tg.setHeaderColor('#060807');
      tg.setBackgroundColor('#060807');
    } catch {
      // older Telegram client without this API — safe to ignore
    }
    syncViewportHeight(tg);
    tg.onEvent('viewportChanged', () => syncViewportHeight(tg));
  } else {
    syncViewportHeight(null);
    window.addEventListener('resize', () => syncViewportHeight(null));
  }

  setInterval(tick, 1000);

  // If a cloud vault is in play, don't render anything from the local
  // cache until it's actually unlocked (silently via a remembered
  // passphrase, or via the modal) — otherwise the real accounts/codes
  // flash on screen for the moment before the lock check finishes.
  if (window.Sync.hasCloudStorage()) {
    initCloudSync();
  } else {
    const accounts = loadAccounts();
    renderAccountList(accounts);
    refreshAllCodes();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  if (!isAuthorizedUser()) {
    document.documentElement.innerHTML = '';
    return;
  }
  init();
});
