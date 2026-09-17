import forge from "node-forge";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";

const NATIVE_KEYS_URL = "https://raw.githubusercontent.com/XuliGan4eg2006/Happ-converter/master/assets/native_keys.json";
const CRYPT5_KEYS_URL = "https://raw.githubusercontent.com/XuliGan4eg2006/Happ-converter/master/assets/crypt5_final_keys.json";
const MAX_PAYLOAD = 512 * 1024;
const MAX_KEY_RESPONSE = 512 * 1024;

let nativeKeysPromise;
let crypt5KeysPromise;

function b64DecodeBytes(text) {
  const value = String(text || "").trim();
  const candidates = [value, value.replace(/=+$/, "")];
  for (const candidate of candidates) {
    const padded = candidate + "=".repeat((4 - candidate.length % 4) % 4);
    try {
      return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
    } catch {}
    try {
      const standard = padded.replace(/-/g, "+").replace(/_/g, "/");
      return Uint8Array.from(atob(standard), c => c.charCodeAt(0));
    } catch {}
  }
  throw new Error("Invalid base64");
}

function bytesToBinary(bytes) {
  let out = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return out;
}

function bytesToText(bytes) {
  return new TextDecoder().decode(bytes);
}

function shuffleBlocks(text, blockSize, order) {
  const bytes = new TextEncoder().encode(text);
  const full = Math.floor(bytes.length / blockSize) * blockSize;
  const out = new Uint8Array(bytes.length);
  let p = 0;
  for (let i = 0; i < full; i += blockSize) {
    for (const index of order) out[p++] = bytes[i + index];
  }
  out.set(bytes.subarray(full), p);
  return bytesToText(out);
}

function m4831f(text) {
  return shuffleBlocks(text, 6, [1, 3, 5, 0, 2, 4]);
}

function inverseM4831f(text) {
  return shuffleBlocks(text, 6, [3, 0, 4, 1, 5, 2]);
}

function m4842j(text) {
  return shuffleBlocks(text, 2, [1, 0]);
}

function permute4(text) {
  return shuffleBlocks(text, 4, [2, 3, 0, 1]);
}

async function fetchJsonCached(url) {
  const cache = caches.default;
  const request = new Request(url, { method: "GET" });
  let response = await cache.match(request);
  if (!response) {
    response = await fetch(request, {
      headers: { "Accept": "application/json", "User-Agent": "OceaniaVPN-HappDecrypt/1.0" },
    });
    if (!response.ok) throw new Error(`Key source HTTP ${response.status}`);
    const length = Number(response.headers.get("content-length") || 0);
    if (length && length > MAX_KEY_RESPONSE) throw new Error("Key source is too large");
    response = new Response(response.body, {
      status: response.status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=86400",
      },
    });
    await cache.put(request, response.clone());
  }
  const text = await response.text();
  if (text.length > MAX_KEY_RESPONSE) throw new Error("Key source is too large");
  return JSON.parse(text);
}

async function loadNativeKeys() {
  if (!nativeKeysPromise) {
    nativeKeysPromise = fetchJsonCached(NATIVE_KEYS_URL).then(data => {
      if (!Array.isArray(data?.keys) || data.keys.length < 4) throw new Error("Invalid native key table");
      return data.keys.map(loadPrivateKey);
    }).catch(error => {
      nativeKeysPromise = null;
      throw error;
    });
  }
  return nativeKeysPromise;
}

async function loadCrypt5Keys() {
  if (!crypt5KeysPromise) {
    crypt5KeysPromise = fetchJsonCached(CRYPT5_KEYS_URL).then(data => {
      if (!data?.keys || typeof data.keys !== "object") throw new Error("Invalid crypt5 key table");
      return data.keys;
    }).catch(error => {
      crypt5KeysPromise = null;
      throw error;
    });
  }
  return crypt5KeysPromise;
}

function loadPrivateKey(encoded) {
  const value = String(encoded || "").trim();
  if (!value) throw new Error("Empty RSA private key");

  // Key tables may contain either PEM or base64 DER (PKCS#8 / PKCS#1).
  if (/-----BEGIN [A-Z0-9 ]+PRIVATE KEY-----/i.test(value)) {
    try {
      return forge.pki.privateKeyFromPem(value);
    } catch (e) {
      throw new Error(`Invalid RSA private key PEM: ${e?.message || "parse failed"}`);
    }
  }

  const der = b64DecodeBytes(value);
  const derBinary = bytesToBinary(der);
  let asn1;
  try {
    asn1 = forge.asn1.fromDer(derBinary);
  } catch (e) {
    throw new Error(`Invalid RSA private key DER: ${e?.message || "parse failed"}`);
  }

  // Try PKCS#8 first, then the traditional PKCS#1 RSAPrivateKey form.
  try {
    return forge.pki.privateKeyFromAsn1(asn1);
  } catch {
    throw new Error("Unsupported RSA private key encoding");
  }
}

function rsaDecrypt(privateKey, ciphertext) {
  const encrypted = bytesToBinary(b64DecodeBytes(ciphertext));
  const plaintext = privateKey.decrypt(encrypted, "RSAES-PKCS1-V1_5");
  return plaintext;
}

async function decryptRsaCrypt(payload, mode) {
  if (payload.length > MAX_PAYLOAD) throw new Error("Crypt payload is too large");
  const keys = await loadNativeKeys();
  const key = keys[mode];
  if (!key) throw new Error(`Missing native crypt${mode ? mode + 1 : ""} key`);
  return rsaDecrypt(key, payload);
}

async function decryptCrypt5(payload) {
  if (payload.length > MAX_PAYLOAD) throw new Error("Crypt5 payload is too large");

  const original = inverseM4831f(payload);
  const shuffled = permute4(original);
  if (shuffled.length < 8) throw new Error("crypt5 payload too short");

  const marker = shuffled.slice(0, 4) + shuffled.slice(-4);
  const body = shuffled.slice(4, -4);
  if (body.length < 13) throw new Error("crypt5 body too short");

  const nonce = new TextEncoder().encode(body.slice(0, 12));
  const rest = body.slice(12);
  const match = rest.match(/^(\d+)/);
  if (!match) throw new Error("crypt5 segment length missing");

  const segmentLen = Number(match[1]);
  if (!Number.isSafeInteger(segmentLen) || segmentLen < 1 || segmentLen > MAX_PAYLOAD) {
    throw new Error("crypt5 segment length invalid");
  }

  const packed = rest.slice(match[1].length);
  if (packed.length < 1 + segmentLen) throw new Error("crypt5 encrypted segment truncated");

  const encryptedSegment = packed.slice(1, 1 + segmentLen);
  const rsaCiphertext = packed.slice(1 + segmentLen);

  const keys = await loadCrypt5Keys();
  const encodedKey = keys[marker];
  if (!encodedKey) throw new Error(`Unknown crypt5 key marker: ${marker}`);

  const privateKey = loadPrivateKey(encodedKey);
  const rsaPlain = rsaDecrypt(privateKey, rsaCiphertext);
  const chachaKey = b64DecodeBytes(m4842j(rsaPlain));
  if (chachaKey.length !== 32) throw new Error(`Invalid ChaCha20 key length: ${chachaKey.length}`);

  const encrypted = b64DecodeBytes(encryptedSegment);
  const plaintext = chacha20poly1305(chachaKey, nonce).decrypt(encrypted);
  return bytesToText(plaintext);
}

export function parseCryptMode(value) {
  const prefixes = [
    ["happ://crypt5/", 4],
    ["happ://crypt4/", 3],
    ["happ://crypt3/", 2],
    ["happ://crypt2/", 1],
    ["happ://crypt/", 0],
  ];
  const input = String(value || "").trim();
  for (const [prefix, mode] of prefixes) {
    if (input.toLowerCase().startsWith(prefix)) return { mode, payload: input.slice(prefix.length), name: prefix.slice(7, -1) };
  }
  return null;
}

export async function decryptHappCrypt(value) {
  const parsed = parseCryptMode(value);
  if (!parsed) throw new Error("Unsupported Happ crypt prefix");
  if (!parsed.payload) throw new Error("Empty crypt payload");

  if (parsed.mode === 4) {
    const step1 = m4831f(parsed.payload);
    const step2 = await decryptCrypt5(step1);
    const step3 = m4842j(step2);
    return bytesToText(b64DecodeBytes(step3));
  }

  return rsaDecrypt((await loadNativeKeys())[parsed.mode], parsed.payload);
}
