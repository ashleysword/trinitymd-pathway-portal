(function clinicPortal(global) {
  'use strict';

  const root = global.document && global.document.getElementById('portal-root');
  if (!root) return;

  const apiBase = root.dataset.apiBase;
  const storefront = root.dataset.storefront || '';
  const assetBase = root.dataset.assetBase || '';
  const state = {
    session: null,
    tab: 'kits',
    kits: [],
    documents: [],
    threads: [],
    kitFilter: { q: '', status: '' },
  };

  const STATUS_LABELS = {
    registered: 'Registered',
    assigned: 'Assigned',
    kit_received: 'Kit received',
    processing: 'Processing',
    report_ready: 'Report ready',
    complete: 'Complete',
    cancelled: 'Cancelled',
    pending: 'Under review',
    approved: 'Approved',
    rejected: 'Not approved',
    open: 'Open',
    closed: 'Closed',
  };
  const CATEGORY_LABELS = { general: 'General question', kit_status: 'Kit status', order: 'Order or billing', documents: 'Documents' };

  // ---------- helpers ----------

  function h(tag, attributes, ...children) {
    const element = global.document.createElement(tag);
    for (const [key, value] of Object.entries(attributes || {})) {
      if (value === false || value === null || value === undefined) continue;
      if (key === 'class') element.className = value;
      else if (key === 'text') element.textContent = value;
      else if (key.startsWith('on')) element.addEventListener(key.slice(2), value);
      else if (key === 'dataset') Object.assign(element.dataset, value);
      else element.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      element.append(child instanceof Node ? child : String(child));
    }
    return element;
  }

  function formatDate(value, withTime) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString(undefined, withTime
      ? { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }
      : { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function statusPill(status) {
    return h('span', { class: `status status--${status}`, text: STATUS_LABELS[status] || status });
  }

  function requestId() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }

  class ApiError extends Error {
    constructor(message, status, field, code) {
      super(message);
      this.status = status;
      this.field = field;
      this.code = code;
    }
  }

  async function api(path, options) {
    const init = { method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' }, ...options };
    if (init.body && typeof init.body !== 'string') {
      init.body = JSON.stringify({ ...init.body, csrfToken: state.session && state.session.csrfToken });
      init.headers['Content-Type'] = 'application/json';
    }
    let response;
    try {
      response = await fetch(`${apiBase}${path}`, init);
    } catch (error) {
      throw new ApiError('Connection problem. Check your network and try again.', 0);
    }
    let payload = {};
    try { payload = await response.json(); } catch (error) { payload = {}; }
    if (!response.ok) {
      if (response.status === 401 && /token/i.test(payload.error || '')) {
        await refreshSession();
        throw new ApiError('Your secure session was refreshed. Please try again.', 401);
      }
      throw new ApiError(payload.error || 'Something went wrong. Please try again.', response.status, payload.field, payload.code);
    }
    return payload;
  }

  async function refreshSession() {
    state.session = await api('/session');
  }

  function setNotice(element, kind, message) {
    element.className = `notice notice--${kind}`;
    element.textContent = message || '';
    element.hidden = !message;
  }

  // Chrome mirrors the live clinic hub: announcement bar, white header with the
  // Trinity wordmark, and the navy BioBlueprint footer.
  function mount(...nodes) {
    root.replaceChildren(
      h('div', { class: 'announcement', text: 'BioBlueprint clinic partner hub · approved accounts only' }),
      header(),
      h('main', { class: 'page', id: 'main' }, h('div', { class: 'shell' }, ...nodes)),
      footer());
  }

  function goToTab(tab) {
    state.tab = tab;
    renderPortal();
  }

  function header() {
    const session = state.session;
    const isClinic = Boolean(session && session.signedIn && session.isClinic);
    return h('header', { class: 'site-header' },
      h('div', { class: 'shell nav' },
        h('a', { class: 'logo', href: storefront || '/', 'aria-label': 'Trinity home' },
          h('img', { src: `${assetBase}/portal/trinity-brand-logo.jpeg`, alt: 'Trinity', width: '220', height: '68' })),
        isClinic
          ? h('nav', { class: 'nav-links', 'aria-label': 'Clinic portal navigation' },
            h('button', { type: 'button', onclick: () => goToTab('kits'), text: 'Kits' }),
            h('button', { type: 'button', onclick: () => goToTab('documents'), text: 'Education' }),
            h('button', { type: 'button', onclick: () => goToTab('messages'), text: 'Messages' }),
            h('a', { href: session.options.orderingUrl, text: 'Order kits' }))
          : h('nav', { class: 'nav-links', 'aria-label': 'Clinic access navigation' },
            h('a', { href: `${storefront}/pages/bioblueprint`, text: 'BioBlueprint test' })),
        session && session.signedIn
          ? h('a', { class: 'button button--small', href: session.options.logoutUrl }, 'Sign out ', h('span', { class: 'arrow', 'aria-hidden': 'true' }))
          : h('a', { class: 'button button--small', href: (session && session.loginUrl) || '#' }, 'Sign in ', h('span', { class: 'arrow', 'aria-hidden': 'true' }))));
  }

  function footer() {
    return h('footer', { class: 'site-footer' },
      h('div', { class: 'shell' },
        h('strong', { text: 'BioBlueprint™ clinic partner portal' }),
        h('span', { text: 'For clinic business, kit registration, and kit-status questions. Do not enter patient names, dates of birth, test results, or other health information.' })));
  }

  // ---------- signed out / application ----------

  function renderSignedOut() {
    mount(h('section', { class: 'access' },
      h('div', {},
        h('p', { class: 'eyebrow', text: 'Protected clinic hub' }),
        h('h1', { text: 'Approved clinic access required.' }),
        h('p', { class: 'lede', text: 'Sign in with the email connected to your TrinityMD clinic account to register kits, follow kit status, download clinic education, and message our team. New practices can apply for wholesale access after signing in or creating an account.' })),
      h('aside', {},
        h('div', { class: 'lock', 'aria-hidden': 'true', text: '●' }),
        h('h2', { text: 'Sign in to continue' }),
        h('p', { text: 'Use your clinic account email. If your practice is new to TrinityMD, create an account first and then complete the short wholesale application.' }),
        h('a', { class: 'button', href: state.session.loginUrl }, 'Sign in or create account ', h('span', { class: 'arrow', 'aria-hidden': 'true' })))));
  }

  function renderApplicationStatus(application) {
    const pending = application.status === 'pending';
    mount(h('section', { class: 'intro' },
      h('div', {},
        h('p', { class: 'eyebrow', text: 'Wholesale application' }),
        h('h1', { text: pending ? 'Your application is under review.' : 'Application update.' }))),
    h('section', { class: 'card stack' },
      h('p', {}, 'Practice: ', h('strong', { text: application.company }), ' · Submitted ', formatDate(application.submittedAt)),
      h('p', {}, statusPill(application.status)),
      pending
        ? h('p', { class: 'muted', text: 'Our team reviews each practice before clinic pricing and portal access are turned on. We will email you when a decision is made.' })
        : h('div', { class: 'stack' },
          application.decisionMessage ? h('div', { class: 'notice notice--info', text: application.decisionMessage }) : null,
          h('p', { class: 'muted', text: 'You can submit an updated application if your details have changed.' }),
          h('button', { class: 'button', type: 'button', onclick: () => renderApplicationForm(), text: 'Start a new application' }))));
  }

  function field(id, label, input, { required, help, span } = {}) {
    input.id = id;
    input.name = id;
    if (required) input.required = true;
    const helpId = help ? `${id}-help` : null;
    const errorId = `${id}-error`;
    input.setAttribute('aria-describedby', [helpId, errorId].filter(Boolean).join(' '));
    return h('div', { class: `field${span ? ' span-2' : ''}` },
      h('label', { for: id }, label, required ? h('span', { class: 'req', 'aria-hidden': 'true', text: ' *' }) : null),
      input,
      help ? h('p', { class: 'field-help', id: helpId, text: help }) : null,
      h('p', { class: 'field-error', id: errorId, role: 'alert' }));
  }

  function clearErrors(form) {
    form.querySelectorAll('.field-error').forEach((element) => { element.textContent = ''; });
    form.querySelectorAll('[aria-invalid]').forEach((element) => element.removeAttribute('aria-invalid'));
  }

  function showFieldError(form, name, message) {
    const input = form.querySelector(`[name="${name}"]`);
    const error = form.querySelector(`#${name}-error`);
    if (input) {
      input.setAttribute('aria-invalid', 'true');
      input.focus();
    }
    if (error) error.textContent = message;
    return Boolean(error);
  }

  function renderApplicationForm() {
    const options = state.session.options;
    const customer = state.session.customer;
    const businessType = h('select', {}, h('option', { value: '', text: 'Choose one' }), options.businessTypes.map((type) => h('option', { value: type, text: type })));
    const notice = h('div', { class: 'notice', hidden: true, role: 'status' });
    const submit = h('button', { class: 'button', type: 'submit', text: 'Submit application' });
    const formRequestId = requestId();

    const form = h('form', { novalidate: true, class: 'card' },
      h('h2', { text: 'Practice details' }),
      h('p', { class: 'muted', text: 'Fields marked * are required. Identifiers are used only to verify your practice and are encrypted when stored.' }),
      notice,
      h('fieldset', {},
        h('legend', { text: 'Contact' }),
        h('div', { class: 'form-grid' },
          field('firstName', 'First name', h('input', { type: 'text', autocomplete: 'given-name', maxlength: '60', value: customer.firstName || '' }), { required: true }),
          field('lastName', 'Last name', h('input', { type: 'text', autocomplete: 'family-name', maxlength: '60' }), { required: true }),
          field('contactEmail', 'Business email', h('input', { type: 'email', autocomplete: 'email', maxlength: '254', value: customer.email || '' }), { required: true }),
          field('phone', 'Phone', h('input', { type: 'tel', autocomplete: 'tel', maxlength: '20' })))),
      h('fieldset', {},
        h('legend', { text: 'Practice' }),
        h('div', { class: 'form-grid' },
          field('company', 'Practice name', h('input', { type: 'text', autocomplete: 'organization', maxlength: '120' }), { required: true }),
          field('businessType', 'Business type', businessType, { required: true }),
          field('website', 'Website', h('input', { type: 'url', autocomplete: 'url', maxlength: '200', placeholder: 'https://' }), { span: true }))),
      h('fieldset', {},
        h('legend', { text: 'Verification' }),
        h('div', { class: 'form-grid' },
          field('npi', 'NPI number', h('input', { type: 'text', inputmode: 'numeric', maxlength: '10', autocomplete: 'off' }), { required: true, help: '10-digit National Provider Identifier.' }),
          field('taxId', 'Tax ID / EIN', h('input', { type: 'text', inputmode: 'numeric', maxlength: '10', autocomplete: 'off', placeholder: '12-3456789' }), { required: true }),
          field('resellerPermit', 'Reseller permit number', h('input', { type: 'text', maxlength: '40', autocomplete: 'off' }), { help: 'Optional. Provide it if your practice resells kits tax-exempt.' }),
          h('div', { class: 'field' },
            h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'npiMatchesContact' }), h('span', { text: 'The NPI belongs to the contact person named above.' }))))),
      h('div', { class: 'field' },
        h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'attestation', id: 'attestation', 'aria-describedby': 'attestation-error' }), h('span', { text: 'I confirm this information is accurate and that I am authorized to apply on behalf of this practice.' })),
        h('p', { class: 'field-error', id: 'attestation-error', role: 'alert' })),
      h('div', { class: 'button-row' }, submit));
    const intro = h('section', { class: 'intro' },
      h('div', {},
        h('p', { class: 'eyebrow', text: 'Clinic wholesale application' }),
        h('h1', { text: 'Apply for clinic partner access.' }),
        h('p', { class: 'lede', text: 'Tell us about your practice. Once approved, your account unlocks clinic pricing, kit registration, education materials, and direct messaging with the TrinityMD team.' })));

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      clearErrors(form);
      setNotice(notice, 'info', '');
      const data = Object.fromEntries(new FormData(form).entries());
      for (const name of ['firstName', 'lastName', 'contactEmail', 'company', 'businessType', 'npi', 'taxId']) {
        if (!String(data[name] || '').trim()) {
          showFieldError(form, name, 'This field is required.');
          return;
        }
      }
      if (!form.attestation.checked) {
        showFieldError(form, 'attestation', 'Please confirm before submitting.');
        return;
      }
      submit.disabled = true;
      submit.textContent = 'Submitting…';
      try {
        const result = await api('/applications', {
          method: 'POST',
          body: { ...data, npiMatchesContact: form.npiMatchesContact.checked, attestation: true, requestId: formRequestId },
        });
        await refreshSession();
        renderConfirmation(result.application);
      } catch (error) {
        if (!(error.field && showFieldError(form, error.field, error.message))) setNotice(notice, 'error', error.message);
        submit.disabled = false;
        submit.textContent = 'Submit application';
      }
    });
    mount(intro, form);
  }

  function renderConfirmation(application) {
    if (application.status === 'approved') {
      mount(h('section', { class: 'card stack' },
        h('p', { class: 'eyebrow', text: 'Application received' }),
        h('h1', { text: 'Welcome to the clinic partner portal' }),
        h('p', { text: 'Your practice has been approved. It may take a few minutes for clinic pricing to appear.' }),
        h('button', { class: 'button', type: 'button', onclick: start, text: 'Open the portal' })));
      return;
    }
    mount(h('section', { class: 'intro', tabindex: '-1', id: 'confirmation' },
      h('div', {},
        h('p', { class: 'eyebrow', text: 'Application received' }),
        h('h1', { text: 'Thank you. We have your application.' }))),
    h('section', { class: 'card stack' },
      h('p', {}, 'Practice: ', h('strong', { text: application.company })),
      h('p', { class: 'muted', text: 'Our team will review your practice details and email you when a decision is made. Clinic pricing and portal tools turn on after approval.' })));
    global.document.getElementById('confirmation').focus();
  }

  // ---------- clinic portal ----------

  function renderPortal() {
    const session = state.session;
    const unread = state.threads.filter((thread) => thread.unread).length;
    const tabs = [
      ['kits', 'Kits'],
      ['documents', 'Education'],
      ['messages', 'Messages'],
    ];
    const inProgress = state.kits.filter((kit) => !['complete', 'cancelled'].includes(kit.status)).length;
    const stat = (icon, iconClass, value, label, note) => h('article', { class: 'stat' },
      h('span', { class: `stat-icon ${iconClass}`, 'aria-hidden': 'true', text: icon }),
      h('div', {}, h('p', { text: label }), h('small', { text: note })),
      h('strong', { text: String(value) }));
    const panel = h('div', { id: 'panel', role: 'tabpanel', tabindex: '-1' });
    mount(
      h('section', { class: 'intro' },
        h('div', {},
          h('p', { class: 'eyebrow', text: 'Clinic partner workspace' }),
          h('h1', { text: session.customer.firstName ? `Welcome, ${session.customer.firstName}.` : 'Welcome to your clinic hub.' }),
          h('p', { class: 'lede', text: 'Register and track your BioBlueprint kits, download approved clinic education, and message the TrinityMD team.' })),
        h('a', { class: 'button button--cyan', href: session.options.orderingUrl }, 'Order BioBlueprint kits ', h('span', { class: 'arrow', 'aria-hidden': 'true' }))),
      h('div', { class: 'stats', 'aria-label': 'Clinic account summary' },
        stat('●', '', state.kits.length, 'Registered kits', 'Saved to this clinic account'),
        stat('●', 'stat-icon--blue', inProgress, 'Kits in progress', 'Not yet complete or cancelled'),
        stat('✓', 'stat-icon--lime', unread, 'Unread messages', 'Replies from the TrinityMD team')),
      h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Portal sections' },
        tabs.map(([key, label]) => h('button', {
          type: 'button', role: 'tab', id: `tab-${key}`, 'aria-selected': String(state.tab === key), 'aria-controls': 'panel',
          onclick: () => { state.tab = key; renderPortal(); },
        }, label, key === 'messages' && unread ? h('span', { class: 'badge', text: String(unread) }) : null))),
      panel,
      h('section', { class: 'support' },
        h('div', {},
          h('p', { class: 'eyebrow', text: 'Clinic support' }),
          h('h2', { text: 'Need help with an order or a kit?' }),
          h('p', { class: 'muted', text: 'Send the TrinityMD clinic team a message. Include your Shopify order number or Kit ID, never patient details.' })),
        h('button', { class: 'button button--ghost', type: 'button', onclick: () => { state.tab = 'messages'; renderPortal(); renderNewThread(global.document.getElementById('panel')); } }, 'Message the team ', h('span', { class: 'arrow', 'aria-hidden': 'true' }))));
    panel.setAttribute('aria-labelledby', `tab-${state.tab}`);
    if (state.tab === 'kits') renderKits(panel);
    if (state.tab === 'documents') renderDocuments(panel);
    if (state.tab === 'messages') renderThreads(panel);
  }

  // Kits

  const scanner = { stream: null, detector: null, running: false, canvas: null };

  async function startScanner(video, wrapper, onCode, notice) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setNotice(notice, 'warn', 'Camera scanning is not available on this device. Enter the Kit ID instead.');
      return;
    }
    try {
      scanner.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    } catch (error) {
      setNotice(notice, 'warn', 'Camera access was not granted. You can enter the Kit ID by hand.');
      return;
    }
    if ('BarcodeDetector' in global) {
      try {
        const supported = global.BarcodeDetector.getSupportedFormats ? await global.BarcodeDetector.getSupportedFormats() : [];
        const formats = ['code_128', 'qr_code', 'data_matrix'].filter((format) => !supported.length || supported.includes(format));
        scanner.detector = new global.BarcodeDetector({ formats });
      } catch (error) {
        scanner.detector = null;
      }
    }
    video.srcObject = scanner.stream;
    wrapper.hidden = false;
    await video.play();
    scanner.running = true;
    scanner.canvas = scanner.canvas || global.document.createElement('canvas');
    const tick = async () => {
      if (!scanner.running) return;
      let value = null;
      try {
        if (scanner.detector) {
          const codes = await scanner.detector.detect(video);
          value = codes.length ? codes[0].rawValue : null;
        } else if (global.PathwayCode128Decoder && video.videoWidth) {
          const width = Math.min(960, video.videoWidth);
          const height = Math.round(video.videoHeight * (width / video.videoWidth));
          scanner.canvas.width = width;
          scanner.canvas.height = height;
          const context = scanner.canvas.getContext('2d', { willReadFrequently: true });
          context.drawImage(video, 0, 0, width, height);
          value = global.PathwayCode128Decoder.decodeCode128ImageData(context.getImageData(0, Math.round(height * .3), width, Math.round(height * .4)));
        }
      } catch (error) {
        value = null;
      }
      if (value) {
        stopScanner(wrapper);
        onCode(String(value).trim());
        return;
      }
      global.setTimeout(tick, 180);
    };
    tick();
  }

  function stopScanner(wrapper) {
    scanner.running = false;
    if (scanner.stream) scanner.stream.getTracks().forEach((track) => track.stop());
    scanner.stream = null;
    if (wrapper) wrapper.hidden = true;
  }

  function renderKits(panel) {
    const notice = h('div', { class: 'notice', hidden: true, role: 'status', 'aria-live': 'polite' });
    const input = h('input', {
      type: 'text', id: 'kit-id', name: 'kitId', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', maxlength: '64',
      placeholder: state.session.options.kitIdExample || 'Kit ID from the label', 'aria-describedby': 'kit-help',
    });
    const video = h('video', { playsinline: true, muted: true, 'aria-label': 'Camera preview' });
    const scannerBox = h('div', { class: 'scanner', hidden: true }, video, h('div', { class: 'scanner__guide', 'aria-hidden': 'true' }));
    const submit = h('button', { class: 'button', type: 'submit', text: 'Register kit' });
    let source = 'manual';

    const form = h('form', { class: 'feature-card', novalidate: true },
      h('p', { class: 'eyebrow', text: 'Secure clinic record' }),
      h('h3', { text: 'Register a kit' }),
      h('p', { class: 'signed-in', text: `Signed in as ${state.session.customer.email}` }),
      notice,
      h('div', { class: 'scan-box' },
        h('div', { class: 'stack' },
          scannerBox,
          h('div', { class: 'button-row' },
            h('button', { class: 'button button--ghost', type: 'button', id: 'scan-button', onclick: () => startScanner(video, scannerBox, (code) => {
              input.value = code.toUpperCase();
              source = 'scan';
              setNotice(notice, 'info', `Scanned ${input.value}. Check it matches the label, then register.`);
              submit.focus();
            }, notice), text: 'Scan with camera' }),
            h('button', { class: 'button button--ghost button--small', type: 'button', onclick: () => stopScanner(scannerBox), text: 'Stop camera' }))),
        h('div', {},
          h('label', { for: 'kit-id', text: 'Kit ID' }),
          h('div', { class: 'kit-entry' }, input, submit),
          h('p', { class: 'field-help', id: 'kit-help', text: 'Camera images are processed only on this device and never uploaded.' }))));

    input.addEventListener('input', () => { source = 'manual'; });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const kitId = input.value.trim().toUpperCase();
      if (!kitId) {
        setNotice(notice, 'error', 'Enter or scan a Kit ID.');
        input.focus();
        return;
      }
      submit.disabled = true;
      try {
        const result = await api('/kits', { method: 'POST', body: { kitId, source } });
        setNotice(notice, 'ok', result.created ? `Kit ${result.kit.kitId} is registered to your clinic.` : `Kit ${result.kit.kitId} was already registered to your clinic.`);
        input.value = '';
        source = 'manual';
        // Shopify's metaobject search lags a few seconds behind writes, so the
        // fresh list can miss the kit just registered. Keep it from the response.
        const kits = (await api('/kits')).kits;
        state.kits = kits.some((kit) => kit.kitId === result.kit.kitId) ? kits : [result.kit, ...kits];
        renderKitList(listWrap);
        const counters = global.document.querySelectorAll('.stat strong');
        if (counters.length >= 2) {
          counters[0].textContent = String(state.kits.length);
          counters[1].textContent = String(state.kits.filter((kit) => !['complete', 'cancelled'].includes(kit.status)).length);
        }
        input.focus();
      } catch (error) {
        setNotice(notice, 'error', error.message);
      } finally {
        submit.disabled = false;
      }
    });

    const search = h('input', { type: 'search', placeholder: 'Search Kit ID', 'aria-label': 'Search kits', value: state.kitFilter.q });
    const filter = h('select', { 'aria-label': 'Filter by status' },
      h('option', { value: '', text: 'All statuses' }),
      ['registered', 'assigned', 'kit_received', 'processing', 'report_ready', 'complete', 'cancelled']
        .map((status) => h('option', { value: status, text: STATUS_LABELS[status], selected: state.kitFilter.status === status })));
    const listWrap = h('div');
    search.addEventListener('input', () => { state.kitFilter.q = search.value; renderKitList(listWrap); });
    filter.addEventListener('change', () => { state.kitFilter.status = filter.value; renderKitList(listWrap); });

    const feature = h('section', { class: 'feature' },
      h('div', { class: 'feature-copy' },
        h('p', { class: 'eyebrow', text: 'Secure kit registration' }),
        h('h2', { text: 'Scan or enter each kit as it arrives.' }),
        h('p', { class: 'copy', text: 'Registration links a kit to your clinic account so you can follow its progress. No patient details are needed.' }),
        h('div', { class: 'privacy-note' },
          h('span', { 'aria-hidden': 'true', text: '!' }),
          h('div', {},
            h('strong', { text: 'Kit ID only.' }),
            h('p', { text: 'Do not enter patient names, dates of birth, diagnoses, test results, or medication information anywhere in this portal.' }))),
        h('ul', {},
          h('li', {}, h('span', { text: '1' }), 'Find the barcode label on the BioBlueprint kit.'),
          h('li', {}, h('span', { text: '2' }), 'Scan it with your camera, or type the Kit ID.'),
          h('li', {}, h('span', { text: '3' }), 'Follow its status below as the lab updates it.'))),
      form);

    panel.append(feature, h('section', { class: 'card' },
      h('div', { class: 'panel-heading' },
        h('div', {},
          h('p', { class: 'eyebrow', text: 'Clinic kit records' }),
          h('h2', { text: 'Your kits' }),
          h('p', { class: 'muted', text: 'Search kits registered to this clinic account. Select a kit to see its timeline.' }))),
      h('div', { class: 'toolbar' }, search, filter),
      listWrap));
    renderKitList(listWrap);
  }

  function renderKitList(container) {
    const query = state.kitFilter.q.trim().toUpperCase();
    const kits = state.kits.filter((kit) => (!query || kit.kitId.includes(query)) && (!state.kitFilter.status || kit.status === state.kitFilter.status));
    if (!kits.length) {
      container.replaceChildren(h('p', { class: 'empty', text: state.kits.length ? 'No kits match your search.' : 'No kits registered yet. Scan or enter your first Kit ID above.' }));
      return;
    }
    container.replaceChildren(h('ul', { class: 'list' }, kits.map((kit) => h('li', {},
      h('button', { class: 'row-button', type: 'button', onclick: () => openKit(kit), 'aria-label': `Kit ${kit.kitId}, ${STATUS_LABELS[kit.status] || kit.status}. View timeline.` },
        h('span', { class: 'row-title', text: kit.kitId }),
        statusPill(kit.status),
        h('span', { class: 'row-meta', text: `Registered ${formatDate(kit.registeredAt)}${kit.legacy ? ' · earlier portal record' : ''}` }))))));
  }

  async function openKit(kit) {
    const panel = global.document.getElementById('panel');
    const back = h('button', { class: 'button button--ghost button--small', type: 'button', onclick: () => renderPortal(), text: '← All kits' });
    const body = h('div', {}, h('span', { class: 'spinner', 'aria-label': 'Loading' }));
    panel.replaceChildren(h('section', { class: 'card' }, back, h('h2', { class: 'row-title', text: `Kit ${kit.kitId}` }), body));
    panel.focus();
    if (kit.legacy) {
      body.replaceChildren(h('p', {}, statusPill(kit.status)),
        h('p', { class: 'muted', text: `This kit was assigned through the earlier clinic portal on ${formatDate(kit.registeredAt)}. Contact the TrinityMD team for its detailed history.` }));
      return;
    }
    try {
      const detail = await api(`/kits/${encodeURIComponent(kit.kitId)}`);
      body.replaceChildren(
        h('p', {}, statusPill(detail.kit.status)),
        h('ol', { class: 'timeline', 'aria-label': 'Kit timeline' }, detail.timeline.map((event) => h('li', {},
          h('strong', { text: event.type === 'registered' ? 'Registered by your clinic' : event.type === 'reassigned' ? 'Assigned to your clinic by TrinityMD' : `Status: ${STATUS_LABELS[event.to] || event.to}` }),
          h('time', { datetime: event.at, text: formatDate(event.at, true) }),
          event.note ? h('p', { class: 'muted', text: event.note }) : null))),
        h('button', { class: 'button button--ghost', type: 'button', onclick: () => { state.tab = 'messages'; renderPortal(); renderNewThread(global.document.getElementById('panel'), kit.kitId); }, text: 'Ask about this kit' }));
    } catch (error) {
      body.replaceChildren(h('div', { class: 'notice notice--error', text: error.message }));
    }
  }

  // Documents

  function renderDocuments(panel) {
    const heading = h('div', { class: 'panel-heading' },
      h('div', {},
        h('p', { class: 'eyebrow', text: 'BioBlueprint resource center' }),
        h('h2', { text: 'Education materials' }),
        h('p', { class: 'muted', text: 'Download approved resources for staff education and provider-guided client conversations.' })));
    const grid = state.documents.length
      ? h('div', { class: 'docs' }, state.documents.map((document) => {
        const href = `${apiBase}/documents/${document.id.split('/').pop()}/file`;
        const clinicOnly = document.audience === 'clinic';
        return h('article', { class: 'doc' },
          h('span', { class: `doc-icon${clinicOnly ? ' doc-icon--clinic' : ''}`, 'aria-hidden': 'true', text: document.contentType === 'application/pdf' ? 'PDF' : 'IMG' }),
          h('div', { class: 'doc-body' },
            h('small', { text: `${document.category}${clinicOnly ? ' · Clinic only' : ''}` }),
            h('h3', { text: document.title }),
            document.description ? h('p', { text: document.description }) : null,
            h('p', { class: 'doc-meta', text: `Version ${document.version} · ${formatDate(`${document.publishedDate}T12:00:00`)}` }),
            h('div', { class: 'button-row' },
              h('a', { class: 'button button--small', href, target: '_blank', rel: 'noopener', text: 'View' }),
              h('a', { class: 'button button--ghost button--small', href: `${href}?download=1`, text: 'Download' }))));
      }))
      : h('p', { class: 'empty', text: 'No documents are published yet.' });
    panel.append(h('section', { class: 'card' }, heading, grid,
      h('p', { class: 'education-note', text: 'BioBlueprint resources support provider-guided wellness discussions and do not replace clinical judgment or prescribe treatment.' })));
  }

  // Messages

  function phiWarning() {
    return h('div', { class: 'notice notice--warn', text: 'For business and kit-status questions only. Do not include patient names, dates of birth, test results, diagnoses, or other health information.' });
  }

  function renderThreads(panel) {
    panel.append(h('section', { class: 'card' },
      h('div', { class: 'toolbar' },
        h('h2', { class: 'toolbar-title', text: 'Messages with TrinityMD' }),
        h('button', { class: 'button', type: 'button', onclick: () => renderNewThread(panel), text: 'New message' })),
      state.threads.length
        ? h('ul', { class: 'list' }, state.threads.map((thread) => h('li', {},
          h('button', { class: 'row-button', type: 'button', onclick: () => openThread(thread.id) },
            h('span', { class: 'row-title row-title--text' }, thread.unread ? h('span', { class: 'unread-dot', 'aria-label': 'Unread' }) : null, thread.subject),
            statusPill(thread.status),
            h('span', { class: 'row-meta', text: `${CATEGORY_LABELS[thread.category] || thread.category}${thread.kitId ? ` · Kit ${thread.kitId}` : ''} · Last update ${formatDate(thread.lastMessageAt, true)}` })))))
        : h('p', { class: 'empty', text: 'No conversations yet.' })));
  }

  function renderNewThread(panel, kitId) {
    const notice = h('div', { class: 'notice', hidden: true, role: 'status' });
    const submit = h('button', { class: 'button', type: 'submit', text: 'Send message' });
    const kitSelect = h('select', {}, h('option', { value: '', text: 'No specific kit' }),
      state.kits.map((kit) => h('option', { value: kit.kitId, text: kit.kitId, selected: kit.kitId === kitId })));
    const category = h('select', {}, state.session.options.messageCategories.map((value) => h('option', { value, text: CATEGORY_LABELS[value] || value, selected: kitId ? value === 'kit_status' : value === 'general' })));
    const formRequestId = requestId();
    const form = h('form', { class: 'card', novalidate: true },
      h('button', { class: 'button button--ghost button--small', type: 'button', onclick: () => renderPortal(), text: '← Messages' }),
      h('h2', { text: 'New message' }),
      phiWarning(),
      notice,
      field('category', 'Topic', category),
      field('kitId', 'Related kit', kitSelect),
      field('subject', 'Subject', h('input', { type: 'text', maxlength: '120' }), { required: true }),
      field('body', 'Message', h('textarea', { maxlength: '4000' }), { required: true }),
      h('div', { class: 'button-row' }, submit));
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      clearErrors(form);
      const data = Object.fromEntries(new FormData(form).entries());
      if (!data.subject.trim()) return showFieldError(form, 'subject', 'Add a subject.');
      if (!data.body.trim()) return showFieldError(form, 'body', 'Write a message.');
      submit.disabled = true;
      try {
        const { thread } = await api('/threads', { method: 'POST', body: { ...data, requestId: formRequestId } });
        state.threads = (await api('/threads')).threads;
        openThread(thread.id);
      } catch (error) {
        if (!(error.field && showFieldError(form, error.field, error.message))) setNotice(notice, 'error', error.message);
        submit.disabled = false;
      }
      return undefined;
    });
    panel.replaceChildren(form);
    form.subject.focus();
  }

  async function openThread(id) {
    const panel = global.document.getElementById('panel');
    panel.replaceChildren(h('div', { class: 'card' }, h('span', { class: 'spinner', 'aria-label': 'Loading' })));
    let detail;
    try {
      detail = await api(`/threads/${id.split('/').pop()}`);
    } catch (error) {
      panel.replaceChildren(h('div', { class: 'notice notice--error', text: error.message }));
      return;
    }
    const known = state.threads.find((thread) => thread.id === id);
    if (known) known.unread = false;
    const notice = h('div', { class: 'notice', hidden: true, role: 'status' });
    const textarea = h('textarea', { id: 'reply', name: 'body', maxlength: '4000', 'aria-label': 'Reply' });
    const submit = h('button', { class: 'button', type: 'submit', text: 'Send reply' });
    let replyRequestId = requestId();
    const closed = detail.thread.status === 'closed';
    const form = h('form', { novalidate: true }, phiWarning(), notice, textarea, h('div', { class: 'button-row mt' }, submit));
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!textarea.value.trim()) {
        setNotice(notice, 'error', 'Write a reply first.');
        return;
      }
      submit.disabled = true;
      try {
        await api(`/threads/${id.split('/').pop()}/messages`, { method: 'POST', body: { body: textarea.value, requestId: replyRequestId } });
        replyRequestId = requestId();
        openThread(id);
      } catch (error) {
        setNotice(notice, 'error', error.message);
        submit.disabled = false;
      }
    });
    panel.replaceChildren(h('section', { class: 'card' },
      h('button', { class: 'button button--ghost button--small', type: 'button', onclick: async () => { state.threads = (await api('/threads')).threads; renderPortal(); }, text: '← Messages' }),
      h('h2', { text: detail.thread.subject }),
      h('p', { class: 'muted' }, `${CATEGORY_LABELS[detail.thread.category] || detail.thread.category}${detail.thread.kitId ? ` · Kit ${detail.thread.kitId}` : ''} · `, statusPill(detail.thread.status)),
      h('div', { class: 'messages', role: 'log', 'aria-label': 'Conversation' }, detail.messages.map((message) => h('div', { class: `bubble bubble--${message.from}` },
        h('span', { class: 'visually-hidden', text: message.from === 'clinic' ? 'You wrote: ' : 'TrinityMD wrote: ' }),
        message.body,
        h('time', { datetime: message.at, text: formatDate(message.at, true) })))),
      closed ? h('p', { class: 'notice notice--info', text: 'This conversation is closed. Start a new message if you need more help.' }) : form));
  }

  // ---------- boot ----------

  async function start() {
    mount(h('div', { class: 'card' }, h('span', { class: 'spinner', 'aria-label': 'Loading' }), ' Loading your secure portal…'));
    try {
      await refreshSession();
    } catch (error) {
      mount(h('div', { class: 'notice notice--error', text: error.message }));
      return;
    }
    const session = state.session;
    if (!session.signedIn) return renderSignedOut();
    if (!session.isClinic) {
      if (session.application && (session.application.status === 'pending' || (session.application.status !== 'approved' && root.dataset.initialView !== 'apply'))) {
        return renderApplicationStatus(session.application);
      }
      return renderApplicationForm();
    }
    try {
      const [kits, documents, threads] = await Promise.all([api('/kits'), api('/documents'), api('/threads')]);
      state.kits = kits.kits;
      state.documents = documents.documents;
      state.threads = threads.threads;
    } catch (error) {
      mount(h('div', { class: 'notice notice--error', text: error.message }));
      return undefined;
    }
    renderPortal();
    return undefined;
  }

  start();
})(window);
