import {repositories,parseManifest,parsePullRequest,updateManifest} from './manifest.mjs';

export function githubClient(token, {fetcher=fetch,botLogin=process.env.PREVIEW_BOT_LOGIN || 'leia-org-bot[bot]'}={}) {
  if (!token) throw new Error('An organization-authorized GitHub App token is required.');
  const members = new Map();
  const request = async (path,method='GET',body) => {
    const response = await fetcher(`https://api.github.com/${path}`,{method,headers:{
      Accept:'application/vnd.github+json',Authorization:`Bearer ${token}`,
      'X-GitHub-Api-Version':'2022-11-28','User-Agent':'LEIA-Preview-Coordinator/1.0',
      'Content-Type':'application/json'},body:body === undefined ? undefined : JSON.stringify(body),
      signal:AbortSignal.timeout(30000)});
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub ${method} failed: HTTP ${response.status}. No membership or API errors are treated as permission.`);
    return response.status === 204 ? true : response.json();
  };
  const pages = async path => {
    const result=[];
    for (let page=1;;page++) {
      const batch=await request(`${path}${path.includes('?')?'&':'?'}per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error('GitHub did not return a complete list.');
      result.push(...batch); if (batch.length < 100) return result;
    }
  };
  return {
    request,
    isMember(login) {
      if (!/^[a-zA-Z0-9-]{1,39}$/.test(login || '')) return Promise.resolve(false);
      if (!members.has(login)) members.set(login,request(`orgs/leia-org/memberships/${encodeURIComponent(login)}`)
        .then(result => result?.state === 'active'));
      return members.get(login);
    },
    async snapshot() {
      // Failure in any repository prevents a partial snapshot and destructive reconciliation.
      return (await Promise.all(Object.values(repositories).map(repo => pages(`repos/${repo}/pulls?state=open&base=develop`)))).flat();
    },
    getPullRequest:(repo,number) => request(`repos/${repo}/pulls/${number}`),
    async getDevelopCommit(repo) {
      const result=await request(`repos/${repo}/commits/develop`);
      if (!result?.sha) throw new Error('Cannot resolve develop.'); return result.sha;
    },
    async closedReferences(snapshot) {
      const open = new Set(snapshot.map(pr => pr.html_url)), closed=new Set();
      for (const pr of snapshot) {
        let manifest;
        try {manifest=parseManifest(pr.body);} catch {continue;}
        for (const ref of manifest?.pullRequests || []) if (!open.has(ref.url)) {
          const linked=await request(`repos/${ref.repository}/pulls/${ref.number}`);
          if (linked?.state === 'closed') closed.add(ref.url);
        }
      }
      return closed;
    },
    async patchManifest(patch,manifest) {
      const {repository,number}=patch.reference;
      const live=await request(`repos/${repository}/pulls/${number}`);
      if (live?.state !== 'open' || JSON.stringify(parseManifest(live.body)) !== JSON.stringify(parseManifest(patch.before))) {
        throw new Error('PR links changed during reconciliation. Retry from a fresh snapshot.');
      }
      const body=updateManifest(live.body,manifest);
      if (body !== (live.body || '')) await request(`repos/${repository}/pulls/${number}`,'PATCH',{body});
    },
    async comment(reference,body) {
      parsePullRequest(reference.url);
      if (!botLogin) throw new Error('The expected GitHub App bot login is required for owned comments.');
      const path=`repos/${reference.repository}/issues/${reference.number}/comments`;
      const marker='<!-- leia-linked-preview-status -->';
      const comments=await pages(path);
      const owned=comments.filter(comment => comment.user?.login === botLogin && comment.body?.startsWith(marker));
      if (owned.length > 1) throw new Error('Multiple owned preview comments require review.');
      const text=`${marker}\n${body}`;
      if (owned.length && owned[0].body === text) return;
      if (owned.length) await request(`repos/${reference.repository}/issues/comments/${owned[0].id}`,'PATCH',{body:text});
      else await request(path,'POST',{body:text});
    },
  };
}
