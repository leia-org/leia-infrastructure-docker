import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {allowedPath} from './core.mjs';
export function git(directory,args,options={}) {
  return execFileSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],{cwd:directory,encoding:'utf8',maxBuffer:8*1024*1024,
    env:{PATH:process.env.PATH,HOME:process.env.HOME,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'},...options});
}
export async function prepareCheckout(request,directory) {
  await mkdir(directory,{recursive:true});git(directory,['init']);
  git(directory,['remote','add','origin',`https://github.com/${request.repository}.git`]);
  git(directory,['fetch','--no-tags','origin',request.headSha,request.baseSha]);
  git(directory,['checkout','--detach',request.headSha]);
}
export async function checkedPatch(request,directory,patch) {
  if(typeof patch!=='string' || Buffer.byteLength(patch)>2*1024*1024)throw new Error('Agent patch exceeds the 2 MiB limit.');
  if(patch)git(directory,['apply','--index','--binary','--whitespace=error-all','-'],{input:patch});
  git(directory,['diff','--cached','--check']);
  const files=git(directory,['diff','--cached','--name-only','-z',request.headSha]).split('\0').filter(Boolean);
  if(files.length>200 || files.some(path=>!allowedPath(path)))throw new Error('Agent patch changes a protected path or exceeds 200 files.');
  for(const file of files) {
    const row=git(directory,['ls-files','--stage','--',file]).trim();
    if(row && !/^(100644|100755) [a-f0-9]{40} 0\t/.test(row))throw new Error('Symlinks, submodules and unresolved files are not supported in agent patches.');
  }
  return files;
}
export async function exportPatch(request,directory,output,modelResult) {
  if(modelResult?.status!=='ready' || typeof modelResult.summary!=='string')throw new Error('Agent did not report a completed, checked change.');
  git(directory,['add','-A']);
  if(git(directory,['ls-files','-u']).trim())throw new Error('Unresolved merge conflicts remain.');
  git(directory,['diff','--cached','--check',request.headSha]);
  const files=git(directory,['diff','--cached','--name-only','-z',request.headSha]).split('\0').filter(Boolean);
  if(files.length>200 || files.some(path=>!allowedPath(path)))throw new Error('Agent changed protected paths or exceeded the change limit.');
  const patch=git(directory,['diff','--cached','--binary',request.headSha]);
  if(Buffer.byteLength(patch)>2*1024*1024)throw new Error('Agent patch is too large.');
  await mkdir(output,{recursive:true});await writeFile(resolve(output,'patch.json'),JSON.stringify({patch,summary:modelResult.summary.slice(0,2000)}));
}
