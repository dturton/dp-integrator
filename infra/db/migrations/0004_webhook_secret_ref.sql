-- 0004_webhook_secret_ref.sql
-- Adds the connection-level webhook shared secret ref.
--
-- Shopify custom apps issue two distinct secrets per app:
--   - Admin API access token  → already tracked as `shopify_app_token_ref`
--                                (used by ShopifyGateway.getOrder, Slice C+).
--   - API secret key (HMAC)   → tracked here as `shopify_webhook_secret_ref`
--                                (used by the webhook receiver to verify
--                                 X-Shopify-Hmac-Sha256 on inbound deliveries).
--
-- Until the receiver loads connections from SQL (currently bootstrapped from
-- DPI_CONNECTIONS_JSON env var, Slice A), this column is unused — but keeping
-- the DDL in sync with the Connection type avoids a "later" migration surprise.

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.connections')
    AND name = 'shopify_webhook_secret_ref'
)
BEGIN
  ALTER TABLE dbo.connections
    ADD shopify_webhook_secret_ref NVARCHAR(255) NULL;
END
GO

-- Once existing rows are backfilled the column should be tightened to NOT NULL.
-- Skipped here to keep the migration safely re-runnable in dev.
