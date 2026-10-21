import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {githubClient} from './github.mjs';
import {stateStore} from './state.mjs';
import {reconcile,planReconciliation,statusComment} from './reconcile.mjs';
import {deployEnvironment} from './deploy-environment.mjs';
import {cleanupEnvironment} from './cleanup-environment.mjs';
import {frontendsPublished,latestFrontend,previewTag} from './frontend.mjs';
import {backendServices} from './manifest.mjs';
import {config,cloudflare} from './api.mjs';

const options=()=>({infrastructureCommit:process.env.GITHUB_SHA,infrastructureBranch:process.env.GITHUB_REF_NAME});
async function garbageCollectFrontends(github,state,snapshot) {
  const open=new Set(snapshot.map(pr=>pr.html_url));
  for(const [url,entry] of Object.entries(state.frontendPreviews || {})) {
    if(open.has(url)) continue;
    const plan={environment:entry.environment,revision:entry.revision,services:{[entry.service]:entry.source}};
    const latest=await latestFrontend(plan,entry.service);
    const candidates=[entry,entry.pending].filter(Boolean);
    if(candidates.some(candidate=>latest?.annotations?.['workers/tag']===previewTag(candidate) &&
      latest?.annotations?.['workers/message']===`LEIA linked preview ${candidate.environment} ${candidate.revision}`)) {
      await cloudflare(`accounts/${config.cloudflareAccountId}/workers/workers/${config.workers[entry.service]}/previews/pre-${entry.source.pullRequest}`,'DELETE',undefined,'workers');
    } // Unknown/native deployments are never deleted by the coordinator.
    delete state.frontendPreviews[url];
  }
}
export async function prepare({dryRun=false}={}) {
  const github=githubClient(process.env.PREVIEW_GITHUB_TOKEN),store=stateStore(process.env.GITHUB_TOKEN);
  const previous=await store.load();
  if (!dryRun && process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' && !await github.isMember(process.env.GITHUB_ACTOR)) throw new Error('Only leia-org members may trigger deployment.');
  if(dryRun) return reconcile({github,previous,dryRun:true});
  const plans=[];
  const result=await reconcile({github,previous,...options(),save:value=>store.save(value),
    deploy:(plan,old,onAllocated)=>deployEnvironment(plan,{...options(),onAllocated}),
    cleanup:plan=>cleanupEnvironment(plan,options()),isPublished:frontendsPublished,
    publish:async plan=>{
      if(!Object.keys(plan.services).some(service=>service.endsWith('_frontend'))) return;
      plans.push(plan);return {pending:true};
    }});
  const state=result.state;
  // Record expected ownership before publication so close/build races can clean up a published preview even before finalization.
  state.frontendPreviews ||= {};
  for(const plan of plans) for(const ref of plan.pullRequests.filter(ref=>ref.service.endsWith('_frontend'))) {
    const expected={environment:plan.environment,revision:plan.revision,service:ref.service,source:plan.services[ref.service]};
    state.frontendPreviews[ref.url]={...(state.frontendPreviews[ref.url] || expected),pending:expected};
  }
  // Closed frontend resources are independent from backend group lifetimes.
  await garbageCollectFrontends(github,state,await github.snapshot());await store.save(state);
  const matrix=plans.flatMap(plan=>Object.entries(plan.services).filter(([service])=>service.endsWith('_frontend'))
    .map(([service,source])=>({environment:plan.environment,service,repository:source.repository,commit:source.commit,
      artifact:`frontend-${plan.environment}-${service}-${plan.revision}`})));
  return {plans,state,matrix,errors:result.errors};
}
export async function finalize(artifact) {
  const github=githubClient(process.env.PREVIEW_GITHUB_TOKEN),store=stateStore(process.env.GITHUB_TOKEN);
  if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' && !await github.isMember(process.env.GITHUB_ACTOR)) throw new Error('Only leia-org members may finalize deployment.');
  const state=await store.load(),fresh=await planReconciliation(github,state);
  for(const plan of artifact.plans) {
    const current=state.environments[plan.environment];
    if(!current || current.revision!==plan.revision || !current.backendReady) continue;
    const live=fresh.plans.find(value=>value.environment===plan.environment && value.revision===plan.revision);
    if(!live) continue; // A new push or close will be handled by the next globally locked run.
    current.status=await frontendsPublished(plan) ? 'ready':'failed';
    if(current.status==='ready' && current.applicationUuid && !Object.keys(plan.services).some(service=>backendServices.includes(service))) {
      await cleanupEnvironment(current,options());delete current.applicationUuid;delete current.deploymentUuid;
    }
    if(current.status==='ready') for(const ref of plan.pullRequests.filter(ref=>ref.service.endsWith('_frontend'))) {
      state.frontendPreviews ||= {};
      state.frontendPreviews[ref.url]={environment:plan.environment,revision:plan.revision,service:ref.service,source:plan.services[ref.service]};
    }
    await store.save(state);
    for(const ref of plan.pullRequests) await github.comment(ref,statusComment(current));
  }
  const open=new Set(fresh.snapshot.map(pr=>pr.html_url));
  for(const old of fresh.obsolete) {
    const refs=old.pullRequests.filter(pr=>open.has(pr.url));
    if(refs.some(ref=>!Object.values(state.environments).some(env=>env.environment!==old.environment && env.status==='ready' && env.pullRequests.some(pr=>pr.url===ref.url)))) continue;
    await cleanupEnvironment(old,options());delete state.environments[old.environment];await store.save(state);
  }
  await garbageCollectFrontends(github,state,fresh.snapshot);await store.save(state);
  return state;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const [operation,path='preview-plan.json']=process.argv.slice(2);
    if(operation==='plan') console.log(JSON.stringify(await prepare({dryRun:true}),null,2));
    else if(operation==='prepare') {
      const result=await prepare();await writeFile(path,JSON.stringify(result));
      if(process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
        `matrix=${JSON.stringify({include:result.matrix})}\nhas_frontends=${result.matrix.length>0}\n`);
      console.log(`Prepared ${result.plans.length} changed frontend groups; ${result.errors.length} unauthorized or invalid PRs.`);
    } else if(operation==='finalize') await finalize(JSON.parse(await readFile(path,'utf8')));
    else throw new Error('Unknown pipeline operation.');
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
