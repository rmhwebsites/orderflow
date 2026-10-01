// AES-GCM encryption for store tokens. WebCrypto only (crypto.subtle), so it
// runs on workerd. Payload format: base64(iv) + "." + base64(ciphertext).

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

export async function encryptSecret(plaintext: string, base64Key: string): Promise<string> {
  const key = await importKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return toBase64(iv) + "." + toBase64(new Uint8Array(ciphertext));
}

export async function decryptSecret(payload: string, base64Key: string): Promise<string> {
  const parts = payload.split(".");
  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
    throw new Error("Invalid encrypted payload format");
  }
  let iv: Uint8Array<ArrayBuffer>;
  let ciphertext: Uint8Array<ArrayBuffer>;
  try {
    iv = fromBase64(parts[0]);
    ciphertext = fromBase64(parts[1]);
  } catch {
    throw new Error("Invalid encrypted payload format");
  }
  if (iv.length !== 12) {
    throw new Error("Invalid encrypted payload format");
  }
  const key = await importKey(base64Key);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  } catch {
    throw new Error("Decryption failed: payload is corrupt or key is wrong");
  }
  return new TextDecoder().decode(plaintext);
}
