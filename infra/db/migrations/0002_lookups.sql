-- 0002_lookups.sql  (PostgreSQL)
-- Per-connection lookup tables (brief §5 / v2 spec §16). Used by the mapping
-- engine to translate Shopify values into NS internal IDs.
--
-- All tables keyed by (environment, connection_id, <source_key>) so multi-tenancy
-- is maintained.

------------------------------------------------------------------------------
-- lookup_payment_method — shopify gateway → NS account + payment item
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lookup_payment_method (
  environment     VARCHAR(16) NOT NULL,
  connection_id   VARCHAR(64) NOT NULL,
  shopify_gateway VARCHAR(64) NOT NULL,
  ns_account_id   VARCHAR(64) NOT NULL,
  ns_payment_item VARCHAR(64) NULL,
  CONSTRAINT pk_lookup_payment_method
    PRIMARY KEY (environment, connection_id, shopify_gateway)
);

------------------------------------------------------------------------------
-- lookup_ship_method — shopify shipping line title → NS shipping item
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lookup_ship_method (
  environment            VARCHAR(16)  NOT NULL,
  connection_id          VARCHAR(64)  NOT NULL,
  shopify_shipping_title VARCHAR(255) NOT NULL,
  ns_ship_item_id        VARCHAR(64)  NOT NULL,
  CONSTRAINT pk_lookup_ship_method
    PRIMARY KEY (environment, connection_id, shopify_shipping_title)
);

------------------------------------------------------------------------------
-- lookup_tax — shopify tax title → NS tax code / detail
-- (used by both SuiteTax and Legacy tax strategies)
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lookup_tax (
  environment       VARCHAR(16)  NOT NULL,
  connection_id     VARCHAR(64)  NOT NULL,
  shopify_tax_title VARCHAR(255) NOT NULL,
  ns_tax_code_id    VARCHAR(64)  NOT NULL,
  ns_tax_rate       DECIMAL(8,5) NULL,
  CONSTRAINT pk_lookup_tax
    PRIMARY KEY (environment, connection_id, shopify_tax_title)
);

------------------------------------------------------------------------------
-- lookup_location — shopify location GID → NS location internal id
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lookup_location (
  environment         VARCHAR(16)  NOT NULL,
  connection_id       VARCHAR(64)  NOT NULL,
  shopify_location_id VARCHAR(255) NOT NULL,
  ns_location_id      VARCHAR(64)  NOT NULL,
  CONSTRAINT pk_lookup_location
    PRIMARY KEY (environment, connection_id, shopify_location_id)
);

------------------------------------------------------------------------------
-- lookup_currency — shopify currency code → NS currency internal id
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lookup_currency (
  environment    VARCHAR(16) NOT NULL,
  connection_id  VARCHAR(64) NOT NULL,
  currency_code  CHAR(3)     NOT NULL,
  ns_currency_id VARCHAR(64) NOT NULL,
  CONSTRAINT pk_lookup_currency
    PRIMARY KEY (environment, connection_id, currency_code)
);
