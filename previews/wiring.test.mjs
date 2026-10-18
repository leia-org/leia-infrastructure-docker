import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironmentVariables } from './wiring.mjs';
import { databaseNames } from './seed.mjs';
import { environmentUrls } from './manifest.mjs';

const plan = {environment: 'test-change', urls: environmentUrls('test-change', []),
  services: Object.fromEntries(['auth', 'designer_backend', 'workbench_backend', 'runner'].map(service => [service, {commit: 'a'.repeat(40)}]))};
const source = {
  auth: {MONGO_URI: 'mongodb://pre.example/auth-pre', JWT_SECRET: 'stable-jwt', INTERN_TOKEN: 'stable-intern', API_KEY_STORAGE_SECRET: 'encryption-key', SESSION_COOKIE_DOMAIN: '.leia.ovh'},
  designer_backend: {MONGO_URI: 'mongodb://pre.example/designer-pre', S3_BUCKET: 'leia-images-pre', S3_ACCESS_KEY_ID: 'stable-storage-key'},
  workbench_backend: {MONGO_URI: 'mongodb://pre.example/workbench-pre'}, runner: {REDIS_URL: 'redis://shared.example:6379'},
};

test('isolates all backend dependencies, credentials, cookies and data stores', () => {
  const vars = createEnvironmentVariables(plan, source, 'mongodb://root:private@preview.example:27017/admin');
  const auth = JSON.parse(vars.AUTH_CONFIG_JSON), designer = JSON.parse(vars.DESIGNER_CONFIG_JSON);
  const workbench = JSON.parse(vars.WORKBENCH_CONFIG_JSON), runner = JSON.parse(vars.RUNNER_CONFIG_JSON);
  assert.notEqual(auth.JWT_SECRET, source.auth.JWT_SECRET);
  assert.equal(auth.JWT_SECRET, designer.JWT_SECRET);
  assert.equal(auth.JWT_SECRET, workbench.JWT_SECRET);
  assert.equal(auth.INTERN_TOKEN, runner.INTERN_TOKEN);
  assert.equal(auth.API_KEY_STORAGE_SECRET, source.auth.API_KEY_STORAGE_SECRET);
  assert.equal(auth.SESSION_COOKIE_DOMAIN, undefined);
  assert.equal(designer.AUTH_SERVICE_URL, 'http://auth-test-change:3000');
  assert.equal(workbench.MANAGER_URL, 'http://designer-test-change:3000');
  assert.equal(runner.VITE_AUTH_SERVICE_BACKEND, designer.AUTH_SERVICE_URL);
  assert.equal(runner.REDIS_URL, 'redis://redis:6379');
  assert.notEqual(designer.S3_BUCKET, source.designer_backend.S3_BUCKET);
  assert.equal(designer.S3_ACCESS_KEY_ID, '');
  for (const config of [auth, designer, workbench]) {
    assert.equal(new URL(config.MONGO_URI).hostname, 'preview.example');
    assert.match(new URL(config.MONGO_URI).pathname, /^\/pr_[a-f0-9]{12}_/);
  }
});

test('preserves credentials and test databases across source updates', () => {
  const before = createEnvironmentVariables(plan, source, 'mongodb://root:private@preview.example:27017/admin');
  const after = createEnvironmentVariables(plan, source, 'mongodb://root:private@preview.example:27017/admin', before);
  assert.deepEqual(after, before);
  const rotated = {...source, auth: {...source.auth, API_KEY_STORAGE_SECRET: 'new-stable-key'}};
  assert.equal(JSON.parse(createEnvironmentVariables(plan, rotated,
    'mongodb://root:private@preview.example:27017/admin', before).AUTH_CONFIG_JSON).API_KEY_STORAGE_SECRET, 'encryption-key');
});

test('database names cannot select a stable database or path', () => {
  for (const name of ['pre', 'production', '../auth-pre', 'a'.repeat(70)]) assert.throws(() => databaseNames(name));
  assert.notDeepEqual(databaseNames('change-one'), databaseNames('change-two'));
});
