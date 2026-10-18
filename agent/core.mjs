import {createHash} from 'node:crypto';
import {repositories} from '../previews/manifest.mjs';
export const allowedRepositories=new Set(Object.values(repositories));
export const model='gpt-6-luna';
export const marker=id=>`<!-- leia-agent-command:${id} -->`;
export const hash=body=>createHash('sha256').update(body).digest('hex');
export function command(body) {
  if(typeof body!=='string') return null;
  const match=body.match(/^\/leia[ \t]+([^\r\n]+[\s\S]*)$/);
  if(!match) return null;
  const instruction=match[1].trim();
  if(!instruction || instruction.length>8000) throw new Error('Use /leia followed by an instruction of at most 8000 characters.');
  return instruction;
}
export function validateRequest(request) {
  if(!allowedRepositories.has(request.repository) || !Number.isSafeInteger(request.number) || request.number<1 ||
    !Number.isSafeInteger(request.commentId) || request.commentId<1 || !/^[a-zA-Z0-9-]{1,39}$/.test(request.actor||'') ||
    !/^[a-f0-9]{40}$/.test(request.headSha||'') || !/^[a-f0-9]{40}$/.test(request.baseSha||'') ||
    !/^[a-f0-9]{64}$/.test(request.bodyHash||'') || !['main','develop'].includes(request.baseRef) ||
    typeof request.headRef!=='string' || request.headRef==='main' || !/^[a-zA-Z0-9][a-zA-Z0-9._\/-]{0,200}$/.test(request.headRef) || request.headRef.includes('..') ||
    typeof request.mergeBase!=='boolean' || typeof request.instruction!=='string' || !request.instruction.trim() || request.instruction.length>8000) throw new Error('Invalid or unsupported LEIA agent request.');
  return request;
}
export async function authorize(github,request) {
  validateRequest(request);
  if(!await github.isMember(request.actor)) throw new Error('Only active leia-org members may request agent commits.');
  const pr=await github.request(`repos/${request.repository}/pulls/${request.number}`);
  if(pr?.state!=='open' || pr.head?.repo?.full_name!==request.repository || pr.base?.repo?.full_name!==request.repository ||
    pr.head.ref!==request.headRef || pr.base.ref!==request.baseRef || pr.head.sha!==request.headSha || pr.base.sha!==request.baseSha) throw new Error('The PR was closed or its source/base changed. Post a new /leia command.');
  const comment=await github.request(`repos/${request.repository}/issues/comments/${request.commentId}`);
  if(comment?.user?.login!==request.actor || hash(comment.body||'')!==request.bodyHash || command(comment.body)!==request.instruction ||
    comment.issue_url!==`https://api.github.com/repos/${request.repository}/issues/${request.number}`) throw new Error('The command comment changed or was deleted. Post a new /leia command.');
  return pr;
}
export function requestFrom(repository,pr,comment) {
  const instruction=command(comment.body);if(!instruction) return null;
  return validateRequest({repository,number:pr.number,commentId:comment.id,actor:comment.user?.login,
    headSha:pr.head?.sha,baseSha:pr.base?.sha,headRef:pr.head?.ref,baseRef:pr.base?.ref,
    bodyHash:hash(comment.body),instruction,mergeBase:pr.mergeable===false || /\b(?:conflicts?|conflictos?)\b/i.test(instruction)});
}
export async function reply(github,request,text) {
  const path=`repos/${request.repository}/issues/${request.number}/comments`,owned=[];
  for(let page=1;;page++) {
    const rows=await github.request(`${path}?per_page=100&page=${page}`);if(!Array.isArray(rows))throw new Error('Incomplete PR comments.');
    owned.push(...rows.filter(row=>row.user?.login==='leia-org-bot[bot]' && row.body?.startsWith(marker(request.commentId))));
    if(rows.length<100)break;
  }
  if(owned.length>1)throw new Error('Multiple owned agent replies require review.');
  const body=`${marker(request.commentId)}\n${text}`;
  if(owned[0]?.body===body)return;
  if(owned[0])await github.request(`repos/${request.repository}/issues/comments/${owned[0].id}`,'PATCH',{body});
  else await github.request(path,'POST',{body});
}
export function allowedPath(path) {
  if(typeof path!=='string' || !path.length || path.length>=500 || path.startsWith('/') || /[\x00-\x1f\\\ufffd]/.test(path) ||
    path.split('/').some(part=>part==='..' || part==='.git' || part==='.codex') ||
    path.startsWith('.github/workflows/') || path.startsWith('.github/actions/') ||
    /(?:^|\/)(?:AGENTS\.md|.*\.(?:pem|key|p12|pfx))$/i.test(path))return false;
  return !/(?:^|\/)\.env(?:\..*)?$/i.test(path) || /(?:^|\/)\.env(?:\.[a-zA-Z0-9_-]+)*\.example$/.test(path);
}
export function validationCommands(service,scripts) {
  if(service.endsWith('_frontend')) return [
    ...(scripts['test:preview']?[['npm',['run','test:preview']]]:[]),['npm',['run','build:pre']]];
  if(service==='runner') return scripts['test:unit']?[['npm',['run','test:unit']]]:[['npm',['test','--','--runInBand']]];
  return [['npm',['test','--','--run']]];
}
