import { z } from 'zod';

import type { ApiModule } from '../../app.js';
import { getListQuery } from '../../core/http/list-query.js';
import { sendOne, sendPage } from '../../core/http/response.js';
import { defineModule } from '../../core/http/route.js';
import { getValidated } from '../../core/http/validate.js';
import { zId } from '../../core/ids/ids.js';
import {
  AGEING_BANDS,
  PAYABLE_PARTIES,
  PAYABLE_SOURCES,
  RECEIVABLE_PARTIES,
  RECEIVABLE_SOURCES,
  SETTLEMENT_STATES,
  SIDES,
  type SettlementSide,
} from '../../core/settlement/sides.js';
import type { AccountingDeps } from './accounts.routes.js';
import {
  AgeingOut,
  AgeingQuery,
  CollectionAllocationOut,
  PayableOut,
  PaymentAllocationOut,
  ReceivableOut,
} from './settlement.schema.js';
import { OVERDUE_FILTER, settlementService } from './settlement.service.js';

/**
 * HTTP surface of receivables and payables (P3.05; Spec P4 §11.2–§11.3, §6.4; D-3.05-1, D-3.05-14).
 * Derived records: GET only. No POST, PUT, PATCH or DELETE exists here, by design (P1 §3.1.5): an item is
 * corrected through its source document, and settled by collections and payments (P8.09, P4.07).
 */
export function settlementModules({ db, platform, authz, accessLog, config }: AccountingDeps): ApiModule[] {
  const service = settlementService({ db, accessLog, timezone: config.timezone });
  const byId = { params: z.object({ id: zId }) };

  const build = (side: SettlementSide) => {
    const def = SIDES[side];
    const plural = `${side}s`;
    const doc = def.doc;
    const m = defineModule({
      name: plural,
      path: `/${plural}`,
      tag: 'Accounting',
      platform,
      authz,
      accessLog,
    });
    const schema = side === 'receivable' ? ReceivableOut : PayableOut;
    const allocationSchema = side === 'receivable' ? CollectionAllocationOut : PaymentAllocationOut;
    const auth = { permission: def.viewPermission };

    m.route({
      method: 'get',
      path: '/',
      summary: `List ${plural}`,
      description:
        `The ${side} sub-ledger (read only): one item per source document, with its outstanding amount stored and its ageing band. ` +
        `filter[${OVERDUE_FILTER}]=true lists open items past their due date. An item of an estate follows estate scope; one with no estate is organisation-wide. ` +
        `source_type and source_id link to the document that raised it.`,
      auth,
      list: {
        pagination: 'page',
        filters: {
          party_type: {
            type: { enum: side === 'receivable' ? RECEIVABLE_PARTIES : PAYABLE_PARTIES },
            ops: ['eq'],
          },
          party_id: { type: 'id', ops: ['eq'] },
          state: { type: { enum: SETTLEMENT_STATES }, ops: ['eq', 'in'] },
          ageing_band: { type: { enum: AGEING_BANDS }, ops: ['eq', 'in'] },
          due_date: { type: 'date', ops: ['eq', 'from', 'to'] },
          document_date: { type: 'date', ops: ['eq', 'from', 'to'] },
          estate_id: { type: 'id', ops: ['eq', 'null'] },
          source_type: {
            type: { enum: side === 'receivable' ? RECEIVABLE_SOURCES : PAYABLE_SOURCES },
            ops: ['eq'],
          },
          source_id: { type: 'id', ops: ['eq'] },
          reference_number: { type: 'string', ops: ['eq', 'like'] },
          currency_id: { type: 'id', ops: ['eq'] },
          [OVERDUE_FILTER]: { type: 'bool' },
        },
        sorts: ['due_date', 'document_date', 'outstanding_amount', 'reference_number'],
        defaultSort: ['due_date'],
        maxPageSize: 200,
      },
      success: { status: 200, description: `A page of ${plural}`, schema },
      errors: [],
      handler: async (req, res) => {
        const q = getListQuery(res);
        const { items, total } = await service.list(side, q);
        sendPage(req, res, items, { pagination: q.page ?? { page: 1, perPage: 25 }, total });
      },
    });

    m.route({
      method: 'get',
      path: '/ageing',
      summary: `Ageing of open ${plural}`,
      description:
        'Open items by band as at today (P9 §19.1: current, 1–30, 31–60, 61–90, over 90 days past due), outstanding in base currency, live from the sub-ledger. group_by party adds one row per party, largest first. An estate outside your scope is refused.',
      auth,
      query: AgeingQuery,
      success: { status: 200, description: 'The ageing', schema: AgeingOut },
      errors: ['SCOPE_DENIED'],
      handler: async (_req, res) => {
        const { query } = getValidated(res, { query: AgeingQuery });
        sendOne(res, await service.ageing(side, query));
      },
    });

    m.route({
      method: 'get',
      path: '/:id',
      summary: `Get a ${side}`,
      description: `One ${side}. Its figures change only through allocated ${doc}s, credit notes, write-offs or the reversal of its source.`,
      auth,
      ...byId,
      success: { status: 200, description: `The ${side}`, schema },
      errors: [],
      handler: async (_req, res) => {
        const { params } = getValidated(res, byId);
        sendOne(res, await service.get(side, params.id));
      },
    });

    m.route({
      method: 'get',
      path: '/:id/allocations',
      summary: `The ${doc}s allocated to a ${side}`,
      description: `Every ${doc} allocating to it, drafts included. applied: the ${doc} is posted and not reversed, so the amount is off the outstanding. fx_gain_loss is fixed at posting (positive = gain).`,
      auth,
      ...byId,
      success: { status: 200, description: 'The allocations', schema: z.array(allocationSchema) },
      errors: [],
      handler: async (_req, res) => {
        const { params } = getValidated(res, byId);
        sendOne(res, await service.allocations(side, params.id));
      },
    });

    return m.build();
  };

  return [build('receivable'), build('payable')];
}
