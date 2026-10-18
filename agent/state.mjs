import {githubClient} from '../previews/github.mjs';
const repo='leia-org/leia-infrastructure-docker',branch='leia-agent-state',location=`repos/${repo}/contents/agent/state.json`;
export function agentStateStore(token) {
  const api=githubClient(token);let exists=false;
  return {async load() {
    exists=Boolean(await api.request(`repos/${repo}/git/ref/heads/${branch}`));
    if(!exists)return {version:1,enabledAt:new Date().toISOString(),commands:{}};
    const file=await api.request(`${location}?ref=${branch}`);
    if(!file?.content)throw new Error('Agent state is missing; refusing to replay commands.');
    const value=JSON.parse(Buffer.from(file.content,'base64'));
    if(value.version!==1 || !value.commands || !Number.isFinite(Date.parse(value.enabledAt)) || (value.scanSince && !Number.isFinite(Date.parse(value.scanSince))))throw new Error('Unsupported agent state.');
    return value;
  },async save(value) {
    if(!exists) {
      const base=await api.request(`repos/${repo}/git/ref/heads/main`);
      await api.request(`repos/${repo}/git/refs`,'POST',{ref:`refs/heads/${branch}`,sha:base.object.sha});exists=true;
    }
    const current=await api.request(`${location}?ref=${branch}`);
    await api.request(location,'PUT',{branch,message:'build: record LEIA agent command status',content:Buffer.from(JSON.stringify(value)+'\n').toString('base64'),...(current?.sha?{sha:current.sha}:{})});
  }};
}
