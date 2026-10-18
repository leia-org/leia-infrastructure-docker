import test from 'node:test';
import assert from 'node:assert/strict';
import {githubClient} from './github.mjs';
import {parsePullRequest,manifestBlock} from './manifest.mjs';
const ref=parsePullRequest('https://github.com/leia-org/leia-workbench-backend/pull/54');
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
test('membership requires active state, denies missing/pending membership and fails on permission errors',async()=>{
  for(const [status,state,expected] of [[200,'active',true],[200,'pending',false],[404,null,false]]) {
    const client=githubClient('private',{fetcher:async()=>json({state},status)});assert.equal(await client.isMember('member'),expected);
  }
  await assert.rejects(githubClient('private',{fetcher:async()=>json({},403)}).isMember('member'),/403/);
});
test('a failing repository list aborts the entire scan',async()=>{
  const client=githubClient('private',{fetcher:async url=>url.includes('leia-auth/') ? json({},500) : json([])});
  await assert.rejects(client.snapshot(),/500/);
});
test('comment updates belong to the configured bot; a spoofed marker cannot be overwritten',async()=>{
  const calls=[];let body='<!-- leia-linked-preview-status -->\nOld';
  const client=githubClient('private',{botLogin:'leia-preview[bot]',fetcher:async(url,init)=>{
    calls.push({url,method:init.method,body:init.body});
    if(init.method==='GET') return json([{id:1,user:{login:'outsider'},body},{id:2,user:{login:'leia-preview[bot]'},body}]);
    return json({});}});
  await client.comment(ref,'New');assert.match(calls[1].url,/comments\/2$/);assert.equal(calls[1].method,'PATCH');
  calls.length=0;await client.comment(ref,'Old');assert.equal(calls.length,1);
});
test('concurrent metadata edits cause a retry instead of overwriting links',async()=>{
  const old=manifestBlock({environment:'first',pullRequests:[ref]});
  const changed=manifestBlock({environment:'second',pullRequests:[ref]});let writes=0;
  const client=githubClient('private',{fetcher:async(url,init)=>{if(init.method!=='GET') writes++;return json({state:'open',body:changed});}});
  await assert.rejects(client.patchManifest({reference:ref,before:old},{environment:'first',pullRequests:[ref]}),/changed/);assert.equal(writes,0);
});
