import { hostname } from 'node:os';

import type { Logger } from 'pino';

import type { Database } from '../db/prisma.js';

/**
 * A worker or the scheduler saying it is alive (P14 §10: "last scheduler run" and the workers are read
 * every morning from /system/health). A process whose beat is older than three intervals is shown dead.
 */

export const HEARTBEAT_SECONDS = 30;

export interface Heartbeat {
  readonly key: string;
  stop(): Promise<void>;
}

export async function startHeartbeat(
  db: Database,
  logger: Logger,
  p: { kind: 'scheduler' | 'worker'; appVersion: string; seconds?: number },
): Promise<Heartbeat> {
  const host = hostname().slice(0, 100);
  const key = p.kind === 'scheduler' ? 'scheduler' : `worker:${host}:${String(process.pid)}`.slice(0, 120);
  const now = () => {
    const d = new Date();
    d.setUTCMilliseconds(0);
    return d;
  };
  const fields = { kind: p.kind, host, pid: process.pid, appVersion: p.appVersion.slice(0, 50) };
  const started = now();
  await db.processHeartbeat.upsert({
    where: { processKey: key },
    create: { processKey: key, ...fields, startedAt: started, beatAt: started },
    update: { ...fields, startedAt: started, beatAt: started, stoppedAt: null },
  });
  const timer = setInterval(
    () => {
      db.processHeartbeat
        .update({ where: { processKey: key }, data: { beatAt: now() } })
        .catch((err: unknown) => {
          logger.warn({ err }, 'could not record the process heartbeat');
        });
    },
    (p.seconds ?? HEARTBEAT_SECONDS) * 1000,
  );
  timer.unref();
  return {
    key,
    async stop() {
      clearInterval(timer);
      await db.processHeartbeat
        .update({ where: { processKey: key }, data: { beatAt: now(), stoppedAt: now() } })
        .catch(() => undefined);
    },
  };
}
