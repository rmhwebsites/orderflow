// HTML entity escaping for email templates. Every dynamic value interpolated
// into email HTML or subjects goes through escapeHtml; see the sendEmail JSDoc.

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ENTITIES[char]);
}

// Subjects are plain text, never HTML: no entity encoding. Strips CR/LF and
// other control characters (header-injection hygiene), collapses whitespace,
// trims.
export function sanitizeSubject(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
