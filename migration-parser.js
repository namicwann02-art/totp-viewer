// Decodes Google Authenticator's "Export accounts" QR payload:
// otpauth-migration://offline?data=<base64 protobuf MigrationPayload>
//
// MigrationPayload {
//   repeated OtpParameters otp_parameters = 1;
//   ...
// }
// OtpParameters {
//   bytes secret = 1;
//   string name = 2;
//   string issuer = 3;
//   Algorithm algorithm = 4;  // 1=SHA1 2=SHA256 3=SHA512
//   DigitCount digits = 5;    // 1=SIX 2=EIGHT
//   OtpType type = 6;         // 1=HOTP 2=TOTP
//   int64 counter = 7;
// }

function readVarint(bytes, pos) {
  let result = 0;
  let shift = 0;
  let b;
  do {
    b = bytes[pos++];
    result |= (b & 0x7f) << shift;
    shift += 7;
  } while (b & 0x80);
  return [result >>> 0, pos];
}

function skipField(bytes, pos, wireType) {
  if (wireType === 0) return readVarint(bytes, pos)[1];
  if (wireType === 1) return pos + 8;
  if (wireType === 2) {
    const [len, p] = readVarint(bytes, pos);
    return p + len;
  }
  if (wireType === 5) return pos + 4;
  throw new Error('Desteklenmeyen protobuf wire type: ' + wireType);
}

function parseOtpParameters(bytes) {
  const otp = { secret: null, name: '', issuer: '', algorithm: 1, digits: 1, type: 2 };
  const decoder = new TextDecoder();
  let pos = 0;
  while (pos < bytes.length) {
    const [tag, p1] = readVarint(bytes, pos);
    pos = p1;
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x7;
    if (wireType === 2) {
      const [len, p2] = readVarint(bytes, pos);
      pos = p2;
      const val = bytes.subarray(pos, pos + len);
      pos += len;
      if (fieldNum === 1) otp.secret = val;
      else if (fieldNum === 2) otp.name = decoder.decode(val);
      else if (fieldNum === 3) otp.issuer = decoder.decode(val);
    } else if (wireType === 0) {
      const [val, p2] = readVarint(bytes, pos);
      pos = p2;
      if (fieldNum === 4) otp.algorithm = val;
      else if (fieldNum === 5) otp.digits = val;
      else if (fieldNum === 6) otp.type = val;
    } else {
      pos = skipField(bytes, pos, wireType);
    }
  }
  return otp;
}

function parseMigrationPayload(bytes) {
  const accounts = [];
  let pos = 0;
  while (pos < bytes.length) {
    const [tag, p1] = readVarint(bytes, pos);
    pos = p1;
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x7;
    if (fieldNum === 1 && wireType === 2) {
      const [len, p2] = readVarint(bytes, pos);
      pos = p2;
      accounts.push(parseOtpParameters(bytes.subarray(pos, pos + len)));
      pos += len;
    } else {
      pos = skipField(bytes, pos, wireType);
    }
  }
  return accounts;
}

function base64ToBytes(b64) {
  const normalized = b64.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

// Parses a scanned QR string. Throws if it's not a recognized migration URI.
function parseMigrationUri(uri) {
  if (!uri.startsWith('otpauth-migration://')) {
    throw new Error('Bu bir Google Authenticator "Hesapları Aktar" QR kodu değil.');
  }
  const dataMatch = uri.match(/[?&]data=([^&]+)/);
  if (!dataMatch) {
    throw new Error('QR kodunda beklenen veri bulunamadı.');
  }
  const bytes = base64ToBytes(decodeURIComponent(dataMatch[1]));
  const rawAccounts = parseMigrationPayload(bytes);

  return rawAccounts
    .filter(a => a.type === 2 && a.secret) // sadece TOTP hesapları (HOTP desteklenmiyor)
    .map(a => ({
      id: crypto.randomUUID(),
      name: a.name,
      issuer: a.issuer,
      secretB64: bytesToBase64(a.secret),
      algorithm: a.algorithm || 1,
      digits: a.digits || 1,
    }));
}

window.MigrationParser = { parseMigrationUri };
