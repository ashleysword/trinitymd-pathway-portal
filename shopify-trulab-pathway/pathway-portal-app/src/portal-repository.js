import { createHash, randomUUID } from 'node:crypto';
import { PortalStorageError } from './shopify-storage.js';

// Each collection maps to one app-owned metaobject type. Records keep their
// business payload in a JSON field plus three filterable index fields.
export const PORTAL_COLLECTIONS = {
  applications: '$app:portal_application',
  kits: '$app:portal_kit',
  kitEvents: '$app:portal_kit_event',
  documents: '$app:portal_document',
  threads: '$app:portal_thread',
  messages: '$app:portal_message',
  audit: '$app:portal_audit',
};

// Shopify accepts the `$app:` alias in queries but returns the resolved type,
// e.g. `app--443624423425--portal_application`.
export function isPortalType(actual, collection) {
  const alias = PORTAL_COLLECTIONS[collection];
  const name = alias.slice('$app:'.length);
  return actual === alias || new RegExp(`^app--\\d+--${name}$`).test(String(actual));
}

export class DuplicateRecordError extends PortalStorageError {
  constructor() {
    super('That record already exists.', { statusCode: 409, code: 'DUPLICATE_RECORD' });
    this.name = 'DuplicateRecordError';
  }
}

export function recordHandle(prefix, ...parts) {
  const digest = createHash('sha256').update(parts.map(String).join('\u0000')).digest('hex');
  return `${prefix}-${digest.slice(0, 48)}`;
}

function assertCollection(collection) {
  if (!PORTAL_COLLECTIONS[collection]) throw new Error(`Unknown portal collection: ${collection}`);
}

function matches(entry, filter) {
  if (filter.owner !== undefined && entry.index.owner !== String(filter.owner)) return false;
  if (filter.status !== undefined && entry.index.status !== filter.status) return false;
  if (filter.key !== undefined && entry.index.key !== String(filter.key)) return false;
  return true;
}

function cleanIndex(index = {}) {
  return {
    owner: String(index.owner ?? ''),
    status: String(index.status ?? ''),
    key: String(index.key ?? ''),
  };
}

// In-memory implementation for tests and the local development server only.
export class MemoryPortalRepository {
  constructor() {
    this.collections = new Map(Object.keys(PORTAL_COLLECTIONS).map((name) => [name, new Map()]));
    this.handles = new Map();
    this.sequence = 0;
  }

  async create(collection, record, { handle, index } = {}) {
    assertCollection(collection);
    const handleKey = `${collection}:${handle || randomUUID()}`;
    if (this.handles.has(handleKey)) throw new DuplicateRecordError();
    this.sequence += 1;
    const id = `gid://shopify/Metaobject/${900000 + this.sequence}`;
    const stored = structuredClone({ ...record, id });
    this.collections.get(collection).set(id, { record: stored, index: cleanIndex(index), handle: handleKey, sequence: this.sequence });
    this.handles.set(handleKey, id);
    return structuredClone(stored);
  }

  async get(collection, id) {
    assertCollection(collection);
    const entry = this.collections.get(collection).get(id);
    return entry ? structuredClone(entry.record) : null;
  }

  async getByHandle(collection, handle) {
    assertCollection(collection);
    const id = this.handles.get(`${collection}:${handle}`);
    return id ? this.get(collection, id) : null;
  }

  async list(collection, filter = {}) {
    assertCollection(collection);
    return [...this.collections.get(collection).values()]
      .filter((entry) => matches(entry, filter))
      .sort((left, right) => right.sequence - left.sequence)
      .slice(0, filter.limit || 1000)
      .map((entry) => structuredClone(entry.record));
  }

  async update(collection, id, record, { index } = {}) {
    assertCollection(collection);
    const entry = this.collections.get(collection).get(id);
    if (!entry) throw new PortalStorageError('Record not found.', { statusCode: 404, code: 'NOT_FOUND' });
    entry.record = structuredClone({ ...record, id });
    if (index) entry.index = cleanIndex(index);
    return structuredClone(entry.record);
  }
}

const METAOBJECT_FIELDS = 'id handle fields { key value }';

const CREATE_MUTATION = `#graphql
  mutation PortalRecordCreate($input: MetaobjectCreateInput!) {
    metaobjectCreate(metaobject: $input) {
      metaobject { ${METAOBJECT_FIELDS} }
      userErrors { field message code }
    }
  }
`;

const UPDATE_MUTATION = `#graphql
  mutation PortalRecordUpdate($id: ID!, $input: MetaobjectUpdateInput!) {
    metaobjectUpdate(id: $id, metaobject: $input) {
      metaobject { ${METAOBJECT_FIELDS} }
      userErrors { field message code }
    }
  }
`;

const GET_QUERY = `#graphql
  query PortalRecord($id: ID!) {
    metaobject(id: $id) { type ${METAOBJECT_FIELDS} }
  }
`;

const BY_HANDLE_QUERY = `#graphql
  query PortalRecordByHandle($handle: MetaobjectHandleInput!) {
    metaobjectByHandle(handle: $handle) { ${METAOBJECT_FIELDS} }
  }
`;

const LIST_QUERY = `#graphql
  query PortalRecords($type: String!, $query: String, $first: Int!, $after: String) {
    metaobjects(type: $type, query: $query, first: $first, after: $after, sortKey: "id", reverse: true) {
      nodes { ${METAOBJECT_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

function searchValue(value) {
  return `"${String(value).replace(/["\\]/g, '')}"`;
}

function isTakenHandle(userErrors) {
  return userErrors.some((error) => /TAKEN|DUPLICATE/i.test(String(error.code || ''))
    || /already (?:exists|been taken)/i.test(String(error.message || '')));
}

// Shopify app-owned metaobject implementation. Index fields must be marked
// admin_filterable in shopify.app.toml for the list filters to work.
export class ShopifyPortalRepository {
  constructor({ client, pageSize = 100, maxPages = 20 }) {
    if (!client?.graphql) throw new Error('A Shopify Admin client is required.');
    this.client = client;
    this.pageSize = pageSize;
    this.maxPages = maxPages;
  }

  fields(record, index) {
    const clean = cleanIndex(index);
    return [
      { key: 'owner', value: clean.owner },
      { key: 'status', value: clean.status },
      { key: 'lookup_key', value: clean.key },
      { key: 'payload', value: JSON.stringify(record) },
    ];
  }

  decode(metaobject) {
    if (!metaobject) return null;
    const payload = (metaobject.fields || []).find((field) => field.key === 'payload')?.value;
    try {
      return { ...JSON.parse(payload || '{}'), id: metaobject.id };
    } catch {
      throw new PortalStorageError('A stored portal record is invalid.', { code: 'INVALID_RECORD' });
    }
  }

  checkErrors(userErrors, message) {
    if (!userErrors?.length) return;
    if (isTakenHandle(userErrors)) throw new DuplicateRecordError();
    throw new PortalStorageError(message, { code: 'METAOBJECT_WRITE_FAILED', userErrors });
  }

  async create(collection, record, { handle, index } = {}) {
    assertCollection(collection);
    const input = { type: PORTAL_COLLECTIONS[collection], fields: this.fields(record, index) };
    if (handle) input.handle = handle;
    const data = await this.client.graphql(CREATE_MUTATION, { input });
    this.checkErrors(data?.metaobjectCreate?.userErrors, 'Shopify could not save the portal record.');
    return this.decode(data?.metaobjectCreate?.metaobject);
  }

  async get(collection, id) {
    assertCollection(collection);
    if (!/^gid:\/\/shopify\/Metaobject\/\d+$/.test(String(id))) return null;
    const data = await this.client.graphql(GET_QUERY, { id });
    if (!data?.metaobject || !isPortalType(data.metaobject.type, collection)) return null;
    return this.decode(data.metaobject);
  }

  async getByHandle(collection, handle) {
    assertCollection(collection);
    const data = await this.client.graphql(BY_HANDLE_QUERY, {
      handle: { type: PORTAL_COLLECTIONS[collection], handle },
    });
    return this.decode(data?.metaobjectByHandle);
  }

  async list(collection, filter = {}) {
    assertCollection(collection);
    const terms = [];
    if (filter.owner !== undefined) terms.push(`fields.owner:${searchValue(filter.owner)}`);
    if (filter.status !== undefined) terms.push(`fields.status:${searchValue(filter.status)}`);
    if (filter.key !== undefined) terms.push(`fields.lookup_key:${searchValue(filter.key)}`);
    const limit = filter.limit || this.pageSize * this.maxPages;
    const records = [];
    let after = null;
    for (let page = 0; page < this.maxPages && records.length < limit; page += 1) {
      const data = await this.client.graphql(LIST_QUERY, {
        type: PORTAL_COLLECTIONS[collection],
        query: terms.join(' AND ') || null,
        first: Math.min(this.pageSize, limit - records.length),
        after,
      });
      const connection = data?.metaobjects;
      for (const node of connection?.nodes || []) records.push(this.decode(node));
      if (!connection?.pageInfo?.hasNextPage) break;
      after = connection.pageInfo.endCursor;
    }
    return records;
  }

  async update(collection, id, record, { index } = {}) {
    assertCollection(collection);
    const fields = this.fields(record, index).filter((field) => index || field.key === 'payload');
    const data = await this.client.graphql(UPDATE_MUTATION, { id, input: { fields } });
    this.checkErrors(data?.metaobjectUpdate?.userErrors, 'Shopify could not update the portal record.');
    return this.decode(data?.metaobjectUpdate?.metaobject);
  }
}
