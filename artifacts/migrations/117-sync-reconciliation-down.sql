-- Down path for migration 117, sync_reconciliation_audit_and_roles.
-- Application rollback only. Cluster roles are handled by artifacts/dba/sync-reconciliation-roles-rollback.sql.

DROP TABLE IF EXISTS sync_reconciliation_role_policy;
DROP TABLE IF EXISTS sync_reconciliation_audit;
DELETE FROM schema_migrations WHERE version = 117;
