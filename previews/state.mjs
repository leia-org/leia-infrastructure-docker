import {githubClient} from './github.mjs';
const repo='leia-org/leia-infrastructure-docker',branch='preview-state',path='previews/state.json';
export function publicState(value) {
  const text=JSON.stringify(value);
  const visit=item=>{if(!item || typeof item!=='object') return;
    for(const [key,value] of Object.entries(item)) {
      if(/password|private.?key|mongo.?uri|config_json|sources_json|credentials|(^|_)token$/i.test(key)) throw new Error('Private configuration must never enter the public state.');
      if(typeof value==='string' && /mongodb(?:\+srv)?:\/\/|redis:\/\/|-----BEGIN .*PRIVATE KEY-----/.test(value)) throw new Error('Private connection string in public state.');
      visit(value);
    }};
  visit(value);return text+'\n';
}
export function stateStore(token) {
  const api=githubClient(token);let exists=false;
  const location=`repos/${repo}/contents/${path}`;
  return {
    async load() {
      const ref=await api.request(`repos/${repo}/git/ref/heads/${branch}`);exists=Boolean(ref);
      if(!exists) return {version:1,environments:{},frontendPreviews:{}};
      const file=await api.request(`${location}?ref=${branch}`);
      if(!file?.content) throw new Error('The state branch exists but its state file is missing. Refusing to assume an empty deployment.');
      const state=JSON.parse(Buffer.from(file.content,'base64').toString());publicState(state);
      if(state.version!==1 || !state.environments) throw new Error('Unsupported coordinator state.');return state;
    },
    async save(value) {
      const content=Buffer.from(publicState(value)).toString('base64');
      if(!exists) {
        const base=await api.request(`repos/${repo}/git/ref/heads/main`);
        if(!base?.object?.sha) throw new Error('Cannot initialize preview state.');
        await api.request(`repos/${repo}/git/refs`,'POST',{ref:`refs/heads/${branch}`,sha:base.object.sha});exists=true;
      }
      const current=await api.request(`${location}?ref=${branch}`);
      await api.request(location,'PUT',{message:'build: reconcile preview environment state',content,branch,
        ...(current?.sha ? {sha:current.sha}:{})});
    },
  };
}
