import { timingSafeEqual } from 'node:crypto';
import { jsonResponse, readJson } from './app.js';
import { isValidNpi } from './clinic-validation.js';
import { AssignmentValidationError } from './validation.js';

// GoHighLevel clinic sign-up. A GHL workflow ("Form submitted" trigger +
// "Custom Webhook" action) POSTs the form fields here with a shared secret
// header. The clinic is tagged immediately, which is what grants wholesale
// pricing at checkout and clinic-hub access.
export const GHL_SIGNUP_PATH = '/webhooks/ghl/clinic-signup';
export const GHL_SECRET_HEADER = 'x-trinity-webhook-secret';

const EMAIL_PATTERN = /^[^\s@"\\]+@[^\s@"\\]+\.[^\s@"\\]+$/;

export class GhlSignupError extends Error {
  constructor(message, statusCode = 422, code = 'INVALID_SIGNUP') {
    super(message);
    this.name = 'GhlSignupError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function secretMatches(provided, expected) {
  const left = Buffer.from(String(provided || ''));
  const right = Buffer.from(String(expected || ''));
  return right.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

function pick(payload, ...keys) {
  for (const key of keys) {
    const value = key.split('.').reduce((node, part) => (node == null ? undefined : node[part]), payload);
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return '';
}

function clip(value, max) {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

// Accepts the JSON body we document for the Custom Webhook action, and falls
// back to GHL's default workflow payload keys (first_name, customData, ...).
export function normalizeGhlSignup(payload = {}, { requireValidNpi = true } = {}) {
  const email = pick(payload, 'email', 'contact.email').toLowerCase();
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) throw new GhlSignupError('A valid email is required.');

  const firstName = clip(pick(payload, 'firstName', 'first_name', 'contact.first_name'), 60);
  const lastName = clip(pick(payload, 'lastName', 'last_name', 'contact.last_name'), 60);
  if (!firstName || !lastName) throw new GhlSignupError('First and last name are required.');

  const npi = pick(payload, 'npi', 'npi_number', 'customData.npi').replace(/\D/g, '');
  if (npi && !isValidNpi(npi)) throw new GhlSignupError('The NPI number is not valid.');
  if (!npi && requireValidNpi) throw new GhlSignupError('An NPI number is required.');

  let phone = pick(payload, 'phone', 'contact.phone').replace(/[^\d+]/g, '');
  if (/^\d{10}$/.test(phone)) phone = `+1${phone}`;
  if (!/^\+\d{10,15}$/.test(phone)) phone = '';

  const contactId = pick(payload, 'contactId', 'contact_id', 'contact.id').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);

  return {
    email,
    firstName,
    lastName,
    phone,
    company: clip(pick(payload, 'company', 'company_name', 'contact.company_name'), 120),
    businessType: clip(pick(payload, 'businessType', 'business_type', 'customData.businessType'), 60),
    website: clip(pick(payload, 'website', 'contact.website'), 200),
    npi,
    contactId,
  };
}

const FIND_CUSTOMER = `query GhlFindCustomer($query: String!) {
  customers(first: 2, query: $query) { nodes { id email tags } }
}`;
const CREATE_CUSTOMER = `mutation GhlCreateCustomer($input: CustomerInput!) {
  customerCreate(input: $input) { customer { id tags } userErrors { field message } }
}`;
const TAG_CUSTOMER = `mutation GhlTagCustomer($id: ID!, $tags: [String!]!) {
  tagsAdd(id: $id, tags: $tags) { node { id } userErrors { field message } }
}`;

function numericId(gid) {
  return String(gid).split('/').pop();
}

export function createGhlSignupHandler({ config, shopify, service = null, logger = console, onClinicAccessChanged = () => {} }) {
  async function findCustomer(email) {
    const data = await shopify.graphql(FIND_CUSTOMER, { query: `email:"${email}"` });
    return (data?.customers?.nodes || []).find((node) => String(node.email || '').toLowerCase() === email) || null;
  }

  async function tagCustomer(id) {
    const data = await shopify.graphql(TAG_CUSTOMER, { id, tags: [config.clinicTag] });
    if (data?.tagsAdd?.userErrors?.length) {
      throw new GhlSignupError('Shopify could not tag the customer.', 502, 'TAG_FAILED');
    }
  }

  async function createCustomer(signup) {
    const input = {
      email: signup.email,
      firstName: signup.firstName,
      lastName: signup.lastName,
      tags: [config.clinicTag],
      ...(signup.phone ? { phone: signup.phone } : {}),
    };
    let data = await shopify.graphql(CREATE_CUSTOMER, { input });
    let errors = data?.customerCreate?.userErrors || [];
    // A phone already used by another customer (or rejected by Shopify) should not block the signup.
    if (errors.some((error) => (error.field || []).includes('phone')) && input.phone) {
      delete input.phone;
      data = await shopify.graphql(CREATE_CUSTOMER, { input });
      errors = data?.customerCreate?.userErrors || [];
    }
    if (errors.length) return null;
    return data.customerCreate.customer;
  }

  async function upsertClinic(signup) {
    let customer = await findCustomer(signup.email);
    if (!customer) {
      const created = await createCustomer(signup);
      if (created) return { customerId: numericId(created.id), created: true, alreadyClinic: false };
      // Lost a race with a concurrent submission for the same email: tag the winner.
      customer = await findCustomer(signup.email);
      if (!customer) throw new GhlSignupError('Shopify could not create the customer.', 502, 'CREATE_FAILED');
    }
    const alreadyClinic = (customer.tags || []).some((tag) => tag.toLowerCase() === config.clinicTag);
    if (!alreadyClinic) await tagCustomer(customer.id);
    return { customerId: numericId(customer.id), created: false, alreadyClinic };
  }

  return {
    handles(pathname) {
      return pathname === GHL_SIGNUP_PATH;
    },

    async handle(request) {
      if (!config.ghlSignupEnabled) return jsonResponse(404, { error: 'Not found.' });
      if (request.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' });
      if (!secretMatches(request.headers.get(GHL_SECRET_HEADER), config.ghlWebhookSecret)) {
        return jsonResponse(401, { error: 'Unauthorized.' });
      }
      try {
        const signup = normalizeGhlSignup(await readJson(request, 32768), { requireValidNpi: config.ghlRequireNpi });
        const result = await upsertClinic(signup);
        onClinicAccessChanged(result.customerId);
        if (service) await service.recordExternalSignup(result.customerId, signup, { source: 'ghl' });
        // IDs only: no names or emails in logs.
        logger.info?.('GHL clinic signup tagged.', { customerId: result.customerId, created: result.created });
        return jsonResponse(200, { ok: true, ...result });
      } catch (error) {
        if (error instanceof AssignmentValidationError) {
          return jsonResponse(400, { error: error.message, code: 'BAD_REQUEST' });
        }
        if (error.statusCode && error.statusCode < 500) {
          return jsonResponse(error.statusCode, { error: error.message, code: error.code || 'INVALID_SIGNUP' });
        }
        logger.error?.('GHL clinic signup failed.', { code: error.code || error.name });
        return jsonResponse(502, { error: 'The signup could not be completed. GHL will retry.', code: error.code || 'SIGNUP_FAILED' });
      }
    },
  };
}
