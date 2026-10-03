/**
 * `npm run docs:openapi`: writes the OpenAPI 3.1 document to docs/openapi.json.
 * Import that file into Postman or Insomnia ("Import → OpenAPI") to get a ready collection (Spec P4 §18.4).
 */
import { mkdirSync, writeFileSync } from 'node:fs';

import { buildOpenApi } from '../src/core/http/openapi.js';
import { buildModules } from '../src/modules/index.js';
import { memoryPlatform } from '../src/core/platform.js';

const version = process.env.APP_VERSION ?? '0.0.0-dev';
const doc = buildOpenApi(buildModules({ platform: memoryPlatform() }), { version });
mkdirSync('docs', { recursive: true });
writeFileSync('docs/openapi.json', `${JSON.stringify(doc, null, 2)}\n`);
process.stdout.write(`✔ Wrote docs/openapi.json (${Object.keys(doc.paths as object).length} paths)\n`);
