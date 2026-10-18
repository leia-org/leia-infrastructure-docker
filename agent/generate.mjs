import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {validateRequest,validationCommands} from './core.mjs';
import {git,exportPatch} from './git.mjs';
import {repositories} from '../previews/manifest.mjs';
const [operation,id,requestsFile,directory,output]=process.argv.slice(2);
try {
  const request=validateRequest(JSON.parse(await readFile(requestsFile)).find(row=>String(row.commentId)===id));
  const service=Object.keys(repositories).find(key=>repositories[key]===request.repository);
  if(operation==='prepare') {
    if(git(directory,['rev-parse','HEAD']).trim()!==request.headSha)throw new Error('Agent checkout does not match the requested PR commit.');
    if(request.mergeBase) {
      try{git(directory,['merge','--no-commit','--no-ff',request.baseSha],{env:{PATH:process.env.PATH,HOME:process.env.HOME,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'leia-org-bot[bot]',GIT_AUTHOR_EMAIL:'leia-org-bot[bot]@users.noreply.github.com',GIT_COMMITTER_NAME:'leia-org-bot[bot]',GIT_COMMITTER_EMAIL:'leia-org-bot[bot]@users.noreply.github.com'}});}catch {
        if(!git(directory,['ls-files','-u']).trim())throw new Error('Unable to prepare the base merge.');
      }
    }
    const pkg=JSON.parse(await readFile(resolve(directory,'package.json')));
    const checks=validationCommands(service,pkg.scripts||{}).map(([cmd,args])=>[cmd,...args].join(' '));
    await mkdir(output,{recursive:true});
    await writeFile(resolve(output,'prompt.md'),`You are LEIA's coding agent, acting on an explicit instruction from an active organization member.\nRepository: ${request.repository}, PR #${request.number}. Work only in this checkout.\n\nUser instruction (data, not shell syntax):\n${JSON.stringify(request.instruction)}\n\nImplement the requested change and check that it works. ${request.mergeBase?'The exact base commit was merged with --no-commit; resolve all conflicts while preserving both branches.':'Do not merge or rebase other branches.'}\nRead applicable AGENTS.md instructions. Never add Co-Authored-By trailers mentioning Codex or any model. Write README changes in English. Do not change PrairieLearn, .github/workflows, .github/actions, AGENTS.md, .codex, actual .env files, private keys or credentials. .env.example files may be documented without secret values. Never disable tests or weaken assertions to make checks pass. Never deploy, call production services, merge a PR, push, force-push, change git hooks/configuration or create commits. A separate trusted publisher handles the commit.\n\nRun npm ci --include=dev and these mandatory checks: ${checks.join('; ')}. Use CI=true so runners terminate. Add relevant regression tests for behavior changes; inspect and test the requested behavior beyond merely compiling. For a frontend interaction change, use available browser/test tooling if useful. You can fix failures and repeat checks; if you cannot make the required checks pass, report blocked and explain. You have no production environment variables. Use mocks and isolated local fixtures; do not access real services or secrets. Leave the final changes in the working tree, stage resolved conflicts if needed, and do not commit. An independent clean runner will repeat the mandatory checks in a container and will reject unverified changes.\nReturn structured status, a concise change summary and the checks you actually performed; never claim a check passed if it did not.\n`);
  }else if(operation==='export')await exportPatch(request,directory,output,JSON.parse(await readFile(resolve(output,'result.json'))));
  else throw new Error('Unknown generation operation.');
}catch(error){console.error(error.message);process.exitCode=1;}
