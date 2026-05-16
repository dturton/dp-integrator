-- 0001_initial_schema.sql
-- Initial Azure SQL schema for dp-integrator.
--
-- Idempotent — safe to re-run during dev. Each table is gated on a sysobjects
-- check. Real migrations in M2+ should switch to a proper tool (dbup / Flyway /
-- Sqitch); this script bootstraps the M0 schema so the gateway interfaces have
-- something to point at.
--
-- Per brief §5: env-scoped state everywhere; `entity_type` enum carries
-- future values so M2+ adds no migration.

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

-------------------------------------------------------------------------------
-- connections — one row per Shopify store → NS account mapping
-------------------------------------------------------------------------------
IF OBJECT_ID('dbo.connections', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.connections (
    connection_id           NVARCHAR(64)  NOT NULL,
    environment             NVARCHAR(16)  NOT NULL CHECK (environment IN ('dev','sandbox','prod')),
    shopify_store           NVARCHAR(255) NOT NULL,
    shopify_app_token_ref   NVARCHAR(255) NOT NULL,
    ns_account_id           NVARCHAR(64)  NOT NULL,
    ns_subsidiary           NVARCHAR(64)  NOT NULL,
    ns_location             NVARCHAR(64)  NULL,
    base_currency           CHAR(3)       NOT NULL,
    tax_engine              NVARCHAR(16)  NOT NULL CHECK (tax_engine IN ('suitetax','legacy')),
    order_target            NVARCHAR(16)  NOT NULL CHECK (order_target IN ('sales_order','cash_sale')),
    eligibility_rule        NVARCHAR(MAX) NULL,
    map_version             NVARCHAR(32)  NOT NULL,
    enabled                 BIT           NOT NULL DEFAULT 1,
    created_at              DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at              DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT pk_connections PRIMARY KEY (environment, connection_id)
  );
END
GO

-------------------------------------------------------------------------------
-- entity_xref — the idempotency backbone (brief §4).
-- Dedup key: (environment, connection_id, entity_type, source_system, source_id).
-- entity_type enum already includes future values per the brief.
-------------------------------------------------------------------------------
IF OBJECT_ID('dbo.entity_xref', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.entity_xref (
    environment       NVARCHAR(16)  NOT NULL CHECK (environment IN ('dev','sandbox','prod')),
    connection_id     NVARCHAR(64)  NOT NULL,
    entity_type       NVARCHAR(32)  NOT NULL CHECK (entity_type IN (
                        'order','customer','refund','cancellation','fulfillment','item'
                      )),
    source_system     NVARCHAR(16)  NOT NULL CHECK (source_system IN ('shopify','netsuite')),
    source_id         NVARCHAR(512) NOT NULL,
    target_system     NVARCHAR(16)  NOT NULL CHECK (target_system IN ('shopify','netsuite')),
    target_id         NVARCHAR(64)  NULL,
    target_external   NVARCHAR(512) NOT NULL,
    source_hash       NVARCHAR(128) NULL,
    status            NVARCHAR(16)  NOT NULL CHECK (status IN ('pending','synced','error','ignored')),
    last_synced_at    DATETIME2(3)  NULL,
    created_at        DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at        DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT pk_entity_xref PRIMARY KEY (environment, connection_id, entity_type, source_system, source_id)
  );
END
GO

-- Index for NS-side lookups (target_external = Shopify GID on NS records).
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_entity_xref_target_external')
  CREATE INDEX ix_entity_xref_target_external
    ON dbo.entity_xref(environment, target_system, target_external);
GO

-------------------------------------------------------------------------------
-- sync_watermarks — for catch-up polling (M3).
-------------------------------------------------------------------------------
IF OBJECT_ID('dbo.sync_watermarks', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.sync_watermarks (
    environment   NVARCHAR(16)  NOT NULL CHECK (environment IN ('dev','sandbox','prod')),
    connection_id NVARCHAR(64)  NOT NULL,
    flow          NVARCHAR(64)  NOT NULL,
    last_cursor   NVARCHAR(512) NULL,
    updated_at    DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT pk_sync_watermarks PRIMARY KEY (environment, connection_id, flow)
  );
END
GO

-------------------------------------------------------------------------------
-- error_records — error console + replay surface (brief §13).
-------------------------------------------------------------------------------
IF OBJECT_ID('dbo.error_records', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.error_records (
    id            BIGINT IDENTITY(1,1) NOT NULL,
    environment   NVARCHAR(16)  NOT NULL CHECK (environment IN ('dev','sandbox','prod')),
    connection_id NVARCHAR(64)  NOT NULL,
    flow          NVARCHAR(64)  NOT NULL,
    dedup_key     NVARCHAR(1024) NOT NULL,
    error_class   NVARCHAR(32)  NOT NULL CHECK (error_class IN (
                    'transient','data','auth','unmapped_construct','unknown'
                  )),
    [message]     NVARCHAR(MAX) NOT NULL,
    stack         NVARCHAR(MAX) NULL,
    envelope      NVARCHAR(MAX) NULL,
    retry_count   INT           NOT NULL DEFAULT 0,
    status        NVARCHAR(16)  NOT NULL CHECK (status IN (
                    'open','retrying','resolved','ignored','quarantined'
                  )),
    created_at    DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at    DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT pk_error_records PRIMARY KEY (id)
  );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_error_records_status')
  CREATE INDEX ix_error_records_status
    ON dbo.error_records(environment, connection_id, status, created_at DESC);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_error_records_dedup')
  CREATE INDEX ix_error_records_dedup
    ON dbo.error_records(dedup_key, status);
GO

-------------------------------------------------------------------------------
-- reconciliation_snapshots — daily audit sweep output (brief §9, M3).
-------------------------------------------------------------------------------
IF OBJECT_ID('dbo.reconciliation_snapshots', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.reconciliation_snapshots (
    environment           NVARCHAR(16)  NOT NULL CHECK (environment IN ('dev','sandbox','prod')),
    connection_id         NVARCHAR(64)  NOT NULL,
    business_date         DATE          NOT NULL,
    shopify_order_count   INT           NOT NULL,
    ns_txn_count          INT           NOT NULL,
    shopify_total         DECIMAL(18,4) NOT NULL,
    ns_total              DECIMAL(18,4) NOT NULL,
    discrepancy           NVARCHAR(MAX) NULL,
    created_at            DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT pk_reconciliation_snapshots PRIMARY KEY (environment, connection_id, business_date)
  );
END
GO
