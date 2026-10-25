import type { z } from 'zod';

import type { ApiModule } from '../../app.js';
import type { AccessLog } from '../../core/audit/access-log.js';
import { currentActorId, type PermissionResolver } from '../../core/auth/authorize.js';
import type { Database } from '../../core/db/prisma.js';
import { AppError, Errors } from '../../core/errors/app-error.js';
import { sendOne } from '../../core/http/response.js';
import { defineModule } from '../../core/http/route.js';
import { getValidated } from '../../core/http/validate.js';
import type { Platform } from '../../core/platform.js';
import { approvalsService } from '../approvals/approvals.service.js';
import { notificationsService } from '../notifications/notifications.service.js';
import { HOME_PANELS, panelVisible, type PanelDefinition } from './dashboard.panels.js';
import { DashboardOut, DashboardParams, PanelOut, PanelParams, PanelQuery } from './dashboard.schema.js';

/** HTTP surface of the dashboards (R.5; the panel framework of P1.18; Spec P4 §14.2, P10 §16). */

export interface DashboardDeps {
  readonly db: Database;
  readonly platform: Platform;
  readonly authz: PermissionResolver;
  readonly accessLog: AccessLog;
  readonly config: { readonly timezone: string };
}

const ANYONE =
  'Everyone signed in has a home page; each panel is filtered by the permission that sees its data (P10 §16.2).';
const DASHBOARDS: Readonly<
  Record<'home', { readonly title: string; readonly panels: readonly PanelDefinition[] }>
> = {
  home: { title: 'Dashboard', panels: HOME_PANELS },
};

const head = (d: PanelDefinition) => ({
  key: d.key,
  title: d.title,
  kind: d.kind,
  row: d.row,
  span: d.span,
  available: d.pending === undefined,
  available_from: d.pending?.from ?? null,
  unavailable_reason: d.pending?.reason ?? null,
});

export function dashboardModule({ db, platform, authz, accessLog, config }: DashboardDeps): ApiModule {
  const approvals = approvalsService({ db, authz, accessLog, timezone: config.timezone });
  const notifications = notificationsService(db);
  const m = defineModule({
    name: 'dashboards',
    path: '/dashboards',
    tag: 'Dashboards',
    platform,
    authz,
    accessLog,
  });

  m.route({
    method: 'get',
    path: '/:dashboard',
    summary: 'The panels of a dashboard',
    description:
      'The panels the caller may see, in the order and grid of the manager’s design (row, span of 12). ' +
      'Load each with GET /dashboards/{dashboard}/panels/{panel}: they load independently, so a slow or ' +
      'failed one never holds up the rest. available=false: its data arrives with available_from.',
    auth: { signedIn: true, reason: ANYONE },
    params: DashboardParams,
    success: { status: 200, description: 'The dashboard', schema: DashboardOut },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, { params: DashboardParams });
      const dashboard = DASHBOARDS[params.dashboard];
      const permissions = await authz.permissionsOf(currentActorId());
      sendOne(res, {
        key: params.dashboard,
        title: dashboard.title,
        panels: dashboard.panels.filter((p) => panelVisible(p, permissions)).map(head),
      } satisfies z.infer<typeof DashboardOut>);
    },
  });

  m.route({
    method: 'get',
    path: '/:dashboard/panels/:panel',
    summary: 'One panel’s figures',
    description:
      'Every figure carries its unit and a drill_down (resource + filter) that the screen turns into a ' +
      'link; nothing is hard-coded in the client. as_of says when the figures were read. estate_id narrows ' +
      'to one estate and is refused (SCOPE_DENIED) outside the caller’s scope. A panel the caller may not ' +
      'see is 404. A panel waiting for its phase has available=false and, where the design shows cards, ' +
      'data lists them with their own available_from and no value.',
    auth: { signedIn: true, reason: ANYONE },
    params: PanelParams,
    query: PanelQuery,
    success: { status: 200, description: 'The panel', schema: PanelOut },
    errors: ['SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { params, query } = getValidated(res, { params: PanelParams, query: PanelQuery });
      const userId = currentActorId();
      const permissions = await authz.permissionsOf(userId);
      const def = DASHBOARDS[params.dashboard].panels.find((p) => p.key === params.panel);
      if (!def || !panelVisible(def, permissions)) throw Errors.notFound('No such panel on this dashboard.');
      const estateId = query.estate_id ?? null;
      if (estateId !== null) await assertEstateInScope(db, accessLog, estateId);
      const data = def.load
        ? await def.load({
            db,
            userId,
            permissions,
            estateId,
            approvals,
            notifications,
            timezone: config.timezone,
          })
        : null;
      sendOne(res, {
        ...head(def),
        as_of: new Date().toISOString(),
        estate_id: estateId?.toString() ?? null,
        data,
      } satisfies z.infer<typeof PanelOut>);
    },
  });

  return m.build();
}

/**
 * P10 §18 "parameter override": an estate outside the caller's scope is refused, not silently filtered.
 * An estate that does not exist is refused the same way, so the answer says nothing about other estates.
 */
async function assertEstateInScope(db: Database, accessLog: AccessLog, estateId: bigint): Promise<void> {
  if ((await db.estate.count({ where: { id: estateId } })) === 1) return;
  await accessLog
    .record({
      eventType: 'scope_denied',
      module: 'dashboard',
      recordReference: estateId.toString(),
      detail: {},
    })
    .catch(() => undefined);
  throw new AppError('SCOPE_DENIED', 'This estate is outside your data scope.', [
    { field: 'estate_id', code: 'SCOPE_DENIED', message: 'Ask an administrator for access to this estate.' },
  ]);
}
