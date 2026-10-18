import test from 'node:test';
import assert from 'node:assert/strict';
import {createEnvironmentVariables} from './wiring.mjs';
import {databaseNames} from './seed.mjs';
import {environmentUrls} from './manifest.mjs';
import {composeFor} from './compose.mjs';
const all=['auth','designer_backend','workbench_backend','runner'];
const source={auth:{MONGO_URI:'mongodb://pre.example/auth-pre',JWT_SECRET:'pre-jwt',INTERN_TOKEN:'pre-intern',API_KEY:'pre-api',RUNNER_KEY:'pre-runner',API_KEY_STORAGE_SECRET:'encryption-key',SESSION_COOKIE_DOMAIN:'.leia.ovh'},
  designer_backend:{MONGO_URI:'mongodb://pre.example/designer-pre',JWT_SECRET:'pre-jwt',INTERN_TOKEN:'pre-intern',API_KEY:'designer-key',S3_BUCKET:'pre-bucket',S3_ACCESS_KEY_ID:'pre-s3'},
  workbench_backend:{MONGO_URI:'mongodb://pre.example/workbench-pre',JWT_SECRET:'pre-jwt',JWT_ISSUER:'pre-issuer',INTERN_TOKEN:'pre-intern',MANAGER_KEY:'designer-key'},
  runner:{REDIS_URL:'redis://pre.example',INTERN_TOKEN:'pre-intern',RUNNER_KEY:'pre-runner'}};
const plan=(active=all,isolation='selective')=>({environment:'test-change',isolation,services:Object.fromEntries(active.map(service=>[service,{commit:'a'.repeat(40)}])),urls:environmentUrls('test-change',[],active)});
const uri='mongodb://root:private@preview.example:27017/admin';
test('partial Workbench uses only its database copy and stable pre dependencies and identities',()=>{
  const vars=createEnvironmentVariables(plan(['workbench_backend']),source,uri);
  assert.deepEqual(Object.keys(JSON.parse(vars.SEED_SOURCES_JSON)),['workbench']);
  assert.equal(vars.AUTH_CONFIG_JSON,undefined);assert.equal(vars.DESIGNER_CONFIG_JSON,undefined);assert.equal(vars.RUNNER_CONFIG_JSON,undefined);
  const wb=JSON.parse(vars.WORKBENCH_CONFIG_JSON);
  assert.equal(wb.AUTH_URL,'https://pre.auth.leia.ovh');assert.equal(wb.MANAGER_URL,'https://pre.backend.designer.leia.ovh');
  assert.equal(wb.JWT_SECRET,'pre-jwt');assert.equal(wb.JWT_ISSUER,'pre-issuer');assert.equal(wb.MANAGER_KEY,'designer-key');
  assert.equal(new URL(wb.MONGO_URI).hostname,'preview.example');
});
test('full isolation uses private dependencies, own signing keys and scoped data',()=>{
  const vars=createEnvironmentVariables(plan(all,'full'),source,uri);
  const auth=JSON.parse(vars.AUTH_CONFIG_JSON),wb=JSON.parse(vars.WORKBENCH_CONFIG_JSON),designer=JSON.parse(vars.DESIGNER_CONFIG_JSON);
  assert.notEqual(auth.JWT_SECRET,'pre-jwt');assert.equal(auth.JWT_SECRET,wb.JWT_SECRET);assert.equal(wb.MANAGER_KEY,designer.API_KEY);
  assert.equal(auth.API_KEY_STORAGE_SECRET,'encryption-key');assert.equal(auth.SESSION_COOKIE_DOMAIN,undefined);
  assert.equal(wb.MANAGER_URL,'http://designer-test-change:3000');assert.equal(wb.AUTH_URL,'http://auth-test-change:3000');
  assert.equal(designer.S3_ACCESS_KEY_ID,'');assert.notEqual(designer.S3_BUCKET,'pre-bucket');
});
test('adding a backend preserves existing database credentials and test data',()=>{
  const before=createEnvironmentVariables(plan(['workbench_backend']),source,uri);
  const after=createEnvironmentVariables(plan(['workbench_backend','designer_backend']),source,uri,before);
  assert.deepEqual(JSON.parse(after.PREVIEW_DATABASE_CREDENTIALS_JSON).workbench,JSON.parse(before.PREVIEW_DATABASE_CREDENTIALS_JSON).workbench);
  assert.equal(JSON.parse(after.WORKBENCH_CONFIG_JSON).ADMIN_SECRET,JSON.parse(before.WORKBENCH_CONFIG_JSON).ADMIN_SECRET);
});
test('frontend-only has no seed credentials; Runner-only gets Redis without any Mongo copy',()=>{
  assert.deepEqual(createEnvironmentVariables(plan(['workbench_frontend']),source),{});
  const vars=createEnvironmentVariables(plan(['runner']),source);
  assert.equal(vars.PREVIEW_MONGO_ADMIN_URI,undefined);assert.equal(vars.SEED_SOURCES_JSON,undefined);
  assert.equal(JSON.parse(vars.RUNNER_CONFIG_JSON).REDIS_URL,'redis://redis:6379');
});
test('every generated service subset has no implicit backend dependency and exposes only its runtime config',()=>{
  for(let mask=1;mask<16;mask++){
    const active=all.filter((s,i)=> mask & (1<<i));const compose=composeFor(active);
    assert.equal(Boolean(compose.services.redis),active.includes('runner'));
    for(const [name,config] of Object.entries(compose.services)) {
      for(const dep of Object.keys(config.depends_on || {})) assert.ok(compose.services[dep]);
      if(['seed','redis'].includes(name)) continue;
      assert.deepEqual(Object.keys(config.environment),['APP_CONFIG_JSON']);
      assert.equal(config.env_file,undefined);assert.equal(config.ports,undefined);
    }
  }
});
test('database names cannot point at stable databases or traverse paths',()=>{
  for(const value of ['pre','production','../auth-pre','a'.repeat(70)]) assert.throws(()=>databaseNames(value));
  assert.notDeepEqual(databaseNames('first'),databaseNames('second'));
});
