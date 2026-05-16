-- 0003_governor_slots.sql
-- Backing table for the future SqlGovernorBackingStore (brief §12, invariant 5).
--
-- Each row = one in-flight slot on an NS account. Acquired with INSERT;
-- released with DELETE WHERE holder_id = @h. A guarded INSERT pattern enforces
-- the per-account ceiling at INSERT time (see commented stored proc below);
-- the M1/M2 SQL governor implementation will own the exact procedure.
--
-- M0 ships the schema only — the in-memory governor (Shared / PerProcess)
-- covers test needs.

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID('dbo.ns_governor_slots', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.ns_governor_slots (
    ns_account_id NVARCHAR(64) NOT NULL,
    holder_id     NVARCHAR(64) NOT NULL,
    acquired_at   DATETIME2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
    /* Heartbeat for stuck-slot reaping. Bumped by the holder every N ms. */
    last_heartbeat DATETIME2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT pk_ns_governor_slots PRIMARY KEY (ns_account_id, holder_id)
  );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_ns_governor_slots_account')
  CREATE INDEX ix_ns_governor_slots_account
    ON dbo.ns_governor_slots(ns_account_id, acquired_at);
GO

/*
-- Reference stored proc shape for the SQL governor (added in M1/M2 alongside
-- the real `SqlGovernorBackingStore` impl). Left commented here so the schema
-- migration stays focused on DDL only.
--
-- CREATE OR ALTER PROCEDURE dbo.usp_governor_try_acquire
--   @ns_account_id NVARCHAR(64),
--   @holder_id     NVARCHAR(64),
--   @ceiling       INT,
--   @acquired      BIT OUTPUT
-- AS
-- BEGIN
--   SET NOCOUNT ON;
--   BEGIN TRAN;
--     IF (SELECT COUNT(*) FROM dbo.ns_governor_slots WITH (UPDLOCK, HOLDLOCK)
--         WHERE ns_account_id = @ns_account_id) < @ceiling
--     BEGIN
--       INSERT INTO dbo.ns_governor_slots(ns_account_id, holder_id)
--         VALUES (@ns_account_id, @holder_id);
--       SET @acquired = 1;
--     END
--     ELSE SET @acquired = 0;
--   COMMIT TRAN;
-- END
*/
