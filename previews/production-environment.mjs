import {readFile} from 'node:fs/promises';
import {config,coolify,cloudflare} from './api.mjs';
import {repositories} from './manifest.mjs';

const production=JSON.parse(await readFile(new URL('./production.json',import.meta.url),'utf8'));
const keyPattern=/^[A-Z][A-Z0-9_]*$/;
const excluded=new Set(['CORS_PREVIEW_DOMAINS','TURNSTILE_BYPASS_TOKEN','SKIP_DEPENDENCY_INSTALL',
  'CLOUDFLARE_ACCESS_TEAM_DOMAIN','CLOUDFLARE_ACCESS_TEST_LOGIN_AUD']);
const productionSafety={LEIA_ENVIRONMENT:'production',PRE_TEST_LOGIN_ENABLED:'false'};
const neutral=new Set(['ACCESS_TOKEN_EXPIRES_IN','SESSION_TOKEN_EXPIRES_IN','SESSION_COOKIE_MAX_AGE_SECONDS',
  'SESSION_COOKIE_SAME_SITE','SESSION_COOKIE_SECURE','JWT_AUDIENCE','AVATAR_KBYTES']);
const domains=['auth','designer','workbench','backend.designer','backend.workbench','runner','images'];
const origins='https://designer.leia.ovh,https://workbench.leia.ovh';
function plain(value) {return value!==null && typeof value==='object' && !Array.isArray(value);}
export function productionOverrides(text) {
  let values;try {values=JSON.parse(text||'{}');} catch {throw new Error('LEIA_PRODUCTION_ENV_JSON must contain valid JSON.');}
  if(!plain(values)) throw new Error('LEIA_PRODUCTION_ENV_JSON must be an object keyed by service.');
  for(const [service,env] of Object.entries(values)) {
    if(!Object.hasOwn(repositories,service) || !plain(env)) throw new Error('Unknown service or invalid production environment object.');
    for(const [key,value] of Object.entries(env)) {
      if(!keyPattern.test(key) || typeof value!=='string' || !value.trim() || excluded.has(key) ||
        (Object.hasOwn(productionSafety,key) && value!==productionSafety[key]) || (service.endsWith('_frontend') && !key.startsWith('VITE_'))) {
        throw new Error('Production overrides require nonempty string values, supported keys and public VITE_ frontend variables.');
      }
      if(/https?:\/\/pre(?:[.-]|\d)|(?:mongodb|rediss?):\/\/[^\s]*\bpre\b/i.test(value)) throw new Error('Production overrides must not reference pre environments.');
    }
  }
  return values;
}
export function resolveProductionValue(key,value) {
  if(excluded.has(key)) return undefined;
  if(Object.hasOwn(productionSafety,key)) return productionSafety[key];
  if(key==='AUTH_ALLOWED_ORIGINS') return origins;
  if(key==='SESSION_COOKIE_NAME') return 'leia_session';
  if(typeof value!=='string' || !value.trim()) return undefined;
  if(neutral.has(key) && /^(?:true|false|lax|strict|none|leia-platform|\d+(?:\.\d+)?(?:ms|s|m|h|d)?)$/.test(value)) return value;
  // Only exact known service URLs are translated. Never rewrite arbitrary connection strings or secrets.
  const domain=domains.find(domain=>value===`https://pre.${domain}.leia.ovh`);
  if(domain && /(?:URL|BACKEND|ISSUER|ORIGIN)$/.test(key)) return `https://${domain}.leia.ovh`;
  return undefined;
}
export function environmentPlan({service,source,target,declared=[],overrides={},updateExisting=false}) {
  const additions=[],updates=[],missing=[],skipped=[],patch={};let kept=0;
  const keys=new Set([...Object.keys(source),...declared,...Object.keys(overrides)]);
  for(const key of [...keys].sort()) {
    if(!keyPattern.test(key)) throw new Error('Invalid environment variable name received from provider.');
    if(excluded.has(key)) {skipped.push(key);continue;}
    const exists=Object.hasOwn(target,key);
    const explicit=Object.hasOwn(overrides,key);
    const safety=Object.hasOwn(productionSafety,key);
    if(exists && !safety && !(updateExisting && explicit)) {kept++;continue;}
    const value=safety?productionSafety[key]:explicit?overrides[key]:resolveProductionValue(key,source[key]?.value);
    if(value===undefined) {missing.push(key);continue;}
    const desired={value,is_secret:service.endsWith('_frontend')?false:undefined};
    if(exists && target[key].value===value && target[key].is_secret!==true) {kept++;continue;}
    patch[key]=desired;(exists?updates:additions).push(key);
  }
  return {summary:{service,additions,updates,missing,skipped,kept},patch};
}
function equal(a,b) {return JSON.stringify(Object.entries(a).sort())===JSON.stringify(Object.entries(b).sort());}
function normalizeCoolify(rows) {
  if(!Array.isArray(rows)) throw new Error('Incomplete Coolify environment response.');
  const env={};
  for(const row of rows.filter(row=>!row.is_preview)) {
    if(Object.hasOwn(env,row.key)) throw new Error('Duplicate Coolify environment key.');
    env[row.key]={value:String(row.value??row.real_value??''),is_buildtime:row.is_buildtime??false,is_runtime:row.is_runtime??true};
  }
  return env;
}
function normalizeCloudflare(rows) {
  if(!plain(rows)) throw new Error('Incomplete Cloudflare build environment response.');
  return Object.fromEntries(Object.entries(rows).map(([key,row])=>[key,{value:row.value,is_secret:row.is_secret===true}]));
}
async function exampleKeys(github,repository,commit) {
  const files=await github.request(`repos/${repository}/contents?ref=${commit}`);
  if(!Array.isArray(files)) throw new Error('Cannot inspect environment examples.');
  const keys=new Set();
  for(const file of files.filter(file=>file.type==='file' && /^\.env(?:\.[a-z0-9_-]+)*\.example$/i.test(file.name))) {
    const content=await github.request(`repos/${repository}/contents/${encodeURIComponent(file.name)}?ref=${commit}`);
    if(content?.encoding!=='base64' || typeof content.content!=='string') throw new Error('Cannot read environment example.');
    for(const match of Buffer.from(content.content,'base64').toString().matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/gm)) keys.add(match[1]);
  }
  return keys;
}
export function productionEnvironmentPlanner({github,overrides={},updateExisting=false,providers={coolify,cloudflare}}) {
  const cf=(path,method,body)=>providers.cloudflare(`accounts/${config.cloudflareAccountId}/${path}`,method,body,'workers');
  async function trigger(worker,repository,branch) {
    const list=await cf(`builds/workers/${worker}/triggers`);
    const matches=Array.isArray(list)?list.filter(row=>row.branch_includes?.length===1 && row.branch_includes[0]===branch && !row.deleted_on):[];
    if(matches.length!==1 || matches[0].repo_connection?.provider_account_name!=='leia-org' ||
      matches[0].repo_connection?.repo_name!==repository.split('/')[1]) throw new Error('Unexpected Cloudflare production/pre build owner or branch.');
    return matches[0].trigger_uuid;
  }
  async function resource(service,repository) {
    if(service.endsWith('_frontend')) {
      const preview=await cf(`workers/workers/${config.workers[service]}/previews/develop`);
      if(!preview?.id) throw new Error('Build develop in Cloudflare before planning production variables.');
      const sourceId=await trigger(preview.id,repository,'develop'),targetId=await trigger(production.workers[service],repository,'main');
      const read=async id=>normalizeCloudflare(await cf(`builds/triggers/${id}/environment_variables`));
      return {source:await read(sourceId),target:await read(targetId),read:()=>read(targetId),write:patch=>
        cf(`builds/triggers/${targetId}/environment_variables`,'PATCH',Object.fromEntries(Object.entries(patch).map(([key,row])=>[key,{value:row.value,is_secret:false}])))};
    }
    const sourceId=config.stableApplications[service],targetId=production.applications[service];
    for(const [id,branch] of [[sourceId,'develop'],[targetId,'main']]) {
      const app=await providers.coolify(`applications/${id}`);
      if(app?.uuid!==id || app.git_repository!==repository || app.git_branch!==branch) throw new Error('Unexpected Coolify production/pre application owner or branch.');
    }
    const read=async id=>normalizeCoolify(await providers.coolify(`applications/${id}/envs`));
    const source=await read(sourceId),target=await read(targetId);
    return {source,target,read:()=>read(targetId),write:patch=>providers.coolify(`applications/${targetId}/envs/bulk`,'PATCH',{
      data:Object.entries(patch).map(([key,row])=>({key,value:row.value,is_literal:true,is_preview:false,
        is_buildtime:target[key]?.is_buildtime??source[key]?.is_buildtime??false,is_runtime:target[key]?.is_runtime??source[key]?.is_runtime??true}))})};
  }
  return async plans=>{
    const pending=[];
    for(const plan of plans) {
      const service=Object.keys(repositories).find(service=>repositories[service]===plan.repository);
      const mainKeys=await exampleKeys(github,plan.repository,plan.mainCommit),developKeys=await exampleKeys(github,plan.repository,plan.developCommit);
      const declared=[...developKeys].filter(key=>!mainKeys.has(key));
      const adapter=await resource(service,plan.repository);
      const {summary,patch}=environmentPlan({service,...adapter,declared,overrides:overrides[service]||{},updateExisting});
      pending.push({adapter,patch,summary});
    }
    const summaries=pending.map(row=>row.summary);
    return {summaries,async apply() {
      if(summaries.some(row=>row.missing.length)) throw new Error('Missing production values in LEIA_PRODUCTION_ENV_JSON. No environments were modified.');
      // Check all snapshots before any write, including configuration changed manually while planning.
      for(const {adapter} of pending) if(!equal(await adapter.read(),adapter.target)) throw new Error('Production variables changed while planning. Rerun the action.');
      for(const {adapter,patch} of pending) {
        if(!Object.keys(patch).length) continue;
        if(!equal(await adapter.read(),adapter.target)) throw new Error('Production variables changed before writing. Rerun the action.');
        await adapter.write(patch);
        const current=await adapter.read();
        if(Object.entries(patch).some(([key,row])=>current[key]?.value!==row.value)) throw new Error('Production environment update could not be verified. Rerun safely.');
      }
    }};
  };
}
export function environmentSummary(summaries,{applied=false}={}) {
  if(!summaries) return '';
  const names=keys=>keys.length?keys.map(key=>`\`${key}\``).join(', '):'—';
  const lines=['### Production environment variables','',`Status: ${applied?'synchronized':'plan only'}. Values are never included in this report.`,
    '', '| Service | Add | Update | Missing production values |','|---|---|---|---|'];
  for(const row of summaries) lines.push(`| ${row.service} | ${names(row.additions)} | ${names(row.updates)} | ${names(row.missing)} |`);
  lines.push('', 'Existing production values are preserved by default. Pre-only preview CORS and Turnstile bypass variables are excluded. No variables are deleted, services restarted or databases copied.');
  return lines.join('\n');
}
