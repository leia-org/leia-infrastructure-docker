import { MongoClient } from 'mongodb';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

export function databaseNames(environment) {
  if (!/^[a-z][a-z0-9-]{1,23}$/.test(environment || '') || /^(pre|prod|production|development|main|develop)$/.test(environment)) {
    throw new Error('Invalid preview environment.');
  }
  const prefix = `pr_${createHash('sha256').update(environment).digest('hex').slice(0, 12)}_`;
  return Object.fromEntries(['auth', 'designer', 'workbench'].map(service => [service, prefix + service]));
}

export async function cloneCollection(source, target, info) {
  if (info.type !== 'collection' || info.name.startsWith('system.')) throw new Error('Unsupported source collection type.');
  const collection = await target.createCollection(info.name, info.options || {});
  let batch = [], count = 0;
  for await (const document of source.collection(info.name).find({}).batchSize(100)) {
    batch.push(document);
    if (batch.length === 100) { await collection.insertMany(batch); count += batch.length; batch = []; }
  }
  if (batch.length) { await collection.insertMany(batch); count += batch.length; }
  const indexes = await source.collection(info.name).listIndexes().toArray();
  for (const index of indexes.filter(index => index.name !== '_id_')) {
    const { key, v, ns, ...options } = index;
    await collection.createIndex(key, options);
  }
  if (await collection.countDocuments({}) !== count) throw new Error('Copied document count does not match.');
  return count;
}

async function seed() {
  const environment = process.env.PREVIEW_ENVIRONMENT;
  const names = databaseNames(environment);
  const sources = JSON.parse(process.env.SEED_SOURCES_JSON || '{}');
  const credentials = JSON.parse(process.env.PREVIEW_DATABASE_CREDENTIALS_JSON || '{}');
  const targetUri = process.env.PREVIEW_MONGO_ADMIN_URI;
  const targetUrl = new URL(targetUri);
  const clients = [];
  const admin = new MongoClient(targetUri, {serverSelectionTimeoutMS: 30000});
  const lease = randomUUID();
  let records;
  try {
    await admin.connect();
    records = admin.db('leia_preview_control').collection('environments');
    const record = await records.findOne({_id: environment});
    if (process.env.PREVIEW_OPERATION === 'cleanup') {
      if (!record) return;
      for (const [service, name] of Object.entries(names)) {
        if (record.databases?.[service] !== name) throw new Error('Stored database ownership does not match.');
      }
      for (const name of Object.values(names)) {
        const target = admin.db(name);
        await target.command({dropUser: name}).catch(error => { if (error.codeName !== 'UserNotFound') throw error; });
        await target.dropDatabase();
      }
      await records.deleteOne({_id: environment});
      console.log('Removed only the databases and users owned by this preview environment.');
      return;
    }
    if (process.env.PREVIEW_OPERATION && process.env.PREVIEW_OPERATION !== 'seed') throw new Error('Unknown operation.');
    if (record?.state === 'ready') {
      for (const [service, name] of Object.entries(names)) {
        if (record.databases?.[service] !== name) throw new Error('Stored database ownership does not match.');
        const user = credentials[service];
        if (user?.username !== name || !/^[a-f0-9]{64}$/.test(user?.password || '')) throw new Error('Invalid scoped database credentials.');
        await admin.db(name).command({updateUser: name, pwd: user.password, roles: [{role: 'readWrite', db: name}]});
      }
      console.log('Preview databases already seeded; preserving test data.');
      return;
    }
    // The unique _id and lease filter make concurrent creation fail instead of seeding twice.
    await records.findOneAndUpdate({_id: environment, state: {$ne: 'ready'},
      $or: [{leaseUntil: {$exists: false}}, {leaseUntil: {$lt: new Date()}}]},
    {$set: {state: 'seeding', databases: names, lease,
      leaseUntil: new Date(Date.now() + 30 * 60 * 1000)}}, {upsert: true});
    for (const [service, name] of Object.entries(names)) {
      const sourceUri = sources[service];
      const sourceUrl = new URL(sourceUri);
      if (sourceUrl.pathname !== `/${service}-pre` || sourceUrl.hostname === targetUrl.hostname) {
        throw new Error('Only the expected pre database can be copied to a different preview server.');
      }
      const user = credentials[service];
      if (user?.username !== name || !/^[a-f0-9]{64}$/.test(user?.password || '')) throw new Error('Invalid scoped database credentials.');
      const source = new MongoClient(sourceUri, {serverSelectionTimeoutMS: 30000});
      clients.push(source);
      await source.connect();
      const target = admin.db(name);
      // names are generated internally with the pr_ prefix, never taken from a source URI.
      await target.dropDatabase();
      const info = await source.db().listCollections().toArray();
      let count = 0;
      for (const collection of info) count += await cloneCollection(source.db(), target, collection);
      const existingUser = await target.command({usersInfo: user.username});
      await target.command({[existingUser.users.length ? 'updateUser' : 'createUser']: user.username,
        pwd: user.password, roles: [{role: 'readWrite', db: name}]});
      console.log(`${service}: copied ${info.length} collections and ${count} documents.`);
    }
    await records.updateOne({_id: environment, lease}, {$set: {state: 'ready', seededAt: new Date()},
      $unset: {leaseUntil: '', lease: ''}});
    console.log('Preview data is ready.');
  } catch (error) {
    if (records) await records.updateOne({_id: environment, lease}, {$set: {state: 'failed'},
      $unset: {leaseUntil: '', lease: ''}}).catch(() => {});
    throw error;
  } finally {
    await Promise.allSettled([...clients, admin].map(client => client.close()));
  }
}

if (process.argv[1]?.endsWith('/seed.mjs')) {
  seed().then(() => {
    if (process.env.SEED_SERVE === 'true') createServer((request, response) => {
      response.writeHead(200, {'content-type': 'text/plain'}); response.end('Ready\n');
    }).listen(Number(process.env.PORT || 3000), '0.0.0.0');
  }).catch(error => {
    // Driver errors can contain connection strings; never print them.
    console.error(`Preview seed failed (${error.codeName || error.name}). Inspect private server diagnostics.`);
    const frames = String(error.stack || '').split('\n').slice(1)
      .filter(line => /seed\.mjs:\d+:\d+\)?$/.test(line));
    if (frames.length) console.error(frames.join('\n'));
    process.exitCode = 1;
  });
}
