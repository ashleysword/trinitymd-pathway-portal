import { createHmac, randomUUID } from 'node:crypto';
import {
  decodeDocumentFile,
  normalizeApplication,
  normalizeDocumentInput,
  normalizeKitIdWithPattern,
  normalizeKitReference,
  normalizeMessage,
  normalizeNewThread,
  normalizeStaffNote,
} from './clinic-validation.js';
import { DuplicateRecordError, recordHandle } from './portal-repository.js';
import { decryptField, encryptField } from './security.js';
import { AssignmentValidationError, normalizeKitId } from './validation.js';

export class PortalRequestError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = 'PortalRequestError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const KIT_STATUSES = ['registered', 'kit_received', 'processing', 'report_ready', 'complete', 'cancelled'];

// Staff-only status transitions. Pending owner confirmation of the real lab
// workflow; clinics can register kits but never change their status.
export const KIT_TRANSITIONS = {
  registered: ['kit_received', 'cancelled'],
  kit_received: ['processing', 'cancelled'],
  processing: ['report_ready', 'cancelled'],
  report_ready: ['complete'],
  complete: [],
  cancelled: ['registered'],
};

const MESSAGE_RATE_LIMIT_PER_HOUR = 20;

function notFound(what = 'Record') {
  return new PortalRequestError(`${what} not found.`, 404, 'NOT_FOUND');
}

function maskTail(value, visible = 4) {
  const text = String(value || '');
  return text ? `•••${text.slice(-visible)}` : '';
}

function csvCell(value) {
  const text = String(value ?? '');
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export class ClinicPortalService {
  constructor(options) {
    const {
      repository, shopify, legacyStore, encryptionKey, notifier, fileStore, config,
      now = () => new Date(), onClinicAccessChanged = () => {},
    } = options;
    if (!repository || !shopify?.graphql || !encryptionKey || !notifier || !fileStore || !config) {
      throw new Error('ClinicPortalService is missing a required dependency.');
    }
    this.repo = repository;
    this.shopify = shopify;
    this.legacyStore = legacyStore || null;
    this.encryptionKey = encryptionKey;
    this.notifier = notifier;
    this.fileStore = fileStore;
    this.config = config;
    this.now = now;
    this.onClinicAccessChanged = onClinicAccessChanged;
  }

  timestamp() {
    return this.now().toISOString();
  }

  fingerprint(kind, value) {
    return createHmac('sha256', this.encryptionKey).update(`${kind}:${value}`).digest('hex').slice(0, 32);
  }

  async audit(actor, action, target, details = {}) {
    await this.repo.create('audit', { at: this.timestamp(), actor, action, target, details }, {
      index: { owner: details.clinicCustomerId || '', status: action, key: target },
    });
  }

  // ---------- Applications ----------

  publicApplication(application) {
    if (!application) return null;
    return {
      id: application.id,
      status: application.status,
      company: application.practice.company,
      businessType: application.practice.businessType,
      submittedAt: application.createdAt,
      decidedAt: application.decidedAt || null,
      decisionMessage: application.status === 'rejected' ? application.decisionMessage || '' : '',
    };
  }

  staffApplication(application, { includeSensitive = false, duplicates = [] } = {}) {
    const { practice } = application;
    const output = {
      id: application.id,
      customerId: application.customerId,
      status: application.status,
      practice: {
        firstName: practice.firstName,
        lastName: practice.lastName,
        contactEmail: practice.contactEmail,
        phone: practice.phone,
        company: practice.company,
        businessType: practice.businessType,
        website: practice.website,
        npi: practice.npi,
        npiMatchesContact: practice.npiMatchesContact,
        taxId: maskTail(practice.taxIdLast4),
        resellerPermit: practice.resellerPermitEncrypted ? maskTail(practice.resellerPermitLast4) : '',
      },
      notes: application.notes,
      history: application.history,
      tagStatus: application.tagStatus,
      createdAt: application.createdAt,
      updatedAt: application.updatedAt,
      decidedAt: application.decidedAt || null,
      decidedBy: application.decidedBy || null,
      duplicates,
    };
    if (includeSensitive) {
      output.practice.taxId = practice.taxIdEncrypted ? decryptField(practice.taxIdEncrypted, this.encryptionKey) : '';
      output.practice.resellerPermit = practice.resellerPermitEncrypted
        ? decryptField(practice.resellerPermitEncrypted, this.encryptionKey)
        : '';
    }
    return output;
  }

  async latestApplicationFor(customerId) {
    const [latest] = await this.repo.list('applications', { owner: customerId, limit: 1 });
    return latest || null;
  }

  async getMyApplication(customer) {
    return this.publicApplication(await this.latestApplicationFor(customer.id));
  }

  async submitApplication(customer, input) {
    const normalized = normalizeApplication(input);
    const handle = recordHandle('application', customer.id, normalized.requestId);
    const retried = await this.repo.getByHandle('applications', handle);
    if (retried) return { application: this.publicApplication(retried), created: false };

    if (this.isClinic(customer)) {
      throw new PortalRequestError('This account already has approved clinic access.', 409, 'ALREADY_APPROVED');
    }
    const existing = await this.latestApplicationFor(customer.id);
    if (existing && ['pending', 'approved'].includes(existing.status)) {
      throw new PortalRequestError('An application for this account is already on file. Our team will contact you about its status.', 409, 'APPLICATION_EXISTS');
    }

    const at = this.timestamp();
    const { requestId, taxId, resellerPermit, ...practice } = normalized;
    const record = {
      customerId: customer.id,
      status: 'pending',
      practice: {
        ...practice,
        taxIdEncrypted: encryptField(taxId, this.encryptionKey),
        taxIdLast4: taxId.slice(-4),
        resellerPermitEncrypted: resellerPermit ? encryptField(resellerPermit, this.encryptionKey) : '',
        resellerPermitLast4: resellerPermit.slice(-4),
      },
      npiFingerprint: this.fingerprint('npi', practice.npi),
      taxIdFingerprint: this.fingerprint('ein', taxId),
      notes: [],
      history: [{ at, actor: { type: 'clinic', id: customer.id }, action: 'submitted', to: 'pending' }],
      tagStatus: 'not_applied',
      createdAt: at,
      updatedAt: at,
    };

    let application;
    try {
      application = await this.repo.create('applications', record, {
        handle,
        index: { owner: customer.id, status: 'pending', key: record.npiFingerprint },
      });
    } catch (error) {
      if (error instanceof DuplicateRecordError) {
        return { application: this.publicApplication(await this.repo.getByHandle('applications', handle)), created: false };
      }
      throw error;
    }
    await this.audit({ type: 'clinic', id: customer.id }, 'application.submitted', application.id, { clinicCustomerId: customer.id });
    await this.notifier.notify('application.submitted', { audience: 'staff', recordId: application.id });

    if (this.config.approvalMode === 'auto') {
      application = await this.decideApplication({ type: 'system', id: 'auto-approval' }, application, 'approve', {
        note: 'Automatically approved under the current auto-approval policy.',
      });
    }
    return { application: this.publicApplication(application), created: true };
  }

  // Flags other applications sharing an NPI or Tax ID (compared by keyed
  // fingerprint, so encrypted identifiers never need bulk decryption).
  // A clinic approved outside the portal (GHL form). The tag is already on the
  // customer; this only gives staff the same record and audit trail.
  async recordExternalSignup(customerId, signup, { source }) {
    const handle = recordHandle('application', customerId, `${source}-${signup.contactId || signup.email}`);
    if (await this.repo.getByHandle('applications', handle)) return null;
    const at = this.timestamp();
    const actor = { type: 'system', id: `${source}-signup` };
    const record = {
      customerId: String(customerId),
      status: 'approved',
      source,
      practice: {
        firstName: signup.firstName,
        lastName: signup.lastName,
        contactEmail: signup.email,
        phone: signup.phone,
        company: signup.company,
        businessType: signup.businessType,
        website: signup.website,
        npi: signup.npi,
        npiMatchesContact: false,
        taxIdEncrypted: '',
        taxIdLast4: '',
        resellerPermitEncrypted: '',
        resellerPermitLast4: '',
      },
      npiFingerprint: signup.npi ? this.fingerprint('npi', signup.npi) : '',
      taxIdFingerprint: '',
      notes: [],
      history: [
        { at, actor, action: 'submitted', to: 'approved' },
        { at, actor, action: 'tag_applied' },
      ],
      tagStatus: 'applied',
      createdAt: at,
      updatedAt: at,
      decidedAt: at,
      decidedBy: actor,
    };
    let application;
    try {
      application = await this.repo.create('applications', record, {
        handle,
        index: { owner: String(customerId), status: 'approved', key: record.npiFingerprint },
      });
    } catch (error) {
      if (error instanceof DuplicateRecordError) return null;
      throw error;
    }
    await this.audit(actor, 'application.approved', application.id, { clinicCustomerId: String(customerId), source });
    await this.notifier.notify('application.approved', { audience: 'staff', recordId: application.id, customerId: String(customerId) });
    return application;
  }

  findDuplicates(application, pool) {
    // A missing identifier (GHL sign-ups have no EIN, often no NPI) matches nothing.
    const same = (left, right) => Boolean(left) && left === right;
    return pool
      .filter((other) => other.id !== application.id
        && (same(other.npiFingerprint, application.npiFingerprint) || same(other.taxIdFingerprint, application.taxIdFingerprint)))
      .map((other) => ({
        id: other.id,
        company: other.practice.company,
        status: other.status,
        matches: [
          same(other.npiFingerprint, application.npiFingerprint) ? 'NPI' : null,
          same(other.taxIdFingerprint, application.taxIdFingerprint) ? 'Tax ID' : null,
        ].filter(Boolean),
      }));
  }

  async listApplications({ status } = {}) {
    const pool = await this.repo.list('applications');
    return pool
      .filter((application) => !status || application.status === status)
      .map((application) => this.staffApplication(application, { duplicates: this.findDuplicates(application, pool) }));
  }

  async getApplication(staff, id) {
    const application = await this.repo.get('applications', id);
    if (!application) throw notFound('Application');
    await this.audit({ type: 'staff', id: staff.staffId }, 'application.viewed_identifiers', id, { clinicCustomerId: application.customerId });
    const pool = await this.repo.list('applications');
    return this.staffApplication(application, { includeSensitive: true, duplicates: this.findDuplicates(application, pool) });
  }

  async addApplicationNote(staff, id, input) {
    const note = normalizeStaffNote(input?.note, { required: true });
    const application = await this.repo.get('applications', id);
    if (!application) throw notFound('Application');
    const at = this.timestamp();
    application.notes.push({ at, staffId: staff.staffId, text: note });
    application.history.push({ at, actor: { type: 'staff', id: staff.staffId }, action: 'note_added' });
    application.updatedAt = at;
    const saved = await this.repo.update('applications', id, application);
    await this.audit({ type: 'staff', id: staff.staffId }, 'application.note_added', id, { clinicCustomerId: application.customerId });
    return this.staffApplication(saved);
  }

  async reviewApplication(staff, id, input = {}) {
    const decision = input.decision;
    if (!['approve', 'reject'].includes(decision)) throw new AssignmentValidationError('Choose approve or reject.', 'decision');
    const application = await this.repo.get('applications', id);
    if (!application) throw notFound('Application');
    if (input.expectedUpdatedAt && input.expectedUpdatedAt !== application.updatedAt) {
      throw new PortalRequestError('This application changed since you opened it. Reload and review again.', 409, 'STALE_APPLICATION');
    }
    const saved = await this.decideApplication({ type: 'staff', id: staff.staffId }, application, decision, {
      note: normalizeStaffNote(input.note, { required: decision === 'reject' }),
      decisionMessage: normalizeStaffNote(input.decisionMessage),
    });
    return this.staffApplication(saved);
  }

  async decideApplication(actor, application, decision, { note = '', decisionMessage = '' } = {}) {
    if (application.status !== 'pending') {
      throw new PortalRequestError(`This application is already ${application.status}.`, 409, 'APPLICATION_DECIDED');
    }
    const at = this.timestamp();
    const to = decision === 'approve' ? 'approved' : 'rejected';
    application.status = to;
    application.decidedAt = at;
    application.decidedBy = actor;
    application.decisionMessage = decisionMessage;
    application.updatedAt = at;
    if (note) application.notes.push({ at, staffId: actor.id, text: note });
    application.history.push({ at, actor, action: decision === 'approve' ? 'approved' : 'rejected', from: 'pending', to });

    if (to === 'approved') {
      if (this.config.customerTaggingEnabled) {
        const data = await this.shopify.graphql(
          `mutation PortalApproveClinic($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { node { id } userErrors { field message } } }`,
          { id: `gid://shopify/Customer/${application.customerId}`, tags: [this.config.clinicTag] },
        );
        if (data?.tagsAdd?.userErrors?.length) {
          throw new PortalRequestError('Shopify could not apply the clinic access tag. The application was not approved.', 502, 'TAG_FAILED');
        }
        application.tagStatus = 'applied';
        this.onClinicAccessChanged(application.customerId);
      } else {
        application.tagStatus = 'manual_required';
      }
      application.history.push({ at, actor, action: `tag_${application.tagStatus}` });
    }

    const saved = await this.repo.update('applications', application.id, application, {
      index: { owner: application.customerId, status: to, key: application.npiFingerprint },
    });
    await this.audit(actor, `application.${to}`, application.id, { clinicCustomerId: application.customerId, tagStatus: application.tagStatus });
    await this.notifier.notify(`application.${to}`, { audience: 'applicant', recordId: application.id, customerId: application.customerId });
    return saved;
  }

  // ---------- Kits ----------

  isClinic(customer) {
    return (customer.tags || []).some((tag) => tag.toLowerCase() === this.config.clinicTag);
  }

  publicKit(kit) {
    return {
      id: kit.id,
      kitId: kit.kitId,
      status: kit.status,
      source: kit.source,
      registeredAt: kit.registeredAt,
      updatedAt: kit.updatedAt,
      clinicReference: kit.clinicReference || '',
      legacy: false,
    };
  }

  async setKitReference(customer, kitIdInput, input = {}) {
    const kit = await this.findKitByKitId(normalizeKitId(kitIdInput));
    if (!kit || kit.clinicCustomerId !== customer.id) throw notFound('Kit');
    const clinicReference = normalizeKitReference(input.clinicReference);
    if ((kit.clinicReference || '') === clinicReference) return { kit: this.publicKit(kit), changed: false };
    kit.clinicReference = clinicReference;
    const saved = await this.repo.update('kits', kit.id, kit, { index: { owner: kit.clinicCustomerId, status: kit.status, key: kit.kitId } });
    // The audit entry records that it changed, never the text itself.
    await this.audit({ type: 'clinic', id: customer.id }, 'kit.reference_updated', kit.kitId, { clinicCustomerId: customer.id });
    return { kit: this.publicKit(saved), changed: true };
  }

  async findKitByKitId(kitId) {
    return this.repo.getByHandle('kits', recordHandle('kit', kitId));
  }

  async isKitRegistered(kitId) {
    return Boolean(await this.findKitByKitId(normalizeKitId(kitId)));
  }

  async listClinicKits(customer) {
    const kits = (await this.repo.list('kits', { owner: customer.id })).map((kit) => this.publicKit(kit));
    let legacy = [];
    if (this.legacyStore) {
      const assignments = await this.legacyStore.listAssignments({ customerId: customer.id });
      legacy = assignments.map((assignment) => ({
        id: assignment.id,
        kitId: assignment.kitId,
        status: assignment.status,
        source: 'legacy_assignment',
        registeredAt: assignment.createdAt,
        updatedAt: assignment.updatedAt,
        legacy: true,
      }));
    }
    return [...kits, ...legacy].sort((left, right) => String(right.registeredAt).localeCompare(String(left.registeredAt)));
  }

  async registerKit(customer, input = {}) {
    const kitId = normalizeKitIdWithPattern(input.kitId, this.config.kitIdPattern);
    const source = input.source === 'scan' ? 'scan' : 'manual';

    const existing = await this.findKitByKitId(kitId);
    if (existing) {
      if (existing.clinicCustomerId === customer.id) return { kit: this.publicKit(existing), created: false };
      throw new PortalRequestError('This Kit ID is already registered. Contact TrinityMD clinic support if you believe this is a mistake.', 409, 'KIT_REGISTERED_ELSEWHERE');
    }
    if (this.legacyStore) {
      const legacy = await this.legacyStore.findLegacyKit(kitId);
      if (legacy) {
        if (legacy.clinicCustomerId === customer.id) {
          return { kit: { id: legacy.id, kitId, status: legacy.status, source: 'legacy_assignment', registeredAt: legacy.createdAt, updatedAt: legacy.createdAt, legacy: true }, created: false };
        }
        throw new PortalRequestError('This Kit ID is already registered. Contact TrinityMD clinic support if you believe this is a mistake.', 409, 'KIT_REGISTERED_ELSEWHERE');
      }
    }

    const at = this.timestamp();
    const record = {
      kitId,
      clinicCustomerId: customer.id,
      status: 'registered',
      source,
      registeredBy: { type: 'clinic', id: customer.id },
      registeredAt: at,
      updatedAt: at,
    };
    let kit;
    try {
      kit = await this.repo.create('kits', record, {
        handle: recordHandle('kit', kitId),
        index: { owner: customer.id, status: 'registered', key: kitId },
      });
    } catch (error) {
      if (!(error instanceof DuplicateRecordError)) throw error;
      const raced = await this.findKitByKitId(kitId);
      if (raced?.clinicCustomerId === customer.id) return { kit: this.publicKit(raced), created: false };
      throw new PortalRequestError('This Kit ID is already registered. Contact TrinityMD clinic support if you believe this is a mistake.', 409, 'KIT_REGISTERED_ELSEWHERE');
    }
    await this.addKitEvent(kit, { type: 'registered', to: 'registered', actor: record.registeredBy, note: source === 'scan' ? 'Registered by barcode scan.' : 'Registered by manual entry.' });
    await this.notifier.notify('kit.registered', { audience: 'staff', recordId: kit.id });
    return { kit: this.publicKit(kit), created: true };
  }

  async addKitEvent(kit, { type, from = null, to = null, actor, note = '' }) {
    return this.repo.create('kitEvents', { kitId: kit.kitId, kitRecordId: kit.id, type, from, to, actor, note, at: this.timestamp() }, {
      index: { owner: kit.clinicCustomerId, status: type, key: kit.kitId },
    });
  }

  async kitTimeline(kit, { forStaff = false } = {}) {
    const events = await this.repo.list('kitEvents', { key: kit.kitId });
    return events
      .filter((event) => forStaff || event.kitRecordId === kit.id)
      .sort((left, right) => String(left.at).localeCompare(String(right.at)))
      .map((event) => ({
        type: event.type,
        from: event.from,
        to: event.to,
        at: event.at,
        actor: forStaff ? event.actor : { type: event.actor.type },
        note: forStaff || event.actor.type !== 'staff' || event.type === 'status_changed' ? event.note : '',
      }));
  }

  async getClinicKit(customer, kitIdInput) {
    const kitId = normalizeKitId(kitIdInput);
    const kit = await this.findKitByKitId(kitId);
    if (!kit || kit.clinicCustomerId !== customer.id) throw notFound('Kit');
    return { kit: this.publicKit(kit), timeline: await this.kitTimeline(kit) };
  }

  async listAllKits({ status, clinicCustomerId, query } = {}) {
    const filter = {};
    if (status) filter.status = status;
    if (clinicCustomerId) filter.owner = String(clinicCustomerId);
    const search = String(query || '').trim().toUpperCase();
    return (await this.repo.list('kits', filter))
      .filter((kit) => !search || kit.kitId.includes(search))
      .map((kit) => ({ ...this.publicKit(kit), clinicCustomerId: kit.clinicCustomerId, registeredBy: kit.registeredBy }));
  }

  async getStaffKit(kitIdInput) {
    const kit = await this.findKitByKitId(normalizeKitId(kitIdInput));
    if (!kit) throw notFound('Kit');
    return { kit: { ...this.publicKit(kit), clinicCustomerId: kit.clinicCustomerId, registeredBy: kit.registeredBy }, timeline: await this.kitTimeline(kit, { forStaff: true }) };
  }

  async updateKitStatus(staff, kitIdInput, input = {}) {
    const kit = await this.findKitByKitId(normalizeKitId(kitIdInput));
    if (!kit) throw notFound('Kit');
    const to = String(input.status || '');
    if (!KIT_STATUSES.includes(to)) throw new AssignmentValidationError('Choose a valid kit status.', 'status');
    if (input.expectedStatus && input.expectedStatus !== kit.status) {
      throw new PortalRequestError('This kit changed since you opened it. Reload and try again.', 409, 'STALE_KIT');
    }
    if (kit.status === to) return { kit: this.publicKit(kit), changed: false };
    if (!KIT_TRANSITIONS[kit.status]?.includes(to)) {
      throw new PortalRequestError(`A kit cannot move from ${kit.status} to ${to}.`, 422, 'INVALID_TRANSITION');
    }
    const note = normalizeStaffNote(input.note, { required: to === 'cancelled' || kit.status === 'cancelled' });
    const from = kit.status;
    kit.status = to;
    kit.updatedAt = this.timestamp();
    const saved = await this.repo.update('kits', kit.id, kit, { index: { owner: kit.clinicCustomerId, status: to, key: kit.kitId } });
    await this.addKitEvent(saved, { type: 'status_changed', from, to, actor: { type: 'staff', id: staff.staffId }, note });
    await this.audit({ type: 'staff', id: staff.staffId }, 'kit.status_changed', kit.kitId, { clinicCustomerId: kit.clinicCustomerId, from, to });
    await this.notifier.notify('kit.status_changed', { audience: 'clinic', recordId: kit.id, customerId: kit.clinicCustomerId });
    return { kit: this.publicKit(saved), changed: true };
  }

  async reassignKit(staff, kitIdInput, input = {}) {
    const kit = await this.findKitByKitId(normalizeKitId(kitIdInput));
    if (!kit) throw notFound('Kit');
    const targetId = String(input.clinicCustomerId || '');
    if (!/^\d+$/.test(targetId)) throw new AssignmentValidationError('Enter the Shopify customer ID of the receiving clinic.', 'clinicCustomerId');
    if (targetId === kit.clinicCustomerId) throw new AssignmentValidationError('The kit already belongs to that clinic.', 'clinicCustomerId');
    const reason = normalizeStaffNote(input.reason, { required: true });
    const data = await this.shopify.graphql(
      `query PortalReassignTarget($id: ID!) { customer(id: $id) { id tags } }`,
      { id: `gid://shopify/Customer/${targetId}` },
    );
    if (!data?.customer || !this.isClinic(data.customer)) {
      throw new PortalRequestError('The receiving account is not an approved clinic.', 422, 'TARGET_NOT_CLINIC');
    }
    const from = kit.clinicCustomerId;
    kit.clinicCustomerId = targetId;
    kit.updatedAt = this.timestamp();
    const saved = await this.repo.update('kits', kit.id, kit, { index: { owner: targetId, status: kit.status, key: kit.kitId } });
    await this.addKitEvent(saved, { type: 'reassigned', actor: { type: 'staff', id: staff.staffId }, note: reason });
    await this.audit({ type: 'staff', id: staff.staffId }, 'kit.reassigned', kit.kitId, { clinicCustomerId: targetId, fromClinicCustomerId: from });
    return { kit: { ...this.publicKit(saved), clinicCustomerId: targetId } };
  }

  async exportKitsCsv(filter = {}) {
    const kits = await this.listAllKits(filter);
    // New columns go last so readers that use column positions keep working.
    const rows = [['kit_id', 'clinic_customer_id', 'status', 'source', 'registered_at', 'updated_at', 'clinic_reference']];
    for (const kit of kits) rows.push([kit.kitId, kit.clinicCustomerId, kit.status, kit.source, kit.registeredAt, kit.updatedAt, kit.clinicReference]);
    return `${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
  }

  // ---------- Documents ----------

  publicDocument(document) {
    return {
      id: document.id,
      title: document.title,
      description: document.description,
      category: document.category,
      version: document.version,
      publishedDate: document.publishedDate,
      audience: document.audience,
      contentType: document.file?.contentType || 'application/pdf',
      size: document.file?.size || null,
    };
  }

  async listDocuments({ isClinic }) {
    const published = await this.repo.list('documents', { status: 'published' });
    return published
      .filter((document) => document.audience === 'public' || (isClinic && document.audience === 'clinic'))
      .sort((left, right) => left.category.localeCompare(right.category) || left.title.localeCompare(right.title))
      .map((document) => this.publicDocument(document));
  }

  async openDocument({ isClinic, staff = false }, id) {
    const document = await this.repo.get('documents', id);
    if (!document) throw notFound('Document');
    if (!staff) {
      if (document.status !== 'published') throw notFound('Document');
      if (document.audience === 'clinic' && !isClinic) throw new PortalRequestError('Approved clinic access is required.', 403, 'CLINIC_REQUIRED');
    }
    const file = await this.fileStore.get(document.file.key);
    if (!file) throw notFound('Document file');
    return { bytes: file.bytes, contentType: document.file.contentType, filename: document.file.filename };
  }

  async listAllDocuments() {
    return (await this.repo.list('documents')).map((document) => ({
      ...this.publicDocument(document),
      status: document.status,
      filename: document.file?.filename,
      updatedAt: document.updatedAt,
      updatedBy: document.updatedBy,
    }));
  }

  async createDocument(staff, input = {}) {
    const fields = normalizeDocumentInput(input);
    const file = decodeDocumentFile(input.file);
    const key = `documents/${randomUUID()}`;
    await this.fileStore.put(key, file.bytes, { contentType: file.contentType, filename: file.filename });
    const at = this.timestamp();
    const status = fields.status || 'draft';
    const document = await this.repo.create('documents', {
      ...fields,
      status,
      file: { key, contentType: file.contentType, filename: file.filename, size: file.bytes.length },
      createdAt: at,
      updatedAt: at,
      updatedBy: staff.staffId,
    }, { index: { status, key: fields.audience } });
    await this.audit({ type: 'staff', id: staff.staffId }, 'document.created', document.id, { audience: fields.audience, status });
    return document;
  }

  async updateDocument(staff, id, input = {}) {
    const document = await this.repo.get('documents', id);
    if (!document) throw notFound('Document');
    const fields = normalizeDocumentInput(input, { partial: true });
    if (input.file) {
      const file = decodeDocumentFile(input.file);
      const key = `documents/${randomUUID()}`;
      await this.fileStore.put(key, file.bytes, { contentType: file.contentType, filename: file.filename });
      document.file = { key, contentType: file.contentType, filename: file.filename, size: file.bytes.length };
      if (!fields.version) throw new AssignmentValidationError('Enter a new version when replacing the file.', 'version');
    }
    Object.assign(document, fields, { updatedAt: this.timestamp(), updatedBy: staff.staffId });
    const saved = await this.repo.update('documents', id, document, { index: { status: document.status, key: document.audience } });
    await this.audit({ type: 'staff', id: staff.staffId }, 'document.updated', id, { changed: Object.keys(fields).concat(input.file ? ['file'] : []) });
    return saved;
  }

  // ---------- Messages ----------

  threadView(thread, side) {
    const readAt = side === 'clinic' ? thread.clinicReadAt : thread.staffReadAt;
    const unread = thread.lastMessageBy !== side && (!readAt || thread.lastMessageAt > readAt);
    return {
      id: thread.id,
      subject: thread.subject,
      category: thread.category,
      kitId: thread.kitId || null,
      status: thread.status,
      createdAt: thread.createdAt,
      lastMessageAt: thread.lastMessageAt,
      lastMessageBy: thread.lastMessageBy,
      messageCount: thread.messageCount,
      unread,
      ...(side === 'staff' ? { clinicCustomerId: thread.clinicCustomerId } : {}),
    };
  }

  async assertMessageRate(customer) {
    const since = new Date(this.now().getTime() - 60 * 60 * 1000).toISOString();
    const recent = await this.repo.list('messages', { owner: customer.id, limit: MESSAGE_RATE_LIMIT_PER_HOUR + 1 });
    const count = recent.filter((message) => message.author.type === 'clinic' && message.at >= since).length;
    if (count >= MESSAGE_RATE_LIMIT_PER_HOUR) {
      throw new PortalRequestError('Message limit reached. Please wait before sending more messages.', 429, 'RATE_LIMITED');
    }
  }

  async listThreads(customer) {
    return (await this.repo.list('threads', { owner: customer.id })).map((thread) => this.threadView(thread, 'clinic'));
  }

  async createThread(customer, input) {
    const normalized = normalizeNewThread(input);
    const handle = recordHandle('thread', customer.id, normalized.requestId);
    const retried = await this.repo.getByHandle('threads', handle);
    if (retried) return this.threadView(retried, 'clinic');
    if (normalized.kitId) {
      const kit = await this.findKitByKitId(normalized.kitId);
      const legacy = !kit && this.legacyStore ? await this.legacyStore.findLegacyKit(normalized.kitId) : null;
      const ownerId = kit?.clinicCustomerId || legacy?.clinicCustomerId;
      if (ownerId !== customer.id) throw new AssignmentValidationError('Choose a kit registered to your clinic.', 'kitId');
    }
    await this.assertMessageRate(customer);
    const at = this.timestamp();
    let thread;
    try {
      thread = await this.repo.create('threads', {
        clinicCustomerId: customer.id,
        subject: normalized.subject,
        category: normalized.category,
        kitId: normalized.kitId,
        status: 'open',
        createdAt: at,
        lastMessageAt: at,
        lastMessageBy: 'clinic',
        clinicReadAt: at,
        staffReadAt: null,
        messageCount: 1,
        latestMessage: { from: 'clinic', authorId: customer.id, body: normalized.body, at },
      }, { handle, index: { owner: customer.id, status: 'open', key: normalized.category } });
    } catch (error) {
      if (error instanceof DuplicateRecordError) return this.threadView(await this.repo.getByHandle('threads', handle), 'clinic');
      throw error;
    }
    await this.repo.create('messages', { threadId: thread.id, author: { type: 'clinic', id: customer.id }, body: normalized.body, at }, {
      handle: recordHandle('message', thread.id, normalized.requestId),
      index: { owner: customer.id, key: thread.id },
    });
    await this.audit({ type: 'clinic', id: customer.id }, 'thread.created', thread.id, { clinicCustomerId: customer.id });
    await this.notifier.notify('message.from_clinic', { audience: 'staff', recordId: thread.id });
    return this.threadView(thread, 'clinic');
  }

  async loadThread(id, customer = null) {
    const thread = await this.repo.get('threads', id);
    if (!thread || (customer && thread.clinicCustomerId !== customer.id)) throw notFound('Conversation');
    return thread;
  }

  async readThread(id, side, customer = null) {
    const thread = await this.loadThread(id, customer);
    const stored = await this.repo.list('messages', { key: thread.id });
    // The message list comes from Shopify search, which lags a few seconds behind
    // writes. The thread (read by ID) keeps a copy of its newest message.
    const latest = thread.latestMessage;
    if (latest && !stored.some((message) => message.at === latest.at && message.author.type === latest.from && message.body === latest.body)) {
      stored.push({ id: `${thread.id}#latest`, author: { type: latest.from, id: latest.authorId }, body: latest.body, at: latest.at });
    }
    const messages = stored
      .sort((left, right) => String(left.at).localeCompare(String(right.at)))
      .map((message) => ({
        id: message.id,
        from: message.author.type,
        body: message.body,
        at: message.at,
        ...(side === 'staff' ? { authorId: message.author.id } : {}),
      }));
    const view = this.threadView(thread, side);
    thread[side === 'clinic' ? 'clinicReadAt' : 'staffReadAt'] = this.timestamp();
    await this.repo.update('threads', thread.id, thread);
    return { thread: { ...view, unread: false }, messages };
  }

  async postMessage(side, actorId, id, input, customer = null) {
    const normalized = normalizeMessage(input);
    const thread = await this.loadThread(id, customer);
    if (thread.status === 'closed' && side === 'clinic') {
      throw new PortalRequestError('This conversation is closed. Start a new message instead.', 409, 'THREAD_CLOSED');
    }
    const handle = recordHandle('message', thread.id, normalized.requestId);
    if (await this.repo.getByHandle('messages', handle)) return this.threadView(thread, side);
    if (side === 'clinic') await this.assertMessageRate(customer);
    const at = this.timestamp();
    try {
      await this.repo.create('messages', { threadId: thread.id, author: { type: side, id: actorId }, body: normalized.body, at }, {
        handle,
        index: { owner: thread.clinicCustomerId, key: thread.id },
      });
    } catch (error) {
      if (error instanceof DuplicateRecordError) return this.threadView(thread, side);
      throw error;
    }
    thread.lastMessageAt = at;
    thread.lastMessageBy = side;
    thread.messageCount += 1;
    thread.latestMessage = { from: side, authorId: actorId, body: normalized.body, at };
    thread[side === 'clinic' ? 'clinicReadAt' : 'staffReadAt'] = at;
    if (side === 'staff' && thread.status === 'closed') thread.status = 'open';
    const saved = await this.repo.update('threads', thread.id, thread, { index: { owner: thread.clinicCustomerId, status: thread.status, key: thread.category } });
    await this.audit({ type: side, id: actorId }, 'message.posted', thread.id, { clinicCustomerId: thread.clinicCustomerId });
    await this.notifier.notify(side === 'clinic' ? 'message.from_clinic' : 'message.from_staff', {
      audience: side === 'clinic' ? 'staff' : 'clinic',
      recordId: thread.id,
      customerId: thread.clinicCustomerId,
    });
    return this.threadView(saved, side);
  }

  async listAllThreads({ unreadOnly = false, status } = {}) {
    const threads = (await this.repo.list('threads', status ? { status } : {})).map((thread) => this.threadView(thread, 'staff'));
    return unreadOnly ? threads.filter((thread) => thread.unread) : threads;
  }

  async setThreadStatus(staff, id, status) {
    if (!['open', 'closed'].includes(status)) throw new AssignmentValidationError('Choose open or closed.', 'status');
    const thread = await this.loadThread(id);
    thread.status = status;
    const saved = await this.repo.update('threads', id, thread, { index: { owner: thread.clinicCustomerId, status, key: thread.category } });
    await this.audit({ type: 'staff', id: staff.staffId }, `thread.${status}`, id, { clinicCustomerId: thread.clinicCustomerId });
    return this.threadView(saved, 'staff');
  }

  async listAudit({ limit = 200 } = {}) {
    return this.repo.list('audit', { limit });
  }
}
