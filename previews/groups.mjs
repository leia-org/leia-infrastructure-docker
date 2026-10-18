import {parseManifest, parsePullRequest, updateManifest, validatePullRequest} from './manifest.mjs';

const short = {designer_frontend:'df', workbench_frontend:'wf', designer_backend:'db', workbench_backend:'wb', auth:'auth', runner:'runner'};
export const standaloneName = reference => `${short[reference.service]}-${reference.number}`;

// Resolve the complete open-PR snapshot before provisioning or deleting anything.
// An explicit name or a one-sided full URL is sufficient; PR numbers are never guessed.
export async function groupPullRequests(pullRequests, previous, isMember, closedReferences = new Set()) {
  const items = new Map(), errors = [];
  for (const pr of pullRequests) {
    const reference = parsePullRequest(pr.html_url);
    try {
      await validatePullRequest(reference, pr, isMember);
      items.set(reference.url, {pr, reference, manifest: parseManifest(pr.body)});
    } catch (error) { errors.push({pullRequest: reference.url, message: error.message}); }
  }
  const parents = new Map([...items.keys()].map(url => [url, url]));
  const find = url => { const parent = parents.get(url); if (parent === url) return url;
    const root = find(parent); parents.set(url, root); return root; };
  const union = (a, b) => { const roots = [find(a), find(b)].sort(); parents.set(roots[1], roots[0]); };
  const named = new Map(), invalid = new Set();
  for (const [url, item] of items) if (item.manifest) {
    if (named.has(item.manifest.environment)) union(url, named.get(item.manifest.environment));
    else named.set(item.manifest.environment, url);
    for (const ref of item.manifest.pullRequests) {
      if (items.has(ref.url)) union(url, ref.url);
      // A previously linked PR can be closed: remove its live service, not the remaining group.
      else if (!closedReferences.has(ref.url)) {
        invalid.add(url); errors.push({pullRequest:url, message:`Linked PR is unavailable or not authorized: ${ref.url}`});
      }
    }
  }
  const groups = new Map();
  for (const [url, item] of items) {
    const root = find(url); if (!groups.has(root)) groups.set(root, []); groups.get(root).push(item);
  }
  const desired = [], patches = [];
  for (const group of groups.values()) {
    const refs = group.map(item => item.reference).sort((a,b) => a.url.localeCompare(b.url));
    const groupUrls = new Set(refs.map(ref => ref.url));
    if (group.some(item => invalid.has(item.reference.url))) continue;
    if (new Set(refs.map(ref => ref.service)).size !== refs.length) {
      for (const ref of refs) errors.push({pullRequest:ref.url,message:'A group cannot contain two PRs for the same service. Unlink one explicitly.'});
      continue;
    }
    const old = Object.values(previous.environments || {}).filter(env => env.pullRequests?.some(pr => groupUrls.has(pr.url)))
      .sort((a,b) => Number(!a.applicationUuid)-Number(!b.applicationUuid) || (a.createdAt || '').localeCompare(b.createdAt || '') || a.environment.localeCompare(b.environment));
    const names = [...new Set(group.map(item => item.manifest?.environment).filter(Boolean))].sort();
    // Only reuse an old ID if it still belongs to this connected component. This also supports explicit splits.
    // Keep an already running backend group before a frontend-only placeholder; do not copy its data again.
    const claimed = old.find(env => env.applicationUuid && refs.some(ref => !ref.service.endsWith('_frontend') && env.pullRequests?.some(pr => pr.url === ref.url))) || old.find(env => names.includes(env.environment));
    const environment = claimed?.environment || names[0] || old[0]?.environment || standaloneName(refs[0]);
    const isolation = group.some(item => item.manifest?.isolation === 'full') ? 'full' : 'selective';
    const manifest = {environment, isolation, pullRequests: refs};
    desired.push(manifest);
    for (const item of group) {
      const body = updateManifest(item.pr.body, manifest);
      if (body !== (item.pr.body || '')) patches.push({reference:item.reference, before:item.pr.body || '', body});
    }
  }
  if (new Set(desired.map(group => group.environment)).size !== desired.length) throw new Error('Environment ID collision. No resources were changed.');
  return {desired, patches, errors};
}

export function obsoleteEnvironments(previous, desired, openPullRequests, errors = []) {
  const retained = new Set(desired.map(plan => plan.environment));
  const open = new Set(openPullRequests.map(pr => pr.html_url));
  const invalid = new Set(errors.map(error => error.pullRequest));
  return Object.values(previous.environments || {}).filter(env => !retained.has(env.environment) &&
    !env.pullRequests?.some(pr => open.has(pr.url) && invalid.has(pr.url)));
}
