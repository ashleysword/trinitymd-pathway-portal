(function staffConsole(global) {
  'use strict';

  const root = global.document.getElementById('staff-root');
  if (!root) return;
  const devTokenUrl = root.dataset.devTokenUrl || '';

  const STATUS_LABELS = {
    registered: 'Registered', kit_received: 'Kit received', processing: 'Processing', report_ready: 'Report ready',
    complete: 'Complete', cancelled: 'Cancelled', pending: 'Pending', approved: 'Approved', rejected: 'Rejected',
    open: 'Open', closed: 'Closed', draft: 'Draft', published: 'Published', archived: 'Archived',
  };
  const state = { tab: 'applications', overview: null, selected: null, appStatus: 'pending', kitFilter: { q: '', status: '' }, unreadOnly: false };

  function h(tag, attributes, ...children) {
    const element = global.document.createElement(tag);
    for (const [key, value] of Object.entries(attributes || {})) {
      if (value === false || value === null || value === undefined) continue;
      if (key === 'class') element.className = value;
      else if (key === 'text') element.textContent = value;
      else if (key.startsWith('on')) element.addEventListener(key.slice(2), value);
      else element.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      element.append(child instanceof Node ? child : String(child));
    }
    return element;
  }
  const when = (value) => (value ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
  const pill = (status) => h('span', { class: `status status--${status}`, text: STATUS_LABELS[status] || status });
  const numericId = (gid) => String(gid).split('/').pop();
  const requestId = () => (global.crypto.randomUUID ? global.crypto.randomUUID() : String(Date.now()));

  async function sessionToken() {
    if (devTokenUrl) {
      const response = await fetch(devTokenUrl);
      return (await response.json()).token;
    }
    return global.shopify.idToken();
  }

  async function api(path, options = {}) {
    const headers = { Accept: 'application/json', Authorization: `Bearer ${await sessionToken()}` };
    const init = { method: options.method || 'GET', headers };
    if (options.body) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    const response = await fetch(`/staff/api${path}`, init);
    if (options.raw) {
      if (!response.ok) throw new Error('Download failed.');
      return response;
    }
    let payload = {};
    try { payload = await response.json(); } catch (error) { payload = {}; }
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
    return payload;
  }

  async function download(path, filename) {
    const response = await api(path, { raw: true });
    const url = URL.createObjectURL(await response.blob());
    const link = h('a', { href: url, download: filename });
    global.document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function notice(kind, message) {
    return h('div', { class: `notice notice--${kind}`, role: kind === 'error' ? 'alert' : 'status', text: message });
  }

  function guard(container, fn) {
    return async (event) => {
      if (event) event.preventDefault();
      container.querySelectorAll('.notice--error').forEach((element) => element.remove());
      try {
        await fn(event);
      } catch (error) {
        container.prepend(notice('error', error.message));
      }
    };
  }

  // ---------- layout ----------

  async function render() {
    try {
      state.overview = await api('/overview');
    } catch (error) {
      root.replaceChildren(h('div', { class: 'staff-shell' }, notice('error', error.message)));
      return;
    }
    const overview = state.overview;
    const tabs = [['applications', 'Applications'], ['kits', 'Kits'], ['documents', 'Documents'], ['messages', 'Messages'], ['audit', 'Audit log']];
    const panel = h('div', { id: 'panel' });
    root.replaceChildren(
      devTokenUrl ? h('div', { class: 'dev-banner', text: 'Local development console · synthetic data only' }) : '',
      h('div', { class: 'staff-shell' },
        h('div', { class: 'staff-head' },
          h('div', {}, h('p', { class: 'eyebrow', text: 'TrinityMD staff' }), h('h1', { text: 'Clinic portal review' })),
          h('p', { class: 'muted', text: `Approval policy: ${overview.approvalMode === 'auto' ? 'automatic' : 'manual review'} · Shopify tagging ${overview.customerTaggingEnabled ? 'on' : 'off (dry run)'}` })),
        h('div', { class: 'stats' },
          h('div', { class: 'card stat' }, h('strong', { text: String(overview.pendingApplications) }), h('span', { text: 'Pending applications' })),
          h('div', { class: 'card stat' }, h('strong', { text: String(overview.kits) }), h('span', { text: 'Portal kits' })),
          h('div', { class: 'card stat' }, h('strong', { text: String(overview.unreadThreads) }), h('span', { text: 'Unread conversations' }))),
        h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([key, label]) => h('button', {
          type: 'button', role: 'tab', 'aria-selected': String(state.tab === key),
          onclick: () => { state.tab = key; state.selected = null; render(); },
          text: label,
        }))),
        panel));
    const views = { applications: renderApplications, kits: renderKits, documents: renderDocuments, messages: renderMessages, audit: renderAudit };
    await guard(panel, () => views[state.tab](panel))();
  }

  function splitView(panel, listCard, detailCard) {
    panel.replaceChildren(h('div', { class: 'split' }, listCard, detailCard));
  }

  // ---------- applications ----------

  async function renderApplications(panel) {
    const { applications } = await api(`/applications${state.appStatus ? `?status=${state.appStatus}` : ''}`);
    const filter = h('select', { 'aria-label': 'Filter applications' },
      [['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['', 'All']].map(([value, label]) => h('option', { value, text: label, selected: state.appStatus === value })));
    filter.addEventListener('change', () => { state.appStatus = filter.value; state.selected = null; renderApplications(panel); });
    const detail = h('section', { class: 'card' }, h('p', { class: 'muted', text: 'Select an application to review.' }));
    const list = h('section', { class: 'card' },
      h('div', { class: 'toolbar' }, h('h2', { class: 'toolbar-title', text: 'Applications' }), filter),
      applications.length ? h('ul', { class: 'list' }, applications.map((application) => h('li', {},
        h('button', { class: 'row-button', type: 'button', 'aria-current': String(state.selected === application.id), onclick: () => { state.selected = application.id; renderApplications(panel); } },
          h('span', { class: 'row-title row-title--text', text: application.practice.company }),
          pill(application.status),
          h('span', { class: 'row-meta', text: `${application.practice.businessType} · NPI ${application.practice.npi} · ${when(application.createdAt)}${application.duplicates.length ? ' · ⚠ possible duplicate' : ''}` })))))
        : h('p', { class: 'empty', text: 'No applications in this view.' }));
    splitView(panel, list, detail);
    if (state.selected) await guard(detail, () => renderApplicationDetail(detail, state.selected, panel))();
  }

  async function renderApplicationDetail(container, id, panel) {
    const { application } = await api(`/applications/${numericId(id)}`);
    const p = application.practice;
    const note = h('textarea', { id: 'review-note', maxlength: '2000' });
    const message = h('textarea', { id: 'decision-message', maxlength: '2000' });
    const review = (decision) => guard(container, async () => {
      if (decision === 'reject' && !note.value.trim()) throw new Error('Add an internal note explaining the rejection.');
      await api(`/applications/${numericId(id)}/review`, { method: 'POST', body: { decision, note: note.value, decisionMessage: message.value, expectedUpdatedAt: application.updatedAt } });
      render();
    });
    container.replaceChildren(
      h('div', { class: 'toolbar' }, h('h2', { class: 'toolbar-title', text: p.company }), pill(application.status)),
      application.duplicates.length ? notice('warn', `Possible duplicate: ${application.duplicates.map((dup) => `${dup.company} (${dup.status}, same ${dup.matches.join(' & ')})`).join('; ')}`) : '',
      application.tagStatus === 'manual_required' ? notice('warn', 'Approved in the portal, but Shopify tagging is off. Add the clinic tag to this customer manually after confirming the approval.') : '',
      h('dl', { class: 'facts' },
        [['Contact', `${p.firstName} ${p.lastName}`], ['Email', p.contactEmail], ['Phone', p.phone || '—'], ['Business type', p.businessType],
          ['Website', p.website || '—'], ['NPI', p.npi], ['NPI matches contact', p.npiMatchesContact ? 'Yes' : 'No'], ['Tax ID / EIN', p.taxId],
          ['Reseller permit', p.resellerPermit || '—'], ['Shopify customer', application.customerId], ['Submitted', when(application.createdAt)],
          ['Decided', application.decidedAt ? `${when(application.decidedAt)} by ${application.decidedBy.type} ${application.decidedBy.id}` : '—']]
          .map(([label, value]) => [h('dt', { text: label }), h('dd', { class: label === 'NPI' || label === 'Tax ID / EIN' ? 'mono' : '', text: value })])),
      h('p', { class: 'field-help', text: 'Viewing identifiers is recorded in the audit log. Verify the NPI in the NPPES registry before approving.' }),
      application.status === 'pending' ? h('div', { class: 'stack' },
        h('div', { class: 'field' }, h('label', { for: 'review-note', text: 'Internal note (required to reject)' }), note),
        h('div', { class: 'field' }, h('label', { for: 'decision-message', text: 'Message shown to applicant (optional)' }), message),
        h('div', { class: 'button-row' },
          h('button', { class: 'button', type: 'button', onclick: review('approve'), text: 'Approve clinic' }),
          h('button', { class: 'button button--ghost', type: 'button', onclick: review('reject'), text: 'Reject' }))) : '',
      h('h3', { class: 'mt', text: 'Notes' }),
      application.notes.length ? h('ul', { class: 'history' }, application.notes.map((item) => h('li', {}, h('strong', { text: `${when(item.at)} · staff ${item.staffId}: ` }), item.text))) : h('p', { class: 'muted', text: 'No notes yet.' }),
      (() => {
        const input = h('input', { type: 'text', maxlength: '2000', 'aria-label': 'Add note' });
        const form = h('form', { class: 'inline-form mt' }, h('div', { class: 'field' }, input), h('button', { class: 'button button--small', type: 'submit', text: 'Add note' }));
        form.addEventListener('submit', guard(container, async () => {
          await api(`/applications/${numericId(id)}/notes`, { method: 'POST', body: { note: input.value } });
          renderApplications(panel);
        }));
        return form;
      })(),
      h('h3', { class: 'mt', text: 'History' }),
      h('ul', { class: 'history' }, application.history.map((item) => h('li', { text: `${when(item.at)} · ${item.action.replace(/_/g, ' ')} · ${item.actor.type} ${item.actor.id}` }))));
  }

  // ---------- kits ----------

  function kitQuery() {
    const params = new URLSearchParams();
    if (state.kitFilter.q) params.set('q', state.kitFilter.q);
    if (state.kitFilter.status) params.set('status', state.kitFilter.status);
    return params.toString() ? `?${params}` : '';
  }

  async function renderKits(panel) {
    const { kits } = await api(`/kits${kitQuery()}`);
    const search = h('input', { type: 'search', placeholder: 'Kit ID', 'aria-label': 'Search kits', value: state.kitFilter.q });
    const status = h('select', { 'aria-label': 'Status' }, h('option', { value: '', text: 'All statuses' }),
      Object.keys(state.overview.kitTransitions).map((value) => h('option', { value, text: STATUS_LABELS[value], selected: state.kitFilter.status === value })));
    const apply = () => { state.kitFilter = { q: search.value.trim(), status: status.value }; renderKits(panel); };
    search.addEventListener('change', apply);
    status.addEventListener('change', apply);
    const detail = h('section', { class: 'card' }, h('p', { class: 'muted', text: 'Select a kit to view its timeline and update status.' }));
    const list = h('section', { class: 'card' },
      h('div', { class: 'toolbar' }, search, status,
        h('button', { class: 'button button--ghost button--small', type: 'button', onclick: guard(panel, () => download(`/kits/export.csv${kitQuery()}`, 'clinic-kits.csv')), text: 'Export CSV' })),
      kits.length ? h('ul', { class: 'list' }, kits.map((kit) => h('li', {},
        h('button', { class: 'row-button', type: 'button', 'aria-current': String(state.selected === kit.kitId), onclick: () => { state.selected = kit.kitId; renderKits(panel); } },
          h('span', { class: 'row-title', text: kit.kitId }), pill(kit.status),
          h('span', { class: 'row-meta', text: `Clinic ${kit.clinicCustomerId}${kit.clinicReference ? ` · Ref: ${kit.clinicReference}` : ''} · ${kit.source} · ${when(kit.registeredAt)}` })))))
        : h('p', { class: 'empty', text: 'No kits match.' }),
      h('p', { class: 'field-help mt', text: 'Kits assigned through the earlier portal stay in their original Shopify records and are not listed here until migrated.' }));
    splitView(panel, list, detail);
    if (state.selected) await guard(detail, () => renderKitDetail(detail, state.selected, panel))();
  }

  async function renderKitDetail(container, kitId, panel) {
    const { kit, timeline } = await api(`/kits/${encodeURIComponent(kitId)}`);
    const next = state.overview.kitTransitions[kit.status] || [];
    const statusSelect = h('select', { id: 'next-status' }, next.map((value) => h('option', { value, text: STATUS_LABELS[value] })));
    const statusNote = h('input', { type: 'text', id: 'status-note', maxlength: '2000' });
    const statusForm = h('form', { class: 'inline-form' },
      h('div', { class: 'field' }, h('label', { for: 'next-status', text: 'Move to' }), statusSelect),
      h('div', { class: 'field' }, h('label', { for: 'status-note', text: 'Note (shown to clinic)' }), statusNote),
      h('button', { class: 'button button--small', type: 'submit', text: 'Update status' }));
    statusForm.addEventListener('submit', guard(container, async () => {
      await api(`/kits/${encodeURIComponent(kitId)}/status`, { method: 'POST', body: { status: statusSelect.value, note: statusNote.value, expectedStatus: kit.status } });
      renderKits(panel);
    }));
    const target = h('input', { type: 'text', id: 'reassign-target', inputmode: 'numeric' });
    const reason = h('input', { type: 'text', id: 'reassign-reason', maxlength: '2000' });
    const reassignForm = h('form', { class: 'inline-form' },
      h('div', { class: 'field' }, h('label', { for: 'reassign-target', text: 'Receiving clinic customer ID' }), target),
      h('div', { class: 'field' }, h('label', { for: 'reassign-reason', text: 'Reason (required)' }), reason),
      h('button', { class: 'button button--ghost button--small', type: 'submit', text: 'Reassign kit' }));
    reassignForm.addEventListener('submit', guard(container, async () => {
      if (!global.confirm(`Move kit ${kitId} to clinic ${target.value}? The current clinic will lose access.`)) return;
      await api(`/kits/${encodeURIComponent(kitId)}/reassign`, { method: 'POST', body: { clinicCustomerId: target.value.trim(), reason: reason.value } });
      renderKits(panel);
    }));
    container.replaceChildren(
      h('div', { class: 'toolbar' }, h('h2', { class: 'toolbar-title mono', text: kit.kitId }), pill(kit.status)),
      h('dl', { class: 'facts' }, [['Clinic customer', kit.clinicCustomerId], ['Clinic reference', kit.clinicReference || '—'], ['Registered', when(kit.registeredAt)], ['Registered by', `${kit.registeredBy.type} ${kit.registeredBy.id}`], ['Source', kit.source]]
        .map(([label, value]) => [h('dt', { text: label }), h('dd', { text: value })])),
      next.length ? statusForm : h('p', { class: 'muted', text: 'No further status changes are allowed from this stage.' }),
      h('h3', { class: 'mt', text: 'Timeline' }),
      h('ol', { class: 'timeline' }, timeline.map((event) => h('li', {},
        h('strong', { text: event.type === 'status_changed' ? `${STATUS_LABELS[event.from]} → ${STATUS_LABELS[event.to]}` : event.type }),
        h('time', { text: `${when(event.at)} · ${event.actor.type} ${event.actor.id}` }),
        event.note ? h('p', { class: 'muted', text: event.note }) : null))),
      h('h3', { class: 'mt', text: 'Correct clinic assignment' }),
      reassignForm);
  }

  // ---------- documents ----------

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(new Error('Could not read the file.'));
      reader.readAsDataURL(file);
    });
  }

  // `latest` is a document just saved: Shopify search can lag a few seconds,
  // so keep the saved copy over whatever the list returns.
  async function renderDocuments(panel, latest = null) {
    let { documents } = await api('/documents');
    if (latest) documents = [latest, ...documents.filter((document) => document.id !== latest.id)];
    const table = h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Title', 'Audience', 'Version', 'Date', 'Status', ''].map((label) => h('th', { text: label })))),
      h('tbody', {}, documents.map((document) => {
        const toggle = document.status === 'published' ? 'archived' : 'published';
        return h('tr', {},
          h('td', {}, h('strong', { text: document.title }), h('br'), h('span', { class: 'muted', text: `${document.category} · ${document.filename}` })),
          h('td', { text: document.audience === 'clinic' ? 'Clinic only' : 'Public' }),
          h('td', { text: document.version }),
          h('td', { text: document.publishedDate }),
          h('td', {}, pill(document.status)),
          h('td', {}, h('div', { class: 'button-row' },
            h('button', { class: 'button button--ghost button--small', type: 'button', onclick: guard(panel, () => download(`/documents/${numericId(document.id)}/file`, document.filename)), text: 'Open' }),
            h('button', { class: 'button button--small', type: 'button', onclick: guard(panel, async () => { const saved = await api(`/documents/${numericId(document.id)}`, { method: 'PATCH', body: { status: toggle } }); renderDocuments(panel, saved.document); }), text: toggle === 'published' ? 'Publish' : 'Archive' }))));
      }))));
    const form = h('form', { class: 'card', novalidate: true },
      h('h2', { text: 'Add a document' }),
      h('div', { class: 'form-grid' },
        ...[['title', 'Title', 'text'], ['category', 'Category', 'text'], ['version', 'Version', 'text'], ['publishedDate', 'Document date', 'date']].map(([name, label, type]) =>
          h('div', { class: 'field' }, h('label', { for: `doc-${name}`, text: label }), h('input', { id: `doc-${name}`, name, type, required: true }))),
        h('div', { class: 'field' }, h('label', { for: 'doc-audience', text: 'Audience' }),
          h('select', { id: 'doc-audience', name: 'audience' }, h('option', { value: 'clinic', text: 'Approved clinics only' }), h('option', { value: 'public', text: 'Public (shareable)' }))),
        h('div', { class: 'field' }, h('label', { for: 'doc-file', text: 'File (PDF, PNG, JPEG · max 4 MB)' }), h('input', { id: 'doc-file', name: 'file', type: 'file', accept: 'application/pdf,image/png,image/jpeg', required: true })),
        h('div', { class: 'field span-2' }, h('label', { for: 'doc-description', text: 'Description' }), h('input', { id: 'doc-description', name: 'description', type: 'text', maxlength: '300' }))),
      h('p', { class: 'field-help', text: 'New documents start as drafts. Publish them from the list once reviewed.' }),
      h('button', { class: 'button', type: 'submit', text: 'Upload draft' }));
    form.addEventListener('submit', guard(form, async () => {
      const data = Object.fromEntries(new FormData(form).entries());
      const file = form.file.files[0];
      if (!file) throw new Error('Choose a file to upload.');
      if (file.size > 4 * 1024 * 1024) throw new Error('Files must be 4 MB or smaller.');
      const saved = await api('/documents', { method: 'POST', body: { ...data, file: { filename: file.name, contentType: file.type, base64: await readFile(file) } } });
      renderDocuments(panel, saved.document);
    }));
    panel.replaceChildren(h('section', { class: 'card' }, h('h2', { text: 'Documents' }), documents.length ? table : h('p', { class: 'empty', text: 'No documents yet.' })), form);
  }

  // ---------- messages ----------

  async function renderMessages(panel) {
    const { threads } = await api(`/threads${state.unreadOnly ? '?unread=1' : ''}`);
    const unread = h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: state.unreadOnly, onchange: (event) => { state.unreadOnly = event.target.checked; renderMessages(panel); } }), h('span', { text: 'Unread only' }));
    const detail = h('section', { class: 'card' }, h('p', { class: 'muted', text: 'Select a conversation.' }));
    const list = h('section', { class: 'card' },
      h('div', { class: 'toolbar' }, h('h2', { class: 'toolbar-title', text: 'Clinic inbox' }), unread),
      threads.length ? h('ul', { class: 'list' }, threads.map((thread) => h('li', {},
        h('button', { class: 'row-button', type: 'button', 'aria-current': String(state.selected === thread.id), onclick: () => { state.selected = thread.id; renderMessages(panel); } },
          h('span', { class: 'row-title row-title--text' }, thread.unread ? h('span', { class: 'unread-dot', 'aria-label': 'Unread' }) : '', thread.subject),
          pill(thread.status),
          h('span', { class: 'row-meta', text: `Clinic ${thread.clinicCustomerId} · ${thread.category}${thread.kitId ? ` · ${thread.kitId}` : ''} · ${when(thread.lastMessageAt)}` })))))
        : h('p', { class: 'empty', text: 'No conversations.' }));
    splitView(panel, list, detail);
    if (state.selected) await guard(detail, () => renderThread(detail, state.selected, panel))();
  }

  async function renderThread(container, id, panel) {
    const { thread, messages } = await api(`/threads/${numericId(id)}`);
    const textarea = h('textarea', { 'aria-label': 'Reply', maxlength: '4000' });
    let replyId = requestId();
    const form = h('form', {}, textarea, h('div', { class: 'button-row mt' },
      h('button', { class: 'button', type: 'submit', text: 'Send reply' }),
      h('button', { class: 'button button--ghost', type: 'button', onclick: guard(container, async () => {
        await api(`/threads/${numericId(id)}/status`, { method: 'POST', body: { status: thread.status === 'open' ? 'closed' : 'open' } });
        renderMessages(panel);
      }), text: thread.status === 'open' ? 'Close conversation' : 'Reopen' })));
    form.addEventListener('submit', guard(container, async () => {
      await api(`/threads/${numericId(id)}/messages`, { method: 'POST', body: { body: textarea.value, requestId: replyId } });
      replyId = requestId();
      renderMessages(panel);
    }));
    container.replaceChildren(
      h('div', { class: 'toolbar' }, h('h2', { class: 'toolbar-title', text: thread.subject }), pill(thread.status)),
      notice('warn', 'Replies are visible to the clinic. Do not request or send patient health information here.'),
      h('div', { class: 'messages' }, messages.map((message) => h('div', { class: `bubble bubble--${message.from === 'staff' ? 'clinic' : 'staff'}` },
        h('span', { class: 'visually-hidden', text: message.from === 'staff' ? 'Staff wrote: ' : 'Clinic wrote: ' }),
        message.body, h('time', { text: `${when(message.at)} · ${message.from} ${message.authorId}` })))),
      form);
  }

  // ---------- audit ----------

  async function renderAudit(panel) {
    const { entries } = await api('/audit');
    panel.replaceChildren(h('section', { class: 'card' }, h('h2', { text: 'Audit log' }),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['When', 'Actor', 'Action', 'Target'].map((label) => h('th', { text: label })))),
        h('tbody', {}, entries.map((entry) => h('tr', {},
          h('td', { text: when(entry.at) }), h('td', { text: `${entry.actor.type} ${entry.actor.id}` }), h('td', { text: entry.action }), h('td', { class: 'mono', text: entry.target }))))))));
  }

  render();
})(window);
