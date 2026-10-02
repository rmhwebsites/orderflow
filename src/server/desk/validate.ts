// Shared input normalization for the desk services.

// RFC 5321 caps the full address at 254 octets.
export const EMAIL_MAX = 254;

// ASCII addresses only: a local part of RFC 5322 atext characters and dots,
// then a dotted hostname. Narrower than the RFC on purpose. These addresses
// go into outbound mail headers (vendor To and CC in Phase 7, reply-to,
// notification lists), so nothing that could split or extend a header
// (whitespace, commas, semicolons, angle brackets, quotes) is accepted.
// Matched after the length check, so its cost is bounded.
const EMAIL =
  /^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

// The trimmed, lowercased address, or null when it is not a valid one.
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const email = value.trim().toLowerCase();
  if (email.length === 0 || email.length > EMAIL_MAX || !EMAIL.test(email)) {
    return null;
  }
  return email;
}

// Up to max addresses, each normalized, deduped in first-seen order; null
// when the value is not an array, has too many entries, or any entry is
// invalid.
export function normalizeEmailList(value: unknown, max: number): string[] | null {
  if (!Array.isArray(value) || value.length > max) {
    return null;
  }
  const emails: string[] = [];
  for (const entry of value) {
    const email = normalizeEmail(entry);
    if (email === null) {
      return null;
    }
    if (!emails.includes(email)) {
      emails.push(email);
    }
  }
  return emails;
}
