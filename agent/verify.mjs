import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {validateRequest,validationCommands,hash} from './core.mjs';
import {prepareCheckout,checkedPatch,git} from './git.mjs';
import {repositories} from '../previews/manifest.mjs';
import {verificationEnvironment} from './environment.mjs';
const config=JSON.parse(await readFile(new URL('./config.json',import.meta.url)));
export async function verify({request,artifact,directory,run=execFileSync,checkout=prepareCheckout,image=config.verificationImage}) {
  validateRequest(request);await checkout(request,directory);
  const files=await checkedPatch(request,directory,artifact.patch);
  const service=Object.keys(repositories).find(key=>repositories[key]===request.repository);
  // Choose checks from the original PR, so an agent cannot remove a script to evade verification.
  const original=JSON.parse(git(directory,['show',`${request.headSha}:package.json`]));
  const checks=[['npm',['ci','--include=dev']],...validationCommands(service,original.scripts||{})];
  const current=JSON.parse(await readFile(resolve(directory,'package.json')));
  for(const [cmd,args]of checks.slice(1)) {
    const name=args[0]==='run'?args[1]:'test';
    if(current.scripts?.[name]!==original.scripts?.[name])throw new Error('Mandatory verification scripts cannot be changed by an agent.');
  }
  const variables=verificationEnvironment(service);
  const docker=['run','--rm','--read-only','--cpus=2','--memory=4g','--pids-limit=512','--cap-drop=ALL','--security-opt=no-new-privileges',
    '--user',`${process.getuid()}:${process.getgid()}`,'--tmpfs','/tmp:rw,nosuid,nodev,size=1g','--mount',`type=bind,src=${resolve(directory)},dst=/work`,
    '--mount',`type=bind,src=${resolve(directory,'.git')},dst=/work/.git,readonly`,'--workdir','/work','--env','HOME=/tmp','--env','CI=true',...Object.entries(variables).flatMap(([key,value])=>['--env',`${key}=${value}`]),image];
  const results=[];
  for(const [cmd,args]of checks) {
    console.log(`Verifying: ${cmd} ${args.join(' ')}`);
    run('docker',[...docker,cmd,...args],{stdio:'inherit',timeout:8*60*1000,env:{PATH:process.env.PATH,HOME:process.env.HOME}});
    results.push({command:[cmd,...args].join(' '),result:'passed'});
  }
  git(directory,['diff','--exit-code']);
  if(git(directory,['ls-files','--others','--exclude-standard']).trim())throw new Error('Verification created untracked source files.');
  return {version:1,requestHash:hash(JSON.stringify(request)),patchHash:hash(artifact.patch),files,checks:results,summary:artifact.summary};
}
if(process.argv[1]?.endsWith('/verify.mjs')) {
  try {
    const [id,requestsFile,artifactDir,directory,output]=process.argv.slice(2);
    const request=JSON.parse(await readFile(requestsFile)).find(row=>String(row.commentId)===id),artifact=JSON.parse(await readFile(resolve(artifactDir,'patch.json')));
    const result=await verify({request,artifact,directory,image:config.verificationImage});
    await mkdir(output,{recursive:true});await writeFile(resolve(output,'verified.json'),JSON.stringify(result));
    await writeFile(resolve(output,'patch.json'),JSON.stringify(artifact));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
