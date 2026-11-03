import test from 'node:test';
import assert from 'node:assert/strict';
import { DuplicateRecordError, MemoryPortalRepository, ShopifyPortalRepository } from '../src/portal-repository.js';

test('memory repository enforces handles and filters by index fields', async () => {
  const repo = new MemoryPortalRepository();
  const first = await repo.create('kits', { kitId: 'A' }, { handle: 'kit-a', index: { owner: '1', status: 'registered', key: 'A' } });
  await repo.create('kits', { kitId: 'B' }, { handle: 'kit-b', index: { owner: '2', status: 'registered', key: 'B' } });
  await assert.rejects(repo.create('kits', { kitId: 'A' }, { handle: 'kit-a' }), DuplicateRecordError);
  assert.deepEqual((await repo.list('kits', { owner: '1' })).map((kit) => kit.kitId), ['A']);
  assert.equal((await repo.getByHandle('kits', 'kit-b')).kitId, 'B');
  await repo.update('kits', first.id, { kitId: 'A', status: 'x' }, { index: { owner: '3', status: 'x', key: 'A' } });
  assert.equal((await repo.list('kits', { owner: '3' })).length, 1);
});

test('Shopify repository writes app-owned metaobjects with filterable index fields', async () => {
  const calls = [];
  const client = {
    async graphql(query, variables) {
      calls.push({ query, variables });
      if (query.includes('PortalRecordCreate')) {
        return { metaobjectCreate: { metaobject: { id: 'gid://shopify/Metaobject/5', fields: variables.input.fields }, userErrors: [] } };
      }
      if (query.includes('PortalRecords')) {
        return { metaobjects: { nodes: [{ id: 'gid://shopify/Metaobject/5', fields: [{ key: 'payload', value: '{"kitId":"A"}' }] }], pageInfo: { hasNextPage: false } } };
      }
      if (query.includes('PortalRecord(')) return { metaobject: { type: '$app:portal_thread', id: variables.id, fields: [] } };
      throw new Error('unexpected');
    },
  };
  const repo = new ShopifyPortalRepository({ client });
  const created = await repo.create('kits', { kitId: 'A' }, { handle: 'kit-x', index: { owner: '1', status: 'registered', key: 'A' } });
  assert.equal(created.kitId, 'A');
  assert.equal(calls[0].variables.input.type, '$app:portal_kit');
  assert.equal(calls[0].variables.input.handle, 'kit-x');
  assert.deepEqual(calls[0].variables.input.fields.map((field) => field.key), ['owner', 'status', 'lookup_key', 'payload']);

  await repo.list('kits', { owner: '1', status: 'registered' });
  assert.equal(calls[1].variables.query, 'fields.owner:"1" AND fields.status:"registered"');

  assert.equal(await repo.get('kits', 'gid://shopify/Metaobject/9'), null, 'records of another type are not returned');
  assert.equal(await repo.get('kits', 'not-a-gid'), null);
});

test('Shopify repository maps a taken handle to a duplicate error', async () => {
  const repo = new ShopifyPortalRepository({
    client: { graphql: async () => ({ metaobjectCreate: { metaobject: null, userErrors: [{ code: 'TAKEN', message: 'Handle has already been taken' }] } }) },
  });
  await assert.rejects(repo.create('kits', {}, { handle: 'kit-a' }), DuplicateRecordError);
});
