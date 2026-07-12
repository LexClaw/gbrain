-- Rollback for the separately reviewed sync reconciliation DBA bootstrap.
-- Refuses to drop roles while memberships remain, so callers must revoke app-role membership first.

REVOKE USAGE ON SCHEMA public FROM gbrain_normal_sync, gbrain_reconciliation_approve, gbrain_reconciliation_apply, gbrain_source_repair, gbrain_hard_purge;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM gbrain_normal_sync, gbrain_reconciliation_approve, gbrain_reconciliation_apply, gbrain_source_repair, gbrain_hard_purge;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM gbrain_normal_sync, gbrain_reconciliation_approve, gbrain_reconciliation_apply, gbrain_source_repair, gbrain_hard_purge;

DROP ROLE IF EXISTS gbrain_hard_purge;
DROP ROLE IF EXISTS gbrain_source_repair;
DROP ROLE IF EXISTS gbrain_reconciliation_apply;
DROP ROLE IF EXISTS gbrain_reconciliation_approve;
DROP ROLE IF EXISTS gbrain_normal_sync;
DROP ROLE IF EXISTS gbrain_reconciliation_owner;
