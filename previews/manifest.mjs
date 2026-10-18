import { createHash } from 'node:crypto';

export const repositories = Object.freeze({
  designer_frontend: 'leia-org/leia-designer-frontend',
  workbench_frontend: 'leia-org/leia-workbench-frontend',
  designer_backend: 'leia-org/leia-designer-backend',
  workbench_backend: 'leia-org/leia-workbench-backend',
  auth: 'leia-org/leia-auth',
  runner: 'leia-org/leia-runner',
});
const start = '<!-- leia-preview-environment:start -->';
const end = '<!-- leia-preview-environment:end -->';
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value);

export function parsePullRequest(value) {
  if (typeof value !== 'string') throw new Error('Pull requests must be full GitHub URLs.');
  const match = /^https:\/\/github\.com\/(leia-org\/[^/]+)\/pull\/([1-9][0-9]*)$/.exec(value);
  if (!match || !Object.values(repositories).includes(match[1])) {
    throw new Error('Only pull requests from the six LEIA application repositories are supported.');
  }
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number)) throw new Error('Invalid pull request number.');
  return { repository: match[1], number, url: value,
    service: Object.keys(repositories).find(key => repositories[key] === match[1]) };
}

export function parseManifest(body) {
  if (typeof body !== 'string' || !body.includes(start)) return null;
  if (body.split(start).length !== 2 || body.split(end).length !== 2) {
    throw new Error('Exactly one preview environment block is required.');
  }
  const block = body.slice(body.indexOf(start) + start.length, body.indexOf(end)).trim();
  const fence = /^```json\s*\n([\s\S]*?)\n```$/.exec(block);
  if (!fence) throw new Error('The preview environment block must contain one JSON code block.');
  let value;
  try { value = JSON.parse(fence[1]); } catch { throw new Error('Invalid preview environment JSON.'); }
  if (!plainObject(value) || Object.keys(value).some(k => !['environment', 'pull_requests'].includes(k))) {
    throw new Error('Supported preview fields: environment and pull_requests.');
  }
  if (!/^[a-z][a-z0-9-]{1,23}$/.test(value.environment || '') || /^(pre|prod|production|development|main|develop)$/.test(value.environment)) {
    throw new Error('Use a unique environment slug of 2–24 lowercase letters, digits or hyphens.');
  }
  if (!Array.isArray(value.pull_requests) || value.pull_requests.length < 1 || value.pull_requests.length > 6) {
    throw new Error('List between one and six pull request URLs.');
  }
  const pullRequests = value.pull_requests.map(parsePullRequest);
  if (new Set(pullRequests.map(pr => pr.service)).size !== pullRequests.length) {
    throw new Error('An environment can contain only one pull request per service.');
  }
  return { environment: value.environment, pullRequests: pullRequests.sort((a, b) => a.service.localeCompare(b.service)) };
}

export function environmentUrls(environment, pullRequests) {
  // Keep backend names under *.leia.ovh for ordinary Cloudflare wildcard TLS coverage.
  // Frontend preview URLs retain the existing Workers naming convention.
  const result = {
    auth: `https://pr-${environment}-auth.leia.ovh`,
    designer_backend: `https://pr-${environment}-designer-api.leia.ovh`,
    workbench_backend: `https://pr-${environment}-workbench-api.leia.ovh`,
    runner: `https://pr-${environment}-runner.leia.ovh`,
    designer_frontend: 'https://pre.designer.leia.ovh',
    workbench_frontend: 'https://pre.workbench.leia.ovh',
  };
  for (const pr of pullRequests) {
    if (pr.service === 'designer_frontend') result.designer_frontend = `https://pre-${pr.number}.designer.leia.ovh`;
    if (pr.service === 'workbench_frontend') result.workbench_frontend = `https://pre-${pr.number}.workbench.leia.ovh`;
  }
  return result;
}

export async function resolveEnvironment(manifest, getPullRequest, getDevelopCommit) {
  const selected = {};
  const signature = JSON.stringify(manifest.pullRequests.map(pr => pr.url));
  for (const reference of manifest.pullRequests) {
    const pr = await getPullRequest(reference.repository, reference.number);
    if (pr.base?.repo?.full_name !== reference.repository || pr.base?.ref !== 'develop') {
      throw new Error(`${reference.url}: previews must target develop in the expected repository.`);
    }
    if (pr.state !== 'open') throw new Error(`${reference.url}: linked pull requests must be open.`);
    if (!['OWNER', 'MEMBER', 'COLLABORATOR'].includes(pr.author_association) || pr.head?.repo?.full_name !== reference.repository) {
      throw new Error(`${reference.url}: fork or external contributions require a separate reviewed deployment.`);
    }
    const related = parseManifest(pr.body);
    if (!manifest.implicit && (!related || related.environment !== manifest.environment || JSON.stringify(related.pullRequests.map(item => item.url)) !== signature)) {
      throw new Error(`${reference.url}: copy the same environment block into every linked pull request.`);
    }
    if (manifest.implicit && (manifest.pullRequests.length !== 1 || reference.service.endsWith('_frontend') || related)) {
      throw new Error('Implicit environments are supported only for a single unlinked backend PR.');
    }
    if (!/^[a-f0-9]{40}$/.test(pr.head?.sha || '')) throw new Error('Invalid Git commit.');
    selected[reference.service] = { repository: reference.repository, commit: pr.head.sha, pullRequest: reference.number };
  }
  for (const [service, repository] of Object.entries(repositories)) {
    if (selected[service] || service.endsWith('_frontend')) continue;
    const commit = await getDevelopCommit(repository);
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid develop commit.');
    selected[service] = { repository, commit, pullRequest: null };
  }
  const urls = environmentUrls(manifest.environment, manifest.pullRequests);
  const revision = createHash('sha256').update(JSON.stringify(selected)).digest('hex').slice(0, 16);
  return { environment: manifest.environment, revision, services: selected, urls,
    frontendBuildVariables: {
      designer_frontend: {
        VITE_APP_BACKEND: urls.designer_backend,
        VITE_AUTH_SERVICE_BACKEND: urls.auth,
        VITE_WORKBENCH_URL: urls.workbench_frontend,
      },
      workbench_frontend: { VITE_APP_BACKEND: urls.workbench_backend, VITE_AUTH_SERVICE_BACKEND: urls.auth },
    },
  };
}
