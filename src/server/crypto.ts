// AES-GCM encryption for store tokens. WebCrypto only (crypto.subtle), so it
// runs on workerd. Payload format: "v1." + base64(iv) + "." + base64(ciphertext).
// A single ENCRYPTION_KEY secret is in use; the v1 prefix reserves room for key
// rotation (a future version can change the key or layout without ambiguity).
// Callers bind a ciphertext to its row by passing the workspaceId as aad
// (AES-GCM additionalData), so a payload copied onto another row fails to decrypt.

const VERSION = "v1";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function importKey(base64Key: string): Promise<CryptoKey> {
  const raw = fromBase64(base64Key);
  if (raw.length !== 32) {
    throw new Error("Encryption key must be 32 bytes of base64-encoded data");
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function gcmParams(iv: Uint8Array<ArrayBuffer>, aad?: string): AesGcmParams {
  const params: AesGcmParams = { name: "AES-GCM", iv };
  if (aad) {
    params.additionalData = new TextEncoder().encode(aad);
  }
  return params;
}

export async function encryptSecret(plaintext: string, base64Key: string, aad?: string): Promise<string> {
  const key = await importKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    gcmParams(iv, aad),
    key,
    new TextEncoder().encode(plaintext),
  );
  return VERSION + "." + toBase64(iv) + "." + toBase64(new Uint8Array(ciphertext));
}

export async function decryptSecret(payload: string, base64Key: string, aad?: string): Promise<string> {
  const parts = payload.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION || parts[1].length === 0 || parts[2].length === 0) {
    throw new Error("Invalid encrypted payload format");
  }
  let iv: Uint8Array<ArrayBuffer>;
  let ciphertext: Uint8Array<ArrayBuffer>;
  try {
    iv = fromBase64(parts[1]);
    ciphertext = fromBase64(parts[2]);
  } catch {
    throw new Error("Invalid encrypted payload format");
  }
  if (iv.length !== 12) {
    throw new Error("Invalid encrypted payload format");
  }
  const key = await importKey(base64Key);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(gcmParams(iv, aad), key, ciphertext);
  } catch {
    throw new Error("Decryption failed: payload is corrupt, bound to a different row, or the key is wrong");
  }
  return new TextDecoder().decode(plaintext);
}
