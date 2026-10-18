import { readFile } from 'node:fs/promises';

export const config = JSON.parse(await readFile(new URL('./deployment.json', import.meta.url), 'utf8'));

export async function coolify(path, method = 'GET', body) {
  if (!process.env.COOLIFY_TOKEN) throw new Error('COOLIFY_TOKEN is required.');
  const response = await fetch(`${config.coolifyUrl}/api/v1/${path}`, {
    method, headers: {Authorization: `Bearer ${process.env.COOLIFY_TOKEN}`,
      'Content-Type': 'application/json', 'User-Agent': 'LEIA-Preview-Coordinator/1.0'},
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Coolify ${method} request failed: HTTP ${response.status}`);
  return response.json();
}

export async function cloudflare(path, method = 'GET', body, kind = 'dns') {
  const token = process.env[kind === 'workers' ? 'CLOUDFLARE_WORKERS_TOKEN' : 'CLOUDFLARE_DNS_TOKEN'];
  if (!token) throw new Error(`Cloudflare ${kind} token is required.`);
  const response = await fetch(`https://api.cloudflare.com/client/v4/${path}`, {
    method, headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Cloudflare ${method} request failed: HTTP ${response.status}`);
  const result = await response.json();
  if (!result.success) throw new Error('Cloudflare returned an unsuccessful response.');
  return result.result;
}

export async function environmentVariables(uuid) {
  const values = await coolify(`applications/${uuid}/envs`);
  return Object.fromEntries(values.filter(value => !value.is_preview)
    .map(value => [value.key, String(value.value ?? value.real_value ?? '')]));
}

export async function waitForDeployment(uuid, timeoutMs = 30 * 60 * 1000) {
  const until = Date.now() + timeoutMs;
  let reported;
  while (Date.now() < until) {
    const deployment = await coolify(`deployments/${uuid}`);
    if (deployment.status !== reported) { console.log(`Deployment ${uuid}: ${deployment.status}`); reported = deployment.status; }
    if (deployment.status === 'finished') return;
    if (!['queued', 'in_progress'].includes(deployment.status)) throw new Error(`Deployment ${uuid} did not finish successfully.`);
    await new Promise(resolve => setTimeout(resolve, 15000));
  }
  throw new Error(`Deployment ${uuid} timed out.`);
}

export function applicationSettings(name, infrastructureCommit, infrastructureBranch) {
  if (!/^[a-f0-9]{40}$/.test(infrastructureCommit || '')) throw new Error('An exact infrastructure commit is required.');
  return {
    project_uuid: config.projectUuid, server_uuid: config.serverUuid,
    environment_name: config.environmentName, destination_uuid: config.destinationUuid,
    github_app_uuid: config.githubAppUuid, git_repository: 'leia-org/leia-infrastructure-docker',
    git_branch: infrastructureBranch || 'main', git_commit_sha: infrastructureCommit, name,
    is_auto_deploy_enabled: false, is_preview_deployments_enabled: false,
    instant_deploy: false, autogenerate_domain: false, inject_build_args_to_dockerfile: false,
  };
}
