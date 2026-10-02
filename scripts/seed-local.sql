-- SAMPLE DATA FOR LOCAL VISUAL QA. LOCAL D1 ONLY. NEVER APPLY REMOTELY.
--
-- Creates one sample workspace, "Example Co (sample data)" (slug
-- example-co), with the seven default statuses, twelve sample orders and a
-- few note and status events. Every row id starts with "sample-", every
-- customer email is @example.com, every order is tagged sample-data and its
-- checkout note says it is sample data. Order dates are relative to the
-- moment you apply the script, so the desk always looks current.
--
-- 1. Apply it to the LOCAL database (never add --remote):
--      npx wrangler d1 execute orderingdesk --local --file scripts/seed-local.sql
--    Re-running it resets the sample orders, events and statuses; the
--    workspace row and its members are kept.
--
-- 2. Sign in locally:
--      npm run dev
--    open http://localhost:3000/sign-in and enter your email. Local dev
--    never sends email: the dev server log prints a line starting with
--    [email-fallback] whose "url" is the magic link. Open that URL in the
--    same browser to finish signing in.
--
-- 3. Add yourself to the sample workspace (your user row exists after the
--    first sign-in; replace the address with the one you signed in with):
--      npx wrangler d1 execute orderingdesk --local --command "INSERT INTO workspace_members (id, workspace_id, user_id, role) SELECT 'sample-member-' || id, 'sample-ws-example-co', id, 'owner' FROM user WHERE email = 'you@example.com' ON CONFLICT DO NOTHING;"
--
-- 4. Open http://localhost:3000/w/example-co
--
-- Two orders carry status keys that are not in the status list
-- (legacy_review, backorder) so the "Unknown status" chip shows; two are
-- marked itemsTruncated so the "more items in Shopify" marker and the
-- drawer notice show. Sample orders have no Shopify order number, so the
-- "Open in Shopify" link stays hidden for them even with a store connected.

-- Workspace (upsert, so memberships added in step 3 survive a re-run).
INSERT INTO workspaces (id, name, slug, accent_color, logo_url, created_by, created_at)
VALUES ('sample-ws-example-co', 'Example Co (sample data)', 'example-co', '#91d500', NULL, 'sample-user-marta', unixepoch() * 1000 - 30 * 86400000)
ON CONFLICT (id) DO UPDATE SET name = excluded.name, slug = excluded.slug, accent_color = excluded.accent_color;

INSERT INTO workspace_settings (workspace_id, notification_emails, po_prefix, reply_to, from_name)
VALUES ('sample-ws-example-co', '[]', 'EX', NULL, NULL)
ON CONFLICT (workspace_id) DO NOTHING;

-- A sample teammate, so timeline entries show a member's name.
INSERT INTO user (id, name, email, email_verified, image, created_at, updated_at)
VALUES ('sample-user-marta', 'Marta Ruiz (sample)', 'marta.ruiz.sample@example.com', 1, NULL, unixepoch() * 1000, unixepoch() * 1000)
ON CONFLICT (id) DO NOTHING;

INSERT INTO workspace_members (id, workspace_id, user_id, role, last_seen_at)
VALUES ('sample-member-marta', 'sample-ws-example-co', 'sample-user-marta', 'member', 0)
ON CONFLICT DO NOTHING;

-- Reset the sample content.
DELETE FROM events WHERE workspace_id = 'sample-ws-example-co';
DELETE FROM orders WHERE workspace_id = 'sample-ws-example-co';
DELETE FROM statuses WHERE workspace_id = 'sample-ws-example-co';

-- The seven default statuses, as POST /api/workspaces seeds them.
INSERT INTO statuses (id, workspace_id, key, label, color, sort, triggers_po) VALUES
  ('sample-st-new', 'sample-ws-example-co', 'new', 'New', 'lime', 0, 0),
  ('sample-st-processing', 'sample-ws-example-co', 'processing', 'Processing', 'blue', 1, 0),
  ('sample-st-on-hold', 'sample-ws-example-co', 'on_hold', 'On Hold', 'amber', 2, 0),
  ('sample-st-approved', 'sample-ws-example-co', 'approved', 'Approved', 'green', 3, 1),
  ('sample-st-shipped', 'sample-ws-example-co', 'shipped', 'Shipped', 'violet', 4, 0),
  ('sample-st-delivered', 'sample-ws-example-co', 'delivered', 'Delivered', 'slate', 5, 0),
  ('sample-st-issue', 'sample-ws-example-co', 'issue', 'Issue', 'red', 6, 0);

-- Orders, newest first. The snapshot JSON matches what the sync stores.
INSERT INTO orders (id, workspace_id, shopify_order_id, name, shopify, status_key, status_set_by, status_set_at, created_at, synced_at) VALUES
('sample-order-1012', 'sample-ws-example-co', 'sample-1012', '#1012', json_object(
  'shopifyOrderId', 'sample-1012', 'name', '#1012', 'createdAt', unixepoch() * 1000 - 35 * 60000,
  'customerName', 'Priya Raman', 'email', 'priya.raman@example.com',
  'total', '126.56', 'currency', 'CAD', 'financialStatus', 'paid', 'fulfillmentStatus', 'unfulfilled',
  'items', json_array(
    json_object('title', 'Crew Hoodie', 'qty', 2, 'price', '45.00', 'sku', 'EX-HD-NV-L', 'variant', 'Navy / L'),
    json_object('title', 'Trucker Cap', 'qty', 1, 'price', '22.00', 'sku', 'EX-CAP-BK', 'variant', 'Black')),
  'itemsTruncated', json('false'),
  'shipping', json_object('name', 'Priya Raman', 'a1', '1871 Barrington St', 'a2', 'Suite 400', 'city', 'Halifax', 'prov', 'NS', 'zip', 'B3J 2A1', 'country', 'CA'),
  'tags', 'sample-data', 'note', 'Sample data for local testing.'),
  'new', NULL, NULL, unixepoch() * 1000 - 35 * 60000, unixepoch() * 1000),

('sample-order-1011', 'sample-ws-example-co', 'sample-1011', '#1011', json_object(
  'shopifyOrderId', 'sample-1011', 'name', '#1011', 'createdAt', unixepoch() * 1000 - 3 * 3600000,
  'customerName', 'Tomás Ferreira', 'email', 'tomas.ferreira@example.com',
  'total', '157.07', 'currency', 'CAD', 'financialStatus', 'paid', 'fulfillmentStatus', 'unfulfilled',
  'items', json_array(
    json_object('title', 'Insulated Work Jacket', 'qty', 1, 'price', '139.00', 'sku', 'EX-JKT-CH-XL', 'variant', 'Charcoal / XL')),
  'itemsTruncated', json('false'),
  'shipping', json_object('name', 'Tomás Ferreira', 'a1', '45 Wright Ave', 'a2', '', 'city', 'Dartmouth', 'prov', 'NS', 'zip', 'B3B 1G6', 'country', 'CA'),
  'tags', 'sample-data', 'note', 'Sample data for local testing. Please ship before Friday.'),
  'new', NULL, NULL, unixepoch() * 1000 - 3 * 3600000, unixepoch() * 1000),

('sample-order-1010', 'sample-ws-example-co', 'sample-1010', '#1010', json_object(
  'shopifyOrderId', 'sample-1010', 'name', '#1010', 'createdAt', unixepoch() * 1000 - 7 * 3600000,
  'customerName', 'Grace Okafor', 'email', 'grace.okafor@example.com',
  'total', '88.14', 'currency', 'CAD', 'financialStatus', 'paid', 'fulfillmentStatus', 'unfulfilled',
  'items', json_array(
    json_object('title', 'Hi-Vis Safety Vest', 'qty', 2, 'price', '18.00', 'sku', 'EX-VST-OR-M', 'variant', 'Orange / M'),
    json_object('title', 'Steel Water Bottle', 'qty', 1, 'price', '24.00', 'sku', 'EX-BTL-750', 'variant', '750 ml'),
    json_object('title', 'Logo Sticker Pack', 'qty', 1, 'price', '6.00', 'sku', 'EX-STK-10', 'variant', 'Pack of 10')),
  'itemsTruncated', json('false'),
  'shipping', json_object('name', 'Grace Okafor', 'a1', '210 Main St', 'a2', '', 'city', 'Moncton', 'prov', 'NB', 'zip', 'E1C 1B9', 'country', 'CA'),
  'tags', 'sample-data', 'note', 'Sample data for local testing.'),
  'processing', 'sample-user-marta', unixepoch() * 1000 - 5 * 3600000, unixepoch() * 1000 - 7 * 3600000, unixepoch() * 1000),

('sample-order-1009', 'sample-ws-example-co', 'sample-1009', '#1009', json_object(
  'shopifyOrderId', 'sample-1009', 'name', '#1009', 'createdAt', unixepoch() * 1000 - 26 * 3600000,
  'customerName', 'Liam Chen', 'email', 'liam.chen@example.com',
  'total', '2348.50', 'currency', 'CAD', 'financialStatus', 'paid', 'fulfillmentStatus', 'unfulfilled',
  'items', json_array(
    json_object('title', 'Crew Hoodie', 'qty', 12, 'price', '45.00', 'sku', 'EX-HD-NV-M', 'variant', 'Navy / M'),
    json_object('title', 'Crew Hoodie', 'qty', 10, 'price', '45.00', 'sku', 'EX-HD-NV-L', 'variant', 'Navy / L'),
    json_object('title', 'Trucker Cap', 'qty', 20, 'price', '22.00', 'sku', 'EX-CAP-BK', 'variant', 'Black'),
    json_object('title', 'Hi-Vis Safety Vest', 'qty', 15, 'price', '18.00', 'sku', 'EX-VST-OR-L', 'variant', 'Orange / L'),
    json_object('title', 'Steel Water Bottle', 'qty', 12, 'price', '24.00', 'sku', 'EX-BTL-750', 'variant', '750 ml'),
    json_object('title', 'Insulated Work Jacket', 'qty', 2, 'price', '139.00', 'sku', 'EX-JKT-CH-L', 'variant', 'Charcoal / L')),
  'itemsTruncated', json('true'),
  'shipping', json_object('name', 'Liam Chen, Yard Operations', 'a1', '3 Commerce Way', 'a2', 'Receiving dock B', 'city', 'Truro', 'prov', 'NS', 'zip', 'B2N 5B2', 'country', 'CA'),
  'tags', 'sample-data, team-order', 'note', 'Sample data for local testing. Team order for the new yard crew.'),
  'processing', 'sample-user-marta', unixepoch() * 1000 - 20 * 3600000, unixepoch() * 1000 - 26 * 3600000, unixepoch() * 1000),

('sample-order-1008', 'sample-ws-example-co', 'sample-1008', '#1008', json_object(
  'shopifyOrderId', 'sample-1008', 'name', '#1008', 'createdAt', unixepoch() * 1000 - 30 * 3600000,
  'customerName', 'Hannah Dube', 'email', 'hannah.dube@example.com',
  'total', '64.40', 'currency', 'CAD', 'financialStatus', 'pending', 'fulfillmentStatus', 'unfulfilled',
  'items', json_array(
    json_object('title', 'Quarter-Zip Pullover', 'qty', 1, 'price', '56.00', 'sku', 'EX-QZ-GR-S', 'variant', 'Heather Grey / S')),
  'itemsTruncated', json('false'),
  'shipping', json_object('name', 'Hannah Dube', 'a1', '88 Kent St', 'a2', '', 'city', 'Charlottetown', 'prov', 'PE', 'zip', 'C1A 1M9', 'country', 'CA'),
  'tags', 'sample-data, needs-approval', 'note', 'Sample data for local testing. Waiting on cost centre approval.'),
  'on_hold', 'sample-user-marta', unixepoch() * 1000 - 28 * 3600000, unixepoch() * 1000 - 30 * 3600000, unixepoch() * 1000),

('sample-order-1007', 'sample-ws-example-co', 'sample-1007', '#1007', json_object(
  'shopifyOrderId', 'sample-1007', 'name', '#1007', 'createdAt', unixepoch() * 1000 - 2 * 86400000,
  'customerName', 'Marcus Lee', 'email', 'marcus.lee@example.com',
  'total', '412.85', 'currency', 'CAD', 'financialStatus', 'paid', 'fulfillmentStatus', 'unfulfilled',
  'items', json_array(
    json_object('title', 'Insulated Work Jacket', 'qty', 2, 'price', '139.00', 'sku', 'EX-JKT-CH-M', 'variant', 'Charcoal / M'),
    json_object('title', 'Crew Hoodie', 'qty', 2, 'price', '45.00', 'sku', 'EX-HD-NV-M', 'variant', 'Navy / M')),
  'itemsTruncated', json('false'),
  'shipping', json_object('name', 'Marcus Lee', 'a1', '1500 Bedford Hwy', 'a2', 'Unit 12', 'city', 'Bedford', 'prov', 'NS', 'zip', 'B4A 1E3', 'country', 'CA'),
  'tags', 'sample-data', 'note', 'Sample data for local testing.'),
  'approved', 'sample-user-marta', unixepoch() * 1000 - 40 * 3600000, unixepoch() * 1000 - 2 * 86400000, unixepoch() * 1000),

('sample-order-1006', 'sample-ws-example-co', 'sample-1006', '#1006', json_object(
  'shopifyOrderId', 'sample-1006', 'name', '#1006', 'createdAt', unixepoch() * 1000 - 3 * 86400000,
  'customerName', 'Sofia Marchetti', 'email', 'sofia.marchetti@example.com',
  'total', '50.85', 'currency', 'CAD', 'financialStatus', 'paid', 'fulfillmentStatus', 'fulfilled',
  'items', json_array(
    json_object('title', 'Trucker Cap', 'qty', 1, 'price', '22.00', 'sku', 'EX-CAP-GN', 'variant', 'Green'),
    json_object('title', 'Steel Water Bottle', 'qty', 1, 'price', '24.00', 'sku', 'EX-BTL-750', 'variant', '750 ml')),
  'itemsTruncated', json('false'),
  'shipping', json_object('name', 'Sofia Marchetti', 'a1', '9 Water St', 'a2', '', 'city', 'St. John''s', 'prov', 'NL', 'zip', 'A1C 1A1', 'country', 'CA'),
  'tags', 'sample-data', 'note', 'Sample data for local testing.'),
  'shipped', 'sample-user-marta', unixepoch() * 1000 - 50 * 3600000, unixepoch() * 1000 - 3 * 86400000, unixepoch() * 1000),

('sample-order-1005', 'sample-ws-example-co', 'sample-1005', '#1005', json_object(
  'shopifyOrderId', 'sample-1005', 'name', '#1005', 'createdAt', unixepoch() * 1000 - 4 * 86400000,
  'customerName', 'Owen Gallagher', 'email', 'owen.gallagher@example.com',
  'total', '20.34', 'currency', 'CAD', 'financialStatus', 'paid', 'fulfillmentStatus', 'fulfilled',
  'items', json_array(
    json_object('title', 'Logo Sticker Pack', 'qty', 3, 'price', '6.00', 'sku', 'EX-STK-10', 'variant', 'Pack of 10')),
  'itemsTruncated', json('false'),
  'shipping', json_object('name', 'Owen Gallagher', 'a1', '77 Prince St', 'a2', '', 'city', 'Sydney', 'prov', 'NS', 'zip', 'B1P 5J9', 'country', 'CA'),
  'tags', 'sample-data', 'note', 'Sample data for local testing.'),
  'shipped', 'sample-user-marta', unixepoch() * 1000 - 70 * 3600000, unixepoch() * 1000 - 4 * 86400000, unixepoch() * 1000),

('sample-order-1004', 'sample-ws-example-co', 'sample-1004', '#1004', json_object(
  'shopifyOrderId', 'sample-1004', 'name', '#1004', 'createdAt', unixepoch() * 1000 - 6 * 86400000,
  'customerName', 'Aisha Karimi', 'email', 'aisha.karimi@example.com',
  'total', '203.40', 'currency', 'CAD', 'financialStatus', 'paid', 'fulfillmentStatus', 'fulfilled',
  'items', json_array(
    json_object('title', 'Softshell Vest', 'qty', 1, 'price', '84.00', 'sku', 'EX-SSV-BK-M', 'variant', 'Black / M'),
    json_object('title', 'Quarter-Zip Pullover', 'qty', 1, 'price', '56.00', 'sku', 'EX-QZ-GR-M', 'variant', 'Heather Grey / M'),
    json_object('title', 'Trucker Cap', 'qty', 2, 'price', '22.00', 'sku', 'EX-CAP-BK', 'variant', 'Black')),
  'itemsTruncated', json('false'),
  'shipping', json_object('name', 'Aisha Karimi', 'a1', '400 Queen St', 'a2', '', 'city', 'Fredericton', 'prov', 'NB', 'zip', 'E3B 1B6', 'country', 'CA'),
  'tags', 'sample-data', 'note', 'Sample data for local testing.'),
  'delivered', 'sample-user-marta', unixepoch() * 1000 - 2 * 86400000, unixepoch() * 1000 - 6 * 86400000, unixepoch() * 1000),

('sample-order-1003', 'sample-ws-example-co', 'sample-1003', '#1003', json_object(
  'shopifyOrderId', 'sample-1003', 'name', '#1003', 'createdAt', unixepoch() * 1000 - 9 * 86400000,
  'customerName', 'Ben Tremblay', 'email', 'ben.tremblay@example.com',
  'total', '45.20', 'currency', 'CAD', 'financialStatus', 'paid', 'fulfillmentStatus', 'unfulfilled',
  'items', json_array(
    json_object('title', 'Crew Hoodie', 'qty', 1, 'price', '45.00', 'sku', 'EX-HD-RD-S', 'variant', 'Red / S')),
  'itemsTruncated', json('false'),
  'shipping', NULL,
  'tags', 'sample-data, pickup', 'note', 'Sample data for local testing. Picking up at the Halifax branch.'),
  'legacy_review', NULL, NULL, unixepoch() * 1000 - 9 * 86400000, unixepoch() * 1000),

('sample-order-1002', 'sample-ws-example-co', 'sample-1002', '#1002', json_object(
  'shopifyOrderId', 'sample-1002', 'name', '#1002', 'createdAt', unixepoch() * 1000 - 13 * 86400000,
  'customerName', 'Chloe Nguyen', 'email', 'chloe.nguyen@example.com',
  'total', '978.10', 'currency', 'CAD', 'financialStatus', 'paid', 'fulfillmentStatus', 'partially fulfilled',
  'items', json_array(
    json_object('title', 'Softshell Vest', 'qty', 6, 'price', '84.00', 'sku', 'EX-SSV-BK-L', 'variant', 'Black / L'),
    json_object('title', 'Hi-Vis Safety Vest', 'qty', 10, 'price', '18.00', 'sku', 'EX-VST-YL-L', 'variant', 'Yellow / L'),
    json_object('title', 'Steel Water Bottle', 'qty', 6, 'price', '24.00', 'sku', 'EX-BTL-750', 'variant', '750 ml')),
  'itemsTruncated', json('true'),
  'shipping', json_object('name', 'Chloe Nguyen, Branch Office', 'a1', '120 Industrial Dr', 'a2', '', 'city', 'Saint John', 'prov', 'NB', 'zip', 'E2L 4L1', 'country', 'CA'),
  'tags', 'sample-data, team-order', 'note', 'Sample data for local testing.'),
  'backorder', NULL, NULL, unixepoch() * 1000 - 13 * 86400000, unixepoch() * 1000),

('sample-order-1001', 'sample-ws-example-co', 'sample-1001', '#1001', json_object(
  'shopifyOrderId', 'sample-1001', 'name', '#1001', 'createdAt', unixepoch() * 1000 - 20 * 86400000,
  'customerName', 'Daniel Kowalski', 'email', 'daniel.kowalski@example.com',
  'total', '31.64', 'currency', 'CAD', 'financialStatus', 'partially refunded', 'fulfillmentStatus', 'fulfilled',
  'items', json_array(
    json_object('title', 'Trucker Cap', 'qty', 1, 'price', '22.00', 'sku', 'EX-CAP-BK', 'variant', 'Black'),
    json_object('title', 'Logo Sticker Pack', 'qty', 1, 'price', '6.00', 'sku', 'EX-STK-10', 'variant', 'Pack of 10')),
  'itemsTruncated', json('false'),
  'shipping', json_object('name', 'Daniel Kowalski', 'a1', '15 Ochterloney St', 'a2', '', 'city', 'Dartmouth', 'prov', 'NS', 'zip', 'B2Y 4M9', 'country', 'CA'),
  'tags', 'sample-data', 'note', 'Sample data for local testing. Cap arrived damaged; partial refund issued.'),
  'issue', 'sample-user-marta', unixepoch() * 1000 - 18 * 86400000, unixepoch() * 1000 - 20 * 86400000, unixepoch() * 1000);

-- The "new order" event the sync writes for each order.
INSERT INTO events (id, workspace_id, order_id, type, text, actor_id, meta, created_at)
SELECT 'sample-evt-new-' || id, workspace_id, id, 'order_new',
  'New order ' || name || ' from ' || json_extract(shopify, '$.customerName'), NULL,
  json_object('orderName', name), created_at
FROM orders WHERE workspace_id = 'sample-ws-example-co';

-- Status changes by the sample teammate, matching each order's status_set_at.
INSERT INTO events (id, workspace_id, order_id, type, text, actor_id, meta, created_at)
SELECT 'sample-evt-status-' || o.id, o.workspace_id, o.id, 'status', 'Status set to ' || s.label,
  'sample-user-marta', json_object('from', 'new', 'to', o.status_key), o.status_set_at
FROM orders o JOIN statuses s ON s.workspace_id = o.workspace_id AND s.key = o.status_key
WHERE o.workspace_id = 'sample-ws-example-co' AND o.status_set_at IS NOT NULL;

-- A few notes.
INSERT INTO events (id, workspace_id, order_id, type, text, actor_id, meta, created_at) VALUES
  ('sample-evt-note-1', 'sample-ws-example-co', 'sample-order-1009', 'note',
   'Confirmed sizes with Liam. The rest of the line items are in Shopify; pull the full list before ordering.',
   'sample-user-marta', NULL, unixepoch() * 1000 - 19 * 3600000),
  ('sample-evt-note-2', 'sample-ws-example-co', 'sample-order-1008', 'note',
   'Emailed the cost centre owner for approval.' || char(10) || 'Will follow up Monday if there is no answer.',
   'sample-user-marta', NULL, unixepoch() * 1000 - 27 * 3600000),
  ('sample-evt-note-3', 'sample-ws-example-co', 'sample-order-1001', 'note',
   'Customer sent a photo of the damaged cap. Refund approved for the cap only.',
   'sample-user-marta', NULL, unixepoch() * 1000 - 18 * 86400000 + 600000);
