import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createHmac,verify} from 'node:crypto';
import {createWorker,commandEvent,repositories} from './worker.mjs';
import {repositories as manifest} from '../../previews/manifest.mjs';
const keys=generateKeyPairSync('rsa',{modulusLength:2048});
const env={LEIA_BOT_APP_ID:'5369466',LEIA_BOT_INSTALLATION_ID:'172724374',LEIA_WEBHOOK_SECRET:'test-webhook-secret-that-is-at-least-32-characters',
  LEIA_BOT_PRIVATE_KEY:keys.privateKey.export({type:'pkcs8',format:'pem'})};
const repository='leia-org/leia-designer-frontend';
const payload={action:'created',repository:{full_name:repository},issue:{number:116,state:'open',pull_request:{url:`https://api.github.com/repos/${repository}/pulls/116`}},
  comment:{id:42,body:'/leia fix merge conflicts\r\n',user:{login:'member',type:'User'},issue_url:`https://api.github.com/repos/${repository}/issues/116`},sender:{login:'member'}};
function signed(value=payload,secret=env.LEIA_WEBHOOK_SECRET,kind='issue_comment') {
  const body=typeof value==='string'?value:JSON.stringify(value);
  return new Request('https://events.example/github',{method:'POST',headers:{'x-github-event':kind,'x-github-delivery':'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    'x-hub-signature-256':`sha256=${createHmac('sha256',secret).update(body).digest('hex')}`},body});
}
function github({member='active',status=200,dispatchStatus=204}={}) {
  const calls=[],errors=[];
  const worker=createWorker(async(url,options)=>{
    calls.push({url,options});
    if(url.endsWith('/access_tokens')) {
      const jwt=options.headers.Authorization.slice(7).split('.');
      assert.ok(verify('RSA-SHA256',Buffer.from(jwt.slice(0,2).join('.')),keys.publicKey,Buffer.from(jwt[2],'base64url')));
      const claims=JSON.parse(Buffer.from(jwt[1],'base64url'));assert.equal(claims.iss,env.LEIA_BOT_APP_ID);assert.ok(claims.exp-claims.iat<=360);
      assert.deepEqual(JSON.parse(options.body),{repositories:['leia-infrastructure-docker'],permissions:{contents:'write',members:'read'}});
      return Response.json({token:'test-installation-token'});
    }
    if(url.includes('/memberships/'))return Response.json({state:member},{status});
    if(url.endsWith('/dispatches'))return dispatchStatus===204?new Response(null,{status:204}):Response.json({message:'error'},{status:dispatchStatus});
    if(url.endsWith('/installation/token')&&options.method==='DELETE')return new Response(null,{status:204});
    throw Error('Unexpected route');
  },{error:value=>errors.push(value)});
  return {worker,calls,errors};
}
test('event relay allowlist matches all six applications',()=>assert.deepEqual([...repositories].sort(),Object.values(manifest).sort()));
test('signed member commands wake only the central scan and revoke the temporary token',async()=>{
  const {worker,calls}=github();assert.equal((await worker.fetch(signed(),env)).status,202);
  const dispatch=calls.find(row=>row.url.endsWith('/dispatches'));
  assert.equal(dispatch.url,'https://api.github.com/repos/leia-org/leia-infrastructure-docker/dispatches');
  assert.deepEqual(JSON.parse(dispatch.options.body),{event_type:'leia-agent-command',client_payload:{repository,number:116,commentId:42,actor:'member',delivery:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'}});
  assert.ok(!dispatch.options.body.includes('fix merge conflicts'));
  assert.equal(calls.at(-1).options.method,'DELETE');
});
test('missing, forged or tampered signatures cannot make GitHub calls',async()=>{
  const {worker,calls}=github();
  for(const request of [signed(payload,'different-secret'),new Request('https://events.example/github',{method:'POST',body:JSON.stringify(payload)})])assert.equal((await worker.fetch(request,env)).status,401);
  const request=signed();request.headers.set('x-hub-signature-256','sha256='+'f'.repeat(64));assert.equal((await worker.fetch(request,env)).status,401);assert.equal(calls.length,0);
});
test('edits, bots, outsiders, ordinary issues and unsupported repositories do not wake the agent',async()=>{
  const {worker,calls}=github();
  const invalid=[{...payload,action:'edited'},{...payload,action:'deleted'},{...payload,repository:{full_name:'outside/repository'}},
    {...payload,sender:{login:'other-user'}},{...payload,issue:{...payload.issue,state:'closed'}},{...payload,issue:{number:116,state:'open'}},
    {...payload,comment:{...payload.comment,user:{login:'bot',type:'Bot'}}},
    ...['hello /leia fix','/leia','/leia\nfix','/leia '+'a'.repeat(8001)].map(body=>({...payload,comment:{...payload.comment,body}}))];
  for(const value of invalid){assert.equal(commandEvent(value),null);assert.equal((await worker.fetch(signed(value),env)).status,202);}
  assert.equal(calls.length,0);
});
test('membership must be active and lookup failures fail closed',async()=>{
  for(const options of [{member:'pending'},{status:404},{status:403}]) {
    const {worker,calls}=github(options),result=await worker.fetch(signed(),env);
    assert.equal(result.status,options.status===403?502:202);assert.equal(calls.some(row=>row.url.endsWith('/dispatches')),false);assert.equal(calls.at(-1).options.method,'DELETE');
  }
});
test('payload limits and invalid signed JSON are rejected without API calls',async()=>{
  const {worker,calls}=github();assert.equal((await worker.fetch(signed('{broken'),env)).status,400);
  assert.equal((await worker.fetch(signed('x'.repeat(256*1024+1)),env)).status,413);
  const request=signed();request.headers.set('content-length',String(256*1024+1));assert.equal((await worker.fetch(request,env)).status,413);assert.equal(calls.length,0);
});
test('health, ping and unrelated events do not dispatch work',async()=>{
  const {worker,calls}=github();assert.equal((await worker.fetch(new Request('https://events.example/health'),env)).status,200);
  assert.equal((await worker.fetch(new Request('https://events.example/health'),{})).status,503);
  assert.equal((await worker.fetch(new Request('https://events.example/github'),env)).status,405);
  assert.equal((await worker.fetch(new Request('https://events.example/unknown'),env)).status,404);
  assert.equal((await worker.fetch(signed({},env.LEIA_WEBHOOK_SECRET,'ping'),env)).status,200);
  assert.equal((await worker.fetch(signed({},env.LEIA_WEBHOOK_SECRET,'push'),env)).status,202);
  assert.equal(calls.length,0);
});
test('dispatch failures remain visible and do not expose secrets',async()=>{
  const {worker,calls,errors}=github({dispatchStatus:403});const result=await worker.fetch(signed(),env);
  assert.equal(result.status,502);assert.ok(!JSON.stringify(errors).includes('test-installation-token'));assert.ok(!(await result.text()).includes('test-installation-token'));
  assert.equal(calls.at(-1).options.method,'DELETE');
});
test('Cloudflare scheduled backup wakes the same idempotent scanner',async()=>{
  const {worker,calls}=github();await worker.scheduled({},env);
  assert.equal(calls.some(row=>row.url.includes('/memberships/')),false);
  const dispatch=JSON.parse(calls.find(row=>row.url.endsWith('/dispatches')).options.body);
  assert.equal(dispatch.event_type,'leia-agent-command');assert.match(dispatch.client_payload.delivery,/^scheduled-\d+$/);
});
