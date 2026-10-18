import {writeFile,appendFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {githubClient} from '../previews/github.mjs';
import {allowedRepositories,command,requestFrom,authorize,reply} from './core.mjs';
import {agentStateStore} from './state.mjs';
async function pages(github,path) {
  const rows=[];for(let page=1;;page++) {
    const batch=await github.request(`${path}${path.includes('?')?'&':'?'}per_page=100&page=${page}`);
    if(!Array.isArray(batch))throw new Error('Incomplete agent command scan.');
    rows.push(...batch);if(batch.length<100)return rows;
  }
}
export async function scan({github,store,runId,limit=3,now=()=>new Date().toISOString()}) {
  const state=await store.load(),candidates=[],rejected=[],scanStartedAt=now();
  const since=state.scanSince||state.enabledAt;
  // Complete the scan before claiming any command. No partial repository scan is accepted.
  for(const repository of allowedRepositories) {
    const comments=await pages(github,`repos/${repository}/issues/comments?since=${encodeURIComponent(since)}`);
    for(const comment of comments) {
      if(Date.parse(comment.created_at)<Date.parse(state.enabledAt) || state.commands[String(comment.id)] || comment.user?.type==='Bot')continue;
      let instruction;try{instruction=command(comment.body);}catch{continue;}
      if(!instruction || !await github.isMember(comment.user?.login))continue;
      const match=comment.issue_url?.match(new RegExp(`^https://api.github.com/repos/${repository}/issues/([1-9][0-9]*)$`));if(!match)continue;
      const pr=await github.request(`repos/${repository}/pulls/${match[1]}`);
      if(!pr || pr.state!=='open' || pr.head?.repo?.full_name!==repository || pr.base?.repo?.full_name!==repository)continue;
      try {const request=requestFrom(repository,pr,comment);candidates.push({...request,createdAt:comment.created_at});}
      catch {rejected.push({repository,number:pr.number,commentId:comment.id});}
    }
  }
  const selected=[],busy=new Set();
  for(const request of candidates.sort((a,b)=>Date.parse(a.createdAt)-Date.parse(b.createdAt)||a.commentId-b.commentId)) {
    const key=`${request.repository}#${request.number}`;if(busy.has(key) || selected.length>=limit)continue;
    await authorize(github,request);busy.add(key);selected.push(request);
  }
  for(const request of rejected)state.commands[String(request.commentId)]={repository:request.repository,number:request.number,status:'rejected',runId:String(runId),updatedAt:now()};
  for(const request of selected)state.commands[String(request.commentId)]={repository:request.repository,number:request.number,
    actor:request.actor,headSha:request.headSha,baseSha:request.baseSha,bodyHash:request.bodyHash,status:'claimed',runId:String(runId),updatedAt:now()};
  const accepted=new Set(selected.map(request=>request.commentId));
  const waiting=candidates.filter(request=>!accepted.has(request.commentId));
  state.scanSince=waiting.length?new Date(Math.min(...waiting.map(request=>Date.parse(request.createdAt)))-1000).toISOString():scanStartedAt;
  await store.save(state); // Claim before any costly work; reruns never repeat a claimed comment.
  for(const request of rejected)await reply(github,request,'### LEIA agent\nThis PR is outside the supported scope. Commands require an open PR in one of the six application repositories, targeting main/develop, with a source branch other than main in the same repository.').catch(()=>{});
  for(const request of selected)await reply(github,request,`### LEIA agent\nQueued with \`gpt-6-luna\` for @${request.actor}. I will check the result before adding a commit.\n\n[Follow the run](https://github.com/leia-org/leia-infrastructure-docker/actions/runs/${runId}).`).catch(()=>{console.error('Unable to acknowledge an accepted command.');});
  return selected;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const selected=await scan({github:githubClient(process.env.PREVIEW_GITHUB_TOKEN),store:agentStateStore(process.env.GITHUB_TOKEN),runId:process.env.GITHUB_RUN_ID});
    await writeFile('agent-requests.json',JSON.stringify(selected));
    const matrix=selected.map(request=>({id:String(request.commentId),repository:request.repository,headSha:request.headSha}));
    await appendFile(process.env.GITHUB_OUTPUT,`matrix=${JSON.stringify(matrix)}\nhas_requests=${matrix.length>0}\n`);
    console.log(`Accepted ${selected.length} LEIA agent command(s).`);
  }catch(error){console.error(error.message);process.exitCode=1;}
}
