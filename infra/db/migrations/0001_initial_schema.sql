-- 0001_initial_schema.sql  (PostgreSQL)
-- Initial schema for dp-integrator on Azure Database for PostgreSQL Flexible Server.
--
-- Per brief §5: env-scoped state everywhere; entity_type enum carries future
-- values so M2+ adds no migration.
--
-- Idempotent — safe to re-run during dev (all `CREATE … IF NOT EXISTS`).
-- A real migration runner (dbmate / golang-migrate / etc.) lands in Slice B
-- alongside the actual SqlXrefStore impl.

------------------------------------------------------------------------------
-- connections — one row per Shopify store → NS account mapping
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connections (
  connection_id              VARCHAR(64)  NOT NULL,
  environment                VARCHAR(16)  NOT NULL CHECK (environment IN ('dev','sandbox','prod')),
  shopify_store              VARCHAR(255) NOT NULL,
  shopify_app_token_ref      VARCHAR(255) NULL,
  shopify_client_id_ref      VARCHAR(255) NULL,
  shopify_client_secret_ref  VARCHAR(255) NULL,
  shopify_webhook_secret_ref VARCHAR(255) NOT NULL,
  ns_account_id              VARCHAR(64)  NOT NULL,
  ns_subsidiary              VARCHAR(64)  NOT NULL,
  ns_location                VARCHAR(64)  NULL,
  base_currency              CHAR(3)      NOT NULL,
  tax_engine                 VARCHAR(16)  NOT NULL CHECK (tax_engine IN ('suitetax','legacy')),
  order_target               VARCHAR(16)  NOT NULL CHECK (order_target IN ('sales_order','cash_sale')),
  eligibility_rule           JSONB        NULL,
  map_version                VARCHAR(32)  NOT NULL,
  enabled                    BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at                 TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_connections_shopify_auth CHECK (
    shopify_app_token_ref IS NOT NULL OR
    (shopify_client_id_ref IS NOT NULL AND shopify_client_secret_ref IS NOT NULL)
  ),
  CONSTRAINT pk_connections PRIMARY KEY (environment, connection_id)
);

------------------------------------------------------------------------------
-- entity_xref — the idempotency backbone (brief §4).
-- Dedup key: (environment, connection_id, entity_type, source_system, source_id).
-- entity_type CHECK already includes future values.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entity_xref (
  environment     VARCHAR(16)  NOT NULL CHECK (environment IN ('dev','sandbox','prod')),
  connection_id   VARCHAR(64)  NOT NULL,
  entity_type     VARCHAR(32)  NOT NULL CHECK (entity_type IN (
                    'order','customer','refund','cancellation','fulfillment','item'
                  )),
  source_system   VARCHAR(16)  NOT NULL CHECK (source_system IN ('shopify','netsuite')),
  source_id       VARCHAR(512) NOT NULL,
  target_system   VARCHAR(16)  NOT NULL CHECK (target_system IN ('shopify','netsuite')),
  target_id       VARCHAR(64)  NULL,
  target_external VARCHAR(512) NOT NULL,
  source_hash     VARCHAR(128) NULL,
  status          VARCHAR(16)  NOT NULL CHECK (status IN ('pending','deferred','synced','error','ignored')),
  claimed_at      TIMESTAMPTZ  NULL,
  last_synced_at  TIMESTAMPTZ  NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT pk_entity_xref PRIMARY KEY (environment, connection_id, entity_type, source_system, source_id)
);

CREATE INDEX IF NOT EXISTS ix_entity_xref_target_external
  ON entity_xref(environment, target_system, target_external);

------------------------------------------------------------------------------
-- sync_watermarks — for catch-up polling (M3).
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_watermarks (
  environment   VARCHAR(16)  NOT NULL CHECK (environment IN ('dev','sandbox','prod')),
  connection_id VARCHAR(64)  NOT NULL,
  flow          VARCHAR(64)  NOT NULL,
  last_cursor   VARCHAR(512) NULL,
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT pk_sync_watermarks PRIMARY KEY (environment, connection_id, flow)
);

------------------------------------------------------------------------------
-- error_records — error console + replay surface (brief §13).
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS error_records (
  id            BIGSERIAL    PRIMARY KEY,
  environment   VARCHAR(16)  NOT NULL CHECK (environment IN ('dev','sandbox','prod')),
  connection_id VARCHAR(64)  NOT NULL,
  flow          VARCHAR(64)  NOT NULL,
  dedup_key     VARCHAR(1024) NOT NULL,
  error_class   VARCHAR(32)  NOT NULL CHECK (error_class IN (
                  'transient','data','auth','unmapped_construct','unknown'
                )),
  message       TEXT         NOT NULL,
  stack         TEXT         NULL,
  envelope      JSONB        NULL,
  retry_count   INTEGER      NOT NULL DEFAULT 0,
  status        VARCHAR(16)  NOT NULL CHECK (status IN (
                  'open','retrying','resolved','ignored','quarantined'
                )),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_error_records_status
  ON error_records(environment, connection_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_error_records_dedup
  ON error_records(dedup_key, status);

------------------------------------------------------------------------------
-- reconciliation_snapshots — daily audit sweep output (brief §9, M3).
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reconciliation_snapshots (
  environment         VARCHAR(16)   NOT NULL CHECK (environment IN ('dev','sandbox','prod')),
  connection_id       VARCHAR(64)   NOT NULL,
  business_date       DATE          NOT NULL,
  shopify_order_count INTEGER       NOT NULL,
  ns_txn_count        INTEGER       NOT NULL,
  shopify_total       DECIMAL(18,4) NOT NULL,
  ns_total            DECIMAL(18,4) NOT NULL,
  discrepancy         JSONB         NULL,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT pk_reconciliation_snapshots PRIMARY KEY (environment, connection_id, business_date)
);
