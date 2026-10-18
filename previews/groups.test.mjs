import test from 'node:test';
import assert from 'node:assert/strict';
import {groupPullRequests,obsoleteEnvironments} from './groups.mjs';
import {manifestBlock,parsePullRequest} from './manifest.mjs';
import {reconcile,statusComment} from './reconcile.mjs';
const wf='https://github.com/leia-org/leia-workbench-frontend/pull/88';
const wb='https://github.com/leia-org/leia-workbench-backend/pull/54';
function pr(url,body='Description') {const ref=parsePullRequest(url);return {html_url:url,number:ref.number,state:'open',user:{login:'member'},body,
  base:{ref:'develop',repo:{full_name:ref.repository}},head:{sha:'a'.repeat(40),repo:{full_name:ref.repository}}};}
const block=(environment,urls=[])=>manifestBlock({environment,pullRequests:urls.map(parsePullRequest)});
const member=async()=>true;
test('late one-sided links join the first preview and update both bodies',async()=>{
  const first=await groupPullRequests([pr(wf)],{},member);assert.equal(first.desired[0].environment,'wf-88');
  const previous={environments:{'wf-88':{...first.desired[0],createdAt:'2026-01-01'}}};
  const joined=await groupPullRequests([pr(wf,first.patches[0].body),pr(wb,block('wf-88',[wf]))],previous,member);
  assert.equal(joined.desired.length,1);assert.equal(joined.desired[0].environment,'wf-88');assert.equal(joined.patches.length,2);
  assert.deepEqual(joined.desired[0].pullRequests.map(r=>r.url).sort(),[wf,wb].sort());
});
test('separate previews stay independent until explicitly linked, then reuse the older group',async()=>{
  assert.equal((await groupPullRequests([pr(wf),pr(wb)],{},member)).desired.length,2);
  const previous={environments:{'wf-88':{environment:'wf-88',pullRequests:[parsePullRequest(wf)],createdAt:'2026-01-01'},
    'wb-54':{environment:'wb-54',pullRequests:[parsePullRequest(wb)],createdAt:'2026-02-01'}}};
  const joined=await groupPullRequests([pr(wf,block('wf-88',[wb])),pr(wb,block('wb-54'))],previous,member);
  assert.equal(joined.desired.length,1);assert.equal(joined.desired[0].environment,'wf-88');
});
test('closing one PR removes its live service and keeps the remaining group',async()=>{
  const previous={environments:{shared:{environment:'shared',pullRequests:[wf,wb].map(parsePullRequest)}}};
  const result=await groupPullRequests([pr(wf,block('shared',[wf,wb]))],previous,member,new Set([wb]));
  assert.deepEqual(result.desired[0].pullRequests.map(r=>r.url),[wf]);assert.equal(result.desired[0].environment,'shared');
  assert.deepEqual(obsoleteEnvironments(previous,result.desired,[pr(wf)]),[]);
});
test('unavailable or unauthorized links are not mistaken for closed PRs',async()=>{
  const previous={environments:{shared:{environment:'shared',pullRequests:[wf,wb].map(parsePullRequest)}}};
  const result=await groupPullRequests([pr(wf,block('shared',[wf,wb]))],previous,member);
  assert.equal(result.desired.length,0);assert.equal(result.errors.length,1);
  assert.deepEqual(obsoleteEnvironments(previous,result.desired,[pr(wf)],result.errors),[]);
});
test('conflicting service PRs and nonmembers cannot provision groups',async()=>{
  const conflict=await groupPullRequests([pr(wf,block('shared')),pr(wf.replace('/88','/89'),block('shared'))],{},member);
  assert.equal(conflict.desired.length,0);assert.equal(conflict.errors.length,2);
  assert.equal((await groupPullRequests([pr(wf)],{},async()=>false)).desired.length,0);
});
function fakeGithub(initial) {let snapshot=structuredClone(initial);const comments=new Map();return {
  comments,setSnapshot(value){snapshot=structuredClone(value);},snapshot:async()=>snapshot,closedReferences:async()=>new Set(),isMember:member,
  getPullRequest:async(repo,num)=>snapshot.find(p=>p.html_url===`https://github.com/${repo}/pull/${num}`),getDevelopCommit:async()=> 'b'.repeat(40),
  patchManifest:async(patch)=>{snapshot.find(p=>p.html_url===patch.reference.url).body=patch.body;},comment:async(ref,body)=>comments.set(ref.url,body)};}
test('duplicate events deploy once; closing the last PR cleans up once',async()=>{
  const github=fakeGithub([pr(wb)]);let state={environments:{}},deploys=0,cleanups=0;
  const options={github,infrastructureCommit:'c'.repeat(40),save:async v=>{state=structuredClone(v);},
    deploy:async(plan,old,allocated)=>{deploys++;await allocated('owned-uuid');return {applicationUuid:'owned-uuid'};},publish:async()=>{},cleanup:async()=>{cleanups++;}};
  await reconcile({...options,previous:state});await reconcile({...options,previous:state});
  assert.equal(deploys,1);assert.equal(github.comments.size,1);assert.equal(state.environments['wb-54'].status,'ready');
  github.setSnapshot([]);await reconcile({...options,previous:state});await reconcile({...options,previous:state});
  assert.equal(cleanups,1);assert.deepEqual(state.environments,{});
});
test('frontend-only bypasses server capacity and backend provisioning',async()=>{
  const github=fakeGithub([pr(wf)]);let deploys=0,publishes=0;
  await reconcile({github,previous:{environments:{}},maximumActive:0,infrastructureCommit:'c'.repeat(40),save:async()=>{},
    deploy:async()=>{deploys++;},publish:async()=>{publishes++;},cleanup:async()=>{}});
  assert.equal(deploys,0);assert.equal(publishes,1);
});
test('partial scans never clean up; a failed deployment retains its allocated UUID for retry',async()=>{
  let cleanups=0;
  await assert.rejects(reconcile({github:{snapshot:async()=>{throw Error('HTTP 500');}},previous:{environments:{}},cleanup:async()=>{cleanups++;}}),/500/);
  assert.equal(cleanups,0);const github=fakeGithub([pr(wb)]);let state;
  await reconcile({github,infrastructureCommit:'c'.repeat(40),save:async v=>{state=structuredClone(v);},
    deploy:async(plan,old,allocated)=>{await allocated('owned-uuid');throw Error('Failed');},publish:async()=>{},cleanup:async()=>{}});
  assert.equal(state.environments['wb-54'].applicationUuid,'owned-uuid');assert.equal(state.environments['wb-54'].status,'failed');
});
test('bot comments list deployed and shared URLs and database copies',async()=>{
  const github=fakeGithub([pr(wb)]);let state;
  await reconcile({github,infrastructureCommit:'c'.repeat(40),save:async v=>{state=v;},deploy:async()=>({applicationUuid:'id'}),publish:async()=>{},cleanup:async()=>{}});
  const comment=statusComment(state.environments['wb-54']);assert.match(comment,/Shared pre/);assert.match(comment,/pre.auth.leia.ovh/);
  assert.match(comment,/pr-wb-54-workbench-api.leia.ovh/);assert.match(comment,/Database copies: workbench_backend/);
});
test('backend opened last rebuilds the unchanged frontend only after the backend is ready',async()=>{
  const github=fakeGithub([pr(wf)]);let state={environments:{}},published=[],events=[];
  const options={github,infrastructureCommit:'c'.repeat(40),save:async v=>{state=structuredClone(v);},cleanup:async()=>{},
    deploy:async(plan,old,allocated)=>{events.push('backend-ready');await allocated('owned-uuid');return {applicationUuid:'owned-uuid'};},
    publish:async plan=>{events.push('frontend-publish');published.push(plan);}};
  await reconcile({...options,previous:state});
  assert.equal(published[0].frontendBuildVariables.workbench_frontend.VITE_APP_BACKEND,'https://pre.backend.workbench.leia.ovh');
  github.setSnapshot([pr(wf,block('wf-88',[wf])),pr(wb,block('wf-88',[wf]))]);events=[];
  await reconcile({...options,previous:state});
  assert.deepEqual(events,['backend-ready','frontend-publish']);
  assert.equal(published[0].services.workbench_frontend.commit,published[1].services.workbench_frontend.commit);
  assert.notEqual(published[0].revision,published[1].revision);
  assert.equal(published[1].frontendBuildVariables.workbench_frontend.VITE_APP_BACKEND,'https://pr-wf-88-workbench-api.leia.ovh');
});
test('frontend artifact retries do not redeploy unchanged backends or prematurely report ready',async()=>{
  const github=fakeGithub([pr(wf,block('shared',[wf,wb])),pr(wb,block('shared',[wf,wb]))]);
  let state={environments:{}},deploys=0;
  const options={github,infrastructureCommit:'c'.repeat(40),save:async v=>{state=structuredClone(v);},cleanup:async()=>{},
    deploy:async()=>{deploys++;return {applicationUuid:'owned-uuid'};},publish:async()=>({pending:true})};
  await reconcile({...options,previous:state});await reconcile({...options,previous:state});
  assert.equal(deploys,1);assert.equal(state.environments.shared.status,'building');assert.equal(state.environments.shared.backendReady,true);
});
test('linking an existing backend to a frontend placeholder reuses the backend data and application',async()=>{
  const previous={environments:{'wf-88':{environment:'wf-88',pullRequests:[parsePullRequest(wf)],createdAt:'2026-01-01'},
    'wb-54':{environment:'wb-54',pullRequests:[parsePullRequest(wb)],createdAt:'2026-02-01',applicationUuid:'existing-backend'}}};
  const result=await groupPullRequests([pr(wf,block('wf-88',[wb])),pr(wb,block('wf-88',[wf]))],previous,member);
  assert.equal(result.desired.length,1);assert.equal(result.desired[0].environment,'wb-54');
});
