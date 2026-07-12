# Destructive path inventory, sync safety v3

Scope: CLI, engine, direct SQL, jobs, scripts, MCP/API via operations, source ops.

Guarded proposal/apply boundary:
- `src/commands/sync.ts`, filesystem-derived removals propose manifests via `proposeSyncReconciliation`; apply requires `applySyncReconciliation` under apply role.

Known destructive primitives, not normal sync:
- `src/commands/sync.ts`, proposal/apply lifecycle, role-gated tombstone apply, and authorized retention purge path.
- `src/core/pglite-engine.ts`, `deletePage`, `deletePages`, `purgeDeletedPages` engine primitives.
- `src/core/postgres-engine.ts`, `deletePage`, `deletePages`, `purgeDeletedPages` engine primitives.
- `src/core/operations.ts`, `delete_page`, `delete_pages`, `restore_page`, `purge_deleted` operation handlers. MCP/API scope and localOnly gates remain in the operation contract.
- `src/commands/pages.ts`, explicit operator page lifecycle CLI.
- `src/commands/jobs.ts`, job cleanup path.
- `src/core/cycle.ts`, autopilot TTL purge phase.
- `src/commands/migrate-engine.ts`, force-wipe migration target path.
- `scripts/dedup-content-hash.ts`, reviewed duplicate consolidation script.

Explicitly out of runtime production surface:
- `test/**`, local fixtures only.
- `docs/**`, `skills/**`, prose examples only.
- `artifacts/dba/**`, separately reviewed DBA bootstrap and rollback.
- `artifacts/migrations/**`, reviewed rollback artifact.
