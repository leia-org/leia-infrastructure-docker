import {readFile} from 'node:fs/promises';
import {parseManifest,resolveEnvironment} from './manifest.mjs';
import {githubClient} from './github.mjs';
try {
  const github=githubClient(process.env.PREVIEW_GITHUB_TOKEN || process.env.GITHUB_TOKEN);
  const manifest=parseManifest(await readFile(process.argv[2],'utf8'));
  if(!manifest) throw new Error('No preview environment block found.');
  console.log(JSON.stringify(await resolveEnvironment(manifest,github.getPullRequest,github.getDevelopCommit,
    login => github.isMember(login)),null,2));
} catch(error) {console.error(error.message);process.exitCode=1;}
