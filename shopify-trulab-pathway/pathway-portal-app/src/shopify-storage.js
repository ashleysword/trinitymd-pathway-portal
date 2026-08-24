import { createHash } from 'node:crypto';
import { decryptField, encryptField } from './security.js';

export const ASSIGNMENT_METAOBJECT_TYPE = '$app:pathway_assignment';
export const ASSIGNMENT_METAFIELD_KEY = 'pathway_assignments';
export const MAX_ASSIGNMENTS_PER_CLINIC = 1024;

const ASSIGNMENT_FIELDS = `
  id
  handle
  type
  createdAt
  updatedAt
  fields { key value }
`;

const LIST_ASSIGNMENTS_QUERY = `#graphql
  query PortalAssignments($customerId: ID!, $first: Int!, $after: String) {
    customer(id: $customerId) {
      id
      assignmentRefs: metafield(namespace: "$app", key: "${ASSIGNMENT_METAFIELD_KEY}") {
        id
        value
        compareDigest
        references(first: $first, after: $after) {
          nodes {
            ... on Metaobject {
              ${ASSIGNMENT_FIELDS}
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

const CREATE_ASSIGNMENT_MUTATION = `#graphql
  mutation CreatePortalAssignment($input: MetaobjectCreateInput!) {
    metaobjectCreate(metaobject: $input) {
      metaobject { ${ASSIGNMENT_FIELDS} }
      userErrors { field message code }
    }
  }
`;

const SET_ASSIGNMENT_REFS_MUTATION = `#graphql
  mutation SetPortalAssignmentRefs($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id value compareDigest }
      userErrors { field message code }
    }
  }
`;

const DELETE_ASSIGNMENT_MUTATION = `#graphql
  mutation DeletePortalAssignment($id: ID!) {
    metaobjectDelete(id: $id) {
      deletedId
      userErrors { field message code }
    }
  }
`;

export class PortalStorageError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'PortalStorageError';
    this.statusCode = options.statusCode || 500;
    this.code = options.code;
    this.userErrors = options.userErrors;
  }
}

export class DuplicateKitAssignmentError extends PortalStorageError {
  constructor() {
    super('One of those PATHWAY kit IDs has already been assigned.', {
      statusCode: 409,
      code: 'DUPLICATE_KIT_ID',
    });
    this.name = 'DuplicateKitAssignmentError';
  }
}

function customerGid(customerId) {
  return `gid://shopify/Customer/${customerId}`;
}

export function assignmentHandle(kitId) {
  const digest = createHash('sha256').update(String(kitId).trim().toUpperCase()).digest('hex');
  return `pathway-${digest.slice(0, 48)}`;
}

function fieldMap(metaobject) {
  return new Map((metaobject?.fields || []).map((field) => [field.key, field.value]));
}

function parseReferenceIds(value) {
  if (!value) return [];
  try {
    const ids = JSON.parse(value);
    if (!Array.isArray(ids) || ids.some((id) => !/^gid:\/\/shopify\/Metaobject\/\d+$/.test(id))) {
      throw new Error('Invalid reference list.');
    }
    return [...new Set(ids)];
  } catch {
    throw new PortalStorageError('The clinic assignment index is invalid.', {
      code: 'INVALID_ASSIGNMENT_INDEX',
    });
  }
}

function isDigestConflict(userErrors) {
  return (userErrors || []).some((error) =>
    /COMPARE_DIGEST|STALE|MISMATCH/i.test(String(error.code || ''))
      || /compare digest|changed since|stale/i.test(String(error.message || '')),
  );
}

function isDuplicateHandle(userErrors) {
  return (userErrors || []).some((error) =>
    /TAKEN|DUPLICATE/i.test(String(error.code || ''))
      || /already (?:exists|been taken)|must be unique/i.test(String(error.message || ''))
      || (Array.isArray(error.field)
        && error.field.some((part) => String(part).toLowerCase() === 'handle')),
  );
}

export class ShopifyAssignmentStore {
  constructor(options) {
    this.client = options.client;
    this.encryptionKey = options.encryptionKey;
    this.now = options.now || (() => new Date());
    this.pageSize = options.pageSize || 250;
    if (!this.client?.graphql) throw new Error('A Shopify Admin client is required.');
    if (!this.encryptionKey) throw new Error('An encryption key is required.');
  }

  toPublicAssignment(metaobject, expectedCustomerId) {
    const fields = fieldMap(metaobject);
    const storedCustomerId = fields.get('clinic_customer_id');
    if (!storedCustomerId || storedCustomerId !== String(expectedCustomerId)) {
      throw new PortalStorageError('A stored assignment is not owned by this clinic.', {
        code: 'ASSIGNMENT_OWNERSHIP_MISMATCH',
      });
    }
    try {
      return {
        id: metaobject.id,
        kitId: fields.get('kit_id'),
        clientEmail: decryptField(fields.get('client_email_encrypted'), this.encryptionKey),
        clientName: decryptField(fields.get('client_name_encrypted'), this.encryptionKey),
        status: fields.get('status') || 'assigned',
        providerReviewStatus: fields.get('provider_review_status') || 'not_started',
        createdAt: fields.get('assigned_at') || metaobject.createdAt,
        updatedAt: fields.get('updated_at') || metaobject.updatedAt,
      };
    } catch (error) {
      if (error instanceof PortalStorageError) throw error;
      throw new PortalStorageError('A stored assignment could not be decrypted.', {
        code: 'ASSIGNMENT_DECRYPTION_FAILED',
      });
    }
  }

  async assignmentSnapshot(customerId) {
    const nodesById = new Map();
    let after = null;
    let referenceIds = [];
    let compareDigest = null;
    let metafieldId = null;

    do {
      const data = await this.client.graphql(LIST_ASSIGNMENTS_QUERY, {
        customerId: customerGid(customerId),
        first: this.pageSize,
        after,
      });
      if (!data?.customer) {
        throw new PortalStorageError('The Shopify clinic customer could not be found.', {
          statusCode: 404,
          code: 'CUSTOMER_NOT_FOUND',
        });
      }

      const metafield = data.customer.assignmentRefs;
      if (!metafield) {
        return { referenceIds: [], nodes: [], compareDigest: null, metafieldId: null };
      }
      metafieldId = metafield.id;
      compareDigest = metafield.compareDigest ?? null;
      referenceIds = parseReferenceIds(metafield.value);
      const connection = metafield.references;
      for (const node of connection?.nodes || []) {
        if (node?.id) nodesById.set(node.id, node);
      }
      after = connection?.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
      if (after && nodesById.size >= MAX_ASSIGNMENTS_PER_CLINIC) after = null;
    } while (after);

    return {
      referenceIds,
      nodes: [...nodesById.values()],
      compareDigest,
      metafieldId,
    };
  }

  async listAssignments(context) {
    const snapshot = await this.assignmentSnapshot(context.customerId);
    return snapshot.nodes
      .map((node) => this.toPublicAssignment(node, context.customerId))
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  }

  buildMetaobjectInput(customerId, assignment) {
    const timestamp = this.now().toISOString();
    return {
      type: ASSIGNMENT_METAOBJECT_TYPE,
      handle: assignmentHandle(assignment.kitId),
      fields: [
        { key: 'kit_id', value: assignment.kitId },
        { key: 'clinic_customer_id', value: String(customerId) },
        { key: 'client_email_encrypted', value: encryptField(assignment.clientEmail, this.encryptionKey) },
        { key: 'client_name_encrypted', value: encryptField(assignment.clientName, this.encryptionKey) },
        { key: 'status', value: 'assigned' },
        { key: 'provider_review_status', value: 'not_started' },
        { key: 'assigned_at', value: timestamp },
        { key: 'updated_at', value: timestamp },
      ],
    };
  }

  async createMetaobject(customerId, assignment) {
    const data = await this.client.graphql(CREATE_ASSIGNMENT_MUTATION, {
      input: this.buildMetaobjectInput(customerId, assignment),
    });
    const payload = data?.metaobjectCreate;
    const userErrors = payload?.userErrors || [];
    if (userErrors.length) {
      if (isDuplicateHandle(userErrors)) throw new DuplicateKitAssignmentError();
      throw new PortalStorageError('Shopify could not create the kit assignment.', {
        code: 'METAOBJECT_CREATE_FAILED',
        userErrors,
      });
    }
    if (!payload?.metaobject?.id) {
      throw new PortalStorageError('Shopify did not return the created kit assignment.', {
        code: 'METAOBJECT_CREATE_EMPTY',
      });
    }
    return payload.metaobject;
  }

  async deleteMetaobject(id) {
    const data = await this.client.graphql(DELETE_ASSIGNMENT_MUTATION, { id });
    const userErrors = data?.metaobjectDelete?.userErrors || [];
    if (userErrors.length) {
      throw new PortalStorageError('Shopify could not roll back a kit assignment.', {
        code: 'METAOBJECT_DELETE_FAILED',
        userErrors,
      });
    }
  }

  async rollbackMetaobjects(metaobjects) {
    for (const metaobject of [...metaobjects].reverse()) {
      try {
        await this.deleteMetaobject(metaobject.id);
      } catch (error) {
        console.error('PATHWAY assignment rollback failed.', error);
      }
    }
  }

  async attachReferences(customerId, createdIds, initialSnapshot) {
    let snapshot = initialSnapshot;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const referenceIds = [...new Set([...snapshot.referenceIds, ...createdIds])];
      if (referenceIds.length > MAX_ASSIGNMENTS_PER_CLINIC) {
        throw new PortalStorageError(
          `This clinic has reached Shopify's ${MAX_ASSIGNMENTS_PER_CLINIC}-assignment active-reference limit.`,
          { statusCode: 422, code: 'ASSIGNMENT_LIMIT_REACHED' },
        );
      }

      const data = await this.client.graphql(SET_ASSIGNMENT_REFS_MUTATION, {
        metafields: [{
          ownerId: customerGid(customerId),
          namespace: '$app',
          key: ASSIGNMENT_METAFIELD_KEY,
          type: 'list.metaobject_reference',
          value: JSON.stringify(referenceIds),
          compareDigest: snapshot.compareDigest,
        }],
      });
      const userErrors = data?.metafieldsSet?.userErrors || [];
      if (!userErrors.length) return;
      if (!isDigestConflict(userErrors) || attempt === 2) {
        throw new PortalStorageError('Shopify could not update the clinic assignment index.', {
          code: 'ASSIGNMENT_INDEX_UPDATE_FAILED',
          userErrors,
        });
      }

      snapshot = await this.assignmentSnapshot(customerId);
      if (createdIds.every((id) => snapshot.referenceIds.includes(id))) return;
    }
  }

  async createAssignments(context, assignments) {
    const snapshot = await this.assignmentSnapshot(context.customerId);
    const requestedKitIds = new Set(assignments.map((assignment) => assignment.kitId));
    const existingKitIds = new Set(snapshot.nodes.map((node) => fieldMap(node).get('kit_id')));
    if ([...requestedKitIds].some((kitId) => existingKitIds.has(kitId))) {
      throw new DuplicateKitAssignmentError();
    }
    if (snapshot.referenceIds.length + assignments.length > MAX_ASSIGNMENTS_PER_CLINIC) {
      throw new PortalStorageError(
        `This clinic has reached Shopify's ${MAX_ASSIGNMENTS_PER_CLINIC}-assignment active-reference limit.`,
        { statusCode: 422, code: 'ASSIGNMENT_LIMIT_REACHED' },
      );
    }

    const created = [];
    try {
      for (const assignment of assignments) {
        created.push(await this.createMetaobject(context.customerId, assignment));
      }
    } catch (error) {
      await this.rollbackMetaobjects(created);
      throw error;
    }

    try {
      await this.attachReferences(context.customerId, created.map((metaobject) => metaobject.id), snapshot);
    } catch (error) {
      await this.rollbackMetaobjects(created);
      throw error;
    }

    return created.map((metaobject) => this.toPublicAssignment(metaobject, context.customerId));
  }
}
