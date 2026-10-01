import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core";

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  accentColor: text("accent_color").notNull().default("#91d500"),
  logoUrl: text("logo_url"),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const workspaceMembers = sqliteTable("workspace_members", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  userId: text("user_id").notNull(),
  role: text("role", { enum: ["owner", "admin", "member"] }).notNull(),
  lastSeenAt: integer("last_seen_at").notNull().default(0),
}, (t) => [uniqueIndex("member_unique").on(t.workspaceId, t.userId)]);

export const storeConnections = sqliteTable("store_connections", {
  workspaceId: text("workspace_id").primaryKey().references(() => workspaces.id),
  shopDomain: text("shop_domain").notNull(),
  encryptedToken: text("encrypted_token").notNull(),
  status: text("status", { enum: ["ok", "error", "disabled"] }).notNull().default("ok"),
  lastSyncAt: integer("last_sync_at").notNull().default(0),
  lastManualSyncAt: integer("last_manual_sync_at").notNull().default(0),
  runningUntil: integer("running_until").notNull().default(0),
  lastError: text("last_error"),
});

export const statuses = sqliteTable("statuses", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  key: text("key").notNull(),
  label: text("label").notNull(),
  color: text("color").notNull(),
  sort: integer("sort").notNull(),
  triggersPo: integer("triggers_po", { mode: "boolean" }).notNull().default(false),
}, (t) => [uniqueIndex("status_key_unique").on(t.workspaceId, t.key)]);

export const orders = sqliteTable("orders", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  shopifyOrderId: text("shopify_order_id").notNull(),
  name: text("name").notNull(),
  shopify: text("shopify", { mode: "json" }).notNull(),
  statusKey: text("status_key").notNull(),
  statusSetBy: text("status_set_by"),
  statusSetAt: integer("status_set_at"),
  createdAt: integer("created_at").notNull(),
  syncedAt: integer("synced_at").notNull(),
}, (t) => [
  uniqueIndex("order_unique").on(t.workspaceId, t.shopifyOrderId),
  index("order_ws_created").on(t.workspaceId, t.createdAt),
]);

export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  orderId: text("order_id"),
  type: text("type", { enum: ["order_new", "status", "note", "po_sent", "po_draft", "sync_error"] }).notNull(),
  text: text("text").notNull(),
  actorId: text("actor_id"),
  meta: text("meta", { mode: "json" }),
  createdAt: integer("created_at").notNull(),
}, (t) => [index("events_ws_created").on(t.workspaceId, t.createdAt), index("events_order").on(t.orderId)]);

export const vendors = sqliteTable("vendors", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
  email: text("email").notNull(),
  cc: text("cc", { mode: "json" }),
  notes: text("notes"),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
});

export const purchaseOrders = sqliteTable("purchase_orders", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  orderId: text("order_id").notNull(),
  vendorId: text("vendor_id").notNull(),
  poNumber: text("po_number").notNull(),
  lineItems: text("line_items", { mode: "json" }).notNull(),
  shipTo: text("ship_to", { mode: "json" }),
  notes: text("notes"),
  status: text("status", { enum: ["draft", "sent", "failed"] }).notNull().default("draft"),
  pdfKey: text("pdf_key"),
  sentAt: integer("sent_at"),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at").notNull(),
}, (t) => [uniqueIndex("po_number_unique").on(t.workspaceId, t.poNumber)]);

export const workspaceSettings = sqliteTable("workspace_settings", {
  workspaceId: text("workspace_id").primaryKey().references(() => workspaces.id),
  notificationEmails: text("notification_emails", { mode: "json" }).notNull().default("[]"),
  poPrefix: text("po_prefix").notNull().default("PO"),
  replyTo: text("reply_to"),
  fromName: text("from_name"),
});

export const notificationPrefs = sqliteTable("notification_prefs", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
  pushNewOrders: integer("push_new_orders", { mode: "boolean" }).notNull().default(true),
  emailNewOrders: integer("email_new_orders", { mode: "boolean" }).notNull().default(true),
  pushAllActivity: integer("push_all_activity", { mode: "boolean" }).notNull().default(false),
}, (t) => [uniqueIndex("prefs_unique").on(t.userId, t.workspaceId)]);

export const pushSubscriptions = sqliteTable("push_subscriptions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  endpoint: text("endpoint").notNull().unique(),
  keys: text("keys", { mode: "json" }).notNull(),
  userAgent: text("user_agent"),
  createdAt: integer("created_at").notNull(),
});
