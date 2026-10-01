CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`order_id` text,
	`type` text NOT NULL,
	`text` text NOT NULL,
	`actor_id` text,
	`meta` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `events_ws_created` ON `events` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `events_order` ON `events` (`order_id`);--> statement-breakpoint
CREATE TABLE `notification_prefs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`push_new_orders` integer DEFAULT true NOT NULL,
	`email_new_orders` integer DEFAULT true NOT NULL,
	`push_all_activity` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prefs_unique` ON `notification_prefs` (`user_id`,`workspace_id`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`shopify_order_id` text NOT NULL,
	`name` text NOT NULL,
	`shopify` text NOT NULL,
	`status_key` text NOT NULL,
	`status_set_by` text,
	`status_set_at` integer,
	`created_at` integer NOT NULL,
	`synced_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_unique` ON `orders` (`workspace_id`,`shopify_order_id`);--> statement-breakpoint
CREATE INDEX `order_ws_created` ON `orders` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `purchase_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`order_id` text NOT NULL,
	`vendor_id` text NOT NULL,
	`po_number` text NOT NULL,
	`line_items` text NOT NULL,
	`ship_to` text,
	`notes` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`pdf_key` text,
	`sent_at` integer,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `po_number_unique` ON `purchase_orders` (`workspace_id`,`po_number`);--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`keys` text NOT NULL,
	`user_agent` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE TABLE `statuses` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`color` text NOT NULL,
	`sort` integer NOT NULL,
	`triggers_po` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `status_key_unique` ON `statuses` (`workspace_id`,`key`);--> statement-breakpoint
CREATE TABLE `store_connections` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`shop_domain` text NOT NULL,
	`encrypted_token` text NOT NULL,
	`status` text DEFAULT 'ok' NOT NULL,
	`last_sync_at` integer DEFAULT 0 NOT NULL,
	`last_manual_sync_at` integer DEFAULT 0 NOT NULL,
	`running_until` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `vendors` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`cc` text,
	`notes` text,
	`archived` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `workspace_members` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`last_seen_at` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `member_unique` ON `workspace_members` (`workspace_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `workspace_settings` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`notification_emails` text DEFAULT '[]' NOT NULL,
	`po_prefix` text DEFAULT 'PO' NOT NULL,
	`reply_to` text,
	`from_name` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`accent_color` text DEFAULT '#91d500' NOT NULL,
	`logo_url` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_slug_unique` ON `workspaces` (`slug`);