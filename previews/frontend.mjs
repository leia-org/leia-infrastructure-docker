import {lstat,readdir,writeFile,readFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {config,cloudflare} from './api.mjs';
import {repositories} from './manifest.mjs';
export const previewTag=plan=>`leia-${createHash('sha256').update(plan.environment).digest('hex').slice(0,8)}-${plan.revision}`;
export function buildVariables(plan,service) {
  if(!service.endsWith('_frontend') || !plan.services[service] || plan.services[service].repository!==repositories[service]) throw new Error('Unexpected frontend build source.');
  return {...plan.frontendBuildVariables[service],VITE_IMAGE_PUBLIC_URL:'https://images.leia.ovh',
    VITE_CLOUDFLARE_SITE_KEY:config.siteKey,VITE_TURNSTILE_ENABLED:'true'};
}
export async function validateAssets(directory) {
  const root=await lstat(directory);if(!root.isDirectory() || root.isSymbolicLink()) throw new Error('Static assets must be a regular directory.');
  async function walk(path) {
    for(const name of await readdir(path)) {
      const file=join(path,name),info=await lstat(file);
      if(info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error('Static assets cannot contain links or special files.');
      if(info.isDirectory()) await walk(file);
    }
  }
  await walk(directory);if(!(await lstat(join(directory,'index.html'))).isFile()) throw new Error('Missing frontend entry point.');
}
export const run=(command,args,options={})=>new Promise((accept,reject)=>{
  const child=spawn(command,args,{stdio:'inherit',...options});child.once('error',()=>reject(new Error('Failed to start the build tool.')));
  child.once('exit',code=>code===0?accept():reject(new Error(`Build tool exited with status ${code}.`)));
});
export async function buildFrontend(plan,service,directory) {
  // This function must run in the separate unprivileged build job, never in the coordinator/publisher job.
  const env=Object.fromEntries(['PATH','HOME','TMPDIR','RUNNER_TEMP','NODE_EXTRA_CA_CERTS'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
  Object.assign(env,{CI:'true',...buildVariables(plan,service)});
  await run('npm',['ci','--include=dev'],{cwd:directory,env});
  await run('npm',['run','build:pre'],{cwd:directory,env});
  await validateAssets(join(directory,'dist'));
}
export async function latestFrontend(plan,service) {
  const worker=config.workers[service],number=plan.services[service]?.pullRequest;
  if(!worker || !Number.isSafeInteger(number) || number<1) throw new Error('Invalid managed frontend preview.');
  return cloudflare(`accounts/${config.cloudflareAccountId}/workers/workers/${worker}/previews/pre-${number}/deployments/latest`,'GET',undefined,'workers');
}
export async function frontendsPublished(plan) {
  for(const service of Object.keys(plan.services).filter(service=>service.endsWith('_frontend'))) {
    const deployment=await latestFrontend(plan,service);
    if(deployment?.annotations?.['workers/tag']!==previewTag(plan)) return false;
  }
  return true;
}
export async function publishFrontend(plan,service,directory) {
  buildVariables(plan,service);await validateAssets(directory);
  const number=plan.services[service].pullRequest;
  const temporary=resolve(process.env.RUNNER_TEMP || '/tmp',`leia-publish-${plan.environment}-${service}`);
  await mkdir(temporary,{recursive:true});
  const file=join(temporary,'wrangler.json');
  await writeFile(file,JSON.stringify({name:config.workers[service],compatibility_date:'2026-10-18',
    assets:{directory:resolve(directory),not_found_handling:'single-page-application'},previews:{}}));
  const env=Object.fromEntries(['PATH','HOME','TMPDIR','RUNNER_TEMP'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
  Object.assign(env,{CI:'true',CLOUDFLARE_ACCOUNT_ID:config.cloudflareAccountId,CLOUDFLARE_API_TOKEN:process.env.CLOUDFLARE_WORKERS_TOKEN});
  if(!env.CLOUDFLARE_API_TOKEN) throw new Error('Workers publishing token is required.');
  const wrangler=new URL('./node_modules/wrangler/bin/wrangler.js',import.meta.url);
  await run(process.execPath,[wrangler.pathname,'preview','--config',file,'--name',`pre-${number}`,
    '--tag',previewTag(plan),'--message',`LEIA linked preview ${plan.environment} ${plan.revision}`],{env});
  if((await latestFrontend(plan,service))?.annotations?.['workers/tag']!==previewTag(plan)) throw new Error('Published preview does not match the planned revision.');
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const [operation,planFile,environment,service,directory]=process.argv.slice(2);
    const artifact=JSON.parse(await readFile(planFile,'utf8'));
    const plan=artifact.plans.find(plan=>plan.environment===environment);
    if(!plan) throw new Error('The frontend plan is missing.');
    if(operation==='build') await buildFrontend(plan,service,resolve(directory));
    else if(operation==='publish') {
      const {githubClient}=await import('./github.mjs');const {planReconciliation}=await import('./reconcile.mjs');
      const github=githubClient(process.env.PREVIEW_GITHUB_TOKEN);
      const fresh=await planReconciliation(github,artifact.state);
      if(!fresh.plans.some(current=>current.environment===plan.environment && current.revision===plan.revision)) throw new Error('PR sources or links changed before publication.');
      await publishFrontend(plan,service,resolve(directory));
    } else throw new Error('Unknown frontend operation.');
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
