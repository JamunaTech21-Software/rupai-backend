import type { Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

/**
 * The scope-leakage suite (Spec P13, P6 §4.3, P4 §4.2–§4.3). Every epic that adds a scoped resource
 * plugs it in, so the same three failure modes are tested everywhere:
 *
 *   1. list      → rows outside the caller's scope are simply absent
 *   2. single    → a record outside the scope is 404, never 403 (no existence disclosure)
 *   3. aggregate → a total or count includes only in-scope rows (the easy one to get wrong)
 *
 * Usage, inside a test file whose beforeAll creates the data and the actor:
 *
 *   describeScopeLeakage({
 *     resource: 'plucking work records',
 *     app: () => app,
 *     headers: () => bearer(estateAUser),
 *     listPath: '/api/v1/plucking-work-records',
 *     itemPath: (id) => `/api/v1/plucking-work-records/${id}`,
 *     inScope: () => [recordInA.id],
 *     outOfScope: () => [recordInB.id],
 *     aggregate: { path: '/api/v1/dashboards/plucking', read: (b) => b.data.total_records, expected: () => 1 },
 *   });
 *
 * Values are read lazily, because they only exist once beforeAll has run.
 */
export interface ScopeLeakageCase {
  readonly resource: string;
  readonly app: () => Express;
  /** Request headers that authenticate as the narrowly scoped caller. */
  readonly headers: () => Record<string, string>;
  readonly listPath: string;
  readonly itemPath: (id: string) => string;
  readonly inScope: () => readonly string[];
  readonly outOfScope: () => readonly string[];
  /** Where the list keeps ids. Defaults to `data[].id`. */
  readonly idsOf?: (body: unknown) => string[];
  readonly aggregate?: {
    readonly path: string;
    readonly read: (body: unknown) => number;
    readonly expected: () => number;
  };
}

const defaultIds = (body: unknown) => (body as { data: { id: string }[] }).data.map((r) => r.id);

export function describeScopeLeakage(c: ScopeLeakageCase): void {
  describe(`scope leakage: ${c.resource}`, () => {
    it('the list contains in-scope rows and no out-of-scope row', async () => {
      const res = await request(c.app()).get(`${c.listPath}?per_page=200`).set(c.headers());
      expect(res.status).toBe(200);
      const ids = (c.idsOf ?? defaultIds)(res.body);
      for (const id of c.inScope()) expect(ids).toContain(id);
      for (const id of c.outOfScope()) expect(ids).not.toContain(id);
      expect(res.body.meta.applied_scope).toBeDefined();
    });

    it('an out-of-scope record is 404, exactly like one that does not exist', async () => {
      for (const id of c.inScope()) {
        expect((await request(c.app()).get(c.itemPath(id)).set(c.headers())).status).toBe(200);
      }
      for (const id of c.outOfScope()) {
        const res = await request(c.app()).get(c.itemPath(id)).set(c.headers());
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      }
    });

    if (c.aggregate) {
      const agg = c.aggregate;
      it('aggregates count only in-scope rows', async () => {
        const res = await request(c.app()).get(agg.path).set(c.headers());
        expect(res.status).toBe(200);
        expect(agg.read(res.body)).toBe(agg.expected());
      });
    }
  });
}
