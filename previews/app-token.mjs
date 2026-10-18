import {sign} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {appendFile} from 'node:fs/promises';
import {repositories} from './manifest.mjs';
export async function installationToken(privateKey,appId,installationId) {
  if(!/^\d+$/.test(String(appId || '')) || !/^\d+$/.test(String(installationId || '')) || !privateKey) throw new Error('GitHub App credentials are required.');
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const now=Math.floor(Date.now()/1000);
  const input=`${encode({alg:'RS256',typ:'JWT'})}.${encode({iat:now-60,exp:now+8*60,iss:String(appId)})}`;
  const jwt=`${input}.${sign('RSA-SHA256',Buffer.from(input),privateKey).toString('base64url')}`;
  const response=await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`,{
    method:'POST',headers:{Authorization:`Bearer ${jwt}`,Accept:'application/vnd.github+json','User-Agent':'LEIA-Preview-Coordinator/1.0',
      'X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'},
    body:JSON.stringify({repositories:Object.values(repositories).map(repo=>repo.split('/')[1]),
      permissions:{contents:'read',pull_requests:'write',members:'read'}}),signal:AbortSignal.timeout(30000)});
  if(!response.ok) throw new Error(`GitHub App authentication failed: HTTP ${response.status}`);
  const value=await response.json();if(!value.token || !value.expires_at) throw new Error('Missing installation token.');
  return {token:value.token,expiresAt:value.expires_at};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const {token}=await installationToken(process.env.LEIA_BOT_PRIVATE_KEY,process.env.LEIA_BOT_APP_ID,process.env.LEIA_BOT_INSTALLATION_ID);
    if(!process.env.GITHUB_ENV) throw new Error('This entry point only writes masked Actions environment variables.');
    console.log(`::add-mask::${token}`);
    await appendFile(process.env.GITHUB_ENV,`PREVIEW_GITHUB_TOKEN=${token}\n`);
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
