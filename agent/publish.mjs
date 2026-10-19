import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {githubClient} from '../previews/github.mjs';
import {agentStateStore} from './state.mjs';
import {authorize,validateRequest,hash,reply} from './core.mjs';
import {prepareCheckout,checkedPatch,git} from './git.mjs';
async function proposeProtectedBranchFix({github,request,commit,treeSha,message,parents,checks}) {
  const repository=request.repository,branch=`fix/leia-pr-${request.number}-command-${request.commentId}`;
  const reference=`repos/${repository}/git/ref/heads/${branch}`;
  const existing=await github.request(reference);
  if(existing) {
    const previous=await github.request(`repos/${repository}/git/commits/${existing.object?.sha}`);
    if(previous?.tree?.sha!==treeSha || previous.message!==message || JSON.stringify(previous.parents?.map(row=>row.sha))!==JSON.stringify(parents))throw new Error('The repair branch already exists with different contents or parents.');
    commit={sha:existing.object.sha};
  }else {
    await authorize({...github,isMember:github.isMemberFresh||github.isMember},request);
    await github.request(`repos/${repository}/git/refs`,'POST',{ref:`refs/heads/${branch}`,sha:commit.sha});
  }
  const path=`repos/${repository}/pulls`;
  const existingPrs=await github.request(`${path}?state=all&head=${encodeURIComponent(`leia-org:${branch}`)}&base=${encodeURIComponent(request.headRef)}`);
  if(!Array.isArray(existingPrs) || existingPrs.length>1)throw new Error('Cannot identify the owned repair PR.');
  let repair=existingPrs[0];
  if(repair && (repair.state!=='open' || repair.user?.login!=='leia-org-bot[bot]' || repair.head?.sha!==commit.sha))throw new Error('An existing repair PR needs manual review.');
  if(!repair) {
    await authorize({...github,isMember:github.isMemberFresh||github.isMember},request);
    repair=await github.request(path,'POST',{
      title:request.mergeBase?`fix: resolve conflicts for PR #${request.number}`:`fix: apply LEIA request for PR #${request.number}`,
      head:branch,base:request.headRef,
      body:`Prepared for [PR #${request.number}](https://github.com/${repository}/pull/${request.number}) from [this command](https://github.com/${repository}/pull/${request.number}#issuecomment-${request.commentId}) by @${request.actor}.\n\nThe source branch \`${request.headRef}\` is protected, so this verified change requires normal PR review. No branch protection was bypassed.\n\nIndependent checks:\n${checks.map(row=>`- \`${row.command}\`: passed`).join('\n')}\n\n${request.mergeBase?'Use **Create a merge commit** when merging this repair PR to preserve both branch histories and resolve the original PR conflicts. Squashing or rebasing can discard the required merge ancestry.':'Merge this repair PR after normal checks and approval to apply the requested change.'}\n\nThe original PR stays open; this bot does not merge either PR.`});
  }
  if(!Number.isSafeInteger(repair?.number) || repair.html_url!==`https://github.com/${repository}/pull/${repair.number}`)throw new Error('GitHub did not return a valid repair PR.');
  return {sha:commit.sha,url:`https://github.com/${repository}/commit/${commit.sha}`,pullRequestUrl:repair.html_url,repairBranch:branch};
}
export async function publish({github,request,artifact,verified,directory,checkout=prepareCheckout}) {
  validateRequest(request);
  if(verified?.version!==1 || verified.requestHash!==hash(JSON.stringify(request)) || verified.patchHash!==hash(artifact.patch) ||
    !Array.isArray(verified.checks) || verified.checks.length<2 || verified.checks.some(row=>row.result!=='passed'))throw new Error('Independent verification is missing or does not match the patch.');
  await authorize(github,request);
  await checkout(request,directory);
  const files=await checkedPatch(request,directory,artifact.patch);
  let mergeRequired=false;
  if(request.mergeBase) {
    try{git(directory,['merge-base','--is-ancestor',request.baseSha,request.headSha]);}catch{mergeRequired=true;}
  }
  if(!files.length && !mergeRequired)return {unchanged:true};
  const branch=await github.request(`repos/${request.repository}/branches/${encodeURIComponent(request.headRef)}`);
  if(branch?.commit?.sha!==request.headSha || typeof branch.protected!=='boolean')throw new Error('Cannot verify the source branch and its protection status.');
  const prefix=`repos/${request.repository}/git`;
  const head=await github.request(`${prefix}/commits/${request.headSha}`);
  if(!head?.tree?.sha)throw new Error('Cannot resolve the original PR tree.');
  const tree=[];
  for(const file of files) {
    const row=git(directory,['ls-files','--stage','--',file]).trim();
    if(!row) {tree.push({path:file,mode:'100644',type:'blob',sha:null});continue;}
    const mode=row.split(' ')[0];
    const content=git(directory,['show',`:${file}`],{encoding:'buffer'});
    const blob=await github.request(`${prefix}/blobs`,'POST',{encoding:'base64',content:content.toString('base64')});
    tree.push({path:file,mode,type:'blob',sha:blob.sha});
  }
  // A conflict resolution can keep the existing tree while recording the base
  // as a second parent. GitHub rejects creation of a tree with no entries.
  const created=tree.length?await github.request(`${prefix}/trees`,'POST',{base_tree:head.tree.sha,tree}):head.tree;
  const title=request.mergeBase?'fix: resolve PR merge conflicts':'fix: apply LEIA agent request';
  const message=`${title}\n\nRequested by @${request.actor} in PR #${request.number}, comment ${request.commentId}. Independently verified before publication.`;
  const parents=[request.headSha,...(mergeRequired?[request.baseSha]:[])];
  const commit=await github.request(`${prefix}/commits`,'POST',{message,tree:created.sha,parents});
  if(!/^[a-f0-9]{40}$/.test(commit?.sha||''))throw new Error('GitHub did not create a valid commit.');
  // Fresh membership, command, head and base checks immediately before publishing. No force push.
  await authorize({...github,isMember:github.isMemberFresh||github.isMember},request);
  if(branch.protected)return proposeProtectedBranchFix({github,request,commit,treeSha:created.sha,message,parents,checks:verified.checks});
  await github.request(`${prefix}/refs/heads/${encodeURIComponent(request.headRef)}`,'PATCH',{sha:commit.sha,force:false});
  return {sha:commit.sha,url:`https://github.com/${request.repository}/commit/${commit.sha}`};
}
export async function finalize({github,store,requests,artifacts,runId}) {
  const state=await store.load();let failures=0;
  for(const request of requests) {
    const entry=state.commands[String(request.commentId)];
    if(!entry || entry.runId!==String(runId))throw new Error('Agent command claim does not belong to this run.');
    if(entry.status==='complete')continue;
    const directory=await mkdtemp(join(tmpdir(),'leia-agent-publish-'));
    try {
      const {artifact,verified}=await artifacts(request);
      const result=await publish({github,request,artifact,verified,directory});
      Object.assign(entry,{status:'complete',updatedAt:new Date().toISOString(),...(result.sha?{commitSha:result.sha}:{}),...(result.pullRequestUrl?{repairPullRequestUrl:result.pullRequestUrl}:{})});
      await store.save(state);
      const checks=verified.checks.map(row=>`- \`${row.command}\`: passed`).join('\n');
      const outcome=result.pullRequestUrl?`The source branch \`${request.headRef}\` is protected. Prepared [a repair PR](${result.pullRequestUrl}) with [commit ${result.sha.slice(0,7)}](${result.url}) for review. ${request.mergeBase?'Merge that repair PR using **Create a merge commit** to preserve the merge ancestry and resolve these conflicts.':'Merge that repair PR after normal review to apply the requested change.'}`:result.unchanged?'No commit was necessary; the requested result is already present.':`Added [commit ${result.sha.slice(0,7)}](${result.url}) to \`${request.headRef}\`.`;
      await reply(github,request,`### LEIA agent\n${outcome}\n\nIndependent verification in a clean container:\n${checks}\n\n[Verification details](https://github.com/leia-org/leia-infrastructure-docker/actions/runs/${runId}). The original PR remains open; no branch protection was bypassed.`).catch(()=>{console.error('Published result could not be acknowledged in the PR.');});
    }catch(error) {
      console.error(`Command ${request.commentId}: ${error.message}`);
      failures++;Object.assign(entry,{status:'failed',updatedAt:new Date().toISOString()});await store.save(state);
      await reply(github,request,`### LEIA agent\nI could not publish a verified commit. A required check may have failed, the request or branches may have changed, or publication may have been rejected.\n\n[Inspect the run](https://github.com/leia-org/leia-infrastructure-docker/actions/runs/${runId}). No PR was merged and no force push was used. Post a new \`/leia <instruction>\` comment after addressing the failure.`).catch(()=>{console.error('Unable to acknowledge the failed command.');});
    }finally{await rm(directory,{recursive:true,force:true});}
  }
  return {failures};
}
if(process.argv[1]?.endsWith('/publish.mjs')) {
  try {
    const [requestsFile,artifactRoot]=process.argv.slice(2),github=githubClient(process.env.PREVIEW_GITHUB_TOKEN);
    github.isMemberFresh=actor=>githubClient(process.env.PREVIEW_GITHUB_TOKEN).isMember(actor);
    const requests=JSON.parse(await readFile(requestsFile));
    const infra=githubClient(process.env.GITHUB_TOKEN),jobs=[];
    for(let page=1;;page++) {
      const batch=await infra.request(`repos/leia-org/leia-infrastructure-docker/actions/runs/${process.env.GITHUB_RUN_ID}/attempts/${process.env.GITHUB_RUN_ATTEMPT}/jobs?per_page=100&page=${page}`);
      if(!Array.isArray(batch?.jobs))throw new Error('Cannot verify the independent job results.');
      jobs.push(...batch.jobs);if(batch.jobs.length<100)break;
    }
    const result=await finalize({github,store:agentStateStore(process.env.GITHUB_TOKEN),requests,runId:process.env.GITHUB_RUN_ID,
      artifacts:async request=>{
        const checks=jobs.filter(job=>job.name===`Verify command ${request.commentId}`);
        if(checks.length!==1 || checks[0].conclusion!=='success')throw new Error('Independent verification job did not succeed.');
        return {artifact:JSON.parse(await readFile(resolve(artifactRoot,`verified-${request.commentId}`,'patch.json'))),verified:JSON.parse(await readFile(resolve(artifactRoot,`verified-${request.commentId}`,'verified.json')))};
      }});
    if(result.failures)process.exitCode=1;
  }catch(error){console.error(error.message);process.exitCode=1;}
}
