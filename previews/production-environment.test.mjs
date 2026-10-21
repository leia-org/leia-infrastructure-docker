import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {productionOverrides,resolveProductionValue,environmentPlan,productionEnvironmentPlanner,environmentSummary} from './production-environment.mjs';
import {config} from './api.mjs';
const production=JSON.parse(await readFile(new URL('./production.json',import.meta.url)));
const repository='leia-org/leia-auth';
const plans=[{repository,mainCommit:'a'.repeat(40),developCommit:'b'.repeat(40)}];
const env=value=>({value});
function fixture({source={JWT_ISSUER:env('https://pre.auth.leia.ovh')},target={},added=[],drift=false,wrongOwner=false,frontend=false}={}) {
  const service=frontend?'designer_frontend':'auth',repo=frontend?'leia-org/leia-designer-frontend':repository;
  const writes=[];let state=structuredClone(target),reads=0;
  const github={request:async path=>path.includes('/contents?')?[{name:'.env.example',type:'file'}]:{
    encoding:'base64',content:Buffer.from((path.includes('b'.repeat(40))?added:[]).map(key=>key+'=').join('\n')).toString('base64')}};
  const providers={coolify:async(path,method='GET',body)=>{
    const isTarget=path.includes(production.applications.auth);
    if(method==='PATCH') {writes.push({path,body});for(const row of body.data)state[row.key]=env(row.value);return {};}
    if(path.endsWith('/envs')) {
      if(isTarget && ++reads>1 && drift) state.MANUAL=env('changed');
      return Object.entries(isTarget?state:source).map(([key,row])=>({key,...row,is_runtime:true,is_buildtime:false}));
    }
    return {uuid:isTarget?production.applications.auth:config.stableApplications.auth,git_repository:wrongOwner?'other/repo':repository,git_branch:isTarget?'main':'develop'};
  },cloudflare:async(path,method='GET',body)=>{
    if(path.endsWith('/previews/develop'))return {id:'preview-worker'};
    if(path.endsWith('/triggers'))return [{trigger_uuid:path.includes('preview-worker')?'source':'target',branch_includes:[path.includes('preview-worker')?'develop':'main'],repo_connection:{provider_account_name:wrongOwner?'other':'leia-org',repo_name:'leia-designer-frontend'}}];
    if(method==='PATCH'){writes.push({path,body});Object.assign(state,body);return state;}
    if(path.endsWith('/environment_variables'))return path.includes('/source/')?source:state;
    throw Error('Unexpected test route');
  }};
  return {writes,run:()=>productionEnvironmentPlanner({github,providers})([{...plans[0],repository:repo}]),
    withOverrides:overrides=>productionEnvironmentPlanner({github,providers,overrides})([{...plans[0],repository:repo}]),service};
}
test('new credentials never inherit pre values; summaries contain names only',()=>{
  const {summary,patch}=environmentPlan({service:'auth',source:{NEW_API_TOKEN:env('sensitive-pre-value')},target:{}});
  assert.deepEqual(summary.missing,['NEW_API_TOKEN']);assert.deepEqual(patch,{});
  assert.ok(!environmentSummary([summary]).includes('sensitive-pre-value'));
});
test('known URLs and neutral session options map to production; bypass and preview CORS stay excluded',()=>{
  assert.equal(resolveProductionValue('JWT_ISSUER','https://pre.auth.leia.ovh'),'https://auth.leia.ovh');
  assert.equal(resolveProductionValue('VITE_IMAGE_PUBLIC_URL','https://pre.images.leia.ovh'),'https://images.leia.ovh');
  assert.equal(resolveProductionValue('SESSION_COOKIE_NAME','__Host-leia_pre_session'),'leia_session');
  assert.equal(resolveProductionValue('ACCESS_TOKEN_EXPIRES_IN','15m'),'15m');
  assert.equal(resolveProductionValue('DATABASE_URL','mongodb://pre/db'),undefined);
  const {summary,patch}=environmentPlan({service:'auth',source:{TURNSTILE_BYPASS_TOKEN:env('pre'),CORS_PREVIEW_DOMAINS:env('any')},target:{}});
  assert.equal(summary.skipped.length,2);assert.equal(summary.missing.length,0);assert.deepEqual(patch,{});
});
test('preserve all existing production values unless an explicit override update is selected',()=>{
  const options={service:'auth',source:{JWT_ISSUER:env('https://pre.auth.leia.ovh')},target:{JWT_ISSUER:env('existing')},overrides:{JWT_ISSUER:'explicit-prod'}};
  assert.deepEqual(environmentPlan(options).patch,{});
  assert.equal(environmentPlan({...options,updateExisting:true}).patch.JWT_ISSUER.value,'explicit-prod');
});
test('central JSON rejects invalid services, values, pre URLs, private frontend keys and pre bypasses without leaking input',()=>{
  for(const text of ['{secret-broken','[]','{"unknown":{}}','{"auth":{"KEY":42}}','{"auth":{"KEY":""}}','{"auth":{"URL":"https://pre.auth.leia.ovh"}}','{"designer_frontend":{"PRIVATE_TOKEN":"x"}}','{"auth":{"TURNSTILE_BYPASS_TOKEN":"x"}}']) assert.throws(()=>productionOverrides(text));
  assert.deepEqual(productionOverrides('{"auth":{"NEW_TOKEN":"production-value"}}'),{auth:{NEW_TOKEN:'production-value'}});
});
test('plan is read-only, applies missing keys once, then has no further writes',async()=>{
  const f=fixture();const first=await f.run();assert.equal(f.writes.length,0);
  await first.apply();assert.equal(f.writes.length,1);assert.equal(f.writes[0].body.data[0].value,'https://auth.leia.ovh');
  const second=await f.run();await second.apply();assert.equal(f.writes.length,1);
});
test('new declared example keys require production values even when pre is missing them',async()=>{
  const f=fixture({added:['NEW_SECRET']});const plan=await f.run();assert.deepEqual(plan.summaries[0].missing,['NEW_SECRET']);
  await assert.rejects(plan.apply(),/Missing production values/);assert.equal(f.writes.length,0);
  const complete=await f.withOverrides({auth:{NEW_SECRET:'production-only'}});await complete.apply();
  assert.equal(f.writes[0].body.data.find(row=>row.key==='NEW_SECRET').value,'production-only');
});
test('manual production drift prevents every planned write',async()=>{
  const f=fixture({drift:true});const plan=await f.run();await assert.rejects(plan.apply(),/changed while planning/);assert.equal(f.writes.length,0);
});
test('unexpected provider repository owners are rejected',async()=>{
  for(const frontend of [false,true]) {const f=fixture({wrongOwner:true,frontend});await assert.rejects(f.run(),/owner or branch/);assert.equal(f.writes.length,0);}
});
test('frontends update main build variables and preserve existing redacted secrets',async()=>{
  const f=fixture({frontend:true,source:{VITE_APP_BACKEND:env('https://pre.backend.designer.leia.ovh'),VITE_EXISTING:{value:null,is_secret:true}},target:{VITE_EXISTING:{value:null,is_secret:true}}});
  const plan=await f.run();assert.equal(plan.summaries[0].missing.length,0);await plan.apply();
  assert.ok(f.writes[0].path.endsWith('/builds/triggers/target/environment_variables'));
  assert.deepEqual(f.writes[0].body,{VITE_APP_BACKEND:{value:'https://backend.designer.leia.ovh',is_secret:false}});
});
test('redacted new Cloudflare values and environment-specific sitekeys require explicit production values',async()=>{
  const f=fixture({frontend:true,source:{VITE_CLOUDFLARE_SITE_KEY:env('pre-sitekey'),VITE_REDACTED:{value:null,is_secret:true}}});
  const plan=await f.run();assert.deepEqual(plan.summaries[0].missing,['VITE_CLOUDFLARE_SITE_KEY','VITE_REDACTED']);
  await assert.rejects(plan.apply());assert.equal(f.writes.length,0);
});
