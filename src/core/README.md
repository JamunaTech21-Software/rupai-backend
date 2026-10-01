# Core

Cross-cutting mechanisms that every module depends on. Modules call these. These never import from `src/modules`.

| Folder      | Responsibility                                                                                                                | Delivered in  |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `context/`  | Per-request context (AsyncLocalStorage): request id, request logger; later the actor and scope                                | P0.02         |
| `logging/`  | Pino root logger, redaction of secrets/NIDs/bank details, `getLogger()` for request-bound logging                             | P0.02         |
| `db/`       | Prisma client (app account, ReadCommitted), `withTransaction`, `lockRowsForUpdate`, `quoteIdentifier`, seeders and `seedRows` | P0.03         |
| `errors/`   | `AppError` hierarchy with stable error codes → HTTP status (Spec P4 §3)                                                       | P0.04 / P0.05 |
| `auth/`     | Tokens, sessions, revocation, `authenticate` and `authorize` middleware (Spec P4 §2.2)                                        | P1.01–P1.02   |
| `scope/`    | Scope resolution and data-access-layer scope enforcement (Spec P1 §12, P6 §4)                                                 | P1.03         |
| `audit/`    | `audit_change`, `status_history` and `access_log` writers, inside the caller's transaction (Spec P1 §13)                      | P1.05         |
| `rules/`    | Effective-dated rule resolution by specificity (Spec P1 §10.2, P9 §3)                                                         | P1.06         |
| `approval/` | Workflow engine: selection, frozen path, approver resolution, actions (Spec P7)                                               | P1.13–P1.14   |
| `jobs/`     | Queue, idempotent job contract, job resource, singleton scheduler (Spec P4 §5.3)                                              | P1.15         |
| `storage/`  | Document storage abstraction on local disk with relative paths (Spec P1 §5.23)                                                | P1.12         |
| `posting/`  | The single posting engine and `posting_link` idempotency guard (Spec P1 §7.2)                                                 | P3.03         |
| `stock/`    | The single stock movement service and weighted-average cost (Spec P1 §7.4, §8)                                                | P4.04         |
