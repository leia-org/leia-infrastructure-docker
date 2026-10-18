import { createHash } from 'node:crypto';

export const repositories = Object.freeze({
  designer_frontend: 'leia-org/leia-designer-frontend',
  workbench_frontend: 'leia-org/leia-workbench-frontend',
  designer_backend: 'leia-org/leia-designer-backend',
  workbench_backend: 'leia-org/leia-workbench-backend',
  auth: 'leia-org/leia-auth',
  runner: 'leia-org/leia-runner',
});
export const backendServices = ['auth', 'designer_backend', 'workbench_backend', 'runner'];
export const stableUrls = Object.freeze({auth: 'https://pre.auth.leia.ovh',
  designer_backend: 'https://pre.backend.designer.leia.ovh',
  workbench_backend: 'https://pre.backend.workbench.leia.ovh', runner: 'https://pre.runner.leia.ovh',
  designer_frontend: 'https://pre.designer.leia.ovh', workbench_frontend: 'https://pre.workbench.leia.ovh'});
export const start = '<!-- leia-preview-environment:start -->';
export const end = '<!-- leia-preview-environment:end -->';

export function validateEnvironment(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{1,23}$/.test(value) || /^(pre|prod|production|development|main|develop)$/.test(value)) {
    throw new Error('Use a unique environment slug of 2–24 lowercase letters, digits or hyphens.');
  }
  return value;
}
export function parsePullRequest(value) {
  if (typeof value !== 'string') throw new Error('Pull requests must be full GitHub URLs.');
  const match = /^https:\/\/github\.com\/(leia-org\/[^/]+)\/pull\/([1-9][0-9]*)$/.exec(value);
  if (!match || !Object.values(repositories).includes(match[1])) throw new Error('Only the six LEIA application repositories are supported.');
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number)) throw new Error('Invalid pull request number.');
  return {repository: match[1], number, url: value,
    service: Object.keys(repositories).find(key => repositories[key] === match[1])};
}
export function parseManifest(body) {
  if (typeof body !== 'string' || !body.includes(start)) return null;
  if (body.split(start).length !== 2 || body.split(end).length !== 2 || body.indexOf(end) < body.indexOf(start)) {
    throw new Error('Exactly one complete preview environment block is required.');
  }
  const block = body.slice(body.indexOf(start) + start.length, body.indexOf(end)).trim();
  const fence = /^```json\s*\n([\s\S]*?)\n```$/.exec(block);
  if (!fence) throw new Error('The environment block must contain one JSON code block.');
  let value;
  try { value = JSON.parse(fence[1]); } catch { throw new Error('Invalid preview environment JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(k => !['environment', 'pull_requests', 'isolation'].includes(k))) throw new Error('Unsupported preview field.');
  validateEnvironment(value.environment);
  const isolation = value.isolation ?? 'selective';
  if (!['selective', 'full'].includes(isolation)) throw new Error('Isolation must be selective or full.');
  const refs = value.pull_requests ?? [];
  if (!Array.isArray(refs) || refs.length > 6) throw new Error('List at most six pull request URLs.');
  const pullRequests = refs.map(parsePullRequest).sort((a, b) => a.service.localeCompare(b.service));
  if (new Set(pullRequests.map(pr => pr.service)).size !== pullRequests.length) throw new Error('Only one PR per service is supported.');
  return {environment: value.environment, pullRequests, isolation};
}
export function manifestBlock(manifest) {
  return `${start}\n\`\`\`json\n${JSON.stringify({environment: manifest.environment,
    isolation: manifest.isolation || 'selective', pull_requests: manifest.pullRequests.map(pr => pr.url).sort()}, null, 2)}\n\`\`\`\n${end}`;
}
export function updateManifest(body, manifest) {
  parseManifest(body); // Never replace ambiguous or malformed user text.
  const block = manifestBlock(manifest);
  if (body?.includes(start)) return body.slice(0, body.indexOf(start)) + block + body.slice(body.indexOf(end) + end.length);
  return `${body || ''}${body ? '\n\n' : ''}${block}`;
}
export function environmentUrls(environment, pullRequests, deployed = pullRequests.map(pr => pr.service)) {
  validateEnvironment(environment);
  const result = {...stableUrls};
  const suffix = {auth: 'auth', designer_backend: 'designer-api', workbench_backend: 'workbench-api', runner: 'runner'};
  for (const service of backendServices) if (deployed.includes(service)) result[service] = `https://pr-${environment}-${suffix[service]}.leia.ovh`;
  for (const pr of pullRequests) if (pr.service.endsWith('_frontend')) {
    result[pr.service] = `https://pre-${pr.number}.${pr.service === 'designer_frontend' ? 'designer' : 'workbench'}.leia.ovh`;
  }
  return result;
}
export async function validatePullRequest(reference, pr, isMember) {
  if (pr.base?.repo?.full_name !== reference.repository || pr.base?.ref !== 'develop' || pr.state !== 'open') {
    throw new Error(`${reference.url}: an open PR targeting develop is required.`);
  }
  // author_association also includes outside collaborators and is not a membership check.
  if (!pr.user?.login || !await isMember(pr.user.login)) throw new Error(`${reference.url}: the author must be an active leia-org member.`);
  if (pr.head?.repo?.full_name !== reference.repository) throw new Error(`${reference.url}: fork code requires a separately reviewed path.`);
  if (!/^[a-f0-9]{40}$/.test(pr.head?.sha || '')) throw new Error('Invalid Git commit.');
}
export async function resolveEnvironment(manifest, getPullRequest, getDevelopCommit, isMember) {
  if (typeof isMember !== 'function') throw new Error('An authenticated organization membership check is required.');
  validateEnvironment(manifest.environment);
  if (!manifest.pullRequests.length) throw new Error('The coordinator must resolve at least one open PR.');
  const selected = {};
  for (const reference of manifest.pullRequests) {
    const pr = await getPullRequest(reference.repository, reference.number);
    await validatePullRequest(reference, pr, isMember);
    selected[reference.service] = {repository: reference.repository, commit: pr.head.sha, pullRequest: reference.number};
  }
  if (manifest.isolation === 'full') for (const service of backendServices) if (!selected[service]) {
    const commit = await getDevelopCommit(repositories[service]);
    if (!/^[a-f0-9]{40}$/.test(commit || '')) throw new Error('Invalid develop commit.');
    selected[service] = {repository: repositories[service], commit, pullRequest: null};
  }
  const services = Object.fromEntries(Object.entries(selected).sort(([a], [b]) => a.localeCompare(b)));
  const urls = environmentUrls(manifest.environment, manifest.pullRequests, Object.keys(services));
  const isolation = manifest.isolation || 'selective';
  const revision = createHash('sha256').update(JSON.stringify({services, urls, isolation})).digest('hex').slice(0, 16);
  return {environment: manifest.environment, isolation, revision, services, urls,
    pullRequests: manifest.pullRequests,
    frontendBuildVariables: {
      designer_frontend: {VITE_APP_BACKEND: urls.designer_backend, VITE_AUTH_SERVICE_BACKEND: urls.auth,
        VITE_WORKBENCH_URL: urls.workbench_frontend},
      workbench_frontend: {VITE_APP_BACKEND: urls.workbench_backend, VITE_AUTH_SERVICE_BACKEND: urls.auth},
    }};
}
