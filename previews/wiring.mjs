import { randomBytes } from 'node:crypto';
import { databaseNames } from './seed.mjs';

const secret = () => randomBytes(32).toString('hex');
export function createEnvironmentVariables(plan, source, mongoAdminUri, previous = {}) {
  const environment = plan.environment;
  const names = databaseNames(environment);
  const credentials = previous.PREVIEW_DATABASE_CREDENTIALS_JSON
    ? JSON.parse(previous.PREVIEW_DATABASE_CREDENTIALS_JSON)
    : Object.fromEntries(Object.entries(names).map(([service, username]) => [service, {username, password: secret()}]));
  const internal = service => `http://${service}-${environment}:3000`;
  const oldAuth = previous.AUTH_CONFIG_JSON ? JSON.parse(previous.AUTH_CONFIG_JSON) : {};
  const signingKey = oldAuth.JWT_SECRET || secret();
  const internToken = oldAuth.INTERN_TOKEN || secret();
  const apiKey = oldAuth.API_KEY || secret();
  const runnerKey = oldAuth.RUNNER_KEY || secret();
  const common = {
    PORT: '3000', NODE_ENV: 'production', JWT_SECRET: signingKey, INTERN_TOKEN: internToken,
    JWT_ISSUER: plan.urls.auth, JWT_AUDIENCE: `leia-preview-${environment}`,
    CORS_PREVIEW_DOMAINS: 'designer.leia.ovh,workbench.leia.ovh',
    RUNNER_KEY: runnerKey, RUNNER_URL: internal('runner'),
  };
  const mongoHost = new URL(mongoAdminUri).host;
  const mongo = service => `mongodb://${credentials[service].username}:${credentials[service].password}@${mongoHost}/${names[service]}?authSource=${names[service]}`;
  const auth = {...source.auth, ...common, MONGO_URI: mongo('auth'), API_KEY: apiKey,
    DESIGNER_FRONTEND_URL: plan.urls.designer_frontend, WORKBENCH_FRONTEND_URL: plan.urls.workbench_frontend,
    AUTH_ALLOWED_ORIGINS: [...new Set([plan.urls.designer_frontend, plan.urls.workbench_frontend,
      'https://pre.designer.leia.ovh', 'https://pre.workbench.leia.ovh'])].join(','),
    SESSION_COOKIE_NAME: `leia_preview_${environment}`, SESSION_COOKIE_SECURE: 'true', SESSION_COOKIE_SAME_SITE: 'lax',
  };
  delete auth.SESSION_COOKIE_DOMAIN;
  const designer = {...source.designer_backend, ...common, API_KEY: apiKey, MONGO_URI: mongo('designer'),
    AUTH_SERVICE_URL: internal('auth'), WORKBENCH_BACKEND_URL: internal('workbench'),
    FRONTEND_URL: plan.urls.designer_frontend, WORKBENCH_FRONTEND_URL: plan.urls.workbench_frontend,
    // Copied image URLs remain readable. Writes must not target the stable pre bucket.
    S3_BUCKET: `leia-preview-${environment}`, S3_ACCESS_KEY_ID: '', S3_SECRET_ACCESS_KEY: '',
  };
  const oldWorkbench = previous.WORKBENCH_CONFIG_JSON ? JSON.parse(previous.WORKBENCH_CONFIG_JSON) : {};
  const workbench = {...source.workbench_backend, ...common, MONGO_URI: mongo('workbench'),
    FRONTEND_URL: plan.urls.workbench_frontend, AUTH_URL: internal('auth'), MANAGER_URL: internal('designer'),
    MANAGER_KEY: apiKey, ADMIN_SECRET: oldWorkbench.ADMIN_SECRET || secret(),
  };
  const runner = {...source.runner, PORT: '3000', NODE_ENV: 'production',
    INTERN_TOKEN: internToken, RUNNER_KEY: runnerKey, VITE_AUTH_SERVICE_BACKEND: internal('auth'), REDIS_URL: 'redis://redis:6379',
  };
  return {
    PREVIEW_ENVIRONMENT: environment, PREVIEW_MONGO_ADMIN_URI: mongoAdminUri,
    SEED_SOURCES_JSON: JSON.stringify({auth: source.auth.MONGO_URI, designer: source.designer_backend.MONGO_URI,
      workbench: source.workbench_backend.MONGO_URI}),
    PREVIEW_DATABASE_CREDENTIALS_JSON: JSON.stringify(credentials),
    AUTH_COMMIT: plan.services.auth.commit, DESIGNER_COMMIT: plan.services.designer_backend.commit,
    WORKBENCH_COMMIT: plan.services.workbench_backend.commit, RUNNER_COMMIT: plan.services.runner.commit,
    AUTH_CONFIG_JSON: JSON.stringify(auth), DESIGNER_CONFIG_JSON: JSON.stringify(designer),
    WORKBENCH_CONFIG_JSON: JSON.stringify(workbench), RUNNER_CONFIG_JSON: JSON.stringify(runner),
  };
}
