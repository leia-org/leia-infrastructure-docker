const encoder=new TextEncoder();
export const repositories=['auth','designer-frontend','designer-backend','workbench-frontend','workbench-backend','runner'].map(name=>`leia-org/leia-${name}`);
const target='leia-org/leia-infrastructure-docker',limit=256*1024;
function response(status,text){return new Response(text,{status,headers:{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'}});}
function configured(env){return /^[0-9]+$/.test(env.LEIA_BOT_APP_ID||'')&&/^[0-9]+$/.test(env.LEIA_BOT_INSTALLATION_ID||'')&&env.LEIA_BOT_PRIVATE_KEY?.includes('-----BEGIN PRIVATE KEY-----')&&env.LEIA_WEBHOOK_SECRET?.length>=32;}
function base64url(bytes){return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');}
async function jwt(env) {
  const bytes=Uint8Array.from(atob(env.LEIA_BOT_PRIVATE_KEY.replace(/-----[^-]+-----/g,'').replace(/\s/g,'')),char=>char.charCodeAt(0));
  const key=await crypto.subtle.importKey('pkcs8',bytes,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
  const now=Math.floor(Date.now()/1000),header=base64url(encoder.encode(JSON.stringify({alg:'RS256',typ:'JWT'})));
  const payload=base64url(encoder.encode(JSON.stringify({iat:now-60,exp:now+300,iss:env.LEIA_BOT_APP_ID})));
  const input=`${header}.${payload}`;
  return `${input}.${base64url(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,encoder.encode(input)))}`;
}
async function boundedBody(request) {
  if(Number(request.headers.get('content-length'))>limit)throw new Error('body-limit');
  const reader=request.body?.getReader();if(!reader)return new Uint8Array();
  const chunks=[];let size=0;
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw new Error('body-limit');}chunks.push(value);}
  const body=new Uint8Array(size);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}return body;
}
async function validSignature(body,signature,secret) {
  if(!/^sha256=[a-f0-9]{64}$/.test(signature||''))return false;
  const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  const bytes=Uint8Array.from(signature.slice(7).match(/../g),byte=>parseInt(byte,16));
  return crypto.subtle.verify('HMAC',key,bytes,body);
}
export function commandEvent(payload) {
  const repo=payload?.repository?.full_name,number=payload?.issue?.number,comment=payload?.comment;
  if(payload?.action!=='created'||!repositories.includes(repo)||!Number.isSafeInteger(number)||number<1||!Number.isSafeInteger(comment?.id)||comment.id<1)return null;
  if(payload.issue.pull_request?.url!==`https://api.github.com/repos/${repo}/pulls/${number}`||payload.issue.state!=='open')return null;
  const actor=comment.user?.login;
  if(comment.user?.type!=='User'||payload.sender?.login!==actor||!/^[a-zA-Z0-9-]{1,39}$/.test(actor||''))return null;
  const instruction=typeof comment.body==='string'?comment.body.match(/^\/leia[ \t]+([^\r\n]+[\s\S]*)$/)?.[1].trim():null;
  if(!instruction||instruction.length>8000)return null;
  if(comment.issue_url!==`https://api.github.com/repos/${repo}/issues/${number}`)return null;
  return {repository:repo,number,commentId:comment.id,actor};
}
async function wake(env,event,delivery,fetcher) {
  const deadline=Date.now()+8000;let token;
  async function api(path,authorization,method='GET',body) {
    const remaining=deadline-Date.now();if(remaining<=0)throw new Error('GitHub request timed out.');
    const result=await fetcher(`https://api.github.com/${path}`,{method,headers:{Authorization:`Bearer ${authorization}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'LEIA-Agent-Events/1.0','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(remaining)});
    if(result.status===404)return null;
    if(!result.ok)throw new Error(`GitHub ${method} returned HTTP ${result.status}.`);
    return result.status===204?true:result.json();
  }
  try {
    const installation=await api(`app/installations/${env.LEIA_BOT_INSTALLATION_ID}/access_tokens`,await jwt(env),'POST',{
      repositories:['leia-infrastructure-docker'],permissions:{contents:'write',members:'read'}});
    token=installation?.token;if(!token)throw new Error('GitHub did not issue a scoped installation token.');
    if(event){const member=await api(`orgs/leia-org/memberships/${encodeURIComponent(event.actor)}`,token);if(member?.state!=='active')return false;}
    const dispatched=await api(`repos/${target}/dispatches`,token,'POST',{event_type:'leia-agent-command',client_payload:{...(event||{}),delivery}});
    if(dispatched!==true)throw new Error('GitHub did not accept the agent wake-up.');
    return true;
  }finally {
    if(token)await fetcher('https://api.github.com/installation/token',{method:'DELETE',headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(2000)}).catch(()=>{});
  }
}
export function createWorker(fetcher=fetch,log=console) {
  return {
    async fetch(request,env) {
      const url=new URL(request.url);
      if(url.pathname==='/health'&&request.method==='GET')return response(configured(env)?200:503,configured(env)?'LEIA agent events ready':'LEIA agent events needs configuration');
      if(url.pathname!=='/github')return response(404,'Not found');
      if(request.method!=='POST')return response(405,'POST required');
      if(!configured(env))return response(503,'Webhook configuration is incomplete');
      let body;try{body=await boundedBody(request);}catch{return response(413,'Payload too large');}
      if(!await validSignature(body,request.headers.get('x-hub-signature-256'),env.LEIA_WEBHOOK_SECRET))return response(401,'Invalid webhook signature');
      const kind=request.headers.get('x-github-event');if(kind==='ping')return response(200,'pong');
      if(kind!=='issue_comment')return response(202,'Event ignored');
      let payload;try{payload=JSON.parse(new TextDecoder().decode(body));}catch{return response(400,'Invalid JSON');}
      const event=commandEvent(payload);if(!event)return response(202,'Comment ignored');
      const delivery=request.headers.get('x-github-delivery');if(!/^[a-f0-9-]{16,128}$/i.test(delivery||''))return response(400,'Invalid delivery ID');
      try{return await wake(env,event,delivery,fetcher)?response(202,'Agent scan requested'):response(202,'Comment ignored');}
      catch{log.error('LEIA agent wake-up failed. Check the GitHub App installation and event receiver configuration.');return response(502,'Agent wake-up failed; the scheduled scan remains available');}
    },
    async scheduled(_controller,env) {
      if(!configured(env))return;
      await wake(env,null,`scheduled-${Math.floor(Date.now()/300000)}`,fetcher);
    },
  };
}
export default createWorker();
