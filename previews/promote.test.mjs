import test from 'node:test';
import assert from 'node:assert/strict';
import {promote,selectedRepositories,releaseSummary} from './promote.mjs';

const repository='leia-org/leia-auth',main='a'.repeat(40),develop='b'.repeat(40);
function fixture({member=true,ahead=2,behind=0,existing=false,race=false,change=false,failCompare=false}={}) {
  const writes=[],comments=[];let current=existing,mainReads=0;
  const pr=()=>({number:12,html_url:`https://github.com/${repository}/pull/12`,
    base:{ref:'main',repo:{full_name:repository}},head:{ref:'develop',repo:{full_name:repository}},
    user:{login:'human'},body:'Keep my release description.'});
  return {writes,github:{isMember:async()=>member,request:async(path,method='GET',body)=>{
    if(method!=='GET')writes.push({path,method,body});
    if(path.endsWith('/commits/main'))return {sha:change && ++mainReads>1?'c'.repeat(40):main};
    if(path.endsWith('/commits/develop'))return {sha:develop};
    if(path.includes('/compare/')) {if(failCompare)throw Error('Comparison unavailable');return {ahead_by:ahead,behind_by:behind};}
    if(path.includes('/pulls?'))return current?[pr()]:[];
    if(path.endsWith('/pulls')&&method==='POST'){current=true;if(race)throw Error('GitHub POST failed: HTTP 422.');return pr();}
    if(path.includes('/comments?'))return comments;
    if(path.endsWith('/comments')&&method==='POST'){comments.push({id:99,user:{login:'leia-org-bot[bot]'},body:body.body});return comments[0];}
    throw Error('Unexpected test request: '+path);
  }}};
}
test('production scope includes all six services and component pairs, including Runner',()=>{
  assert.equal(selectedRepositories().length,6);assert.ok(selectedRepositories().includes('leia-org/leia-runner'));
  assert.deepEqual(selectedRepositories('runner'),['leia-org/leia-runner']);
  assert.equal(selectedRepositories('designer').length,2);assert.equal(selectedRepositories('workbench').length,2);
  assert.throws(()=>selectedRepositories('other-org'));
});
test('planning is read-only even when commits are ready for release',async()=>{
  const {github,writes}=fixture();const plans=await promote({github,actor:'member',component:'auth'});
  assert.equal(writes.length,0);assert.equal(plans[0].ahead,2);assert.equal(plans[0].url,undefined);
});
test('nonmembers and incomplete comparisons cannot create production PRs',async()=>{
  for(const options of [{member:false},{failCompare:true}]) {
    const {github,writes}=fixture(options);await assert.rejects(promote({github,actor:'outside',component:'auth',apply:true}));assert.equal(writes.length,0);
  }
});
test('create develop-to-main once, reuse the human description and update only one bot comment',async()=>{
  const {github,writes}=fixture();const first=await promote({github,actor:'member',component:'auth',apply:true});
  assert.equal(first[0].created,true);
  const second=await promote({github,actor:'member',component:'auth',apply:true});assert.equal(second[0].url,first[0].url);
  assert.equal(writes.filter(x=>x.path.endsWith('/pulls')).length,1);
  assert.equal(writes.filter(x=>x.path.endsWith('/comments')).length,1);
  assert.equal(writes.filter(x=>x.method==='PATCH').length,0);
  const create=writes.find(x=>x.path.endsWith('/pulls'));assert.equal(create.body.head,'develop');assert.equal(create.body.base,'main');
});
test('behind-only repositories are skipped and diverged branches remain reviewable',async()=>{
  const unchanged=fixture({ahead:0,behind:4});await promote({github:unchanged.github,actor:'member',component:'auth',apply:true});assert.equal(unchanged.writes.length,0);
  const diverged=fixture({ahead:3,behind:2});const plans=await promote({github:diverged.github,actor:'member',component:'auth',apply:true});
  assert.match(releaseSummary(plans),/3 ahead, 2 behind/);assert.ok(plans[0].url);
});
test('a concurrent human PR is reused after GitHub rejects duplicate creation',async()=>{
  const {github}=fixture({race:true});const plans=await promote({github,actor:'member',component:'auth',apply:true});assert.equal(plans[0].number,12);
});
test('branch changes during planning require a rerun before creating a PR',async()=>{
  const {github,writes}=fixture({change:true});await assert.rejects(promote({github,actor:'member',component:'auth',apply:true}),/Branches changed/);assert.equal(writes.length,0);
});
