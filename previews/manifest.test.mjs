import test from 'node:test';
import assert from 'node:assert/strict';
import {parseManifest,parsePullRequest,resolveEnvironment,updateManifest,manifestBlock,stableUrls} from './manifest.mjs';
const refs=['https://github.com/leia-org/leia-workbench-frontend/pull/88','https://github.com/leia-org/leia-workbench-backend/pull/54'];
const manifest=(urls=refs,isolation='selective') => ({environment:'test-change',isolation,pullRequests:urls.map(parsePullRequest)});
const pr=(repository,number) => ({state:'open',user:{login:'member'},author_association:'COLLABORATOR',
  body:'Description',base:{ref:'develop',repo:{full_name:repository}},head:{sha:String(number%10).repeat(40),repo:{full_name:repository}}});
const resolve=(value,overrides={},member=async()=>true) => resolveEnvironment(value,async(repo,num)=>({...pr(repo,num),...overrides}),async()=> 'a'.repeat(40),member);
test('ordinary PR text is not a manifest; an environment name can be declared before the next PR exists',()=>{
  assert.equal(parseManifest('Related #54'),null);
  assert.equal(parseManifest(manifestBlock({...manifest([])})).pullRequests.length,0);
});
test('rejects executable/credential URLs, duplicates and reserved names',()=>{
  for(const url of ['https://u:p@github.com/leia-org/leia-auth/pull/1',refs[0]+'#x','$(touch /tmp/x)','https://github.com/other/leia-auth/pull/1']) assert.throws(()=>parsePullRequest(url));
  assert.throws(()=>parseManifest(manifestBlock(manifest([refs[0],refs[0]]))));
  for(const environment of ['pre','main','prod','../pre','UPPER']) assert.throws(()=>parseManifest(manifestBlock({...manifest(),environment})));
});
test('Workbench frontend + backend deploy only those two and route all dependencies to pre',async()=>{
  const plan=await resolve(manifest());
  assert.deepEqual(Object.keys(plan.services),['workbench_backend','workbench_frontend']);
  assert.equal(plan.urls.auth,stableUrls.auth);
  assert.equal(plan.urls.designer_backend,stableUrls.designer_backend);
  assert.equal(plan.urls.runner,stableUrls.runner);
  assert.equal(plan.frontendBuildVariables.workbench_frontend.VITE_APP_BACKEND,'https://pr-test-change-workbench-api.leia.ovh');
});
test('frontend-only has no backend resources; unchanged pre SHAs do not cause redeployments',async()=>{
  const plan=await resolve(manifest([refs[0]]));
  assert.deepEqual(Object.keys(plan.services),['workbench_frontend']);
  assert.equal(plan.frontendBuildVariables.workbench_frontend.VITE_APP_BACKEND,stableUrls.workbench_backend);
});
test('full isolation explicitly pins unchanged backends to develop',async()=>{
  const plan=await resolve(manifest(refs,'full'));
  for(const service of ['auth','designer_backend','runner']) assert.equal(plan.services[service].commit,'a'.repeat(40));
  assert.notEqual(plan.urls.auth,stableUrls.auth);
});
test('membership is checked through the authenticated callback; collaborator status grants nothing',async()=>{
  await assert.rejects(resolve(manifest(),{},async()=>false),/active leia-org member/);
  await assert.rejects(resolveEnvironment(manifest(),pr,async()=> 'a'.repeat(40)),/membership check/);
  await assert.rejects(resolve(manifest(),{},async()=>{throw Error('HTTP 403');}),/403/);
});
test('closed PRs, forks, main targets and invalid sources cannot deploy',async()=>{
  for(const override of [{state:'closed'},{head:{sha:'a'.repeat(40),repo:{full_name:'someone/fork'}}},
    {base:{ref:'main',repo:{full_name:'leia-org/leia-workbench-frontend'}}}, {head:{sha:'$(id)',repo:{full_name:'leia-org/leia-workbench-frontend'}}}]) await assert.rejects(resolve(manifest(),override));
});
test('the bot replaces only its block and leaves human text untouched',()=>{
  const before='Human introduction\n\n'+manifestBlock(manifest([refs[0]]))+'\n\nTest plan';
  const after=updateManifest(before,manifest());
  assert.ok(after.startsWith('Human introduction\n\n'));assert.ok(after.endsWith('\n\nTest plan'));
  assert.equal(updateManifest(after,manifest()),after);
  assert.throws(()=>updateManifest(before+'\n'+manifestBlock(manifest()),manifest()));
});
test('code and routing changes alter revisions, independent of reference ordering',async()=>{
  const a=await resolve(manifest()),b=await resolve(manifest([...refs].reverse()));
  assert.equal(a.revision,b.revision);
  const changed=await resolveEnvironment(manifest(),async(repo,num)=>({...pr(repo,num),head:{sha:'f'.repeat(40),repo:{full_name:repo}}}),async()=> 'a'.repeat(40),async()=>true);
  assert.notEqual(a.revision,changed.revision);
});
