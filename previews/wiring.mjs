import {randomBytes} from 'node:crypto';
import {databaseNames} from './seed.mjs';

const secret = () => randomBytes(32).toString('hex');
const dbServices = {auth:'auth', designer_backend:'designer', workbench_backend:'workbench'};
export function createEnvironmentVariables(plan, source, mongoAdminUri, previous = {}) {
  const environment = plan.environment, names = databaseNames(environment);
  const active = Object.keys(plan.services).filter(service => !service.endsWith('_frontend'));
  if (!active.length) return {};
  const requiredDatabases = active.filter(service => dbServices[service]).map(service => dbServices[service]);
  const credentials = previous.PREVIEW_DATABASE_CREDENTIALS_JSON ? JSON.parse(previous.PREVIEW_DATABASE_CREDENTIALS_JSON) : {};
  for (const service of requiredDatabases) credentials[service] ||= {username:names[service],password:secret()};
  const oldAuth = previous.AUTH_CONFIG_JSON ? JSON.parse(previous.AUTH_CONFIG_JSON) : {};
  const isolated = plan.isolation === 'full';
  const common = {PORT:'3000', NODE_ENV:'production', CORS_PREVIEW_DOMAINS:'designer.leia.ovh,workbench.leia.ovh'};
  // Partial environments must accept pre identities and service-to-service credentials.
  // Separate signing keys are valid only when every backend is isolated together.
  if (isolated) Object.assign(common, {JWT_SECRET:oldAuth.JWT_SECRET || secret(),
    INTERN_TOKEN:oldAuth.INTERN_TOKEN || secret(), API_KEY:oldAuth.API_KEY || secret(),
    RUNNER_KEY:oldAuth.RUNNER_KEY || secret(), JWT_ISSUER:plan.urls.auth, JWT_AUDIENCE:`leia-preview-${environment}`});
  const internalName = {auth:'auth',designer_backend:'designer',workbench_backend:'workbench',runner:'runner'};
  const dependency = service => active.includes(service) ? `http://${internalName[service]}-${environment}:3000` : plan.urls[service];
  const mongo = service => {
    const host = new URL(mongoAdminUri).host, user = credentials[service];
    return `mongodb://${user.username}:${user.password}@${host}/${names[service]}?authSource=${names[service]}`;
  };
  const configs = {};
  if (active.includes('auth')) {
    configs.AUTH_CONFIG_JSON = {...source.auth, ...common, MONGO_URI:mongo('auth'), RUNNER_URL:dependency('runner'),
      API_KEY_STORAGE_SECRET:oldAuth.API_KEY_STORAGE_SECRET ?? source.auth.API_KEY_STORAGE_SECRET,
      DESIGNER_FRONTEND_URL:plan.urls.designer_frontend, WORKBENCH_FRONTEND_URL:plan.urls.workbench_frontend,
      AUTH_ALLOWED_ORIGINS:[...new Set([plan.urls.designer_frontend,plan.urls.workbench_frontend,
        'https://pre.designer.leia.ovh','https://pre.workbench.leia.ovh'])].join(','),
      SESSION_COOKIE_NAME:`leia_preview_${environment}`, SESSION_COOKIE_SECURE:'true',SESSION_COOKIE_SAME_SITE:'lax'};
    delete configs.AUTH_CONFIG_JSON.SESSION_COOKIE_DOMAIN;
  }
  if (active.includes('designer_backend')) configs.DESIGNER_CONFIG_JSON = {...source.designer_backend,...common,
    MONGO_URI:mongo('designer'), AUTH_SERVICE_URL:dependency('auth'), WORKBENCH_BACKEND_URL:dependency('workbench_backend'),
    RUNNER_URL:dependency('runner'),FRONTEND_URL:plan.urls.designer_frontend,WORKBENCH_FRONTEND_URL:plan.urls.workbench_frontend,
    S3_BUCKET:`leia-preview-${environment}`,S3_ACCESS_KEY_ID:'',S3_SECRET_ACCESS_KEY:''};
  if (active.includes('workbench_backend')) {
    const old = previous.WORKBENCH_CONFIG_JSON ? JSON.parse(previous.WORKBENCH_CONFIG_JSON) : {};
    configs.WORKBENCH_CONFIG_JSON = {...source.workbench_backend,...common,MONGO_URI:mongo('workbench'),
      FRONTEND_URL:plan.urls.workbench_frontend,AUTH_URL:dependency('auth'),MANAGER_URL:dependency('designer_backend'),
      RUNNER_URL:dependency('runner'),ADMIN_SECRET:old.ADMIN_SECRET || secret()};
    if (isolated) configs.WORKBENCH_CONFIG_JSON.MANAGER_KEY = common.API_KEY;
  }
  if (active.includes('runner')) configs.RUNNER_CONFIG_JSON = {...source.runner,...common,
    VITE_AUTH_SERVICE_BACKEND:dependency('auth'),REDIS_URL:'redis://redis:6379'};
  const result = {PREVIEW_ENVIRONMENT:environment,
    ...Object.fromEntries(Object.entries(configs).map(([key,value]) => [key,JSON.stringify(value)]))};
  if (requiredDatabases.length) Object.assign(result, {PREVIEW_MONGO_ADMIN_URI:mongoAdminUri,
    SEED_SOURCES_JSON:JSON.stringify(Object.fromEntries(active.filter(service => dbServices[service])
      .map(service => [dbServices[service],source[service].MONGO_URI]))),
    PREVIEW_DATABASE_CREDENTIALS_JSON:JSON.stringify(credentials)});
  const commitKeys = {auth:'AUTH',designer_backend:'DESIGNER',workbench_backend:'WORKBENCH',runner:'RUNNER'};
  for (const service of active) result[`${commitKeys[service]}_COMMIT`] = plan.services[service].commit;
  return result;
}
