import { readFile, writeFile } from 'node:fs/promises';
import { resolve4 } from 'node:dns/promises';
import { config, coolify, cloudflare, environmentVariables, waitForDeployment, applicationSettings } from './api.mjs';
import { createEnvironmentVariables } from './wiring.mjs';
import { databaseNames } from './seed.mjs';
import { repositories, environmentUrls, backendServices } from './manifest.mjs';
import { stackName } from './compose.mjs';

const services = {auth: 'auth', designer_backend: 'designer', workbench_backend: 'workbench', runner: 'runner'};
const marker = 'LEIA managed preview:';

export async function ensureDns(plan) {
  for (const service of Object.keys(plan.services).filter(service => backendServices.includes(service))) {
    const hostname = new URL(plan.urls[service]).hostname;
    if (hostname !== `pr-${plan.environment}-${{auth:'auth', designer_backend:'designer-api', workbench_backend:'workbench-api', runner:'runner'}[service]}.leia.ovh`) {
      throw new Error('Preview hostname does not match the managed environment.');
    }
    const prefix = `zones/${config.cloudflareZoneId}/dns_records`;
    const records = await cloudflare(`${prefix}?name=${encodeURIComponent(hostname)}`);
    if (records.length > 1 || records.some(record => record.comment !== `${marker}${plan.environment}` || record.type !== 'A')) {
      throw new Error(`DNS ownership conflict for ${hostname}.`);
    }
    const value = {type: 'A', name: hostname, content: config.originIp, proxied: false, ttl: 60,
      comment: `${marker}${plan.environment}`};
    if (!records.length) await cloudflare(prefix, 'POST', value);
    else if (records[0].content !== value.content || records[0].proxied) await cloudflare(`${prefix}/${records[0].id}`, 'PUT', value);
  }
  const until = Date.now() + 6 * 60 * 1000;
  while (Date.now() < until) {
    const results = await Promise.all(Object.keys(plan.services).filter(service => backendServices.includes(service)).map(async service => {
      try { return (await resolve4(new URL(plan.urls[service]).hostname)).includes(config.originIp); } catch { return false; }
    }));
    if (results.every(Boolean)) return;
    await new Promise(resolve => setTimeout(resolve, 15000));
  }
  throw new Error('Preview DNS has not propagated. No TLS deployment was started.');
}

export async function verifyEnvironment(plan, timeoutMs = 5 * 60 * 1000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const results = await Promise.all(Object.keys(plan.services).filter(service => backendServices.includes(service)).map(async service => {
      const frontend = service === 'workbench_backend' ? plan.urls.workbench_frontend : plan.urls.designer_frontend;
      try {
        const response = await fetch(plan.urls[service] + '/', {method: 'OPTIONS', redirect: 'error',
          signal: AbortSignal.timeout(10000), headers: {Origin: frontend,
            'Access-Control-Request-Method': 'GET'}});
        const origin = response.headers.get('access-control-allow-origin');
        return response.status === 204 && (origin === frontend || service === 'runner' && origin === '*');
      } catch { return false; }
    }));
    if (results.every(Boolean)) return;
    await new Promise(resolve => setTimeout(resolve, 15000));
  }
  throw new Error('Preview HTTPS readiness or CORS verification failed. Frontends were not published.');
}

export async function deployEnvironment(plan, {infrastructureCommit, infrastructureBranch, localTest = false, onAllocated = async () => {}} = {}) {
  databaseNames(plan.environment);
  if (!/^[a-f0-9]{16}$/.test(plan.revision || '')) throw new Error('Invalid deployment revision.');
  const frontends = [];
  for (const [service, source] of Object.entries(plan.services)) {
    if (source.repository !== repositories[service] || !/^[a-f0-9]{40}$/.test(source.commit || '')) throw new Error('Unexpected deployment source.');
    if (service.endsWith('_frontend')) {
      if (!Number.isSafeInteger(source.pullRequest) || source.pullRequest < 1) throw new Error('Invalid frontend PR.');
      frontends.push({service, number: source.pullRequest});
    }
  }
  const expected = environmentUrls(plan.environment, frontends, Object.keys(plan.services));
  for (const [service, url] of Object.entries(expected)) {
    const testUrl = `http://${plan.environment}-${services[service]}.${config.originIp}.sslip.io`;
    if (plan.urls[service] !== url && !(localTest && services[service] && plan.urls[service] === testUrl)) throw new Error('Unexpected deployment URL.');
  }
  const active = backendServices.filter(service => plan.services[service]);
  if (!active.length) return {...plan,infrastructureCommit};
  if (!localTest) {
    // Check credentials before creating resources. DNS is established before requesting TLS.
    if (!process.env.CLOUDFLARE_DNS_TOKEN) throw new Error('CLOUDFLARE_DNS_TOKEN is required.');
    await ensureDns(plan);
  }
  const name = `leia-preview-${plan.environment}`;
  const apps = (await coolify('applications')).filter(app => app.name === name);
  if (apps.length > 1 || apps.some(app => app.description !== `${marker}${plan.environment}` && !app.description?.startsWith(`${marker}${plan.environment}:`))) throw new Error('Preview application ownership conflict.');
  let app = apps[0];
  const previous = app ? await environmentVariables(app.uuid) : {};
  const source = {};
  for (const [service, uuid] of Object.entries(config.stableApplications)) source[service] = await environmentVariables(uuid);
  const database = active.some(service => service !== 'runner') ? await coolify(`databases/${config.mongoUuid}`) : {};
  if (active.some(service => service !== 'runner') && (database.is_public || !database.internal_db_url || database.status !== 'running:healthy')) throw new Error('The private preview database is not ready.');
  if (!app) {
    const result = await coolify('applications/private-github-app', 'POST', {
      ...applicationSettings(name, infrastructureCommit, infrastructureBranch),
      description: `${marker}${plan.environment}`, build_pack: 'dockercompose',
      docker_compose_location: `/previews/stacks/${stackName(active)}`, connect_to_docker_network: false,
    });
    await onAllocated(result.uuid);
    app = await coolify(`applications/${result.uuid}`);
  }
  await onAllocated(app.uuid);
  const values = createEnvironmentVariables(plan, source, database.internal_db_url, previous);
  values.PREVIEW_CERT_RESOLVER = localTest ? '' : 'letsencrypt';
  values.PREVIEW_HTTP_SCHEME = localTest ? 'http' : 'https';
  for (const service of active) values[`${services[service].toUpperCase()}_HOST`] = new URL(plan.urls[service]).hostname;
  await coolify(`applications/${app.uuid}/envs/bulk`, 'PATCH', {data: Object.entries(values).map(([key, value]) => ({
    key, value, is_literal: true, is_preview: false, is_runtime: true,
    is_buildtime: key.endsWith('_COMMIT') || key === 'PREVIEW_ENVIRONMENT',
  }))});
  await coolify(`applications/${app.uuid}`, 'PATCH', {git_commit_sha: infrastructureCommit,
    docker_compose_location: `/previews/stacks/${stackName(active)}`,
    docker_compose_custom_start_command:null,
    is_raw_compose_deployment_enabled:true, description: `${marker}${plan.environment}:${plan.revision}`});
  const deployment = await coolify('deploy', 'POST', {uuid: app.uuid});
  const deploymentUuid = deployment.deployments[0].deployment_uuid;
  await waitForDeployment(deploymentUuid);
  await verifyEnvironment(plan);
  if (!localTest) {
    const managed=environmentUrls(plan.environment,[],backendServices);
    for (const service of backendServices.filter(service => !active.includes(service))) {
      const prefix=`zones/${config.cloudflareZoneId}/dns_records`;
      const records=await cloudflare(`${prefix}?name=${encodeURIComponent(new URL(managed[service]).hostname)}`);
      for (const record of records) {
        if (record.comment !== `${marker}${plan.environment}` || record.type !== 'A' || record.content !== config.originIp) throw new Error('Stale DNS ownership conflict.');
        await cloudflare(`${prefix}/${record.id}`,'DELETE');
      }
    }
  }
  return {...plan, applicationUuid: app.uuid, deploymentUuid, infrastructureCommit};
}

if (process.argv[1]?.endsWith('/deploy-environment.mjs')) {
  try {
    const plan = JSON.parse(await readFile(process.argv[2], 'utf8'));
    const result = await deployEnvironment(plan, {infrastructureCommit: process.env.INFRASTRUCTURE_COMMIT,
      infrastructureBranch: process.env.INFRASTRUCTURE_BRANCH,
      localTest: process.env.LEIA_PREVIEW_LOCAL_TEST === 'true'});
    await writeFile(process.argv[3] || 'preview-state.json', JSON.stringify(result, null, 2));
    console.log(`Ready: ${result.environment}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
