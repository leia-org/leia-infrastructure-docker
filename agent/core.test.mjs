import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {command,requestFrom,authorize,hash,allowedPath,validationCommands} from './core.mjs';
import {scan} from './scan.mjs';
import {git,checkedPatch,exportPatch} from './git.mjs';
import {verify} from './verify.mjs';
import {publish} from './publish.mjs';
const repository='leia-org/leia-auth',headSha='a'.repeat(40),baseSha='b'.repeat(40);
const pr={number:9,state:'open',head:{sha:headSha,ref:'feature/example',repo:{full_name:repository}},base:{sha:baseSha,ref:'develop',repo:{full_name:repository}}};
const comment={id:12,body:'/leia add a regression test',created_at:'2026-10-18T12:00:00Z',user:{login:'member',type:'User'},issue_url:`https://api.github.com/repos/${repository}/issues/9`};
const request=requestFrom(repository,pr,comment);
function api({member=true,current=pr,currentComment=comment}={}) {
  const writes=[];
  return {writes,isMember:async()=>member,request:async(path,method='GET',body)=>{
    if(method!=='GET'){writes.push({path,method,body});return path.endsWith('/commits')?{sha:'c'.repeat(40)}:{sha:'d'.repeat(40)};}
    if(path.endsWith('/pulls/9'))return current;
    if(path.endsWith('/issues/comments/12'))return currentComment;
    if(path.includes('/issues/comments?'))return path.startsWith(`repos/${repository}/`)?[comment]:[];
    if(path.includes('/comments?'))return [];
    if(path.includes('/git/commits/'))return {tree:{sha:'e'.repeat(40)}};
    throw Error('Unexpected route '+path);
  }};
}
test('parse only actual /leia commands, including multiline instructions',()=>{
  assert.equal(command('/leia fix merge conflicts of this branch'),'fix merge conflicts of this branch');
  assert.equal(command('/leia add x\nand test y'),'add x\nand test y');
  for(const text of ['hi /leia fix','```\n/leia fix\n```','/leia','/leiax do it'])assert.equal(command(text),null);
  assert.throws(()=>command('/leia '+'a'.repeat(8001)));
});
test('authorization rejects nonmembers, forks, edited commands and moved or closed PRs',async()=>{
  await authorize(api(),request);
  for(const options of [{member:false},{current:{...pr,state:'closed'}},{current:{...pr,head:{...pr.head,sha:'f'.repeat(40)}}},
    {current:{...pr,base:{...pr.base,sha:'f'.repeat(40)}}},{current:{...pr,head:{...pr.head,repo:{full_name:'fork/leia-auth'}}}},
    {currentComment:{...comment,body:'/leia different request'}},{currentComment:null}])await assert.rejects(authorize(api(options),request));
  assert.throws(()=>requestFrom(repository,{...pr,head:{...pr.head,ref:'main'}},comment));
});
test('conflict instructions request a real base merge',()=>{
  assert.equal(requestFrom(repository,pr,{...comment,body:'/leia fix merge conflicts'}).mergeBase,true);
  assert.equal(requestFrom(repository,{...pr,mergeable:false},comment).mergeBase,true);
  assert.equal(request.mergeBase,false);
});
test('commands are claimed once, one per PR, before any acknowledgement',async()=>{
  let value={version:1,enabledAt:'2026-10-18T11:00:00Z',commands:{}};const github=api();let saves=0;
  const store={load:async()=>structuredClone(value),save:async next=>{saves++;value=structuredClone(next);}};
  const first=await scan({github,store,runId:1});assert.equal(first.length,1);assert.equal(value.commands['12'].status,'claimed');assert.equal(saves,1);
  const second=await scan({github,store,runId:2});assert.equal(second.length,0);
  const outsider=api({member:false});const none=await scan({github:outsider,store:{load:async()=>({version:1,enabledAt:'2026-10-18T11:00:00Z',commands:{}}),save:async()=>{}},runId:3});assert.equal(none.length,0);
});
test('a partial scan claims nothing, and historical comments are ignored',async()=>{
  const github=api();let saved=false;const normal=github.request;
  github.request=async(path,...args)=>{if(path.startsWith('repos/leia-org/leia-runner/'))throw Error('API unavailable');return normal(path,...args);};
  await assert.rejects(scan({github,store:{load:async()=>({version:1,enabledAt:'2026-10-18T11:00:00Z',commands:{}}),save:async()=>{saved=true;}},runId:1}));assert.equal(saved,false);
  const result=await scan({github:api(),store:{load:async()=>({version:1,enabledAt:'2026-10-18T13:00:00Z',commands:{}}),save:async()=>{}},runId:2});assert.equal(result.length,0);
});
test('protected files, traversal and private environments cannot enter an agent patch',()=>{
  for(const path of ['.github/workflows/ci.yml','.github/actions/x/action.yml','AGENTS.md','sub/AGENTS.md','.codex/config.toml','.env','.env.pre','private.pem','../escape','/absolute','a/.git/config','x\\file','x\nfile'])assert.equal(allowedPath(path),false,path);
  for(const path of ['src/index.js','README.md','.env.example','.env.production.example','tests/example.test.js'])assert.equal(allowedPath(path),true,path);
});
test('mandatory validation covers frontend builds, backend tests and Runner unit tests',()=>{
  assert.deepEqual(validationCommands('auth',{test:'vitest'}),[['npm',['test','--','--run']]]);
  assert.deepEqual(validationCommands('runner',{'test:unit':'vitest run'}),[['npm',['run','test:unit']]]);
  assert.equal(validationCommands('designer_frontend',{'test:preview':'node --test'}).length,2);
  assert.deepEqual(validationCommands('workbench_frontend',{build:'vite build'}),[['npm',['run','build']]]);
  assert.deepEqual(validationCommands('workbench_frontend',{'build:pre':'vite build --mode pre'}),[['npm',['run','build:pre']]]);
});
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'leia-agent-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const source=join(root,'source');await mkdir(source);git(source,['init','-q']);git(source,['config','user.name','Test']);git(source,['config','user.email','test@example.com']);
  await writeFile(join(source,'package.json'),JSON.stringify({scripts:{test:'vitest'}}));await writeFile(join(source,'file.txt'),'before\n');
  git(source,['add','.']);git(source,['commit','-qm','initial']);const head=git(source,['rev-parse','HEAD']).trim();
  await writeFile(join(source,'file.txt'),'after\n');git(source,['add','.']);const patch=git(source,['diff','--cached','--binary']);git(source,['reset','--hard','HEAD']);
  const req={...request,headSha:head,baseSha:head};
  return {root,source,patch,req,checkout:async(_request,directory)=>{await mkdir(directory,{recursive:true});git(directory,['clone','-q',source,'.']);}};
}
test('bounded patch applies to an exact head; symlink changes and conflict markers are rejected',async t=>{
  const f=await fixture(t),target=join(f.root,'apply');await f.checkout(f.req,target);
  assert.deepEqual(await checkedPatch(f.req,target,f.patch),['file.txt']);
  git(target,['reset','--hard','HEAD']);
  await writeFile(join(target,'file.txt'),'<<<<<<< ours\nhello\n=======\nbye\n>>>>>>> theirs\n');
  await assert.rejects(exportPatch(f.req,target,join(f.root,'result'),{status:'ready',summary:'bad'}));
  git(target,['reset','--hard','HEAD']);await symlink('/etc/passwd',join(target,'link'));git(target,['add','.']);
  const linked=git(target,['diff','--cached','--binary']);git(target,['reset','--hard','HEAD']);
  await assert.rejects(checkedPatch(f.req,target,linked),/Symlinks/);
});
test('independent verification runs inside a container, propagates failures and detects changed scripts',async t=>{
  const f=await fixture(t),calls=[];
  const result=await verify({request:f.req,artifact:{patch:f.patch,summary:'change'},directory:join(f.root,'verify'),checkout:f.checkout,run:(cmd,args,options)=>{calls.push({cmd,args,options});}});
  assert.equal(calls.length,2);assert.ok(calls.every(call=>call.cmd==='docker' && call.args.includes('--cap-drop=ALL') && !JSON.stringify(call.options).includes('TOKEN')));
  assert.equal(result.patchHash,hash(f.patch));assert.ok(result.checks.every(check=>check.result==='passed'));
  await assert.rejects(verify({request:f.req,artifact:{patch:f.patch},directory:join(f.root,'fail'),checkout:f.checkout,run:()=>{throw Error('test failure');}}),/test failure/);
  await writeFile(join(f.source,'package.json'),JSON.stringify({scripts:{test:'echo skipped'}}));git(f.source,['add','.']);const changed=git(f.source,['diff','--cached','--binary']);git(f.source,['reset','--hard','HEAD']);
  await assert.rejects(verify({request:f.req,artifact:{patch:changed},directory:join(f.root,'evade'),checkout:f.checkout,run:()=>{}}),/scripts cannot be changed/);
});
test('verified changes publish one non-forced commit with the expected parents and no coauthor trailer',async t=>{
  const f=await fixture(t),github=api({current:{...pr,head:{...pr.head,sha:f.req.headSha},base:{...pr.base,sha:f.req.baseSha}}});
  const artifact={patch:f.patch},verified={version:1,requestHash:hash(JSON.stringify(f.req)),patchHash:hash(f.patch),checks:[{result:'passed'},{result:'passed'}]};
  const result=await publish({github,request:f.req,artifact,verified,directory:join(f.root,'publish'),checkout:f.checkout});
  assert.equal(result.sha,'c'.repeat(40));
  const commit=github.writes.find(row=>row.path.endsWith('/commits'));assert.deepEqual(commit.body.parents,[f.req.headSha]);assert.ok(!/Co-Authored-By/i.test(commit.body.message));
  const update=github.writes.at(-1);assert.equal(update.method,'PATCH');assert.equal(update.body.force,false);assert.ok(update.path.includes('feature%2Fexample'));
});
test('unverified or mismatched artifacts never produce GitHub writes',async t=>{
  const f=await fixture(t),github=api();
  await assert.rejects(publish({github,request:f.req,artifact:{patch:f.patch},verified:{version:1,requestHash:'wrong'},directory:join(f.root,'never'),checkout:f.checkout}));assert.equal(github.writes.length,0);
});
test('a real merge conflict can be resolved into a two-parent commit',async t=>{
  const f=await fixture(t);
  git(f.source,['checkout','-b','base']);await writeFile(join(f.source,'file.txt'),'base change\n');git(f.source,['add','.']);git(f.source,['commit','-qm','base change']);const base=git(f.source,['rev-parse','HEAD']).trim();
  git(f.source,['checkout','-b','feature',f.req.headSha]);await writeFile(join(f.source,'file.txt'),'feature change\n');git(f.source,['add','.']);git(f.source,['commit','-qm','feature change']);const head=git(f.source,['rev-parse','HEAD']).trim();
  assert.throws(()=>git(f.source,['merge','--no-commit','--no-ff',base]));assert.ok(git(f.source,['ls-files','-u']).trim());
  await writeFile(join(f.source,'file.txt'),'base and feature resolved\n');git(f.source,['add','.']);
  const patch=git(f.source,['diff','--cached','--binary',head]);git(f.source,['merge','--abort']);
  const req={...f.req,headSha:head,baseSha:base,mergeBase:true};
  const github=api({current:{...pr,head:{...pr.head,sha:head},base:{...pr.base,sha:base}}});
  await publish({github,request:req,artifact:{patch},verified:{version:1,requestHash:hash(JSON.stringify(req)),patchHash:hash(patch),checks:[{result:'passed'},{result:'passed'}]},directory:join(f.root,'merged'),checkout:f.checkout});
  assert.deepEqual(github.writes.find(row=>row.path.endsWith('/commits')).body.parents,[head,base]);
});
test('a head change immediately before publication never updates the branch',async t=>{
  const f=await fixture(t),github=api({current:{...pr,head:{...pr.head,sha:f.req.headSha},base:{...pr.base,sha:f.req.baseSha}}});
  github.isMemberFresh=async()=>false;
  await assert.rejects(publish({github,request:f.req,artifact:{patch:f.patch},verified:{version:1,requestHash:hash(JSON.stringify(f.req)),patchHash:hash(f.patch),checks:[{result:'passed'},{result:'passed'}]},directory:join(f.root,'revoked'),checkout:f.checkout}),/active leia-org/);
  assert.equal(github.writes.some(row=>row.path.includes('/refs/heads/')),false);
});
