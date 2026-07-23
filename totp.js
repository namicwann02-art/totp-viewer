// RFC 6238 TOTP generation using Web Crypto (SubtleCrypto).

const ALGORITHM_NAMES = { 1: 'SHA-1', 2: 'SHA-256', 3: 'SHA-512' };
const DIGIT_COUNTS = { 1: 6, 2: 8 };

function algorithmToWebCryptoName(algorithm) {
  return ALGORITHM_NAMES[algorithm] || 'SHA-1';
}

function digitsEnumToCount(digits) {
  return DIGIT_COUNTS[digits] || 6;
}

function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const char of clean) {
    const val = alphabet.indexOf(char);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substring(i, i + 8), 2));
  }
  return new Uint8Array(bytes);
}

async function computeTOTP(secretBytes, { algorithm = 'SHA-1', digits = 6, period = 30, at = Date.now() } = {}) {
  const counter = Math.floor(at / 1000 / period);
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter % 2 ** 32);

  const key = await crypto.subtle.importKey(
    'raw', secretBytes, { name: 'HMAC', hash: { name: algorithm } }, false, ['sign']
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));

  const offset = sig[sig.length - 1] & 0x0f;
  const code = ((sig[offset] & 0x7f) << 24 |
                (sig[offset + 1] & 0xff) << 16 |
                (sig[offset + 2] & 0xff) << 8 |
                (sig[offset + 3] & 0xff)) % (10 ** digits);
  return code.toString().padStart(digits, '0');
}

function secondsRemaining(period = 30) {
  return period - (Math.floor(Date.now() / 1000) % period);
}

async function computeTOTPForAccount(account, at = Date.now()) {
  const secretBytes = Uint8Array.from(atob(account.secretB64), c => c.charCodeAt(0));
  return computeTOTP(secretBytes, {
    algorithm: algorithmToWebCryptoName(account.algorithm),
    digits: digitsEnumToCount(account.digits),
    period: 30,
    at,
  });
}

window.TOTP = { computeTOTP, computeTOTPForAccount, secondsRemaining, base32Decode };
