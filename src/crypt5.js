import forge from "node-forge";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import bundledKeys from "../crypt5_keys.json";

const td = new TextDecoder();
const te = new TextEncoder();
const keyCache = new Map();

function decodeB64(value) {
  let s = String(value).replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  while (s.length % 4) s += "=";
  try { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }
  catch { throw new Error("crypt5: некорректный Base64"); }
}
function latin(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}
function byteString(s) { return Uint8Array.from(s, c => c.charCodeAt(0) & 255); }
function swapPairs(input) {
  const out = input.slice();
  for (let i = 0; i + 1 < out.length; i += 2) [out[i], out[i + 1]] = [out[i + 1], out[i]];
  return out;
}
function swapHalves(input) {
  const out = input.slice(), end = out.length - out.length % 4;
  for (let i = 0; i < end; i += 4) {
    [out[i], out[i + 2]] = [out[i + 2], out[i]];
    [out[i + 1], out[i + 3]] = [out[i + 3], out[i + 1]];
  }
  return out;
}
function getPrivateKey(marker, keytable) {
  const encoded = keytable?.[marker];
  if (typeof encoded !== "string" || !encoded) {
    throw new Error(`crypt5: в корневом crypt5_keys.json нет ключа для маркера ${marker}`);
  }
  if (!keyCache.has(marker)) {
    let parsed = null;
    const value = encoded.trim();

    // Also accept PEM values, although the standard crypt5_keys.json stores
    // PKCS#8 DER as Base64 strings keyed by the 8-character marker.
    if (value.includes("-----BEGIN")) {
      try { parsed = forge.pki.privateKeyFromPem(value); } catch {}
    }

    if (!parsed) {
      try {
        const compact = value
          .replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----|-----END (?:RSA )?PRIVATE KEY-----|\s/g, "");
        const der = decodeB64(compact);
        const rootAsn1 = forge.asn1.fromDer(latin(der));

        // PKCS#1 DER can be parsed directly. PKCS#8 wraps the RSA key in an
        // OCTET STRING at field 3, so unwrap it explicitly when needed.
        try { parsed = forge.pki.privateKeyFromAsn1(rootAsn1); } catch {}
        if (!parsed && rootAsn1?.type === forge.asn1.Type.SEQUENCE && rootAsn1.value?.[2]?.type === forge.asn1.Type.OCTETSTRING) {
          const innerAsn1 = forge.asn1.fromDer(rootAsn1.value[2].value);
          parsed = forge.pki.privateKeyFromAsn1(innerAsn1);
        }
      } catch {}
    }

    if (!parsed) {
      throw new Error(`crypt5: не удалось прочитать RSA-ключ ${marker} из crypt5_keys.json`);
    }
    keyCache.set(marker, parsed);
  }
  return keyCache.get(marker);
}

function decryptBody(body, key, salted) {
  if (body.length < 13) throw new Error("crypt5: слишком короткое тело");
  const nonce = body.subarray(0, 12);
  let salt = null, start = 12;
  if (salted) {
    if (body.length < 22) throw new Error("crypt5: короткий salted-заголовок");
    salt = body.subarray(14, 22);
    start = 22;
  }
  let end = start;
  while (end < body.length && body[end] >= 48 && body[end] <= 57) end++;
  if (end === start) throw new Error("crypt5: отсутствует длина сегмента");
  const segmentLength = Number(td.decode(body.subarray(start, end)));
  const packed = body.subarray(end);
  if (!Number.isSafeInteger(segmentLength) || segmentLength < 1 || packed.length <= segmentLength + 1) {
    throw new Error("crypt5: повреждённый сегмент");
  }
  const encryptedUrl = td.decode(packed.subarray(1, segmentLength + 1));
  const rsaCipher = decodeB64(td.decode(packed.subarray(segmentLength + 1)));
  const rsaPlain = key.decrypt(latin(rsaCipher));
  const rawKey = decodeB64(td.decode(swapPairs(byteString(rsaPlain))));
  if (rawKey.length !== 32) throw new Error("crypt5: неожиданный размер ключа");
  const chachaKey = rawKey.slice();
  if (salt) for (let i = 0; i < chachaKey.length; i++) chachaKey[i] ^= salt[i % salt.length];
  let intermediate;
  try {
    intermediate = chacha20poly1305(chachaKey, nonce).decrypt(decodeB64(encryptedUrl));
  } catch {
    throw new Error("crypt5: проверка подлинности не прошла — проверь ключ и формат ссылки");
  }
  return td.decode(decodeB64(td.decode(swapPairs(intermediate))));
}

/** Расшифровывает happ://crypt5/ ключами из crypt5_keys.json в корне репозитория. */
export function decryptCrypt5(payload, keytable = bundledKeys) {
  const text = String(payload).trim().replace(/^happ:\/\/crypt5\//i, "");
  const shuffled = swapHalves(te.encode(text));
  if (shuffled.length < 8) throw new Error("crypt5: ссылка слишком короткая");
  const marker = td.decode(Uint8Array.from([...shuffled.subarray(0, 4), ...shuffled.subarray(shuffled.length - 4)]));
  const key = getPrivateKey(marker, keytable);
  const body = shuffled.subarray(4, shuffled.length - 4);
  const preferSalted = body.length > 12 && !(body[12] >= 48 && body[12] <= 57);
  let last;
  for (const salted of [preferSalted, !preferSalted]) {
    try { return decryptBody(body, key, salted); } catch (e) { last = e; }
  }
  throw last || new Error("crypt5: расшифровка не удалась");
}
