import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  DuplicateKitAssignmentError,
  ShopifyAssignmentStore,
  assignmentHandle,
} from '../src/shopify-storage.js';

function metaobjectFromInput(id, input, createdAt = '2026-08-24T12:00:00.000Z') {
  return {
    id,
    handle: input.handle,
    type: input.type,
    createdAt,
    updatedAt: createdAt,
    fields: input.fields,
  };
}

function emptySnapshot() {
  return {
    customer: {
      id: 'gid://shopify/Customer/12345',
      assignmentRefs: null,
    },
  };
}

test('uses a stable, non-identifying handle for each normalized kit ID', () => {
  assert.equal(assignmentHandle('kit-0001'), assignmentHandle(' KIT-0001 '));
  assert.match(assignmentHandle('KIT-0001'), /^pathway-[a-f0-9]{48}$/);
  assert.doesNotMatch(assignmentHandle('KIT-0001'), /kit/i);
});

test('creates encrypted Shopify metaobjects and attaches them to the clinic customer', async () => {
  const calls = [];
  let nextId = 101;
  const client = {
    async graphql(query, variables) {
      calls.push({ query, variables });
      if (query.includes('query PortalAssignments')) return emptySnapshot();
      if (query.includes('mutation CreatePortalAssignment')) {
        return {
          metaobjectCreate: {
            metaobject: metaobjectFromInput(`gid://shopify/Metaobject/${nextId++}`, variables.input),
            userErrors: [],
          },
        };
      }
      if (query.includes('mutation SetPortalAssignmentRefs')) {
        return {
          metafieldsSet: {
            metafields: [{ id: 'gid://shopify/Metafield/1', value: variables.metafields[0].value }],
            userErrors: [],
          },
        };
      }
      throw new Error('Unexpected query.');
    },
  };
  const store = new ShopifyAssignmentStore({
    client,
    encryptionKey: randomBytes(32),
    now: () => new Date('2026-08-24T12:00:00.000Z'),
  });
  const created = await store.createAssignments(
    { customerId: '12345' },
    [
      { kitId: 'KIT-0001', clientEmail: 'one@example.com', clientName: 'J. Smith' },
      { kitId: 'KIT-0002', clientEmail: 'two@example.com', clientName: 'A. Jones' },
    ],
  );

  assert.deepEqual(created.map(({ kitId }) => kitId), ['KIT-0001', 'KIT-0002']);
  assert.equal(created[0].clientEmail, 'one@example.com');
  const createInput = calls.find(({ query }) => query.includes('mutation CreatePortalAssignment')).variables.input;
  const emailField = createInput.fields.find(({ key }) => key === 'client_email_encrypted');
  assert.notEqual(emailField.value, 'one@example.com');
  const setCall = calls.find(({ query }) => query.includes('mutation SetPortalAssignmentRefs'));
  assert.deepEqual(JSON.parse(setCall.variables.metafields[0].value), [
    'gid://shopify/Metaobject/101',
    'gid://shopify/Metaobject/102',
  ]);
  assert.equal(setCall.variables.metafields[0].ownerId, 'gid://shopify/Customer/12345');
  assert.equal(setCall.variables.metafields[0].compareDigest, null);
});

test('rolls back already-created metaobjects when the clinic reference update fails', async () => {
  const deleted = [];
  const client = {
    async graphql(query, variables) {
      if (query.includes('query PortalAssignments')) return emptySnapshot();
      if (query.includes('mutation CreatePortalAssignment')) {
        return {
          metaobjectCreate: {
            metaobject: metaobjectFromInput('gid://shopify/Metaobject/201', variables.input),
            userErrors: [],
          },
        };
      }
      if (query.includes('mutation SetPortalAssignmentRefs')) {
        return { metafieldsSet: { metafields: [], userErrors: [{ code: 'INVALID', message: 'No.' }] } };
      }
      if (query.includes('mutation DeletePortalAssignment')) {
        deleted.push(variables.id);
        return { metaobjectDelete: { deletedId: variables.id, userErrors: [] } };
      }
      throw new Error('Unexpected query.');
    },
  };
  const store = new ShopifyAssignmentStore({ client, encryptionKey: randomBytes(32) });

  await assert.rejects(
    store.createAssignments(
      { customerId: '12345' },
      [{ kitId: 'KIT-0003', clientEmail: 'three@example.com', clientName: 'R. Reed' }],
    ),
    /assignment index/,
  );
  assert.deepEqual(deleted, ['gid://shopify/Metaobject/201']);
});

test('retries a stale clinic reference update without losing a concurrent assignment', async () => {
  let snapshotCalls = 0;
  let setCalls = 0;
  const concurrentId = 'gid://shopify/Metaobject/401';
  const createdId = 'gid://shopify/Metaobject/402';
  const client = {
    async graphql(query, variables) {
      if (query.includes('query PortalAssignments')) {
        snapshotCalls += 1;
        if (snapshotCalls === 1) return emptySnapshot();
        return {
          customer: {
            id: 'gid://shopify/Customer/12345',
            assignmentRefs: {
              id: 'gid://shopify/Metafield/41',
              value: JSON.stringify([concurrentId]),
              compareDigest: 'new-digest',
              references: {
                nodes: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        };
      }
      if (query.includes('mutation CreatePortalAssignment')) {
        return {
          metaobjectCreate: {
            metaobject: metaobjectFromInput(createdId, variables.input),
            userErrors: [],
          },
        };
      }
      if (query.includes('mutation SetPortalAssignmentRefs')) {
        setCalls += 1;
        if (setCalls === 1) {
          return {
            metafieldsSet: {
              metafields: [],
              userErrors: [{ code: 'COMPARE_DIGEST_MISMATCH', message: 'The value changed since it was read.' }],
            },
          };
        }
        assert.equal(variables.metafields[0].compareDigest, 'new-digest');
        assert.deepEqual(JSON.parse(variables.metafields[0].value), [concurrentId, createdId]);
        return { metafieldsSet: { metafields: [], userErrors: [] } };
      }
      throw new Error('Unexpected query.');
    },
  };
  const store = new ShopifyAssignmentStore({ client, encryptionKey: randomBytes(32) });
  const created = await store.createAssignments(
    { customerId: '12345' },
    [{ kitId: 'KIT-0042', clientEmail: 'forty-two@example.com', clientName: 'F. Ford' }],
  );
  assert.equal(created[0].kitId, 'KIT-0042');
  assert.equal(setCalls, 2);
});

test('maps a taken deterministic handle to a duplicate-kit response', async () => {
  const client = {
    async graphql(query) {
      if (query.includes('query PortalAssignments')) return emptySnapshot();
      if (query.includes('mutation CreatePortalAssignment')) {
        return {
          metaobjectCreate: {
            metaobject: null,
            userErrors: [{ field: ['metaobject', 'handle'], message: 'Handle has already been taken', code: 'TAKEN' }],
          },
        };
      }
      throw new Error('Unexpected query.');
    },
  };
  const store = new ShopifyAssignmentStore({ client, encryptionKey: randomBytes(32) });
  await assert.rejects(
    store.createAssignments(
      { customerId: '12345' },
      [{ kitId: 'KIT-0004', clientEmail: 'four@example.com', clientName: 'S. Stone' }],
    ),
    DuplicateKitAssignmentError,
  );
});

test('refuses to disclose a referenced assignment owned by a different clinic', async () => {
  const key = randomBytes(32);
  const seedStore = new ShopifyAssignmentStore({ client: { graphql() {} }, encryptionKey: key });
  const input = seedStore.buildMetaobjectInput('99999', {
    kitId: 'KIT-0005',
    clientEmail: 'five@example.com',
    clientName: 'T. Taylor',
  });
  const node = metaobjectFromInput('gid://shopify/Metaobject/301', input);
  const client = {
    async graphql() {
      return {
        customer: {
          id: 'gid://shopify/Customer/12345',
          assignmentRefs: {
            id: 'gid://shopify/Metafield/9',
            value: '["gid://shopify/Metaobject/301"]',
            compareDigest: 'digest',
            references: {
              nodes: [node],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      };
    },
  };
  const store = new ShopifyAssignmentStore({ client, encryptionKey: key });
  await assert.rejects(store.listAssignments({ customerId: '12345' }), /not owned by this clinic/);
});
