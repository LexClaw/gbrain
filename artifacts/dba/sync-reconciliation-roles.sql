-- Separately reviewed DBA bootstrap for sync reconciliation roles.
-- Run as a DBA role in disposable rehearsal or production maintenance, not from application migrations.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gbrain_normal_sync') THEN
    CREATE ROLE gbrain_normal_sync NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gbrain_reconciliation_apply') THEN
    CREATE ROLE gbrain_reconciliation_apply NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gbrain_source_repair') THEN
    CREATE ROLE gbrain_source_repair NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gbrain_hard_purge') THEN
    CREATE ROLE gbrain_hard_purge NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO gbrain_normal_sync, gbrain_reconciliation_apply, gbrain_source_repair, gbrain_hard_purge;

GRANT SELECT, INSERT, UPDATE ON pages, content_chunks, ingest_log, sources, sync_reconciliation_audit TO gbrain_normal_sync;
GRANT SELECT ON sync_reconciliation_role_policy TO gbrain_normal_sync;
REVOKE DELETE ON pages, content_chunks, ingest_log, sources, sync_reconciliation_audit FROM gbrain_normal_sync;

GRANT SELECT, UPDATE ON pages, sync_reconciliation_audit TO gbrain_reconciliation_apply;
GRANT SELECT ON sync_reconciliation_role_policy TO gbrain_reconciliation_apply;

GRANT SELECT, UPDATE ON pages, sources, sync_reconciliation_audit TO gbrain_source_repair;
GRANT SELECT ON sync_reconciliation_role_policy TO gbrain_source_repair;

GRANT SELECT, DELETE, UPDATE ON pages, sync_reconciliation_audit TO gbrain_hard_purge;
GRANT SELECT ON sync_reconciliation_role_policy TO gbrain_hard_purge;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO gbrain_normal_sync, gbrain_reconciliation_apply, gbrain_source_repair, gbrain_hard_purge;
