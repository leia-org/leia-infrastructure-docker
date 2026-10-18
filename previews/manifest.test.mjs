import test from 'node:test';
import assert from 'node:assert/strict';
import { parseManifest, parsePullRequest, resolveEnvironment } from './manifest.mjs';

const urls = ['https://github.com/leia-org/leia-designer-frontend/pull/108',
  'https://github.com/leia-org/leia-designer-backend/pull/73'];
const body = (pull_requests = urls, environment = 'related-change') =>
  '<!-- leia-preview-environment:start -->\n```json\n' + JSON.stringify({environment, pull_requests}) +
  '\n```\n<!-- leia-preview-environment:end -->';
const commit = 'a'.repeat(40);
const pr = (repository, number) => ({
  state: 'open', author_association: 'MEMBER', body: body(),
  base: {ref: 'develop', repo: {full_name: repository}},
  head: {sha: number === 108 ? 'b'.repeat(40) : 'c'.repeat(40), repo: {full_name: repository}},
});

test('ordinary PR text does not opt into a linked environment', () => {
  assert.equal(parseManifest('Fix an issue. Related: #73'), null);
});

test('rejects credential URLs, unsupported repositories, fragments and shell text', () => {
  for (const url of ['https://user:secret@github.com/leia-org/leia-auth/pull/1',
    'https://github.com/other-org/leia-auth/pull/1', urls[0] + '#comment', '$(touch /tmp/example)']) {
    assert.throws(() => parsePullRequest(url));
  }
});

test('rejects duplicate services and stable environment names', () => {
  assert.throws(() => parseManifest(body([urls[0], urls[0]])));
  for (const name of ['pre', 'prod', 'main', '../production', 'UPPERCASE']) {
    assert.throws(() => parseManifest(body(urls, name)));
  }
});

test('links different PR numbers and pins every backend inside the environment', async () => {
  const plan = await resolveEnvironment(parseManifest(body()), pr, async () => commit);
  assert.equal(plan.services.designer_frontend.pullRequest, 108);
  assert.equal(plan.services.designer_backend.pullRequest, 73);
  assert.equal(plan.services.auth.commit, commit);
  assert.equal(plan.services.workbench_backend.commit, commit);
  assert.equal(plan.services.runner.commit, commit);
  assert.equal(plan.frontendBuildVariables.designer_frontend.VITE_APP_BACKEND,
    'https://pr-related-change-designer-api.leia.ovh');
  assert.equal(plan.frontendBuildVariables.designer_frontend.VITE_WORKBENCH_URL,
    'https://pre.workbench.leia.ovh');
  assert.equal(plan.frontendBuildVariables.workbench_frontend.VITE_AUTH_SERVICE_BACKEND,
    plan.urls.auth);
});

test('fails instead of deploying conflicting or one-sided links', async () => {
  await assert.rejects(resolveEnvironment(parseManifest(body()), async (repository, number) => ({
    ...pr(repository, number), body: number === 73 ? body([urls[1]]) : body(),
  }), async () => commit), /same environment block/);
});

test('does not execute fork code or silently use closed linked PRs', async () => {
  for (const override of [{state: 'closed'}, {author_association: 'CONTRIBUTOR'},
    {head: {sha: commit, repo: {full_name: 'someone/leia-designer-frontend'}}},
    {base: {ref: 'main', repo: {full_name: 'leia-org/leia-designer-frontend'}}}]) {
    await assert.rejects(resolveEnvironment(parseManifest(body()), async (repository, number) => ({
      ...pr(repository, number), ...override,
    }), async () => commit));
  }
});

test('a source update changes the immutable deployment revision', async () => {
  const manifest = parseManifest(body());
  const before = await resolveEnvironment(manifest, pr, async () => commit);
  const after = await resolveEnvironment(manifest, pr, async () => 'd'.repeat(40));
  assert.notEqual(before.revision, after.revision);
});
