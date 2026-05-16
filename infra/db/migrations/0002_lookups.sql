-- 0002_lookups.sql
-- Per-connection lookup tables (brief §5 / v2 spec §16). Used by the mapping
-- engine to translate Shopify values into NS internal IDs.
--
-- M0 only creates the tables; M1 mapping engine reads from them. All tables
-- are keyed by (environment, connection_id, <source_key>) so multi-tenancy is
-- maintained.

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

-------------------------------------------------------------------------------
-- lookup_payment_method
--   shopify gateway (e.g. shopify_payments, paypal) → NS account + payment item
-------------------------------------------------------------------------------
IF OBJECT_ID('dbo.lookup_payment_method', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.lookup_payment_method (
    environment       NVARCHAR(16)  NOT NULL,
    connection_id     NVARCHAR(64)  NOT NULL,
    shopify_gateway   NVARCHAR(64)  NOT NULL,
    ns_account_id     NVARCHAR(64)  NOT NULL,
    ns_payment_item   NVARCHAR(64)  NULL,
    CONSTRAINT pk_lookup_payment_method
      PRIMARY KEY (environment, connection_id, shopify_gateway)
  );
END
GO

-------------------------------------------------------------------------------
-- lookup_ship_method
--   shopify shipping line title → NS shipping item
-------------------------------------------------------------------------------
IF OBJECT_ID('dbo.lookup_ship_method', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.lookup_ship_method (
    environment            NVARCHAR(16)  NOT NULL,
    connection_id          NVARCHAR(64)  NOT NULL,
    shopify_shipping_title NVARCHAR(255) NOT NULL,
    ns_ship_item_id        NVARCHAR(64)  NOT NULL,
    CONSTRAINT pk_lookup_ship_method
      PRIMARY KEY (environment, connection_id, shopify_shipping_title)
  );
END
GO

-------------------------------------------------------------------------------
-- lookup_tax
--   shopify tax title → NS tax code / detail
--   (used by both SuiteTax and Legacy tax strategies)
-------------------------------------------------------------------------------
IF OBJECT_ID('dbo.lookup_tax', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.lookup_tax (
    environment       NVARCHAR(16)  NOT NULL,
    connection_id     NVARCHAR(64)  NOT NULL,
    shopify_tax_title NVARCHAR(255) NOT NULL,
    ns_tax_code_id    NVARCHAR(64)  NOT NULL,
    ns_tax_rate       DECIMAL(8,5)  NULL,
    CONSTRAINT pk_lookup_tax
      PRIMARY KEY (environment, connection_id, shopify_tax_title)
  );
END
GO

-------------------------------------------------------------------------------
-- lookup_location
--   shopify location GID → NS location internal id
-------------------------------------------------------------------------------
IF OBJECT_ID('dbo.lookup_location', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.lookup_location (
    environment         NVARCHAR(16)  NOT NULL,
    connection_id       NVARCHAR(64)  NOT NULL,
    shopify_location_id NVARCHAR(255) NOT NULL,
    ns_location_id      NVARCHAR(64)  NOT NULL,
    CONSTRAINT pk_lookup_location
      PRIMARY KEY (environment, connection_id, shopify_location_id)
  );
END
GO

-------------------------------------------------------------------------------
-- lookup_currency
--   shopify currency code → NS currency internal id
-------------------------------------------------------------------------------
IF OBJECT_ID('dbo.lookup_currency', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.lookup_currency (
    environment    NVARCHAR(16)  NOT NULL,
    connection_id  NVARCHAR(64)  NOT NULL,
    currency_code  CHAR(3)       NOT NULL,
    ns_currency_id NVARCHAR(64)  NOT NULL,
    CONSTRAINT pk_lookup_currency
      PRIMARY KEY (environment, connection_id, currency_code)
  );
END
GO
