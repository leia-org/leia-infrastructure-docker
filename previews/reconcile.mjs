import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {groupPullRequests,obsoleteEnvironments} from './groups.mjs';
import {resolveEnvironment,backendServices} from './manifest.mjs';
import {githubClient} from './github.mjs';
import {config} from './api.mjs';

export function statusComment(plan) {
  const phase={ready:'Ready',building:'Building frontends',deploying:'Deploying',queued:'Queued (server capacity)',failed:'Deployment failed',closed:'Removed'}[plan.status] || 'Pending';
  const lines=[`### LEIA preview: ${plan.environment}`,`**${phase}**`, '',
    '| Service | Source | URL |','|---|---|---|'];
  for (const [service,url] of Object.entries(plan.urls)) {
    const source=plan.services[service];
    lines.push(`| ${service.replaceAll('_',' ')} | ${source ? `${source.pullRequest ? `PR #${source.pullRequest}` : 'develop'} · \`${source.commit.slice(0,7)}\`` : 'Shared pre'} | [Open](${url}) |`);
  }
  const databases=Object.keys(plan.services).filter(service => ['auth','designer_backend','workbench_backend'].includes(service));
  lines.push('', `Database copies: ${databases.length ? databases.join(', ') : 'none'}. Existing test data is preserved on updates.`);
  if (plan.isolation !== 'full') lines.push('Unchanged services use shared pre. New records in a copied database are not synchronized to pre; operations handled by shared services can modify pre.');
  lines.push('', 'Link another PR by adding its full URL to `pull_requests` in either PR, or reuse this environment name. The bot synchronizes the managed blocks.',
    'Only active leia-org members with same-repository PRs targeting develop can deploy.');
  return lines.join('\n');
}
export async function planReconciliation(github,previous={environments:{}}) {
  const snapshot=await github.snapshot();
  const closed=await github.closedReferences(snapshot);
  const groups=await groupPullRequests(snapshot,previous,login => github.isMember(login),closed);
  const plans=[];
  for (const manifest of groups.desired) plans.push(await resolveEnvironment(manifest,
    (repo,number) => github.getPullRequest(repo,number),repo => github.getDevelopCommit(repo),login => github.isMember(login)));
  return {...groups,plans,snapshot,obsolete:obsoleteEnvironments(previous,plans,snapshot,groups.errors)};
}
export async function reconcile({github,previous={environments:{}},deploy,cleanup,publish,save,
  infrastructureCommit,dryRun=false,now=() => new Date().toISOString(),maximumActive=config.maximumActiveEnvironments}) {
  const planned=await planReconciliation(github,previous);
  if (dryRun) return {plans:planned.plans,patches:planned.patches.map(p => p.reference.url),errors:planned.errors,
    obsolete:planned.obsolete.map(p => p.environment)};
  const state=structuredClone(previous);state.environments ||= {};state.version=1;
  const persist=async () => {state.updatedAt=now();await save(state);};
  // Update only the machine-owned block, after membership and complete-group validation.
  for (const patch of planned.patches) {
    const manifest=planned.desired.find(group => group.pullRequests.some(pr => pr.url === patch.reference.url));
    await github.patchManifest(patch,manifest);
  }
  // Closed groups free capacity first. Replaced groups stay until their replacements are ready.
  const open=new Set(planned.snapshot.map(pr => pr.html_url));
  for (const old of planned.obsolete.filter(env => !env.pullRequests.some(pr => open.has(pr.url)))) {
    await cleanup(old); delete state.environments[old.environment]; await persist();
    for (const ref of old.pullRequests) await github.comment(ref,statusComment({...old,status:'closed'}));
  }
  const plans=planned.plans.sort((a,b) => Number(!state.environments[a.environment])-Number(!state.environments[b.environment]) || a.environment.localeCompare(b.environment));
  for (const plan of plans) {
    const old=state.environments[plan.environment];
    const usesServer=Object.keys(plan.services).some(service => backendServices.includes(service));
    const active=Object.values(state.environments).filter(env => env.applicationUuid).length;
    if (usesServer && !old?.applicationUuid && active >= maximumActive) {
      const queued={...plan,status:'queued'};
      for (const ref of plan.pullRequests) await github.comment(ref,statusComment(queued));
      continue;
    }
    const unchanged=old?.status === 'ready' && old.revision === plan.revision && old.infrastructureCommit === infrastructureCommit;
    if (unchanged) {
      // Heal missing comments and merge any newly discovered one-sided links without a redeploy.
      for (const ref of plan.pullRequests) await github.comment(ref,statusComment(old));
      continue;
    }
    let current={...plan,createdAt:old?.createdAt || now(),infrastructureCommit,status:'deploying',
      ...(old?.applicationUuid ? {applicationUuid:old.applicationUuid}: {})};
    state.environments[plan.environment]=current; await persist();
    try {
      const deployed=usesServer ? await deploy(plan,old,async applicationUuid => {
        current.applicationUuid=applicationUuid;state.environments[plan.environment]=current;await persist();
      }) : {};
      current={...current,...deployed,status:'building'};
      state.environments[plan.environment]=current;await persist();
      for (const ref of plan.pullRequests) await github.comment(ref,statusComment(current));
      await publish(plan,old);
      // Check again before declaring ready: pushes/close/link edits may arrive during a build.
      const fresh=await planReconciliation(github,state);
      if (!fresh.plans.some(candidate => candidate.environment === plan.environment && candidate.revision === plan.revision)) {
        throw new Error('PR source or links changed during deployment. Reconciliation will retry.');
      }
      if (!usesServer && old?.applicationUuid) {await cleanup(old);delete current.applicationUuid;}
      current.status='ready';state.environments[plan.environment]=current;await persist();
      for (const ref of plan.pullRequests) await github.comment(ref,statusComment(current));
    } catch {
      current.status='failed';state.environments[plan.environment]=current;await persist();
      for (const ref of plan.pullRequests) await github.comment(ref,statusComment(current));
    }
  }
  // Never remove a duplicate/replaced group before every still-open PR has a ready destination.
  for (const old of planned.obsolete.filter(env => env.pullRequests.some(pr => open.has(pr.url)))) {
    const replacements=old.pullRequests.filter(pr => open.has(pr.url)).map(ref =>
      Object.values(state.environments).find(env => env.environment !== old.environment && env.status === 'ready' && env.pullRequests?.some(pr => pr.url === ref.url)));
    if (replacements.length && replacements.every(Boolean)) {
      await cleanup(old);delete state.environments[old.environment];await persist();
    }
  }
  // Readiness failure and invalid metadata retain owned resources; they never trigger mass cleanup.
  return {state,errors:planned.errors};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const statePath=process.argv[2] || 'preview-state.json';
    let previous;
    try {previous=JSON.parse(await readFile(statePath,'utf8'));} catch(error) {if(error.code !== 'ENOENT') throw error;}
    const github=githubClient(process.env.PREVIEW_GITHUB_TOKEN || process.env.GITHUB_TOKEN);
    // CLI planning is deliberately read-only; activation must supply trusted deployment adapters.
    const result=await reconcile({github,previous,dryRun:true});
    console.log(JSON.stringify(result,null,2));
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
