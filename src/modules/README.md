# Modules

One folder per bounded context (Spec P1 §4.1), for example `identity/`, `organisation/`, `workforce/`, `attendance/`, `payroll/`, `accounting/`.

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
- **Repositories** contain no business rules and **never issue an unscoped query** on estate- or facility-tier data (Spec P1 §12.3).
- **Cross-module effects** go only through the core contracts in `src/core`: posting, stock movement, settlement, budget consumption and notification (Spec P1 §7.1). A module never writes another module's tables directly.
- **State is never a writable field.** It changes only through transition endpoints (Spec P4 §6.2).
- **Money and quantities are decimals.** Never use `number`, `parseFloat` or `Number()` (Spec P9 §2.1).
