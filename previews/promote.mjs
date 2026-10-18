import {appendFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {repositories} from './manifest.mjs';
import {githubClient} from './github.mjs';

const components={auth:['auth'],designer:['designer_backend','designer_frontend'],
  workbench:['workbench_backend','workbench_frontend'],runner:['runner']};
const start='<!-- leia-production-promotion:start -->',end='<!-- leia-production-promotion:end -->';
const marker='<!-- leia-production-promotion-status -->';
const bot='leia-org-bot[bot]';

export function selectedRepositories(component='all') {
  if(component!=='all' && !Object.hasOwn(components,component)) throw new Error('Choose all, auth, designer, workbench or runner.');
  return (component==='all'?Object.values(components).flat():components[component]).map(service=>repositories[service]);
}
export function releaseSummary(plans) {
  const lines=['### Develop → main','', '| Repository | Changes | Release PR |','|---|---|---|'];
  for(const plan of plans) lines.push(`| ${plan.repository} | ${plan.ahead} ahead, ${plan.behind} behind | ${plan.url?`[Open](${plan.url})`:plan.ahead?'Planned':'Up to date'} |`);
  lines.push('', 'Review and merge each release PR through the normal GitHub checks and approvals. Keep the develop branch.',
    'Merging to main uses the existing production deployments: Cloudflare for frontends and Coolify on Hetzner for APIs. Production environment variables and databases stay in their hosting configuration.',
    'Each PR tracks develop, including later pushes; this is not a frozen or atomic multi-repository release.');
  return lines.join('\n');
}
function releaseBody(plan) {
  return `${start}\nPromote \`develop\` to \`main\` for ${plan.repository}.\n\n`+
    `Candidate at planning: \`${plan.developCommit}\`. [Compare branches](https://github.com/${plan.repository}/compare/main...develop).\n`+
    `${plan.ahead} commits ahead; ${plan.behind} commits behind main. Resolve any conflicts and complete required reviews before merging.\n${end}`;
}
async function openRelease(github,repository) {
  const prs=await github.request(`repos/${repository}/pulls?state=open&base=main&head=leia-org%3Adevelop&per_page=100`);
  if(!Array.isArray(prs) || prs.length>1) throw new Error('Ambiguous open develop-to-main release PRs.');
  if(prs[0] && (prs[0].base?.repo?.full_name!==repository || prs[0].base?.ref!=='main' ||
    prs[0].head?.repo?.full_name!==repository || prs[0].head?.ref!=='develop')) throw new Error('Unexpected release PR source.');
  return prs[0];
}
async function comment(github,plan,body) {
  const prefix=`repos/${plan.repository}/issues`;
  const comments=[];
  for(let page=1;;page++) {
    const batch=await github.request(`${prefix}/${plan.number}/comments?per_page=100&page=${page}`);
    if(!Array.isArray(batch)) throw new Error('Incomplete release comment list.');
    comments.push(...batch);if(batch.length<100) break;
  }
  const owned=comments.filter(value=>value.user?.login===bot && value.body?.startsWith(marker));
  if(owned.length>1) throw new Error('Multiple owned release comments require review.');
  const text=`${marker}\n${body}`;
  if(owned[0]?.body===text) return;
  if(owned[0]) await github.request(`${prefix}/comments/${owned[0].id}`,'PATCH',{body:text});
  else await github.request(`${prefix}/${plan.number}/comments`,'POST',{body:text});
}
export async function promote({github,actor,component='all',apply=false}) {
  const selected=selectedRepositories(component);
  if(!await github.isMember(actor)) throw new Error('Only active leia-org members may plan or create production release PRs.');
  const plans=[];
  // Resolve every repository before creating anything; a partial API scan fails closed.
  for(const repository of selected) {
    const main=await github.request(`repos/${repository}/commits/main`);
    const develop=await github.request(`repos/${repository}/commits/develop`);
    if(!/^[a-f0-9]{40}$/.test(main?.sha||'') || !/^[a-f0-9]{40}$/.test(develop?.sha||'')) throw new Error('Missing stable branch commit.');
    const comparison=await github.request(`repos/${repository}/compare/${main.sha}...${develop.sha}`);
    if(!Number.isSafeInteger(comparison?.ahead_by) || comparison.ahead_by<0 || !Number.isSafeInteger(comparison?.behind_by) || comparison.behind_by<0) throw new Error('Incomplete production comparison.');
    const existing=await openRelease(github,repository);
    plans.push({repository,mainCommit:main.sha,developCommit:develop.sha,ahead:comparison.ahead_by,behind:comparison.behind_by,
      ...(existing?{url:existing.html_url,number:existing.number}:{}),created:false});
  }
  if(!apply) return plans;
  for(const plan of plans.filter(plan=>plan.ahead)) {
    // Reuse a human or bot PR without changing its title, description or branch.
    let existing=await openRelease(github,plan.repository);
    if(!existing) {
      const main=await github.request(`repos/${plan.repository}/commits/main`),develop=await github.request(`repos/${plan.repository}/commits/develop`);
      if(main.sha!==plan.mainCommit || develop.sha!==plan.developCommit) throw new Error('Branches changed during release planning. Rerun the action.');
      try {
        existing=await github.request(`repos/${plan.repository}/pulls`,'POST',{
          title:'release: promote develop to main',head:'develop',base:'main',body:releaseBody(plan)});
        plan.created=true;
      } catch(error) {
        // A person can create the same PR concurrently with this workflow.
        if(!/^GitHub POST failed: HTTP 422\./.test(error.message)) throw error;
        existing=await openRelease(github,plan.repository);if(!existing) throw error;
      }
    }
    if(!existing?.html_url || !Number.isSafeInteger(existing.number)) throw new Error('Missing release PR.');
    plan.url=existing.html_url;plan.number=existing.number;
  }
  const summary=releaseSummary(plans);
  for(const plan of plans.filter(plan=>plan.ahead && plan.url)) await comment(github,plan,summary);
  return plans;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const plans=await promote({github:githubClient(process.env.PREVIEW_GITHUB_TOKEN),actor:process.env.GITHUB_ACTOR,
      component:process.env.PROMOTION_COMPONENT||'all',apply:process.argv.includes('--apply')});
    const summary=releaseSummary(plans);console.log(summary);
    if(process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,summary+'\n');
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
