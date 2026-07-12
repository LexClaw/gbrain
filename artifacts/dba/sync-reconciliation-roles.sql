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

REVOKE ALL PRIVILEGES ON pages, content_chunks, ingest_log, sources, sync_reconciliation_audit, sync_reconciliation_role_policy
  FROM gbrain_normal_sync, gbrain_reconciliation_apply, gbrain_source_repair, gbrain_hard_purge;

GRANT SELECT, INSERT ON pages, content_chunks, ingest_log TO gbrain_normal_sync;
GRANT UPDATE (slug, type, page_kind, title, compiled_truth, frontmatter, timeline, raw_path, source_path, content_hash, embedding, embedding_voyage, embedding_model, embedding_dimensions, updated_at, effective_date, contextual_retrieval_mode, corpus_generation, generation)
  ON pages TO gbrain_normal_sync;
GRANT SELECT ON sources TO gbrain_normal_sync;
GRANT UPDATE (last_commit, last_sync_at, newest_content_at, chunker_version) ON sources TO gbrain_normal_sync;
GRANT SELECT, INSERT ON sync_reconciliation_audit TO gbrain_normal_sync;
GRANT SELECT ON sync_reconciliation_role_policy TO gbrain_normal_sync;

GRANT SELECT ON pages, sources, sync_reconciliation_audit, sync_reconciliation_role_policy TO gbrain_reconciliation_apply;
GRANT UPDATE (deleted_at, updated_at) ON pages TO gbrain_reconciliation_apply;
GRANT UPDATE (authorized, after_state, result, failure, completed_at) ON sync_reconciliation_audit TO gbrain_reconciliation_apply;

GRANT SELECT ON pages, sources, sync_reconciliation_audit, sync_reconciliation_role_policy TO gbrain_source_repair;
GRANT UPDATE (deleted_at, updated_at) ON pages TO gbrain_source_repair;
GRANT UPDATE (local_path, registration_generation) ON sources TO gbrain_source_repair;
GRANT UPDATE (after_state, result, failure, completed_at) ON sync_reconciliation_audit TO gbrain_source_repair;

GRANT SELECT ON pages, sync_reconciliation_audit, sync_reconciliation_role_policy TO gbrain_hard_purge;
GRANT DELETE ON pages TO gbrain_hard_purge;
GRANT UPDATE (after_state, result, failure, completed_at) ON sync_reconciliation_audit TO gbrain_hard_purge;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO gbrain_normal_sync, gbrain_reconciliation_apply, gbrain_source_repair, gbrain_hard_purge;
