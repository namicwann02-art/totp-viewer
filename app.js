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

function qs(id) {
  return document.getElementById(id);
}

function showStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.classList.toggle('error', isError);
  els.status.classList.toggle('hidden', !message);
}

function renderAccountList(accounts) {
  els.emptyState.classList.toggle('hidden', accounts.length > 0);
  els.list.innerHTML = '';
  for (const account of accounts) {
    const li = document.createElement('li');
    li.className = 'account';
    li.dataset.id = account.id;
    const { issuer, name } = displayLabel(account);
    li.innerHTML = `
      <div class="account-view">
        <div class="account-info">
          <div class="account-issuer">${escapeHtml(issuer)}</div>
          <div class="account-name">${escapeHtml(name)}</div>
        </div>
        <div class="account-code" data-role="code">------</div>
        <button class="edit-btn" data-role="edit" title="İsim ver">✎</button>
        <button class="copy-btn" data-role="copy" title="Kopyala">⧉</button>
        <button class="remove-btn" data-role="remove" title="Kaldır">✕</button>
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

function handleListClick(e) {
  const li = e.target.closest('li.account');
  if (!li) return;
  const id = li.dataset.id;

  const role = e.target.dataset.role;

  if (role === 'remove') {
    const accounts = loadAccounts().filter(a => a.id !== id);
    saveAccounts(accounts);
    renderAccountList(accounts);
    refreshAllCodes();
  } else if (role === 'copy') {
    const codeEl = li.querySelector('[data-role="code"]');
    const raw = codeEl.dataset.rawCode;
    if (raw) {
      navigator.clipboard?.writeText(raw);
      showStatus('Kopyalandı.');
      setTimeout(() => showStatus(''), 1500);
    }
  } else if (role === 'edit') {
    li.querySelector('.account-view').classList.add('hidden');
    li.querySelector('.account-edit').classList.remove('hidden');
    li.querySelector('[data-role="edit-issuer"]').focus();
  } else if (role === 'cancel-edit') {
    li.querySelector('.account-edit').classList.add('hidden');
    li.querySelector('.account-view').classList.remove('hidden');
  } else if (role === 'save-edit') {
    const issuerVal = li.querySelector('[data-role="edit-issuer"]').value.trim();
    const nameVal = li.querySelector('[data-role="edit-name"]').value.trim();
    const accounts = loadAccounts();
    const account = accounts.find(a => a.id === id);
    if (account) {
      account.issuer = issuerVal;
      account.name = nameVal;
      saveAccounts(accounts);
    }
    renderAccountList(accounts);
    refreshAllCodes();
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
    saveAccounts(merged);
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

function init() {
  els.list = qs('account-list');
  els.emptyState = qs('empty-state');
  els.status = qs('status');
  els.progressBar = qs('progress-bar');
  els.fileInput = qs('file-input');

  els.list.addEventListener('click', handleListClick);
  els.fileInput.addEventListener('change', handleFileImport);
  qs('import-btn').addEventListener('click', () => els.fileInput.click());

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
}

document.addEventListener('DOMContentLoaded', init);
