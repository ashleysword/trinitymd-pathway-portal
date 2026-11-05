import test from 'node:test';
import assert from 'node:assert/strict';
import { ClinicPortalService } from '../src/clinic-portal.js';
import { MemoryFileStore } from '../src/file-store.js';
import { OutboxNotifier } from '../src/notifier.js';
import { MemoryPortalRepository } from '../src/portal-repository.js';

const CLINIC = { id: '1001', tags: ['clinics'], firstName: 'Dana' };
const OTHER_CLINIC = { id: '1003', tags: ['clinics'] };
const APPLICANT = { id: '1002', tags: [] };
const STAFF = { staffId: '7001' };
const PDF = Buffer.from('%PDF-1.7 synthetic document').toString('base64');

function application(overrides = {}) {
  return {
    firstName: 'Riley', lastName: 'Applicant', contactEmail: 'riley@example.com', company: 'Synthetic Wellness',
    businessType: 'Wellness clinic', npi: '1234567893', taxId: '12-3456789', attestation: true, requestId: 'request-0001',
    ...overrides,
  };
}

function fixture(configOverrides = {}, { legacy = null } = {}) {
  const shopifyCalls = [];
  const customers = { 1001: CLINIC, 1002: APPLICANT, 1003: OTHER_CLINIC };
  const shopify = {
    async graphql(query, variables) {
      shopifyCalls.push({ query, variables });
      if (query.includes('PortalApproveClinic')) return { tagsAdd: { node: { id: variables.id }, userErrors: [] } };
      if (query.includes('PortalReassignTarget')) return { customer: customers[variables.id.split('/').pop()] || null };
      throw new Error('unexpected query');
    },
  };
  const accessChanges = [];
  const notifier = new OutboxNotifier();
  const repository = new MemoryPortalRepository();
  const service = new ClinicPortalService({
    repository,
    shopify,
    legacyStore: legacy,
    encryptionKey: Buffer.alloc(32, 9),
    notifier,
    fileStore: new MemoryFileStore(),
    config: { clinicTag: 'clinics', approvalMode: 'manual', customerTaggingEnabled: true, kitIdPattern: /^TL\d{8}$/, ...configOverrides },
    onClinicAccessChanged: (id) => accessChanges.push(id),
  });
  return { service, shopifyCalls, accessChanges, notifier, repository };
}

test('stores application identifiers encrypted and returns only a minimal applicant view', async () => {
  const { service, repository } = fixture();
  const { application: view, created } = await service.submitApplication(APPLICANT, application({ resellerPermit: 'SR-99' }));
  assert.equal(created, true);
  assert.deepEqual(Object.keys(view).sort(), ['businessType', 'company', 'decidedAt', 'decisionMessage', 'id', 'status', 'submittedAt']);
  const [stored] = await repository.list('applications');
  assert.equal(JSON.stringify(stored).includes('12-3456789'), false);
  assert.equal(JSON.stringify(stored).includes('SR-99'), false);
  const staffList = await service.listApplications();
  assert.equal(staffList[0].practice.taxId, '•••6789');
  const detail = await service.getApplication(STAFF, view.id);
  assert.equal(detail.practice.taxId, '12-3456789');
  assert.equal(detail.practice.resellerPermit, 'SR-99');
  const audit = await service.listAudit();
  assert.ok(audit.some((entry) => entry.action === 'application.viewed_identifiers'));
});

test('handles retries and duplicate applications', async () => {
  const { service } = fixture();
  await service.submitApplication(APPLICANT, application());
  const retry = await service.submitApplication(APPLICANT, application());
  assert.equal(retry.created, false);
  await assert.rejects(service.submitApplication(APPLICANT, application({ requestId: 'request-0002' })), { code: 'APPLICATION_EXISTS' });
  await assert.rejects(service.submitApplication(CLINIC, application({ requestId: 'request-0003' })), { code: 'ALREADY_APPROVED' });

  const other = { id: '2001', tags: [] };
  await service.submitApplication(other, application({ requestId: 'request-0004', company: 'Same NPI Co' }));
  const list = await service.listApplications({ status: 'pending' });
  assert.equal(list.length, 2);
  assert.deepEqual(list[0].duplicates[0].matches, ['NPI', 'Tax ID']);
});

test('approval tags the Shopify customer only through the staff decision path', async () => {
  const { service, shopifyCalls, accessChanges, notifier } = fixture();
  const { application: view } = await service.submitApplication(APPLICANT, application());
  assert.equal(shopifyCalls.length, 0);
  await assert.rejects(service.reviewApplication(STAFF, view.id, { decision: 'reject' }), (error) => error.field === 'note');
  await assert.rejects(service.reviewApplication(STAFF, view.id, { decision: 'approve', expectedUpdatedAt: 'stale' }), { code: 'STALE_APPLICATION' });
  const approved = await service.reviewApplication(STAFF, view.id, { decision: 'approve', note: 'Verified' });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.tagStatus, 'applied');
  assert.deepEqual(shopifyCalls[0].variables, { id: 'gid://shopify/Customer/1002', tags: ['clinics'] });
  assert.deepEqual(accessChanges, ['1002']);
  assert.ok(notifier.outbox.some((item) => item.event === 'application.approved' && item.customerId === '1002'));
  await assert.rejects(service.reviewApplication(STAFF, view.id, { decision: 'reject', note: 'x' }), { code: 'APPLICATION_DECIDED' });
});

test('approval without tagging enabled records a manual tag step instead of calling Shopify', async () => {
  const { service, shopifyCalls } = fixture({ customerTaggingEnabled: false });
  const { application: view } = await service.submitApplication(APPLICANT, application());
  const approved = await service.reviewApplication(STAFF, view.id, { decision: 'approve' });
  assert.equal(approved.tagStatus, 'manual_required');
  assert.equal(shopifyCalls.length, 0);
});

test('auto approval mode mirrors the current Massy policy when explicitly chosen', async () => {
  const { service } = fixture({ approvalMode: 'auto' });
  const { application: view } = await service.submitApplication(APPLICANT, application());
  assert.equal(view.status, 'approved');
});

test('kit registration is idempotent per clinic and blocks other clinics', async () => {
  const { service } = fixture();
  const first = await service.registerKit(CLINIC, { kitId: 'tl00001234', source: 'scan' });
  assert.equal(first.created, true);
  assert.equal(first.kit.kitId, 'TL00001234');
  const again = await service.registerKit(CLINIC, { kitId: 'TL00001234' });
  assert.equal(again.created, false);
  await assert.rejects(service.registerKit(OTHER_CLINIC, { kitId: 'TL00001234' }), { code: 'KIT_REGISTERED_ELSEWHERE' });
  await assert.rejects(service.registerKit(CLINIC, { kitId: 'BAD' }), (error) => error.field === 'kitId');
  await assert.rejects(service.getClinicKit(OTHER_CLINIC, 'TL00001234'), { statusCode: 404 });
  const detail = await service.getClinicKit(CLINIC, 'TL00001234');
  assert.equal(detail.timeline[0].type, 'registered');
  assert.equal(detail.timeline[0].actor.id, undefined);
});

test('kit registration respects legacy assignment records without rewriting them', async () => {
  const legacy = {
    async findLegacyKit(kitId) {
      return kitId === 'TL00009999' ? { id: 'gid://shopify/Metaobject/1', kitId, clinicCustomerId: '1001', status: 'processing', createdAt: '2026-09-25T00:00:00Z' } : null;
    },
    async listAssignments() {
      return [{ id: 'gid://shopify/Metaobject/1', kitId: 'TL00009999', clientEmail: 'secret@example.com', clientName: 'S. Secret', status: 'processing', createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:00Z' }];
    },
  };
  const { service, repository } = fixture({}, { legacy });
  const own = await service.registerKit(CLINIC, { kitId: 'TL00009999' });
  assert.equal(own.created, false);
  assert.equal(own.kit.legacy, true);
  await assert.rejects(service.registerKit(OTHER_CLINIC, { kitId: 'TL00009999' }), { code: 'KIT_REGISTERED_ELSEWHERE' });
  assert.equal((await repository.list('kits')).length, 0);
  const kits = await service.listClinicKits(CLINIC);
  assert.equal(kits[0].legacy, true);
  assert.equal(JSON.stringify(kits).includes('secret@example.com'), false);
});

test('staff status changes follow the transition table and are audited', async () => {
  const { service, notifier } = fixture();
  await service.registerKit(CLINIC, { kitId: 'TL00001234' });
  await assert.rejects(service.updateKitStatus(STAFF, 'TL00001234', { status: 'complete' }), { code: 'INVALID_TRANSITION' });
  await assert.rejects(service.updateKitStatus(STAFF, 'TL00001234', { status: 'cancelled' }), (error) => error.field === 'note');
  await assert.rejects(service.updateKitStatus(STAFF, 'TL00001234', { status: 'kit_received', expectedStatus: 'processing' }), { code: 'STALE_KIT' });
  const result = await service.updateKitStatus(STAFF, 'TL00001234', { status: 'kit_received', note: 'At lab' });
  assert.equal(result.kit.status, 'kit_received');
  const staffView = await service.getStaffKit('TL00001234');
  assert.equal(staffView.timeline.at(-1).actor.id, '7001');
  assert.ok(notifier.outbox.some((item) => item.event === 'kit.status_changed'));
  assert.ok((await service.listAudit()).some((entry) => entry.action === 'kit.status_changed'));
  const csv = await service.exportKitsCsv();
  assert.match(csv, /^kit_id,clinic_customer_id,status/);
  assert.match(csv, /TL00001234,1001,kit_received/);
});

test('staff reassignment requires a reason and an approved receiving clinic', async () => {
  const { service } = fixture();
  await service.registerKit(CLINIC, { kitId: 'TL00001234' });
  await assert.rejects(service.reassignKit(STAFF, 'TL00001234', { clinicCustomerId: '1003' }), (error) => error.field === 'note');
  await assert.rejects(service.reassignKit(STAFF, 'TL00001234', { clinicCustomerId: '1002', reason: 'Mistake' }), { code: 'TARGET_NOT_CLINIC' });
  await service.reassignKit(STAFF, 'TL00001234', { clinicCustomerId: '1003', reason: 'Registered by the wrong clinic' });
  await assert.rejects(service.getClinicKit(CLINIC, 'TL00001234'), { statusCode: 404 });
  assert.equal((await service.getClinicKit(OTHER_CLINIC, 'TL00001234')).kit.kitId, 'TL00001234');
});

test('documents enforce audience and publishing status server-side', async () => {
  const { service } = fixture();
  const clinicDoc = await service.createDocument(STAFF, {
    title: 'Clinic Overview', category: 'Clinic education', version: '1.0', publishedDate: '2026-08-20', audience: 'clinic',
    file: { filename: 'clinic.pdf', contentType: 'application/pdf', base64: PDF },
  });
  assert.equal(clinicDoc.status, 'draft');
  assert.equal((await service.listDocuments({ isClinic: true })).length, 0);
  await assert.rejects(service.openDocument({ isClinic: true }, clinicDoc.id), { statusCode: 404 });
  await service.updateDocument(STAFF, clinicDoc.id, { status: 'published' });
  assert.equal((await service.listDocuments({ isClinic: true })).length, 1);
  assert.equal((await service.listDocuments({ isClinic: false })).length, 0);
  await assert.rejects(service.openDocument({ isClinic: false }, clinicDoc.id), { statusCode: 403 });
  const file = await service.openDocument({ isClinic: true }, clinicDoc.id);
  assert.equal(file.bytes.toString('latin1').slice(0, 5), '%PDF-');
  await assert.rejects(service.updateDocument(STAFF, clinicDoc.id, { file: { filename: 'v2.pdf', contentType: 'application/pdf', base64: PDF } }), (error) => error.field === 'version');
});

test('message threads are clinic-scoped with unread tracking for both sides', async () => {
  const { service } = fixture();
  await service.registerKit(CLINIC, { kitId: 'TL00001234' });
  await assert.rejects(service.createThread(OTHER_CLINIC, { subject: 'Kit', category: 'kit_status', kitId: 'TL00001234', body: 'Status?', requestId: 'thread-0001' }), (error) => error.field === 'kitId');
  const thread = await service.createThread(CLINIC, { subject: 'Kit question', category: 'kit_status', kitId: 'TL00001234', body: 'Status?', requestId: 'thread-0002' });
  const retry = await service.createThread(CLINIC, { subject: 'Kit question', category: 'kit_status', kitId: 'TL00001234', body: 'Status?', requestId: 'thread-0002' });
  assert.equal(retry.id, thread.id);
  assert.equal((await service.listAllThreads({ unreadOnly: true })).length, 1);
  await assert.rejects(service.readThread(thread.id, 'clinic', OTHER_CLINIC), { statusCode: 404 });

  const staffView = await service.readThread(thread.id, 'staff');
  assert.equal(staffView.messages.length, 1);
  assert.equal((await service.listAllThreads({ unreadOnly: true })).length, 0);
  await service.postMessage('staff', STAFF.staffId, thread.id, { body: 'Received yesterday.', requestId: 'reply-0001' });
  const [clinicThread] = await service.listThreads(CLINIC);
  assert.equal(clinicThread.unread, true);
  const clinicView = await service.readThread(thread.id, 'clinic', CLINIC);
  assert.equal(clinicView.messages[1].from, 'staff');
  assert.equal(clinicView.messages[1].authorId, undefined);
  await assert.rejects(service.postMessage('clinic', CLINIC.id, thread.id, { body: 'Patient date of birth 1/1/80', requestId: 'reply-0002' }, CLINIC), (error) => error.field === 'body');
  await service.setThreadStatus(STAFF, thread.id, 'closed');
  await assert.rejects(service.postMessage('clinic', CLINIC.id, thread.id, { body: 'One more', requestId: 'reply-0003' }, CLINIC), { code: 'THREAD_CLOSED' });
});

test('clinic messaging is rate limited', async () => {
  const { service } = fixture();
  const thread = await service.createThread(CLINIC, { subject: 'Busy', body: 'First', requestId: 'thread-rate-0' });
  for (let index = 1; index < 20; index += 1) {
    await service.postMessage('clinic', CLINIC.id, thread.id, { body: `Message ${index}`, requestId: `rate-message-${index}` }, CLINIC);
  }
  await assert.rejects(service.postMessage('clinic', CLINIC.id, thread.id, { body: 'Too many', requestId: 'rate-message-21' }, CLINIC), { statusCode: 429 });
});

test('a new message shows in the thread even while the message search lags', async () => {
  // Seen on the dev store: Shopify search returns a new message only after a few seconds.
  const { service, repository } = fixture();
  const list = repository.list.bind(repository);
  let lagging = true;
  repository.list = async (collection, filter) => {
    const records = await list(collection, filter);
    return collection === 'messages' && lagging ? records.slice(1) : records; // newest first
  };
  const thread = await service.createThread(CLINIC, { subject: 'Lag test', category: 'general', body: 'First question', requestId: 'lag-thread-1' });
  assert.deepEqual((await service.readThread(thread.id, 'clinic', CLINIC)).messages.map((m) => m.body), ['First question']);
  await service.postMessage('staff', STAFF.staffId, thread.id, { body: 'Staff answer', requestId: 'lag-reply-1' });
  const staffView = await service.readThread(thread.id, 'staff');
  assert.deepEqual(staffView.messages.map((m) => m.body), ['First question', 'Staff answer']);
  assert.equal(staffView.messages[1].authorId, STAFF.staffId);
  const clinicView = await service.readThread(thread.id, 'clinic', CLINIC);
  assert.equal('authorId' in clinicView.messages[1], false, 'clinics never see staff IDs');
  lagging = false;
  assert.equal((await service.readThread(thread.id, 'staff')).messages.length, 2, 'no duplicate once search catches up');
});

test('kit reference: owner only, PHI-guarded, length-limited, clearable, never audited as text', async () => {
  const { service, repository } = fixture();
  await service.registerKit(CLINIC, { kitId: 'TL00009999' });
  const { kit, changed } = await service.setKitReference(CLINIC, 'tl00009999', { clinicReference: '  Room 4  batch  ' });
  assert.equal(changed, true);
  assert.equal(kit.clinicReference, 'Room 4 batch');
  assert.equal((await service.setKitReference(CLINIC, 'TL00009999', { clinicReference: 'Room 4 batch' })).changed, false);
  await assert.rejects(service.setKitReference(OTHER_CLINIC, 'TL00009999', { clinicReference: 'x' }), (error) => error.statusCode === 404);
  await assert.rejects(service.setKitReference(CLINIC, 'TL00009999', { clinicReference: 'DOB 1/2/80' }), (error) => error.field === 'clinicReference');
  await assert.rejects(service.setKitReference(CLINIC, 'TL00009999', { clinicReference: 'a'.repeat(61) }), (error) => error.field === 'clinicReference');
  assert.equal((await service.listClinicKits(CLINIC))[0].clinicReference, 'Room 4 batch');
  assert.match(await service.exportKitsCsv(), /clinic_reference[\s\S]*Room 4 batch/);
  const audit = JSON.stringify(await repository.list('audit'));
  assert.ok(audit.includes('kit.reference_updated'));
  assert.equal(audit.includes('Room 4'), false, 'the audit log never stores the reference text');
  assert.equal((await service.setKitReference(CLINIC, 'TL00009999', { clinicReference: '' })).kit.clinicReference, '');
});
