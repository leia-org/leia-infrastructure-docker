import { config, coolify, cloudflare, waitForDeployment, applicationSettings } from './api.mjs';
import { databaseNames } from './seed.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function removeApplication(uuid) {
  await coolify(`applications/${uuid}?delete_volumes=false&delete_configurations=true&docker_cleanup=false`, 'DELETE');
  for (let attempt = 0; attempt < 30; attempt++) {
    if (!(await coolify('applications')).some(app => app.uuid === uuid)) return;
    await pause(2000);
  }
  throw new Error('Preview application deletion is still pending.');
}

export async function cleanupEnvironment(plan, {infrastructureCommit, infrastructureBranch, localTest = false} = {}) {
  databaseNames(plan.environment);
  if (!plan.applicationUuid) throw new Error('An owned preview application UUID is required.');
  const apps = await coolify('applications');
  const app = apps.find(app => app.uuid === plan.applicationUuid);
  if (app && (app.name !== `leia-preview-${plan.environment}` || !app.description?.startsWith(`LEIA managed preview:${plan.environment}:`))) {
    throw new Error('Refusing to remove an application without matching preview ownership.');
  }
  if (app) await removeApplication(app.uuid);
  const name = `leia-preview-cleanup-${plan.environment}`;
  const existing = (await coolify('applications')).filter(app => app.name === name);
  if (existing.length > 1 || existing.some(app => app.description !== `LEIA managed preview cleanup:${plan.environment}`)) {
    throw new Error('Cleanup application ownership conflict.');
  }
  const database = await coolify(`databases/${config.mongoUuid}`);
  if (database.is_public || !database.internal_db_url) throw new Error('The preview database must remain private.');
  const created = existing[0] || await coolify('applications/private-github-app', 'POST', {
    ...applicationSettings(name, infrastructureCommit, infrastructureBranch),
    description: `LEIA managed preview cleanup:${plan.environment}`, build_pack: 'dockerfile',
    dockerfile_location: '/previews/Dockerfile.seed', ports_exposes: '3000',
    health_check_enabled: true, health_check_path: '/', health_check_start_period: 10,
    health_check_retries: 20, limits_memory: '256m', limits_cpus: '0.5',
  });
  await coolify(`applications/${created.uuid}/envs/bulk`, 'PATCH', {data: Object.entries({
    PREVIEW_ENVIRONMENT: plan.environment, PREVIEW_MONGO_ADMIN_URI: database.internal_db_url,
    PREVIEW_OPERATION: 'cleanup', SEED_SERVE: 'true', PORT: '3000',
  }).map(([key, value]) => ({key, value, is_literal: true, is_runtime: true, is_buildtime: false}))});
  await coolify(`applications/${created.uuid}`, 'PATCH', {git_commit_sha: infrastructureCommit});
  const deployment = await coolify('deploy', 'POST', {uuid: created.uuid});
  await waitForDeployment(deployment.deployments[0].deployment_uuid);
  await removeApplication(created.uuid);
  if (!localTest) for (const service of ['auth', 'designer_backend', 'workbench_backend', 'runner']) {
    const hostname = new URL(plan.urls[service]).hostname;
    const prefix = `zones/${config.cloudflareZoneId}/dns_records`;
    const records = await cloudflare(`${prefix}?name=${encodeURIComponent(hostname)}`);
    for (const record of records) {
      if (record.comment !== `LEIA managed preview:${plan.environment}` || record.type !== 'A' || record.content !== config.originIp) {
        throw new Error('Refusing to remove a DNS record without matching preview ownership.');
      }
      await cloudflare(`${prefix}/${record.id}`, 'DELETE');
    }
  }
  console.log(`Removed isolated environment: ${plan.environment}`);
}
