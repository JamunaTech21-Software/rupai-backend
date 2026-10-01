/**
 * `npm run db:drift`: fails if prisma/schema.prisma and the committed migrations disagree.
 *
 * This catches a model changed without a migration, and a migration hand-edited in a way Prisma would
 * model differently. Generated columns and CHECK constraints are invisible to Prisma's diff, which is
 * why they are allowed to live only in the SQL. Runs in CI (P0.06).
 *
 * Needs SHADOW_DATABASE_URL, a scratch database the migrations are replayed into.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');

const MIGRATIONS = 'prisma/migrations';
const hasMigrations = existsSync(MIGRATIONS) && readdirSync(MIGRATIONS).some((f) => /^\d{14}_/.test(f));
const from = hasMigrations ? ['--from-migrations', MIGRATIONS] : ['--from-empty'];

const run = spawnSync(
  'npx',
  ['prisma', 'migrate', 'diff', ...from, '--to-schema', 'prisma/schema.prisma', '--exit-code'],
  { encoding: 'utf8', env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1' } },
);

if (run.status === 0) {
  process.stdout.write('✔ No drift: schema.prisma matches the migrations.\n');
  process.exit(0);
}
if (run.status === 2) {
  process.stderr.write(
    '✖ DRIFT: schema.prisma and prisma/migrations disagree.\n' +
      '  Create a migration with `npm run db:migrate:new -- --name <change>` and review its SQL.\n\n' +
      run.stdout,
  );
  process.exit(1);
}
process.stderr.write(`✖ Drift check could not run:\n${run.stdout}${run.stderr}`);
process.exit(1);
