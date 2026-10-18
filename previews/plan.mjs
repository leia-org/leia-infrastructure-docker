import { readFile } from 'node:fs/promises';
import { parseManifest, resolveEnvironment } from './manifest.mjs';

async function github(path) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'LEIA-Preview-Planner/1.0' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(`https://api.github.com/${path}`, { headers, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`GitHub request failed: HTTP ${response.status}`);
  return response.json();
}

try {
  const manifest = parseManifest(await readFile(process.argv[2], 'utf8'));
  if (!manifest) throw new Error('No preview environment block found.');
  const plan = await resolveEnvironment(manifest,
    (repository, number) => github(`repos/${repository}/pulls/${number}`),
    async repository => (await github(`repos/${repository}/commits/develop`)).sha);
  console.log(JSON.stringify(plan, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
