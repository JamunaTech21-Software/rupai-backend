# Modules

One folder per bounded context (Spec P1 §4.1). `identity/` (users, roles, permissions; P1.01) is the reference example of the layout below. `organisation/` (P1.07: organisation, estate, division, section, field) is the reference for an **estate-tier** module: scope registration, write-level scope checks, delete-only-when-unreferenced. Others will follow, for example `workforce/`, `attendance/`, `payroll/`, `accounting/`.

## Layout of a module

```
src/modules/<module>/
  <module>.routes.ts       Express router: method + path + permission + validation + controller
  <module>.controller.ts   Thin: read the validated request, call the service, shape the response
  <module>.service.ts      Business rules, state machine, guards, invariants, transactions
  <module>.repository.ts   The only layer that touches Prisma; always scope-aware
  <module>.schema.ts       Zod schemas for params/query/body/response (also feed OpenAPI)
  <module>.types.ts        Domain types and state unions
  __tests__/               Unit tests for this module's rules
```

## Layer rules (enforced in code review)

- **Controllers** never touch Prisma and contain no business rules.
- **Services** never touch `req`/`res`. A service that joins a caller's transaction receives the `tx` client as a parameter. It never creates or discovers one on its own (Spec P2 §3.5).
- **Repositories** contain no business rules and **never issue an unscoped query** on estate- or facility-tier data (Spec P1 §12.3). The scope extension makes that the default (see below).
- **Cross-module effects** go only through the core contracts in `src/core`: posting, stock movement, settlement, budget consumption and notification (Spec P1 §7.1). A module never writes another module's tables directly.
- **State is never a writable field.** It changes only through transition endpoints (Spec P4 §6.2).
- **Money and quantities are decimals.** Never use `number`, `parseFloat` or `Number()` (Spec P9 §2.1).

## Data scope for estate- and facility-tier tables (P1.03)

Every model that belongs to an estate or a facility is **registered once** by the epic that creates it. From then on every Prisma query on it is filtered by the caller's scope. You do not add the filter yourself, and you cannot forget it.

```ts
// src/modules/<module>/<module>.scope.ts, imported by the module's routes file
import { byColumn, SCOPED_MODELS } from '../../core/scope/scoped-models.js';

SCOPED_MODELS.register('PluckingWorkRecord', {
  estate: byColumn('estateId'),
  division: (ids) => ({ field: { section: { divisionId: { in: [...ids] } } } }), // through a relation
  self: byColumn('employmentProfileId'),
});
```

When a create cannot be judged from the row's own columns (a section reaches its estate through its division), declare `createsCheckedBy: 'service'` and check the parent in the service (see `organisation/hierarchy.service.ts`). Reads, updates and deletes stay filtered. A grant that reaches a record only through a child (a division grant reading its estate) does not authorise changing it: check the write level in the service with `scopeToCheck()`.

- **Reads and aggregates** (`findMany`, `findUnique`, `count`, `aggregate`, `groupBy`): out-of-scope rows are absent. A single record outside scope comes back `null`, so it is **404**, never 403 (P4 §4.3).
- **Updates and deletes** never match an out-of-scope row (404). **Creates** outside scope are `403 SCOPE_DENIED`. Creates can only be checked automatically for `byColumn` dimensions; a model scoped through relations checks its creates in the service.
- **A query on a scoped model with no scope in context throws.** Routes get a scope from their `auth`. Seeders and jobs wrap their work in `runUnscoped('why', () => …)`.
- **Not filtered, by design:** nested `include`/`select` of a scoped relation, and nested writes. Read a scoped model through its own top-level query.
- **Raw SQL** (reports, dashboards) must AND in `scopeSql(await currentScope(), { estate: 't.estate_id', … })` from `core/scope/sql.ts`.
- **Lists** of scoped resources pass `appliedScope: await appliedScope()` to `sendPage`, so `meta.applied_scope` tells the client what it is looking at.
- **Grant targets:** when you create a table that scope grants point at (estate, division, section, factory/warehouse, department), register an existence check in `SCOPE_TARGETS` (`core/scope/targets.ts`).
- **Test it:** plug the resource into `describeScopeLeakage()` (`tests/helpers/scope-leakage.ts`). It checks list, single (404) and aggregate leakage.
