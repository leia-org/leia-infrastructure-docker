import {writeFile,mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {backendServices,repositories} from './manifest.mjs';

export function stackName(services) {
  const mask = backendServices.reduce((mask,service,index) => mask | (services.includes(service) ? 1 << index : 0), 0);
  if (!mask) throw new Error('A backend stack needs at least one backend.');
  return `mask-${mask}.json`;
}
export function composeFor(services) {
  if (!services.length || services.some(service => !backendServices.includes(service))) throw new Error('Invalid stack services.');
  const result = {services:{},networks:{preview:{},coolify:{external:true}}};
  const seeded = services.some(service => service !== 'runner');
  if (seeded) result.services.seed = {build:{context:'.',dockerfile:'previews/Dockerfile.seed'},environment:{
    PREVIEW_ENVIRONMENT:'${PREVIEW_ENVIRONMENT}',PREVIEW_MONGO_ADMIN_URI:'${PREVIEW_MONGO_ADMIN_URI}',
    SEED_SOURCES_JSON:'${SEED_SOURCES_JSON}',PREVIEW_DATABASE_CREDENTIALS_JSON:'${PREVIEW_DATABASE_CREDENTIALS_JSON}'},
    restart:'no',mem_limit:'256m',cpus:0.5,networks:['preview','coolify']};
  if (services.includes('runner')) result.services.redis = {image:'redis:7-alpine',
    command:['redis-server','--save','','--appendonly','no','--maxmemory','64mb','--maxmemory-policy','allkeys-lru'],
    mem_limit:'96m',cpus:0.25,restart:'unless-stopped',networks:['preview'],
    healthcheck:{test:['CMD','redis-cli','ping'],interval:'5s',timeout:'3s',retries:10}};
  const names = {auth:'auth',designer_backend:'designer',workbench_backend:'workbench',runner:'runner'};
  for (const service of services) {
    const name = names[service], key = name.toUpperCase();
    result.services[name] = {build:{context:`https://github.com/${repositories[service]}.git#\${${key}_COMMIT}`,
      dockerfile_inline:`FROM node:22-bookworm-slim\nWORKDIR /app\nCOPY . .\nRUN npm ci --omit=dev && npm cache clean --force\nEXPOSE 3000\nCMD ["node", "-e", "Object.assign(process.env, JSON.parse(process.env.APP_CONFIG_JSON)); delete process.env.APP_CONFIG_JSON; import('./${service === 'runner' ? 'server.js' : 'src/index.js'}')"]\n`},
      environment:{APP_CONFIG_JSON:`\${${key}_CONFIG_JSON}`}, restart:'unless-stopped',mem_limit:'384m',cpus:0.5,
      healthcheck:{test:['CMD','node','-e',"fetch('http://127.0.0.1:3000/', {method:'OPTIONS'}).then(r=>process.exit(r.status===204?0:1)).catch(()=>process.exit(1))"],interval:'5s',timeout:'3s',start_period:'20s',retries:20},
      labels:[
        'traefik.enable=true','traefik.docker.network=coolify',
        `traefik.http.services.leia-\${PREVIEW_ENVIRONMENT}-${name}.loadbalancer.server.port=3000`,
        `traefik.http.routers.leia-\${PREVIEW_ENVIRONMENT}-${name}-http.rule=Host(\`\${${key}_HOST}\`)`,
        `traefik.http.routers.leia-\${PREVIEW_ENVIRONMENT}-${name}-http.entrypoints=http`,
        `traefik.http.middlewares.leia-\${PREVIEW_ENVIRONMENT}-${name}-redirect.redirectscheme.scheme=\${PREVIEW_HTTP_SCHEME}`,
        `traefik.http.routers.leia-\${PREVIEW_ENVIRONMENT}-${name}-http.middlewares=leia-\${PREVIEW_ENVIRONMENT}-${name}-redirect`,
        `traefik.http.routers.leia-\${PREVIEW_ENVIRONMENT}-${name}-http.service=leia-\${PREVIEW_ENVIRONMENT}-${name}`,
        `traefik.http.routers.leia-\${PREVIEW_ENVIRONMENT}-${name}-https.rule=Host(\`\${${key}_HOST}\`)`,
        `traefik.http.routers.leia-\${PREVIEW_ENVIRONMENT}-${name}-https.entrypoints=https`,
        `traefik.http.routers.leia-\${PREVIEW_ENVIRONMENT}-${name}-https.service=leia-\${PREVIEW_ENVIRONMENT}-${name}`,
        `traefik.http.routers.leia-\${PREVIEW_ENVIRONMENT}-${name}-https.tls=true`,
        `traefik.http.routers.leia-\${PREVIEW_ENVIRONMENT}-${name}-https.tls.certresolver=\${PREVIEW_CERT_RESOLVER}`,
      ],
      networks:{preview:{aliases:[`${name}-\${PREVIEW_ENVIRONMENT}`]},coolify:{}}};
    const depends = {};
    if (seeded && service !== 'runner') depends.seed = {condition:'service_completed_successfully'};
    if (service !== 'auth' && services.includes('auth')) depends.auth = {condition:'service_healthy'};
    if (service === 'runner') depends.redis = {condition:'service_healthy'};
    if (Object.keys(depends).length) result.services[name].depends_on = depends;
  }
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await mkdir(new URL('./stacks/',import.meta.url),{recursive:true});
  for (let mask=1;mask<16;mask++) {
    const services = backendServices.filter((service,index) => mask & (1 << index));
    await writeFile(new URL(`./stacks/${stackName(services)}`,import.meta.url),JSON.stringify(composeFor(services),null,2)+'\n');
  }
}
