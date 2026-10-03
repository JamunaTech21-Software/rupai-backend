import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';

/**
 * Interactive API docs (non-production by default, DOCS_ENABLED):
 *   GET /docs               Swagger UI
 *   GET /docs/openapi.json  the OpenAPI 3.1 document (import into Postman or Insomnia)
 *
 * The API's own CSP forbids everything ('none'). The docs page needs its own scripts and styles, so
 * this router alone relaxes the policy to same-origin assets.
 */
export function docsRouter(document: Record<string, unknown>): Router {
  const router = Router();
  router.use('/docs', (_req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'",
    );
    next();
  });
  router.get('/docs/openapi.json', (_req, res) => {
    res.json(document);
  });
  router.use('/docs', swaggerUi.serve, swaggerUi.setup(document, { customSiteTitle: 'RupAI API' }));
  return router;
}
