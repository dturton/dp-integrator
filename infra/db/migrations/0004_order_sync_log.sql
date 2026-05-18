-- 0004_order_sync_log.sql  (PostgreSQL)
-- Per-order ledger: one row per (environment, connection, shopify_order_gid)
-- capturing a snapshot of the order at the moment the handler reached a
-- terminal outcome (imported / parked / ignored_by_eligibility). Distinct
-- from entity_xref — that table is dedup-only and stays narrow.
--
-- This is the table that powers `dpi recent`, reconciliation reports, and
-- "where did this Shopify order land in NS?" lookups without joining live to
-- Shopify and NS each time.
--
-- Updates: the unique constraint on (env, connection_id, shopify_order_gid)
-- lets the handler do INSERT … ON CONFLICT DO UPDATE so a parked order that
-- later replays cleanly into NS transitions its row from 'parked' to
-- 'imported' without leaving stale data.
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS order_sync_log (
  id                   BIGSERIAL    PRIMARY KEY,
  environment          VARCHAR(16)  NOT NULL CHECK (environment IN ('dev','sandbox','prod')),
  connection_id        VARCHAR(64)  NOT NULL,

  -- Shopify identity
  shopify_order_gid    VARCHAR(128) NOT NULL,
  shopify_order_id     VARCHAR(64)  NOT NULL,           -- numeric tail of the GID
  shopify_order_name   VARCHAR(64)  NULL,               -- storefront "#4937"
  shopify_created_at   TIMESTAMPTZ  NULL,
  shopify_processed_at TIMESTAMPTZ  NULL,
  shopify_updated_at   TIMESTAMPTZ  NULL,
  customer_email       VARCHAR(255) NULL,

  -- Shopify totals (snapshot at sync time)
  currency_code        VARCHAR(8)   NULL,
  total_price          DECIMAL(18,4) NULL,
  subtotal_price       DECIMAL(18,4) NULL,
  total_tax            DECIMAL(18,4) NULL,
  total_discounts      DECIMAL(18,4) NULL,
  total_shipping       DECIMAL(18,4) NULL,

  -- Outcome
  status               VARCHAR(16)  NOT NULL CHECK (status IN ('imported','parked','ignored')),

  -- NetSuite link (populated when status='imported'; nullable otherwise)
  ns_account_id        VARCHAR(64)  NULL,
  ns_record_type       VARCHAR(32)  NULL,
  ns_internal_id       VARCHAR(64)  NULL,
  ns_tran_id           VARCHAR(64)  NULL,               -- NS sales order number (e.g. SO123) — backfilled later

  -- Park / ignore detail (when status≠'imported')
  park_stage           VARCHAR(32)  NULL,
  park_detail          TEXT         NULL,
  park_error_class     VARCHAR(32)  NULL,
  ignored_reason       VARCHAR(64)  NULL,

  synced_at            TIMESTAMPTZ  NULL,               -- when the NS write succeeded
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_order_sync_log_dedup UNIQUE (environment, connection_id, shopify_order_gid)
);

-- Tail recent imports for the operator dashboard (`dpi recent`).
CREATE INDEX IF NOT EXISTS ix_order_sync_log_recent
  ON order_sync_log(environment, connection_id, COALESCE(synced_at, updated_at) DESC);

-- "Find the NS record for Shopify order X" — covers the case where ops know
-- the Shopify side and want to jump to NetSuite.
CREATE INDEX IF NOT EXISTS ix_order_sync_log_ns
  ON order_sync_log(environment, ns_account_id, ns_internal_id)
  WHERE ns_internal_id IS NOT NULL;

-- Customer history view.
CREATE INDEX IF NOT EXISTS ix_order_sync_log_email
  ON order_sync_log(environment, customer_email)
  WHERE customer_email IS NOT NULL;
