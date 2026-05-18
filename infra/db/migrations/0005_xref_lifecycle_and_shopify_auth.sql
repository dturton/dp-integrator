-- 0005_xref_lifecycle_and_shopify_auth.sql  (PostgreSQL)
-- Adds:
--   1. deferred + claimed_at lifecycle support to entity_xref
--   2. explicit Shopify client-credential refs on connections
--   3. deferred status on order_sync_log
--
-- Idempotent — safe to re-run during dev.

ALTER TABLE connections
  ADD COLUMN IF NOT EXISTS shopify_client_id_ref VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS shopify_client_secret_ref VARCHAR(255) NULL;

ALTER TABLE connections
  ALTER COLUMN shopify_app_token_ref DROP NOT NULL;

ALTER TABLE connections
  DROP CONSTRAINT IF EXISTS chk_connections_shopify_auth;

ALTER TABLE connections
  ADD CONSTRAINT chk_connections_shopify_auth CHECK (
    shopify_app_token_ref IS NOT NULL OR
    (shopify_client_id_ref IS NOT NULL AND shopify_client_secret_ref IS NOT NULL)
  );

ALTER TABLE entity_xref
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ NULL;

ALTER TABLE entity_xref
  DROP CONSTRAINT IF EXISTS entity_xref_status_check;

ALTER TABLE entity_xref
  ADD CONSTRAINT entity_xref_status_check
  CHECK (status IN ('pending','deferred','synced','error','ignored'));

ALTER TABLE order_sync_log
  DROP CONSTRAINT IF EXISTS order_sync_log_status_check;

ALTER TABLE order_sync_log
  ADD CONSTRAINT order_sync_log_status_check
  CHECK (status IN ('imported','parked','ignored','deferred'));
