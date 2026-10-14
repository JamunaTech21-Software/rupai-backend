import { CronExpressionParser } from 'cron-parser';

/**
 * Schedule arithmetic. Cron expressions are read in the organisation's timezone (Asia/Dhaka), so
 * "0 2 * * *" means two in the morning on the estate, not in UTC; storage stays UTC (P2 §2.7).
 */

/** Five fields only: minute hour day-of-month month day-of-week. Seconds are not a scheduling unit here. */
export function checkCron(expr: string, timezone: string): string | null {
  if (expr.trim().split(/\s+/).length !== 5) return 'must have five fields: minute hour day month weekday';
  try {
    CronExpressionParser.parse(expr, { tz: timezone });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** The first run strictly after `after`. Times are whole seconds, as the database stores them. */
export function nextRun(expr: string, after: Date, timezone: string): Date {
  const next = CronExpressionParser.parse(expr, { currentDate: after, tz: timezone }).next().toDate();
  next.setUTCMilliseconds(0);
  return next;
}

/** Exponential backoff after a failed attempt: 5 s, 10 s, 20 s … up to 15 minutes (P4 §5.3). */
export function backoffSeconds(failedAttempt: number): number {
  return Math.min(5 * 2 ** Math.max(0, failedAttempt - 1), 900);
}
