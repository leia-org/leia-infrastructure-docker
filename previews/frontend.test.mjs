import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildVariables,validateAssets,previewTag} from './frontend.mjs';
import {publicState} from './state.mjs';
const plan={environment:'wf-88',revision:'a'.repeat(16),services:{workbench_frontend:{repository:'leia-org/leia-workbench-frontend'}},
  frontendBuildVariables:{workbench_frontend:{VITE_APP_BACKEND:'https://pr-wf-88-workbench-api.leia.ovh',VITE_AUTH_SERVICE_BACKEND:'https://pre.auth.leia.ovh'}}};
test('frontend build inputs use planned APIs and the actual public Turnstile variable',()=>{
  const vars=buildVariables(plan,'workbench_frontend');assert.equal(vars.VITE_APP_BACKEND,plan.frontendBuildVariables.workbench_frontend.VITE_APP_BACKEND);
  assert.match(vars.VITE_CLOUDFLARE_SITE_KEY,/^0x/);assert.equal(vars.VITE_AUTH_SERVICE_BACKEND,'https://pre.auth.leia.ovh');
  assert.ok(Object.keys(vars).every(key=>key.startsWith('VITE_')));
});
test('static publication rejects symbolic links before following paths outside the artifact',async()=>{
  const root=await mkdtemp(join(tmpdir(),'leia-assets-test-'));
  try {
    await writeFile(join(root,'index.html'),'<html></html>');await validateAssets(root);
    await symlink('/etc',join(root,'outside'));await assert.rejects(validateAssets(root),/links/);
  } finally {await rm(root,{recursive:true,force:true});}
});
test('public state cannot contain MongoDB roots, Redis URLs, passwords or private keys',()=>{
  for(const value of [{password:'x'},{uri:'mongodb://user:secret@host/pre'},{uri:'redis://host'},
    {LEIA_BOT_PRIVATE_KEY:'key'},{x:'-----BEGIN RSA PRIVATE KEY-----'}]) assert.throws(()=>publicState(value));
  assert.doesNotThrow(()=>publicState({version:1,environments:{'wf-88':plan}}));
});
test('deployment ownership tag changes with either group or revision and stays short',()=>{
  assert.ok(previewTag(plan).length<=32);assert.notEqual(previewTag(plan),previewTag({...plan,environment:'wf-89'}));
  assert.notEqual(previewTag(plan),previewTag({...plan,revision:'b'.repeat(16)}));
});
