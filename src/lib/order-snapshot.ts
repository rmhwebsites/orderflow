// Reads the stored Shopify snapshot (orders.shopify, written by the sync
// normalizer) for the order drawer. Defensive like the server's summarize():
// a malformed snapshot shows empty fields instead of breaking the drawer.

export type SnapshotItem = { title: string; qty: number; price: string | null; sku: string; variant: string };

export type SnapshotShipping = {
  name: string;
  a1: string;
  a2: string;
  city: string;
  prov: string;
  zip: string;
  country: string;
};

export type OrderSnapshot = {
  customerName: string;
  email: string;
  total: string;
  currency: string;
  financialStatus: string;
  fulfillmentStatus: string;
  items: SnapshotItem[];
  shipping: SnapshotShipping | null;
  tags: string[];
  note: string;
};

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function readSnapshot(raw: unknown): OrderSnapshot {
  const s = isDict(raw) ? raw : {};
  const items = Array.isArray(s.items) ? s.items : [];
  const shipping = isDict(s.shipping) ? s.shipping : null;
  return {
    customerName: str(s.customerName),
    email: str(s.email),
    total: str(s.total),
    currency: str(s.currency),
    financialStatus: str(s.financialStatus),
    fulfillmentStatus: str(s.fulfillmentStatus),
    items: items.filter(isDict).map((item) => ({
      title: str(item.title),
      qty: typeof item.qty === "number" && Number.isFinite(item.qty) ? item.qty : 1,
      price: typeof item.price === "string" ? item.price : null,
      sku: str(item.sku),
      variant: str(item.variant),
    })),
    shipping: shipping
      ? {
          name: str(shipping.name),
          a1: str(shipping.a1),
          a2: str(shipping.a2),
          city: str(shipping.city),
          prov: str(shipping.prov),
          zip: str(shipping.zip),
          country: str(shipping.country),
        }
      : null,
    tags: str(s.tags)
      .split(",")
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0),
    note: str(s.note),
  };
}

// Sum of price x quantity in cents, as a decimal string; null when any item
// has no readable price (a partial sum would read as the real one).
export function itemsSubtotal(items: SnapshotItem[]): string | null {
  if (items.length === 0) {
    return null;
  }
  let cents = 0;
  for (const item of items) {
    const price = item.price === null ? NaN : Number(item.price);
    if (!Number.isFinite(price)) {
      return null;
    }
    cents += Math.round(price * 100) * item.qty;
  }
  return (cents / 100).toFixed(2);
}

export function shippingLines(shipping: SnapshotShipping): string[] {
  const locality = [shipping.city, shipping.prov, shipping.zip].filter((part) => part.length > 0).join(" ");
  return [shipping.name, shipping.a1, shipping.a2, locality, shipping.country].filter((line) => line.length > 0);
}

// Tone names (globals.css [data-tone]) for Shopify's own payment and
// fulfillment states, which the normalizer stores lowercased with spaces.
export function financialTone(status: string): string {
  if (status === "paid") {
    return "green";
  }
  if (["pending", "authorized", "partially paid", "expired"].includes(status)) {
    return "amber";
  }
  return "slate";
}

export function fulfillmentTone(status: string): string {
  if (status === "fulfilled") {
    return "green";
  }
  if (["unfulfilled", "partially fulfilled", "in progress", "on hold", "scheduled", "open"].includes(status)) {
    return "amber";
  }
  return "slate";
}
