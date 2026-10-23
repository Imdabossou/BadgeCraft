// ════════════════════════════════════════════════════════════════════════════
// BadgeCraft app — accounts, organisations, events, reception check-in desk.
// The badge designer itself lives in designer.js (global `state`).
// ════════════════════════════════════════════════════════════════════════════

const API = '/api';
const BC = {
  token: null,
  user: null,
  orgs: [],
  activeOrgId: null,
  members: {},          // user id → name, for "checked in by"
  events: [],
  event: null,          // active event
  attendees: [],
  designs: [],          // saved designs in this org [{id, name}]
  designCache: {},      // id → normalized design (for printing)
  loadedDesignId: null, // design currently open in the designer
  designDirty: false,
  tab: 'desk',
  ws: null,
  wsPing: null,
  selected: new Set(),  // attendee table selection
  deskIndex: 0,
  deskResults: [],
};

const FIELD_ORDER = ['first_name', 'last_name', 'name', 'email', 'company', 'job_title', 'ticket_class_name'];
const SOURCE_LABELS = {
  eventbrite: 'Eventbrite', csv: 'CSV import', manual: 'Added', walk_in: 'Walk-in',
  registration: 'Signed up', import: 'Imported',
};

const $ = id => document.getElementById(id);
const orgPath = path => `/orgs/${BC.activeOrgId}${path}`;
const isAdmin = () => ['admin', 'owner'].includes(BC.orgs.find(o => o.id === BC.activeOrgId)?.role);

// ─── API ────────────────────────────────────────────────────────────────────

async function bcFetch(path, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (BC.token) headers['Authorization'] = 'Bearer ' + BC.token;
  const res = await fetch(API + path, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 401 && BC.token && !path.startsWith('/auth/')) {
      authLogout();
      throw new Error('Your session has expired — please sign in again');
    }
    const detail = Array.isArray(err.detail) ? err.detail.map(d => d.msg).join(', ') : err.detail;
    throw new Error(detail || `Request failed (${res.status})`);
  }
  return res.json();
}

// File downloads need the token in the URL (plain link, no headers)
function downloadUrl(path) {
  const a = document.createElement('a');
  a.href = `${API}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(BC.token)}`;
  a.click();
}

function storeGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function storeSet(key, value) { try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { } }

// ─── Bootstrap & auth ─────────────────────────────────────────────────────────

async function bcInit() {
  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get('token');
  const inviteCode = params.get('invite');
  if (urlToken) storeSet('bc_token', urlToken);
  if (inviteCode) storeSet('bc_pending_invite', inviteCode);
  if (urlToken || inviteCode || params.get('error')) window.history.replaceState({}, '', '/');
  if (params.get('error')) showToast('Google sign-in failed — please try again', 'error');

  BC.token = storeGet('bc_token');
  const pendingInvite = storeGet('bc_pending_invite');
  if (pendingInvite) await showInviteBanner(pendingInvite);

  if (!BC.token) return showAuthOverlay();
  try {
    await loadMe();
    const savedOrg = +storeGet('bc_active_org');
    BC.activeOrgId = BC.orgs.find(o => o.id === savedOrg) ? savedOrg : (BC.orgs[0]?.id || null);
    onAuthSuccess();
  } catch (e) {
    storeSet('bc_token', null);
    BC.token = null;
    showAuthOverlay();
  }
}

async function loadMe() {
  const me = await bcFetch('/auth/me');
  BC.user = me;
  BC.orgs = me.organisations || [];
}

function showAuthOverlay() { $('auth-overlay').classList.remove('hidden'); setTimeout(() => $('login-email').focus(), 50); }
function hideAuthOverlay() { $('auth-overlay').classList.add('hidden'); }

function authSwitchTab(tab) {
  $('tab-login').classList.toggle('active', tab === 'login');
  $('tab-register').classList.toggle('active', tab === 'register');
  $('form-login').classList.toggle('hidden', tab !== 'login');
  $('form-register').classList.toggle('hidden', tab !== 'register');
}

async function showInviteBanner(code) {
  try {
    const res = await fetch(API + '/invites/' + encodeURIComponent(code));
    if (!res.ok) throw new Error();
    const inv = await res.json();
    $('auth-invite-text').textContent = `You've been invited to join "${inv.org_name}" as ${inv.role}. Sign in or create an account to accept.`;
    $('auth-invite-banner').classList.add('show');
  } catch {
    storeSet('bc_pending_invite', null);
  }
}

async function authSubmit(kind) {
  const isLogin = kind === 'login';
  const errEl = $(isLogin ? 'login-error' : 'reg-error');
  const btn = $(isLogin ? 'login-btn' : 'reg-btn');
  const body = isLogin
    ? { email: $('login-email').value.trim(), password: $('login-password').value }
    : { name: $('reg-name').value.trim(), email: $('reg-email').value.trim(), password: $('reg-password').value };
  errEl.style.display = 'none';
  if (Object.values(body).some(v => !v)) { errEl.textContent = 'Please fill in all fields'; errEl.style.display = 'block'; return; }
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = isLogin ? 'Signing in…' : 'Creating account…';
  try {
    const res = await bcFetch(isLogin ? '/auth/login' : '/auth/register', { method: 'POST', body });
    BC.token = res.token;
    storeSet('bc_token', BC.token);
    await loadMe();
    BC.activeOrgId = BC.orgs[0]?.id || null;
    onAuthSuccess();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}
function authLogin() { return authSubmit('login'); }
function authRegister() { return authSubmit('register'); }

async function authGoogle() {
  try {
    const res = await bcFetch('/auth/google');
    window.location.href = res.url;
  } catch (e) { showToast(e.message, 'error'); }
}

function authLogout() {
  disconnectWS();
  BC.token = null; BC.user = null; BC.orgs = []; BC.activeOrgId = null;
  BC.event = null; BC.attendees = [];
  storeSet('bc_token', null);
  storeSet('bc_active_org', null);
  toggleUserMenu(false);
  $('reception-event-workspace').style.display = 'none';
  $('reception-empty').style.display = '';
  showAuthOverlay();
}

async function onAuthSuccess() {
  hideAuthOverlay();

  const pendingInvite = storeGet('bc_pending_invite');
  if (pendingInvite) {
    storeSet('bc_pending_invite', null);
    try {
      const res = await bcFetch('/invites/' + encodeURIComponent(pendingInvite) + '/accept', { method: 'POST' });
      await loadMe();
      BC.activeOrgId = res.org_id;
      showToast(`Joined "${res.org_name}" as ${res.role}`, 'success');
    } catch (e) {
      showToast('Could not accept invite: ' + e.message, 'error');
    }
  }

  updateUserMenu();
  if (!BC.orgs.length) {
    showCreateOrgModal(true);
  } else {
    bcActivateOrg(BC.activeOrgId || BC.orgs[0].id);
  }
}

// ─── Organisations ────────────────────────────────────────────────────────────

function updateUserMenu() {
  if (!BC.user) return;
  $('user-menu-wrap').style.display = 'flex';
  const avatarBtn = $('user-avatar-btn');
  if (BC.user.avatar) {
    avatarBtn.innerHTML = `<img src="${esc(BC.user.avatar)}" alt="" referrerpolicy="no-referrer">`;
  } else {
    avatarBtn.textContent = (BC.user.name || '?')[0].toUpperCase();
  }
  $('dd-user-name').textContent = BC.user.name;
  $('dd-user-email').textContent = BC.user.email;
  $('dd-org-list').innerHTML = BC.orgs.map(o => `
    <div class="org-item ${o.id === BC.activeOrgId ? 'active' : ''}" onclick="bcActivateOrg(${o.id})">
      <span>${esc(o.name)}</span>
      <span class="org-item-role">${esc(o.role)}</span>
    </div>`).join('');
}

function toggleUserMenu(force) {
  const dd = $('user-dropdown');
  dd.classList.toggle('open', force !== undefined ? force : !dd.classList.contains('open'));
}
document.addEventListener('click', e => {
  if (!$('user-menu-wrap')?.contains(e.target)) toggleUserMenu(false);
});

async function bcActivateOrg(orgId) {
  const switching = BC.activeOrgId !== orgId;
  BC.activeOrgId = orgId;
  storeSet('bc_active_org', orgId);
  updateUserMenu();
  toggleUserMenu(false);
  document.body.classList.toggle('is-admin', isAdmin());
  if (switching) closeEvent();
  BC.designCache = {};
  try {
    const org = await bcFetch(orgPath(''));
    BC.members = Object.fromEntries(org.members.map(m => [m.user_id, m.name]));
    BC.orgHasEventbrite = org.has_eventbrite;
  } catch { BC.members = {}; }
  await Promise.all([fetchCloudDesigns(), loadEvents()]);
}

function showCreateOrgModal(firstRun = false) {
  toggleUserMenu(false);
  $('org-name-input').value = '';
  $('org-error').style.display = 'none';
  $('org-setup-title').textContent = firstRun ? 'Welcome to BadgeCraft 👋' : 'New organisation';
  $('org-setup-cancel').style.display = BC.orgs.length ? 'block' : 'none';
  $('org-setup-overlay').classList.remove('hidden');
  setTimeout(() => $('org-name-input').focus(), 50);
}

function closeCreateOrgModal() { $('org-setup-overlay').classList.add('hidden'); }

async function createOrg() {
  const name = $('org-name-input').value.trim();
  const errEl = $('org-error');
  if (!name) { errEl.textContent = 'Please enter an organisation name'; errEl.style.display = 'block'; return; }
  try {
    const org = await bcFetch('/orgs', { method: 'POST', body: { name } });
    BC.orgs.push(org);
    closeCreateOrgModal();
    bcActivateOrg(org.id);
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  }
}

async function showOrgSettings() {
  toggleUserMenu(false);
  if (!BC.activeOrgId) return;
  try {
    const org = await bcFetch(orgPath(''));
    const role = BC.orgs.find(o => o.id === BC.activeOrgId)?.role || 'member';
    const admin = ['admin', 'owner'].includes(role);

    const memberRows = org.members.map(m => {
      const isSelf = m.user_id === BC.user?.id;
      const canManage = admin && !isSelf && m.role !== 'owner' && !(role === 'admin' && m.role === 'admin');
      const roleControl = role === 'owner' && !isSelf && m.role !== 'owner'
        ? `<select class="select-sm" onchange="setMemberRole(${m.user_id}, this.value)">
             <option value="member" ${m.role === 'member' ? 'selected' : ''}>member</option>
             <option value="admin" ${m.role === 'admin' ? 'selected' : ''}>admin</option>
           </select>`
        : `<span class="role-badge ${esc(m.role)}">${esc(m.role)}</span>`;
      return `
      <div class="org-member-row">
        <div class="org-member-avatar">${esc((m.name || '?')[0].toUpperCase())}</div>
        <div class="org-member-info">
          <div class="org-member-name">${esc(m.name)}${isSelf ? ' (you)' : ''}</div>
          <div class="org-member-email">${esc(m.email)}</div>
        </div>
        ${roleControl}
        ${canManage ? `<button class="btn btn-sm" onclick="removeMember(${m.user_id})">Remove</button>` : ''}
      </div>`;
    }).join('');

    const inviteSection = admin ? `
      <div class="eb-step-label" style="margin-top:8px">Invite people</div>
      <p class="hint">Members can run the check-in desk and add walk-ins. Admins can also create events, import attendees and change settings.</p>
      <div style="display:flex;gap:8px">
        <input class="eb-input" id="invite-email" type="email" placeholder="Email (optional — leave blank for a link)">
        <select id="invite-role" class="select-sm">
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
        <button class="btn primary" onclick="sendInvite()" style="white-space:nowrap">Invite</button>
      </div>
      <div id="invite-result" class="hint"></div>` : '';

    const tokenSection = admin ? `
      <div class="eb-step-label" style="margin-top:8px">Eventbrite private token</div>
      <p class="hint">Shared by your organisation for importing and syncing Eventbrite events. Find it in Eventbrite under Account Settings → Developer Links → API Keys.</p>
      <div style="display:flex;gap:8px">
        <input class="eb-input" id="org-eb-token" type="password" autocomplete="off" placeholder="${org.has_eventbrite ? 'Token saved — paste a new one to replace it' : 'Paste your Eventbrite private token'}">
        <button class="btn primary" onclick="saveOrgToken('org-eb-token', 'token-save-result')" style="white-space:nowrap">Save token</button>
      </div>
      <div id="token-save-result" class="hint"></div>` : '';

    let modal = $('org-settings-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'org-settings-modal';
      modal.className = 'eb-modal-overlay';
      modal.onclick = e => { if (e.target === modal) modal.classList.remove('open'); };
      document.body.appendChild(modal);
    }
    modal.innerHTML = `
      <div class="eb-modal" style="width:min(600px,96vw)">
        <div class="eb-modal-header">
          <h3>⚙️ ${esc(org.name)}</h3>
          <button class="modal-x" onclick="$('org-settings-modal').classList.remove('open')">✕</button>
        </div>
        <div class="eb-modal-body">
          <div class="eb-step-label">Members (${org.members.length})</div>
          <div>${memberRows}</div>
          ${inviteSection}
          ${tokenSection}
        </div>
      </div>`;
    modal.classList.add('open');
  } catch (e) {
    showAlert('Could not load settings', e.message);
  }
}

async function sendInvite() {
  const email = $('invite-email')?.value.trim();
  const role = $('invite-role')?.value || 'member';
  const resultEl = $('invite-result');
  try {
    const res = await bcFetch(orgPath('/invites'), { method: 'POST', body: { email: email || null, role } });
    resultEl.innerHTML = `${email ? `Invite sent to ${esc(email)}. ` : ''}Link: <a href="${esc(res.link)}">${esc(res.link)}</a>
      <button class="btn btn-sm" onclick="navigator.clipboard.writeText(${esc(JSON.stringify(res.link))}); showToast('Link copied')">Copy</button>`;
  } catch (e) {
    resultEl.textContent = '❌ ' + e.message;
  }
}

async function removeMember(userId) {
  if (!await askConfirm('Remove member', 'Remove this person from the organisation?', 'Remove', true)) return;
  try {
    await bcFetch(orgPath(`/members/${userId}`), { method: 'DELETE' });
    showOrgSettings();
  } catch (e) { showAlert('Error', e.message); }
}

async function setMemberRole(userId, role) {
  try {
    await bcFetch(orgPath(`/members/${userId}/role`), { method: 'PATCH', body: { role } });
    showToast('Role updated', 'success');
  } catch (e) { showAlert('Error', e.message); showOrgSettings(); }
}

async function saveOrgToken(inputId, resultId) {
  const token = $(inputId)?.value.trim();
  const resultEl = $(resultId);
  if (!token) return false;
  try {
    await bcFetch(orgPath(''), { method: 'PATCH', body: { eventbrite_token: token } });
    BC.orgHasEventbrite = true;
    if (resultEl) { resultEl.style.color = 'var(--success)'; resultEl.textContent = '✓ Token saved'; }
    return true;
  } catch (e) {
    if (resultEl) { resultEl.style.color = 'var(--danger)'; resultEl.textContent = '❌ ' + e.message; }
    return false;
  }
}

// ─── Events list ──────────────────────────────────────────────────────────────

function eventKeyStore() { return `bc_active_event_${BC.activeOrgId}`; }

async function loadEvents() {
  const list = $('events-list');
  try {
    BC.events = await bcFetch(orgPath('/events'));
  } catch (e) {
    list.innerHTML = `<div class="list-empty error">${esc(e.message)}</div>`;
    return;
  }
  renderEventsList();
  if (!BC.event) {
    const saved = storeGet(eventKeyStore());
    if (saved && BC.events.some(e => e.event_id === saved)) selectEvent(saved);
  }
}

function formatDate(d, opts = { day: 'numeric', month: 'short', year: 'numeric' }) {
  if (!d) return '';
  const date = new Date(d.length === 10 ? d + 'T00:00:00' : d);
  return isNaN(date) ? d : date.toLocaleDateString('en-GB', opts);
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + (today ? '' : ' ' + d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }));
}

function renderEventsList() {
  const list = $('events-list');
  if (!BC.events.length) {
    list.innerHTML = `<div class="list-empty">No events yet.${isAdmin() ? '<br>Create one or import from Eventbrite.' : '<br>Ask an admin to create one.'}</div>`;
    return;
  }
  list.innerHTML = BC.events.map(e => {
    const active = e.event_id === BC.event?.event_id;
    const eb = e.source === 'eventbrite';
    return `
      <div class="event-card ${active ? 'active' : ''}" data-event-id="${esc(e.event_id)}" onclick="selectEvent(this.dataset.eventId)">
        <div class="event-card-top">
          <div class="event-card-name">${esc(e.name)}</div>
          <span class="event-card-badge ${eb ? 'live' : 'manual'}">${eb ? 'Eventbrite' : 'Self-hosted'}</span>
        </div>
        <div class="event-card-meta">
          ${e.start_date ? `<span>${esc(formatDate(e.start_date))}</span>` : ''}
          ${e.location ? `<span>${esc(e.location)}</span>` : ''}
        </div>
        <div class="event-card-stats">
          <div class="event-stat"><span class="event-stat-num">${e.attendee_count - e.cancelled_count}</span> attendees</div>
          <div class="event-stat"><span class="event-stat-num" style="color:var(--success)">${e.checked_in_count}</span> checked in</div>
        </div>
      </div>`;
  }).join('');
}

// Keep the sidebar card for the active event in step with live changes
function refreshActiveEventCard() {
  if (!BC.event) return;
  const ev = BC.events.find(e => e.event_id === BC.event.event_id);
  if (!ev) return;
  ev.attendee_count = BC.attendees.length;
  ev.cancelled_count = BC.attendees.filter(a => a.cancelled).length;
  ev.checked_in_count = BC.attendees.filter(a => a.checked_in).length;
  renderEventsList();
}

// ─── Event workspace ─────────────────────────────────────────────────────────

async function selectEvent(eventId) {
  const ev = BC.events.find(e => e.event_id === eventId);
  if (!ev) return;
  const changed = BC.event?.event_id !== eventId;
  BC.event = ev;
  storeSet(eventKeyStore(), eventId);
  document.querySelector('#tab-reception').classList.add('has-event');
  $('reception-empty').style.display = 'none';
  $('reception-event-workspace').style.display = 'flex';
  $('eb-sync-btn').style.display = ev.source === 'eventbrite' ? '' : 'none';
  renderEventsList();
  renderHeaderContext();

  if (changed) {
    BC.attendees = [];
    BC.selected.clear();
    $('desk-search').value = '';
    $('att-search').value = '';
    connectWS();
    await Promise.all([loadAttendees(), loadEventDesign()]);
  }
  const savedTab = storeGet('bc_tab');
  switchSubtab(changed ? (savedTab && $('subnav-btn-' + savedTab) && (savedTab !== 'settings' || isAdmin()) ? savedTab : 'desk') : BC.tab);
}

function closeEvent() {
  disconnectWS();
  BC.event = null;
  BC.attendees = [];
  storeSet(eventKeyStore(), null);
  document.querySelector('#tab-reception').classList.remove('has-event');
  $('reception-event-workspace').style.display = 'none';
  $('reception-empty').style.display = '';
  hideMobileDesignFABs();
  renderHeaderContext();
  renderEventsList();
}

function renderHeaderContext() {
  const ev = BC.event;
  $('header-context').innerHTML = ev
    ? `<span class="ctx-event">${esc(ev.name)}</span>${ev.start_date ? `<span class="ctx-sep">·</span><span>${esc(formatDate(ev.start_date))}</span>` : ''}`
    : '';
}

function switchSubtab(name) {
  if (name === 'settings' && !isAdmin()) name = 'desk';
  BC.tab = name;
  storeSet('bc_tab', name);
  document.querySelectorAll('.event-panel').forEach(p => p.classList.toggle('active', p.id === 'event-panel-' + name));
  document.querySelectorAll('.event-subnav-tab').forEach(t => t.classList.toggle('active', t.id === 'subnav-btn-' + name));

  if (isMobile()) { if (name === 'design') { showMobileDesignFABs(); toggleMobilePanel('left'); } else { hideMobileDesignFABs(); closeMobilePanels(); } }
  if (name === 'desk') { deskRender(); setTimeout(() => $('desk-search').focus(), 30); }
  if (name === 'attendees') attRender();
  if (name === 'design') { requestAnimationFrame(() => { updatePage(); redraw(); renderLayers(); renderProps(); updateRecordNav(); }); renderDesignStatus(); }
  if (name === 'layout') requestAnimationFrame(updateLayoutPreview);
  if (name === 'preview') renderPreview();
  if (name === 'print') { refreshPrintTab(); $('ps-design').textContent = designLabel(); }
  if (name === 'settings') renderSettings();
}

// ─── Attendees: data & realtime ──────────────────────────────────────────────

async function loadAttendees() {
  if (!BC.event) return;
  const eventId = BC.event.event_id;
  try {
    const list = await bcFetch(orgPath(`/events/${encodeURIComponent(eventId)}/attendees`));
    if (BC.event?.event_id !== eventId) return;
    BC.attendees = list;
  } catch (e) {
    showToast('Could not load attendees: ' + e.message, 'error');
  }
  onAttendeesChanged();
}

let renderQueued = false;
function onAttendeesChanged() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    syncDesignerData();
    updateDeskStats();
    refreshActiveEventCard();
    if (BC.tab === 'desk') deskRender();
    if (BC.tab === 'attendees') attRender();
    if (BC.tab === 'print') updatePrintSummary();
  });
}

function upsertAttendee(a) {
  const i = BC.attendees.findIndex(x => x.id === a.id);
  if (i === -1) BC.attendees.push(a); else BC.attendees[i] = a;
  onAttendeesChanged();
}

// Field keys for this event: the form fields first, then anything in the data
function eventFieldKeys() {
  const keys = (BC.event?.fields || []).map(f => f.key);
  const seen = new Set(keys);
  const extra = new Set();
  BC.attendees.forEach(a => Object.keys(a.data).forEach(k => { if (!seen.has(k)) extra.add(k); }));
  const ordered = [...FIELD_ORDER.filter(k => extra.has(k)), ...[...extra].filter(k => !FIELD_ORDER.includes(k))];
  return [...keys, ...ordered];
}

// The designer previews and exports use state.csvData / csvHeaders
function syncDesignerData() {
  state.csvHeaders = eventFieldKeys();
  state.csvData = BC.attendees.filter(a => !a.cancelled).map(a => ({ ...a.data }));
  updateStatus();
  updateRecordNav();
  redraw();
}

function sampleRecord() {
  const r = {};
  (BC.event?.fields || []).forEach(f => { r[f.key] = f.options?.[0] || ''; });
  return Object.assign(r, { first_name: 'Alex', last_name: 'Morgan', name: 'Alex Morgan', company: 'Example Ltd', job_title: 'Guest Speaker', email: 'alex@example.com' });
}

function connectWS() {
  disconnectWS();
  if (!BC.token || !BC.event) return;
  const eventId = BC.event.event_id;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/${BC.activeOrgId}/${encodeURIComponent(eventId)}?token=${encodeURIComponent(BC.token)}`);
  let wasOpen = false;
  ws.onopen = () => {
    if (wasOpen) return;
    wasOpen = true;
    if (ws._reconnect) loadAttendees(); // catch up on anything missed while offline
  };
  ws.onmessage = e => handleWSMessage(JSON.parse(e.data));
  ws.onclose = () => {
    $('online-count').style.display = 'none';
    if (BC.ws === ws && BC.event?.event_id === eventId) {
      setTimeout(() => {
        if (BC.ws === ws && BC.event?.event_id === eventId) { connectWS(); BC.ws._reconnect = true; }
      }, 3000);
    }
  };
  BC.ws = ws;
  BC.wsPing = setInterval(() => { if (ws.readyState === 1) ws.send('ping'); }, 25000);
}

function disconnectWS() {
  clearInterval(BC.wsPing);
  const ws = BC.ws;
  BC.ws = null;
  if (ws) ws.close();
  $('online-count').style.display = 'none';
}

function handleWSMessage(msg) {
  switch (msg.type) {
    case 'presence':
      $('online-count').style.display = msg.users_online > 1 ? 'flex' : 'none';
      $('online-num').textContent = msg.users_online;
      break;
    case 'attendee': {
      const isNew = !BC.attendees.some(a => a.id === msg.attendee.id);
      upsertAttendee(msg.attendee);
      if (isNew && msg.attendee.source === 'registration') {
        const name = recordName(msg.attendee.data) || 'Someone';
        if (msg.kiosk) showToast(`${name} signed in at the kiosk`, 'success', { label: 'Print badge', onClick: () => printForAttendees([msg.attendee.id]) });
        else showToast(`New registration: ${name}`);
      }
      break;
    }
    case 'attendee_deleted':
      BC.attendees = BC.attendees.filter(a => a.id !== msg.id);
      BC.selected.delete(msg.id);
      onAttendeesChanged();
      break;
    case 'reload':
      loadAttendees();
      break;
    case 'event':
      Object.assign(BC.event, msg.event);
      Object.assign(BC.events.find(e => e.event_id === msg.event.event_id) || {}, msg.event);
      renderEventsList();
      renderHeaderContext();
      if (BC.loadedDesignId !== BC.event.design_id && BC.event.design_id && !BC.designDirty) loadEventDesign();
      break;
    case 'event_deleted':
      showToast('This event was deleted', 'error');
      closeEvent();
      loadEvents();
      break;
  }
}

// ─── Check-in desk ───────────────────────────────────────────────────────────

const station = { autoprint: true, mode: 'badge' };
try { Object.assign(station, JSON.parse(storeGet('bc_station') || '{}')); } catch { }
$('opt-autoprint').checked = station.autoprint;
$('opt-print-mode').value = station.mode;

function saveStationPrefs() {
  station.autoprint = $('opt-autoprint').checked;
  station.mode = $('opt-print-mode').value;
  storeSet('bc_station', JSON.stringify(station));
  deskRender();
}

const searchCache = new WeakMap();
function searchText(a) {
  let s = searchCache.get(a);
  if (s === undefined) {
    s = [...Object.values(a.data), a.external_id].join(' ').toLowerCase();
    searchCache.set(a, s);
  }
  return s;
}

function sortKey(a) {
  const d = a.data;
  return ((d.last_name || '') + ' ' + (d.first_name || '') + ' ' + recordName(d)).trim().toLowerCase();
}

// A scanned barcode / order number / id that identifies exactly one attendee
function exactMatch(q) {
  const v = q.trim().toLowerCase();
  if (v.length < 4) return null;
  const hits = BC.attendees.filter(a =>
    [a.data.barcode, a.data.order_id, a.external_id].some(x => x && String(x).toLowerCase() === v));
  return hits.length === 1 ? hits[0] : null;
}

function updateDeskStats() {
  const live = BC.attendees.filter(a => !a.cancelled);
  const checked = live.filter(a => a.checked_in).length;
  $('ds-checked').textContent = checked;
  $('ds-total').textContent = live.length;
  $('ds-printed').textContent = live.filter(a => a.printed).length;
  $('ds-walkins').textContent = live.filter(a => a.source === 'walk_in').length;
  $('ds-progress').style.width = live.length ? (checked / live.length * 100) + '%' : '0';
}

function deskOnInput() {
  BC.deskIndex = 0;
  deskRender();
}

function deskRender() {
  const wrap = $('desk-results');
  if (!BC.event) return;
  const q = $('desk-search').value.trim().toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);

  if (!BC.attendees.length) {
    wrap.innerHTML = deskGettingStarted();
    BC.deskResults = [];
    return;
  }

  let results = tokens.length ? BC.attendees.filter(a => tokens.every(t => searchText(a).includes(t))) : [...BC.attendees];
  results.sort((a, b) => (tokens.length ? 0 : (a.checked_in - b.checked_in)) || sortKey(a).localeCompare(sortKey(b)));
  const LIMIT = 60;
  BC.deskResults = results.slice(0, LIMIT);
  if (BC.deskIndex >= BC.deskResults.length) BC.deskIndex = Math.max(0, BC.deskResults.length - 1);

  if (!results.length) {
    wrap.innerHTML = `
      <div class="desk-empty">
        <div class="desk-empty-title">No one matches “${esc($('desk-search').value.trim())}”</div>
        <p>Check the spelling, try their company or email, or register them now.</p>
        <button class="btn primary" onclick="openWalkIn(true)">+ Add “${esc($('desk-search').value.trim())}” as a walk-in</button>
      </div>`;
    return;
  }

  wrap.innerHTML = BC.deskResults.map((a, i) => deskCard(a, i)).join('') +
    (results.length > LIMIT ? `<div class="desk-more">Showing ${LIMIT} of ${results.length} — keep typing to narrow it down</div>` : '');
  wrap.querySelector('.desk-card.selected')?.scrollIntoView({ block: 'nearest' });
}

function initials(name) {
  return (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
}

function deskCard(a, i) {
  const d = a.data;
  const name = recordName(d) || d.email || '(no name)';
  const meta = [d.job_title, d.company].filter(Boolean).join(' · ');
  const tags = [];
  if (d.ticket_class_name) tags.push(`<span class="tag">${esc(d.ticket_class_name)}</span>`);
  const typeField = BC.event?.design_rules?.field;
  if (typeField && typeField !== 'ticket_class_name' && d[typeField]) tags.push(`<span class="tag">${esc(d[typeField])}</span>`);
  if (a.source === 'walk_in') tags.push('<span class="tag accent">Walk-in</span>');
  if (a.source === 'registration') tags.push('<span class="tag accent">Signed up</span>');
  if (a.cancelled) tags.push('<span class="tag danger">Ticket cancelled</span>');

  let status = '', actions;
  const checkLabel = station.autoprint ? 'Check in &amp; print' : 'Check in';
  if (a.checked_in) {
    const by = BC.members[a.checked_in_by];
    status = `<div class="desk-status ok">✓ Checked in ${esc(formatTime(a.checked_in_at))}${by ? ` by ${esc(by)}` : ''}${a.printed ? ` · badge printed${a.print_count > 1 ? ` ×${a.print_count}` : ''}` : ' · <b>badge not printed</b>'}</div>`;
    actions = `
      <button class="btn ${a.printed ? '' : 'primary'}" onclick="event.stopPropagation(); printForAttendees([${a.id}])">${a.printed ? 'Reprint' : 'Print badge'}</button>
      <button class="btn btn-ghost" onclick="event.stopPropagation(); undoCheckIn(${a.id})" title="Undo check-in">Undo</button>`;
  } else {
    if (a.printed) status = `<div class="desk-status">Badge printed in advance</div>`;
    actions = `
      <button class="btn primary" onclick="event.stopPropagation(); checkIn(${a.id})">${checkLabel}</button>
      ${station.autoprint ? `<button class="btn btn-ghost" onclick="event.stopPropagation(); checkIn(${a.id}, false)" title="Check in without printing">No badge</button>` : `<button class="btn btn-ghost" onclick="event.stopPropagation(); printForAttendees([${a.id}])">Print</button>`}`;
  }
  return `
    <div class="desk-card ${i === BC.deskIndex ? 'selected' : ''} ${a.checked_in ? 'checked' : ''} ${a.cancelled ? 'cancelled' : ''}" onclick="deskSelect(${i})" ondblclick="deskPrimary(${a.id})">
      <div class="desk-avatar">${a.checked_in ? '✓' : esc(initials(name))}</div>
      <div class="desk-info">
        <div class="desk-name">${esc(name)}</div>
        ${meta ? `<div class="desk-meta">${esc(meta)}</div>` : ''}
        ${tags.length ? `<div class="desk-tags">${tags.join('')}</div>` : ''}
        ${status}
      </div>
      <div class="desk-actions">
        ${actions}
        <button class="icon-btn" onclick="event.stopPropagation(); openAttendeeModal(${a.id})" title="Edit details">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 17l4-1 9-9-3-3-9 9-1 4z"/></svg>
        </button>
      </div>
    </div>`;
}

function deskGettingStarted() {
  const ev = BC.event;
  const hasDesign = !!ev.design_id;
  const admin = isAdmin();
  const step = (done, title, body, action) => `
    <div class="gs-step ${done ? 'done' : ''}">
      <div class="gs-check">${done ? '✓' : ''}</div>
      <div><b>${title}</b><p>${body}</p>${action || ''}</div>
    </div>`;
  return `
    <div class="getting-started">
      <h3>Get ready for the day</h3>
      ${step(hasDesign, 'Design the badge', 'Lay out names, companies, logos and QR codes. The same design is used for every badge.',
        `<button class="btn btn-sm" onclick="switchSubtab('design')">Open the designer</button>`)}
      ${step(false, 'Add your guest list', ev.source === 'eventbrite'
        ? 'Pull the latest registrations from Eventbrite.'
        : 'Import a CSV, add people one by one, or let people sign themselves up online.',
        ev.source === 'eventbrite'
          ? `<button class="btn btn-sm" onclick="syncEventbrite()">Sync from Eventbrite</button>`
          : `${admin ? `<button class="btn btn-sm" onclick="$('att-csv-file').click()">Import CSV</button> <button class="btn btn-sm" onclick="switchSubtab('settings')">Online registration</button> ` : ''}<button class="btn btn-sm" onclick="openAttendeeModal(null, 'manual')">Add attendee</button>`)}
      ${step(false, 'Check people in', 'Search, or scan a ticket, then check the guest in. Their badge prints straight away. Anyone not on the list can be added as a walk-in.',
        `<button class="btn btn-sm" onclick="deskTestPrint()">Do a test print</button>`)}
    </div>`;
}

function deskSelect(i) {
  BC.deskIndex = i;
  document.querySelectorAll('#desk-results .desk-card').forEach((c, j) => c.classList.toggle('selected', j === i));
}

function deskPrimary(id) {
  const a = BC.attendees.find(x => x.id === id);
  if (!a) return;
  if (a.checked_in) printForAttendees([id]); else checkIn(id);
}

function deskKey(e) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!BC.deskResults.length) return;
    BC.deskIndex = (BC.deskIndex + (e.key === 'ArrowDown' ? 1 : -1) + BC.deskResults.length) % BC.deskResults.length;
    deskSelect(BC.deskIndex);
    document.querySelector('#desk-results .desk-card.selected')?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const q = $('desk-search').value;
    const exact = exactMatch(q);
    if (exact) return deskPrimary(exact.id);
    if (!q.trim()) return;
    const sel = BC.deskResults[BC.deskIndex];
    if (sel) deskPrimary(sel.id); else openWalkIn(true);
  } else if (e.key === 'Escape') {
    deskClear();
  }
}

function deskClear() {
  $('desk-search').value = '';
  BC.deskIndex = 0;
  deskRender();
  if (BC.tab === 'desk') $('desk-search').focus();
}

async function setStatus(ids, body) {
  if (ids.length === 1) {
    upsertAttendee(await bcFetch(orgPath(`/attendees/${ids[0]}/status`), { method: 'PATCH', body }));
  } else if (ids.length) {
    (await bcFetch(orgPath('/attendees/status'), { method: 'POST', body: { ids, ...body } })).forEach(upsertAttendee);
  }
}

async function checkIn(id, print = station.autoprint) {
  const a = BC.attendees.find(x => x.id === id);
  if (!a) return;
  const name = recordName(a.data) || 'Attendee';
  if (a.cancelled && !await askConfirm('Cancelled ticket', `${name}'s ticket was cancelled or refunded on Eventbrite. Check them in anyway?`, 'Check in anyway')) return;
  try {
    await setStatus([id], { checked_in: true });
  } catch (e) {
    return showToast(`Could not check in ${name}: ${e.message}`, 'error');
  }
  showToast(`✓ ${name} checked in`, 'success');
  deskClear();
  if (print) await printForAttendees([id]);
}

async function undoCheckIn(id) {
  const a = BC.attendees.find(x => x.id === id);
  if (!a || !await askConfirm('Undo check-in', `Mark ${recordName(a.data) || 'this attendee'} as not arrived?`, 'Undo check-in')) return;
  try { await setStatus([id], { checked_in: false }); } catch (e) { showToast(e.message, 'error'); }
}

function openWalkIn(prefillFromSearch = false) {
  const prefill = {};
  const q = prefillFromSearch ? $('desk-search').value.trim() : '';
  if (q) {
    if (q.includes('@')) prefill.email = q;
    else {
      const parts = q.split(/\s+/);
      const keys = (BC.event?.fields || []).map(f => f.key);
      if (keys.includes('first_name')) { prefill.first_name = parts[0]; if (keys.includes('last_name')) prefill.last_name = parts.slice(1).join(' '); }
      else if (keys.includes('name')) prefill.name = q;
    }
  }
  openAttendeeModal(null, 'walk_in', prefill);
}

async function deskTestPrint() {
  const live = BC.attendees.find(a => !a.cancelled);
  await printRecords([{ attendee: null, record: live ? live.data : sampleRecord() }], { mark: false });
}

// ─── Attendee table ──────────────────────────────────────────────────────────

function attFiltered() {
  const tokens = $('att-search').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filter = $('att-filter').value;
  const test = {
    all: () => true,
    pending: a => !a.checked_in && !a.cancelled,
    checked: a => a.checked_in,
    unprinted: a => !a.printed && !a.cancelled,
    added: a => a.source === 'walk_in' || a.source === 'registration',
    cancelled: a => a.cancelled,
  }[filter] || (() => true);
  return BC.attendees
    .filter(a => test(a) && tokens.every(t => searchText(a).includes(t)))
    .sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
}

function attRender() {
  const wrap = $('att-table-wrap');
  if (!BC.event) return;
  const list = attFiltered();
  const LIMIT = 500;
  $('att-count').textContent = `${list.length} of ${BC.attendees.length}`;
  BC.selected.forEach(id => { if (!BC.attendees.some(a => a.id === id)) BC.selected.delete(id); });
  updateSelectionUI();

  if (!BC.attendees.length) {
    wrap.innerHTML = `<div class="list-empty" style="padding:48px 20px">No attendees yet. ${BC.event.source === 'eventbrite' ? 'Use <b>Sync</b> to pull registrations from Eventbrite, or add people manually.' : 'Import a CSV, add people manually, or open online registration in Settings.'}</div>`;
    return;
  }
  const typeField = BC.event.design_rules?.field && BC.event.design_rules.field !== 'ticket_class_name' ? BC.event.design_rules.field : null;
  const hasTicket = BC.attendees.some(a => a.data.ticket_class_name);
  const allSelected = list.length > 0 && list.every(a => BC.selected.has(a.id));
  const admin = isAdmin();

  let h = `<table class="reception-table"><thead><tr>
    <th class="td-check"><input type="checkbox" ${allSelected ? 'checked' : ''} onchange="attSelectAll(this.checked)" title="Select all shown"></th>
    <th>Name</th><th>Company</th>${hasTicket ? '<th>Ticket</th>' : ''}${typeField ? `<th>${esc(fieldLabel(typeField))}</th>` : ''}
    <th>Source</th><th>Status</th><th></th></tr></thead><tbody>`;
  for (const a of list.slice(0, LIMIT)) {
    const d = a.data;
    const canDelete = admin || ['walk_in', 'manual', 'registration'].includes(a.source);
    h += `<tr class="${a.cancelled ? 'row-cancelled' : ''}">
      <td class="td-check"><input type="checkbox" ${BC.selected.has(a.id) ? 'checked' : ''} onchange="attToggle(${a.id}, this.checked)"></td>
      <td><div class="td-name">${esc(recordName(d) || '(no name)')}</div>${d.email ? `<div class="td-sub">${esc(d.email)}</div>` : ''}</td>
      <td>${esc(d.company || '')}${d.job_title ? `<div class="td-sub">${esc(d.job_title)}</div>` : ''}</td>
      ${hasTicket ? `<td>${esc(d.ticket_class_name || '')}</td>` : ''}
      ${typeField ? `<td>${esc(d[typeField] || '')}</td>` : ''}
      <td><span class="muted-sm">${esc(SOURCE_LABELS[a.source] || a.source)}</span></td>
      <td>
        ${a.cancelled ? '<span class="badge-status cancelled">Cancelled</span> ' : ''}
        <span class="badge-status ${a.checked_in ? 'checked-in' : ''}" title="${a.checked_in ? esc('Checked in ' + formatTime(a.checked_in_at)) : ''}">${a.checked_in ? 'Checked in' : 'Not arrived'}</span>
        ${a.printed ? `<span class="badge-status printed">Printed${a.print_count > 1 ? ' ×' + a.print_count : ''}</span>` : ''}
      </td>
      <td><div class="td-actions">
        <button class="reception-action-btn" onclick="printForAttendees([${a.id}])" title="Print badge">🖨</button>
        <button class="reception-action-btn" onclick="${a.checked_in ? `undoCheckIn(${a.id})` : `checkIn(${a.id}, false)`}" title="${a.checked_in ? 'Undo check-in' : 'Check in (no print)'}">${a.checked_in ? '↺' : '✓'}</button>
        <button class="reception-action-btn" onclick="openAttendeeModal(${a.id})" title="Edit">✏️</button>
        ${canDelete ? `<button class="reception-action-btn" onclick="deleteAttendee(${a.id})" title="Delete">🗑</button>` : ''}
      </div></td>
    </tr>`;
  }
  h += '</tbody></table>';
  if (list.length > LIMIT) h += `<div class="desk-more">Showing the first ${LIMIT} — search to find others</div>`;
  if (!list.length) h += `<div class="list-empty" style="padding:32px">No attendees match.</div>`;
  wrap.innerHTML = h;
}

function attToggle(id, on) { on ? BC.selected.add(id) : BC.selected.delete(id); updateSelectionUI(); }
function attSelectAll(on) { attFiltered().forEach(a => on ? BC.selected.add(a.id) : BC.selected.delete(a.id)); attRender(); }
function updateSelectionUI() {
  const n = BC.selected.size;
  const btn = $('att-print-selected');
  btn.disabled = !n;
  btn.textContent = n ? `Print ${n} selected` : 'Print selected';
}
function printSelected() { printForAttendees([...BC.selected]); }

function fieldLabel(key) {
  const f = (BC.event?.fields || []).find(f => f.key === key);
  return f ? f.label : key.replace(/^q_/, '').replace(/_/g, ' ').replace(/\b\w/, c => c.toUpperCase());
}

async function deleteAttendee(id) {
  const a = BC.attendees.find(x => x.id === id);
  if (!a || !await askConfirm('Delete attendee', `Delete ${recordName(a.data) || 'this attendee'}? This can't be undone.`, 'Delete', true)) return;
  try {
    await bcFetch(orgPath(`/attendees/${id}`), { method: 'DELETE' });
    BC.attendees = BC.attendees.filter(x => x.id !== id);
    BC.selected.delete(id);
    onAttendeesChanged();
  } catch (e) { showAlert('Error', e.message); }
}

function exportAttendeesCSV() {
  downloadUrl(orgPath(`/events/${encodeURIComponent(BC.event.event_id)}/attendees.csv`));
}

// ─── Add / edit attendee & walk-in form ──────────────────────────────────────

let attModal = null; // { id, source }

function openAttendeeModal(id, source = 'manual', prefill = {}) {
  if (!BC.event) return;
  const a = id ? BC.attendees.find(x => x.id === id) : null;
  attModal = { id: a?.id || null, source };
  const data = a ? a.data : prefill;
  const fields = BC.event.fields || [];
  const fieldKeys = new Set(fields.map(f => f.key));
  const extraKeys = a ? Object.keys(a.data).filter(k => !fieldKeys.has(k)) : [];

  $('att-modal-title').textContent = a ? 'Edit attendee' : (source === 'walk_in' ? 'Register a walk-in' : 'Add attendee');
  const input = f => {
    const val = data[f.key] || '';
    const req = f.required ? 'required' : '';
    if (f.type === 'select' && f.options?.length) {
      return `<select id="af-${esc(f.key)}" data-key="${esc(f.key)}" ${req}>
        <option value="">Choose…</option>
        ${f.options.map(o => `<option ${o === val ? 'selected' : ''}>${esc(o)}</option>`).join('')}
        ${val && !f.options.includes(val) ? `<option selected>${esc(val)}</option>` : ''}
      </select>`;
    }
    const type = f.type === 'email' ? 'email' : f.type === 'tel' ? 'tel' : 'text';
    return `<input id="af-${esc(f.key)}" data-key="${esc(f.key)}" type="${type}" value="${esc(val)}" ${req}>`;
  };
  let html = `<div class="att-form-grid">${fields.map(f => `
    <div class="field-group ${['first_name', 'last_name'].includes(f.key) ? '' : 'span-2'}">
      <label for="af-${esc(f.key)}">${esc(f.label)}${f.required ? ' <span class="req">*</span>' : ''}</label>
      ${input(f)}
    </div>`).join('')}</div>`;
  if (extraKeys.length) {
    html += `<details class="att-extra"><summary>Other details (${extraKeys.length})</summary><div class="att-form-grid">
      ${extraKeys.map(k => `<div class="field-group span-2"><label>${esc(fieldLabel(k))}</label><input data-key="${esc(k)}" value="${esc(a.data[k] || '')}"></div>`).join('')}
    </div></details>`;
  }
  if (a) {
    html += `<div class="hint">${esc(SOURCE_LABELS[a.source] || a.source)}${a.checked_in ? ` · checked in ${esc(formatTime(a.checked_in_at))}` : ''}${a.source === 'eventbrite' ? ' · changes may be overwritten by the next Eventbrite sync' : ''}</div>`;
  }
  html += '<button type="submit" hidden></button>';
  $('att-form').innerHTML = html;

  const footer = [];
  footer.push(`<button class="btn" onclick="closeAttendeeModal()">Cancel</button>`);
  if (a) {
    footer.push(`<button class="btn" onclick="submitAttendee(true)">Save &amp; print</button>`);
    footer.push(`<button class="btn primary" onclick="submitAttendee(false)">Save</button>`);
  } else if (source === 'walk_in') {
    footer.push(`<button class="btn" onclick="submitAttendee(false)">Check in without badge</button>`);
    footer.push(`<button class="btn primary" onclick="submitAttendee(true)">Check in &amp; print badge</button>`);
  } else {
    footer.push(`<button class="btn primary" onclick="submitAttendee(false)">Add attendee</button>`);
  }
  $('att-modal-footer').innerHTML = footer.join('');
  $('attendee-overlay').classList.add('open');
  setTimeout(() => {
    const first = [...$('att-form').querySelectorAll('[data-key]')].find(el => !el.value) || $('att-form').querySelector('[data-key]');
    first?.focus();
  }, 50);
}

function closeAttendeeModal() {
  $('attendee-overlay').classList.remove('open');
  attModal = null;
  if (BC.tab === 'desk') setTimeout(() => $('desk-search').focus(), 30);
}

// Enter in the form triggers the primary button: print for walk-ins, plain save otherwise
function submitAttendeePrimary() {
  if (attModal) submitAttendee(!attModal.id && attModal.source === 'walk_in');
}

async function submitAttendee(print) {
  if (!attModal) return;
  const form = $('att-form');
  const { id, source } = attModal;
  const isNew = !id;
  if (!form.reportValidity()) return;

  const data = {};
  form.querySelectorAll('[data-key]').forEach(el => { data[el.dataset.key] = el.value.trim(); });
  const buttons = $('att-modal-footer').querySelectorAll('button');
  buttons.forEach(b => b.disabled = true);
  try {
    let saved;
    if (isNew) {
      saved = await bcFetch(orgPath(`/events/${encodeURIComponent(BC.event.event_id)}/attendees`), {
        method: 'POST',
        body: { data, source, check_in: source === 'walk_in' },
      });
    } else {
      const existing = BC.attendees.find(x => x.id === id);
      saved = await bcFetch(orgPath(`/attendees/${id}`), { method: 'PATCH', body: { data: { ...existing.data, ...data } } });
    }
    upsertAttendee(saved);
    closeAttendeeModal();
    const name = recordName(saved.data) || 'Attendee';
    showToast(isNew ? (source === 'walk_in' ? `✓ ${name} registered and checked in` : `${name} added`) : `Saved ${name}`, 'success');
    if (BC.tab === 'desk') deskClear();
    if (print) await printForAttendees([saved.id]);
  } catch (e) {
    showAlert('Could not save', e.message);
  } finally {
    buttons.forEach(b => b.disabled = false);
  }
}

// ─── CSV import ──────────────────────────────────────────────────────────────

// RFC 4180-ish parser: quoted fields, escaped quotes, newlines inside quotes,
// and comma / semicolon / tab delimiters (Excel in some locales uses ';').
function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0];
  const delim = [',', ';', '\t'].map(d => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"' && field === '') inQuotes = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

function headerKey(h) {
  return h.replace(/[﻿​-‍­⁠]/g, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50);
}

let csvPending = null;

function attImportCSV(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !BC.event) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const rows = parseCSV(ev.target.result);
    if (rows.length < 2) return showAlert('Nothing to import', 'The file needs a header row and at least one attendee.');
    const rawHeaders = rows[0];
    const keys = [];
    rawHeaders.forEach((h, i) => {
      let k = headerKey(h) || `column_${i + 1}`;
      // Common header spellings → the standard keys used by the walk-in form and designer
      k = { firstname: 'first_name', forename: 'first_name', given_name: 'first_name', lastname: 'last_name', surname: 'last_name', family_name: 'last_name',
        full_name: 'name', organisation: 'company', organization: 'company', company_name: 'company', title: 'job_title', position: 'job_title',
        role: 'job_title', email_address: 'email', e_mail: 'email', phone: 'cell_phone', mobile: 'cell_phone' }[k] || k;
      while (keys.includes(k)) k += '_2';
      keys.push(k);
    });
    const records = rows.slice(1).map(r => Object.fromEntries(keys.map((k, i) => [k, (r[i] || '').trim()])));
    csvPending = { keys, rawHeaders, records };

    $('csv-preview-status').innerHTML = `<span><b>${records.length}</b> attendees with <b>${keys.length}</b> columns. Use the field names below as <code>{{placeholders}}</code> in your badge design.</span>`;
    let t = '<table><thead><tr>' + keys.map((k, i) => `<th>${esc(k)}${headerKey(rawHeaders[i]) !== k ? `<div class="td-sub">${esc(rawHeaders[i])}</div>` : ''}</th>`).join('') + '</tr></thead><tbody>';
    records.slice(0, 6).forEach(r => { t += '<tr>' + keys.map(k => `<td>${esc(r[k])}</td>`).join('') + '</tr>'; });
    if (records.length > 6) t += `<tr><td colspan="${keys.length}" class="muted-sm">… and ${records.length - 6} more</td></tr>`;
    $('csv-preview-table-wrap').innerHTML = t + '</tbody></table>';
    $('csv-replace-existing').checked = false;
    $('csv-overlay').classList.add('open');
  };
  reader.readAsText(file);
}

function closeCSVPreview() { $('csv-overlay').classList.remove('open'); csvPending = null; }

async function confirmCSVImport() {
  if (!csvPending || !BC.event) return;
  const replace = $('csv-replace-existing').checked;
  if (replace && BC.attendees.length && !await askConfirm('Replace attendees',
    `This deletes all ${BC.attendees.length} current attendees (including check-in status) and replaces them with the file.`, 'Replace', true)) return;
  const btn = $('csv-import-confirm-btn');
  btn.disabled = true;
  btn.textContent = 'Importing…';
  try {
    const res = await bcFetch(orgPath(`/events/${encodeURIComponent(BC.event.event_id)}/attendees/import`), {
      method: 'POST', body: { rows: csvPending.records, replace },
    });
    closeCSVPreview();
    await loadAttendees();
    showToast(`Imported ${res.added} new${res.updated ? `, updated ${res.updated}` : ''}`, 'success');
  } catch (e) {
    showAlert('Import failed', e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Import';
  }
}

// ─── Printing ────────────────────────────────────────────────────────────────

function designIdFor(a) {
  const rules = BC.event?.design_rules;
  if (rules?.field && a) {
    const id = rules.rules?.[a.data[rules.field]];
    if (id) return id;
  }
  return BC.event?.design_id || null;
}

async function getDesign(id) {
  // The design open in the designer prints exactly as shown, including unsaved edits
  if (id && id === BC.loadedDesignId) return normalizeDesign(JSON.parse(currentDesignJSON()));
  if (id) {
    if (!BC.designCache[id]) {
      const d = await bcFetch(orgPath(`/designs/${id}`));
      BC.designCache[id] = normalizeDesign(JSON.parse(d.design_json));
    }
    return BC.designCache[id];
  }
  // No design linked yet: fall back to whatever is in the designer
  const current = normalizeDesign(JSON.parse(currentDesignJSON()));
  return current.front.length || current.back.length ? current : null;
}

function printForAttendees(ids) {
  const list = ids.map(id => BC.attendees.find(a => a.id === id)).filter(Boolean);
  return printRecords(list.map(a => ({ attendee: a, record: a.data })));
}

// items: [{ attendee (or null for test prints), record }]
async function printRecords(items, { mark = true } = {}) {
  if (!items.length) return;
  let pages;
  try {
    const groups = new Map();
    for (const it of items) {
      const id = designIdFor(it.attendee);
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(it);
    }
    pages = [];
    for (const [id, group] of groups) {
      const design = await getDesign(id);
      if (!design) {
        showConfirm('No badge design yet', 'Create a badge design for this event before printing.', () => switchSubtab('design'), 'Open the designer');
        return false;
      }
      pages.push(...await layoutPrintPages(design, group.map(g => g.record), station.mode));
    }
  } catch (e) {
    console.error(e);
    showAlert('Could not prepare badges', e.message);
    return false;
  }
  await printPages(pages);
  pages.forEach(p => p.urls.forEach(u => setTimeout(() => URL.revokeObjectURL(u), 60000)));

  const ids = items.map(it => it.attendee?.id).filter(Boolean);
  if (mark && ids.length) {
    try { await setStatus(ids, { printed: true }); } catch (e) { showToast('Printed, but could not record it: ' + e.message, 'error'); }
  }
  return true;
}

function canvasToUrl(c) {
  return new Promise((resolve, reject) => c.toBlob(b => b ? resolve(URL.createObjectURL(b)) : reject(new Error('Could not render badge')), 'image/png'));
}

// Returns [{ w, h, items: [{ src, x, y, w, h }], urls }] in millimetres
async function layoutPrintPages(design, records, mode) {
  await prepareBadgeRender(design, records);
  const sides = design.duplex ? ['front', 'back'] : ['front'];
  const images = [];
  for (const r of records) {
    for (const side of sides) images.push(await canvasToUrl(renderBadgeCanvas(design, r, side)));
    await new Promise(res => setTimeout(res, 0)); // keep the UI responsive on big batches
  }
  const W = design.badgeW, H = design.badgeH;
  if (mode !== 'sheet') {
    // One badge per page — label, card and badge printers. Double-sided designs
    // print the back as the following page for duplex printers.
    return images.map(src => ({ w: W, h: H, items: [{ src, x: 0, y: 0, w: W, h: H }], urls: [src] }));
  }
  // Sheet: fill the design's page grid; double-sided badges sit front/back side by side for folding
  const perPage = Math.max(1, design.cols * design.rows);
  const pages = [];
  images.forEach((src, i) => {
    const slot = i % perPage;
    if (slot === 0) pages.push({ w: design.pageW, h: design.pageH, items: [], urls: [] });
    const p = pages[pages.length - 1];
    const col = slot % design.cols, row = Math.floor(slot / design.cols);
    p.items.push({ src, x: design.marginLeft + col * (W + design.gap), y: design.marginTop + row * (H + design.gap), w: W, h: H });
    p.urls.push(src);
  });
  return pages;
}

async function printPages(pages) {
  const sizes = [...new Set(pages.map(p => `${p.w}x${p.h}`))];
  const css = sizes.map((s, i) => { const [w, h] = s.split('x'); return `@page p${i} { size: ${w}mm ${h}mm; margin: 0; }`; }).join('\n') + `
    @page { margin: 0; }
    html, body { margin: 0; padding: 0; }
    .pg { position: relative; overflow: hidden; break-after: page; page-break-after: always; }
    .pg:last-child { break-after: auto; page-break-after: auto; }
    .pg img { position: absolute; display: block; }`;
  const body = pages.map(p => `<div class="pg" style="width:${p.w}mm;height:${p.h}mm;page:p${sizes.indexOf(`${p.w}x${p.h}`)}">${
    p.items.map(it => `<img src="${it.src}" style="left:${it.x}mm;top:${it.y}mm;width:${it.w}mm;height:${it.h}mm">`).join('')}</div>`).join('');

  $('print-frame')?.remove();
  const frame = document.createElement('iframe');
  frame.id = 'print-frame';
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  doc.open();
  doc.write(`<!doctype html><html><head><title>Badges</title><style>${css}</style></head><body>${body}</body></html>`);
  doc.close();
  await Promise.all([...doc.images].map(img => img.decode().catch(() => { })));
  frame.contentWindow.focus();
  frame.contentWindow.print();
}

// ─── Badge designs ───────────────────────────────────────────────────────────

async function fetchCloudDesigns() {
  try {
    BC.designs = await bcFetch(orgPath('/designs'));
  } catch (e) {
    BC.designs = [];
  }
  renderDesignSelect();
}

function renderDesignSelect() {
  $('cloud-design-select').innerHTML = '<option value="">(Open a saved design…)</option>' +
    BC.designs.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
}

function designLabel() {
  const d = BC.designs.find(d => d.id === BC.loadedDesignId);
  return d ? d.name : 'Unsaved design';
}

function renderDesignStatus() {
  $('design-current-name').textContent = designLabel();
  $('design-dirty').style.display = BC.designDirty ? '' : 'none';
  const ev = BC.event;
  let note = '';
  if (ev) {
    if (!ev.design_id) note = 'This event has no badge design yet. <b>Save</b> to create one and use it for this event.';
    else if (ev.design_id === BC.loadedDesignId) note = 'This is the badge design for this event.';
    else {
      const linked = BC.designs.find(d => d.id === ev.design_id);
      note = `This event uses <b>${esc(linked?.name || 'another design')}</b>. <a href="#" onclick="event.preventDefault(); loadCloudDesign(${ev.design_id})">Open it</a>${isAdmin() && BC.loadedDesignId ? ` · <a href="#" onclick="event.preventDefault(); linkDesign(${BC.loadedDesignId || 0})">Use this one instead</a>` : ''}`;
    }
  }
  $('design-link-note').innerHTML = note;
}

window.onDesignChanged = () => {
  if (BC.suppressDirty) return;
  if (!BC.designDirty) { BC.designDirty = true; renderDesignStatus(); }
};

async function loadEventDesign() {
  if (BC.event?.design_id) await loadCloudDesign(BC.event.design_id, { quiet: true });
  else renderDesignStatus();
}

async function loadCloudDesign(id, { quiet = false } = {}) {
  if (!id) return;
  if (!quiet && BC.designDirty && !await askConfirm('Unsaved changes', 'Open another design and lose the changes to this one?', 'Discard changes', true)) {
    $('cloud-design-select').value = '';
    return;
  }
  try {
    const design = await bcFetch(orgPath(`/designs/${id}`));
    const d = JSON.parse(design.design_json);
    BC.suppressDirty = true;
    state.designs = d.designs && (d.designs.front || d.designs.back) ? d.designs : { front: d.elements || [], back: [] };
    const keys = ['badgeW', 'badgeH', 'badgeBg', 'sizeMode', 'duplex', 'duplexLayout', 'pageW', 'pageH', 'cols', 'rows',
      'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'gap', 'snap'];
    keys.forEach(k => { if (d[k] !== undefined) state[k] = d[k]; });
    state.duplex = !!state.duplex;
    state.currentSide = 'front';
    state.selectedId = null;
    state.elements = [...(state.designs.front || [])];
    updateUIFromState(); updateDuplexUI();
    $('side-btn-front').classList.add('active'); $('side-btn-back').classList.remove('active');
    BC.loadedDesignId = id;
    BC.designCache[id] = normalizeDesign(d);
    requestAnimationFrame(() => {
      updatePage(); renderLayers(); renderProps(); redraw();
      BC.suppressDirty = false;
      BC.designDirty = false;
      renderDesignStatus();
    });
  } catch (e) {
    BC.suppressDirty = false;
    if (!quiet) showAlert('Could not open design', e.message);
  } finally {
    $('cloud-design-select').value = '';
  }
}

async function saveCloudDesign() {
  if (!BC.loadedDesignId) return saveCloudDesignAs();
  try {
    const json = currentDesignJSON();
    await bcFetch(orgPath(`/designs/${BC.loadedDesignId}`), { method: 'PATCH', body: { design_json: json } });
    BC.designCache[BC.loadedDesignId] = normalizeDesign(JSON.parse(json));
    BC.designDirty = false;
    renderDesignStatus();
    showToast('Design saved', 'success');
  } catch (e) {
    showAlert('Could not save design', e.message);
  }
}

async function saveCloudDesignAs() {
  const suggested = BC.event ? `${BC.event.name} badge` : 'Badge design';
  const name = (await askText('Save design', 'Name this badge design:', BC.loadedDesignId ? designLabel() + ' (copy)' : suggested, 'Save'))?.trim();
  if (!name) return;
  if (BC.designs.some(d => d.name.toLowerCase() === name.toLowerCase())) {
    const existing = BC.designs.find(d => d.name.toLowerCase() === name.toLowerCase());
    if (!await askConfirm('Overwrite design?', `A design named "${existing.name}" already exists. Replace it?`, 'Replace', true)) return;
    BC.loadedDesignId = existing.id;
    return saveCloudDesign();
  }
  try {
    const json = currentDesignJSON();
    const res = await bcFetch(orgPath('/designs'), { method: 'POST', body: { name, design_json: json } });
    BC.loadedDesignId = res.id;
    BC.designCache[res.id] = normalizeDesign(JSON.parse(json));
    BC.designDirty = false;
    await fetchCloudDesigns();
    if (BC.event && !BC.event.design_id && isAdmin()) {
      await linkDesign(res.id, true);
      showToast(`Saved "${name}" and set it as this event's badge`, 'success');
    } else {
      showToast(`Saved "${name}"`, 'success');
    }
    renderDesignStatus();
  } catch (e) {
    showAlert('Could not save design', e.message);
  }
}

async function deleteCloudDesign() {
  const id = BC.loadedDesignId;
  if (!id) return showAlert('Nothing to delete', 'This design hasn’t been saved yet.');
  const usedBy = BC.events.filter(e => e.design_id === id).map(e => e.name);
  if (!await askConfirm('Delete design', `Delete "${designLabel()}"?${usedBy.length ? `\n\nIt is used by: ${usedBy.join(', ')}.` : ''}`, 'Delete', true)) return;
  try {
    // Unlink from events first so they don't point at a missing design
    for (const ev of BC.events.filter(e => e.design_id === id)) {
      await bcFetch(orgPath(`/events/${encodeURIComponent(ev.event_id)}`), { method: 'PATCH', body: { design_id: null } });
      ev.design_id = null;
    }
    await bcFetch(orgPath(`/designs/${id}`), { method: 'DELETE' });
    delete BC.designCache[id];
    BC.loadedDesignId = null;
    BC.designDirty = true;
    await fetchCloudDesigns();
    renderDesignStatus();
    showToast('Design deleted');
  } catch (e) {
    showAlert('Could not delete design', e.message);
  }
}

async function linkDesign(designId, quiet = false) {
  if (!BC.event) return;
  try {
    const ev = await bcFetch(orgPath(`/events/${encodeURIComponent(BC.event.event_id)}`), { method: 'PATCH', body: { design_id: designId || null } });
    Object.assign(BC.event, ev);
    if (!quiet) showToast(designId ? 'Badge design updated for this event' : 'Design unlinked', 'success');
    renderDesignStatus();
    if (BC.tab === 'settings') renderSettings();
  } catch (e) { showAlert('Error', e.message); }
}

// ─── Event settings ──────────────────────────────────────────────────────────

let fieldsDraft = [];

function renderSettings() {
  const ev = BC.event;
  if (!ev) return;
  fieldsDraft = JSON.parse(JSON.stringify(ev.fields || []));
  const designOptions = sel => '<option value="">(None)</option>' + BC.designs.map(d => `<option value="${d.id}" ${d.id === sel ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
  const regUrl = ev.registration_url;
  const eb = ev.source === 'eventbrite';

  $('settings-inner').innerHTML = `
    <section class="settings-card">
      <h3>Event details</h3>
      <div class="field-group"><label>Name</label><input id="set-name" value="${esc(ev.name)}" ${eb ? 'disabled title="Managed by Eventbrite"' : ''}></div>
      <div class="field-row-2">
        <div class="field-group"><label>Date</label><input id="set-date" type="date" value="${esc((ev.start_date || '').slice(0, 10))}" ${eb ? 'disabled' : ''}></div>
        <div class="field-group"><label>Location</label><input id="set-location" value="${esc(ev.location || '')}"></div>
      </div>
      <div class="field-group"><label>Description</label><textarea id="set-desc" rows="2" placeholder="Shown on the registration page">${esc(ev.description || '')}</textarea></div>
      ${eb ? `<p class="hint">Name and date come from Eventbrite (event ${esc(ev.event_id)}). Last synced ${esc(formatTime(ev.synced_at))}.</p>` : ''}
      <div class="settings-actions"><button class="btn primary" onclick="saveEventDetails()">Save details</button></div>
    </section>

    <section class="settings-card">
      <h3>Badge design</h3>
      <div class="field-group"><label>Design used for this event</label>
        <div style="display:flex; gap:8px"><select id="set-design" class="select-full" onchange="linkDesign(+this.value || null)">${designOptions(ev.design_id)}</select>
        <button class="btn" onclick="switchSubtab('design')">Edit</button></div>
      </div>
      <details class="settings-details" ${ev.design_rules ? 'open' : ''}>
        <summary>Different badges for different attendee types</summary>
        <p class="hint">For example, give staff, speakers and exhibitors their own design. Choose a field, then pick a design for each value. Everyone else gets the main design.</p>
        <div class="field-group"><label>Based on field</label>
          <select id="rule-field" class="select-full" onchange="renderRuleRows()">
            <option value="">(Off — everyone gets the main design)</option>
            ${eventFieldKeys().map(k => `<option value="${esc(k)}" ${ev.design_rules?.field === k ? 'selected' : ''}>${esc(fieldLabel(k))}</option>`).join('')}
          </select>
        </div>
        <div id="rule-rows"></div>
        <div class="settings-actions"><button class="btn primary" onclick="saveDesignRules()">Save badge rules</button></div>
      </details>
    </section>

    <section class="settings-card">
      <h3>Walk-in &amp; registration form</h3>
      <p class="hint">The details collected when you register a walk-in at reception or when people sign up online. Each field can be used on the badge as a <code>{{placeholder}}</code>.</p>
      <div id="fields-editor"></div>
      <div class="settings-actions">
        <button class="btn" onclick="fieldsAdd()">+ Add field</button>
        <button class="btn primary" onclick="saveFields()">Save form</button>
      </div>
    </section>

    <section class="settings-card">
      <h3>Online registration &amp; self-service kiosk</h3>
      <p class="hint">Share a link so people can register themselves before the event, or open it on a tablet at reception. Sign-ups appear here straight away, and kiosk sign-ups are checked in automatically.</p>
      <label class="check-label"><input type="checkbox" id="set-reg-open" ${ev.registration_open ? 'checked' : ''} onchange="toggleRegistration(this.checked)"> Registration is open</label>
      ${regUrl ? `
        <div class="reg-link ${ev.registration_open ? '' : 'disabled'}">
          <div class="reg-qr" id="reg-qr"></div>
          <div class="reg-link-body">
            <div class="mono reg-url">${esc(regUrl)}</div>
            <div class="settings-actions" style="justify-content:flex-start">
              <button class="btn btn-sm" onclick="navigator.clipboard.writeText(${esc(JSON.stringify(regUrl))}); showToast('Link copied')">Copy link</button>
              <a class="btn btn-sm" href="${esc(regUrl)}" target="_blank" rel="noopener">Open form</a>
              <a class="btn btn-sm" href="${esc(regUrl)}?kiosk=1" target="_blank" rel="noopener">Open kiosk mode</a>
              <button class="btn btn-sm" onclick="downloadRegQR()">Download QR</button>
              <button class="btn btn-sm btn-ghost" onclick="resetRegLink()">New link</button>
            </div>
            ${ev.registration_open ? '' : '<p class="hint">The link is closed — people opening it will see that registration has ended.</p>'}
          </div>
        </div>` : ''}
    </section>

    ${eb ? `
    <section class="settings-card">
      <h3>Eventbrite</h3>
      <p class="hint">Attendees are pulled from Eventbrite event <span class="mono">${esc(ev.event_id)}</span>. Check-ins and walk-ins are kept when you sync, and cancelled or refunded tickets are flagged.</p>
      <div class="settings-actions" style="justify-content:flex-start"><button class="btn primary" onclick="syncEventbrite()">Sync now</button></div>
    </section>` : ''}

    <section class="settings-card danger-zone">
      <h3>Danger zone</h3>
      <div class="danger-row"><div><b>Mark every badge as printed</b><span>For when you've printed everyone's badge in advance.</span></div><button class="btn" onclick="bulkPrinted(true)">Mark all printed</button></div>
      <div class="danger-row"><div><b>Reset print status</b><span>Mark every badge as not printed.</span></div><button class="btn" onclick="bulkPrinted(false)">Reset</button></div>
      <div class="danger-row"><div><b>Clear attendees</b><span>Remove everyone from this event. The event itself stays.</span></div><button class="btn danger" onclick="clearAttendees()">Clear attendees</button></div>
      <div class="danger-row"><div><b>Delete event</b><span>Permanently delete this event and its attendees.</span></div><button class="btn danger" onclick="deleteEvent()">Delete event</button></div>
    </section>`;

  renderFieldsEditor();
  renderRuleRows();
  if (regUrl && window.QRCode) {
    new QRCode($('reg-qr'), { text: regUrl, width: 112, height: 112, correctLevel: QRCode.CorrectLevel.M });
  }
}

async function patchEvent(body, okMessage) {
  try {
    const ev = await bcFetch(orgPath(`/events/${encodeURIComponent(BC.event.event_id)}`), { method: 'PATCH', body });
    Object.assign(BC.event, ev);
    Object.assign(BC.events.find(e => e.event_id === ev.event_id) || {}, ev);
    renderEventsList();
    renderHeaderContext();
    if (okMessage) showToast(okMessage, 'success');
    return true;
  } catch (e) {
    showAlert('Could not save', e.message);
    return false;
  }
}

async function saveEventDetails() {
  const body = { location: $('set-location').value, description: $('set-desc').value };
  if (BC.event.source !== 'eventbrite') Object.assign(body, { name: $('set-name').value, start_date: $('set-date').value || null });
  await patchEvent(body, 'Event details saved');
}

function renderRuleRows() {
  const wrap = $('rule-rows');
  if (!wrap) return;
  const field = $('rule-field').value;
  if (!field) { wrap.innerHTML = ''; return; }
  const values = new Set();
  (BC.event.fields.find(f => f.key === field)?.options || []).forEach(o => values.add(o));
  BC.attendees.forEach(a => { if (a.data[field]) values.add(a.data[field]); });
  const current = BC.event.design_rules?.field === field ? BC.event.design_rules.rules : {};
  if (!values.size) { wrap.innerHTML = '<p class="hint">No attendees have a value for this field yet.</p>'; return; }
  wrap.innerHTML = `<div class="rule-table">${[...values].sort().slice(0, 40).map(v => `
    <div class="rule-row"><span>${esc(v)}</span>
      <select class="select-sm" data-value="${esc(v)}">
        <option value="">Main design</option>
        ${BC.designs.map(d => `<option value="${d.id}" ${current[v] === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
      </select></div>`).join('')}</div>`;
}

async function saveDesignRules() {
  const field = $('rule-field').value;
  const rules = {};
  document.querySelectorAll('#rule-rows select').forEach(s => { if (s.value) rules[s.dataset.value] = +s.value; });
  await patchEvent({ design_rules: field && Object.keys(rules).length ? { field, rules } : null }, 'Badge rules saved');
}

function renderFieldsEditor() {
  const wrap = $('fields-editor');
  wrap.innerHTML = fieldsDraft.map((f, i) => `
    <div class="field-edit-row">
      <div class="field-edit-main">
        <input value="${esc(f.label)}" placeholder="Field label" oninput="fieldsDraft[${i}].label = this.value">
        <select class="select-sm" onchange="fieldsDraft[${i}].type = this.value; renderFieldsEditor()">
          ${[['text', 'Text'], ['email', 'Email'], ['tel', 'Phone'], ['select', 'Choice']].map(([v, l]) => `<option value="${v}" ${f.type === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <label class="check-label"><input type="checkbox" ${f.required ? 'checked' : ''} onchange="fieldsDraft[${i}].required = this.checked"> Required</label>
        <span class="field-key mono" title="Placeholder for the badge designer">${f.key ? `{{${esc(f.key)}}}` : 'new'}</span>
        <div class="field-edit-btns">
          <button class="icon-btn" onclick="fieldsMove(${i}, -1)" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="icon-btn" onclick="fieldsMove(${i}, 1)" title="Move down" ${i === fieldsDraft.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="icon-btn" onclick="fieldsDraft.splice(${i}, 1); renderFieldsEditor()" title="Remove">✕</button>
        </div>
      </div>
      ${f.type === 'select' ? `<input class="field-options" value="${esc((f.options || []).join(', '))}" placeholder="Choices, separated by commas — e.g. Visitor, Exhibitor, Speaker, Staff"
        oninput="fieldsDraft[${i}].options = this.value.split(',').map(s => s.trim()).filter(Boolean)">` : ''}
    </div>`).join('') || '<p class="hint">No fields — add at least one.</p>';
}

function fieldsAdd() {
  fieldsDraft.push({ key: '', label: '', type: 'text', required: false, options: [] });
  renderFieldsEditor();
  const inputs = $('fields-editor').querySelectorAll('.field-edit-main input:first-child');
  inputs[inputs.length - 1]?.focus();
}

function fieldsMove(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= fieldsDraft.length) return;
  [fieldsDraft[i], fieldsDraft[j]] = [fieldsDraft[j], fieldsDraft[i]];
  renderFieldsEditor();
}

async function saveFields() {
  const fields = fieldsDraft.filter(f => f.label.trim()).map(f => ({ ...f, key: f.key || headerKey(f.label) }));
  if (!fields.length) return showAlert('Add a field', 'The form needs at least one field.');
  if (fields.some(f => f.type === 'select' && !(f.options || []).length)) return showAlert('Add choices', 'Choice fields need at least one option.');
  await patchEvent({ fields }, 'Form saved');
  renderSettings();
}

async function toggleRegistration(open) {
  if (await patchEvent({ registration_open: open }, open ? 'Registration is open' : 'Registration closed')) renderSettings();
}

async function resetRegLink() {
  if (!await askConfirm('New registration link', 'The current link and QR code will stop working. Continue?', 'Create new link', true)) return;
  try {
    Object.assign(BC.event, await bcFetch(orgPath(`/events/${encodeURIComponent(BC.event.event_id)}/registration-link/reset`), { method: 'POST' }));
    renderSettings();
  } catch (e) { showAlert('Error', e.message); }
}

function downloadRegQR() {
  const holder = document.createElement('div');
  new QRCode(holder, { text: BC.event.registration_url, width: 1024, height: 1024, correctLevel: QRCode.CorrectLevel.M });
  const c = holder.querySelector('canvas');
  const a = document.createElement('a');
  a.href = c.toDataURL('image/png');
  a.download = `registration-qr-${headerKey(BC.event.name) || 'event'}.png`;
  a.click();
}

async function bulkPrinted(printed) {
  if (!await askConfirm(printed ? 'Mark all printed' : 'Reset print status',
    printed ? 'Mark every attendee’s badge as printed?' : 'Mark every badge as not printed?', 'Continue')) return;
  try {
    await bcFetch(orgPath(`/events/${encodeURIComponent(BC.event.event_id)}/${printed ? 'mark-all-printed' : 'reset-printed'}`), { method: 'POST' });
    await loadAttendees();
    showToast('Done', 'success');
  } catch (e) { showAlert('Error', e.message); }
}

async function clearAttendees() {
  if (!await askConfirm('Clear attendees', `Delete all ${BC.attendees.length} attendees from "${BC.event.name}"? This can't be undone.`, 'Delete attendees', true)) return;
  try {
    await bcFetch(orgPath(`/events/${encodeURIComponent(BC.event.event_id)}/attendees`), { method: 'DELETE' });
    await loadAttendees();
  } catch (e) { showAlert('Error', e.message); }
}

async function deleteEvent() {
  if (!await askConfirm('Delete event', `Permanently delete "${BC.event.name}" and all of its attendees?`, 'Delete event', true)) return;
  try {
    await bcFetch(orgPath(`/events/${encodeURIComponent(BC.event.event_id)}`), { method: 'DELETE' });
    closeEvent();
    await loadEvents();
    showToast('Event deleted');
  } catch (e) { showAlert('Error', e.message); }
}

// ─── Create event ────────────────────────────────────────────────────────────

function openCreateEventModal() {
  ['new-event-name', 'new-event-date', 'new-event-location', 'new-event-desc'].forEach(id => $(id).value = '');
  $('create-event-error').style.display = 'none';
  $('create-event-btn').disabled = true;
  $('create-event-overlay').classList.add('open');
  setTimeout(() => $('new-event-name').focus(), 50);
}

function closeCreateEventModal() { $('create-event-overlay').classList.remove('open'); }

function validateCreateEvent() { $('create-event-btn').disabled = $('new-event-name').value.trim().length < 2; }

async function createManualEvent() {
  const name = $('new-event-name').value.trim();
  if (name.length < 2) return;
  const btn = $('create-event-btn');
  btn.disabled = true;
  btn.textContent = 'Creating…';
  try {
    const ev = await bcFetch(orgPath('/events'), {
      method: 'POST',
      body: { name, start_date: $('new-event-date').value || null, location: $('new-event-location').value, description: $('new-event-desc').value },
    });
    closeCreateEventModal();
    BC.events.unshift(ev);
    storeSet('bc_tab', 'desk');
    await selectEvent(ev.event_id);
  } catch (e) {
    $('create-event-error').textContent = e.message;
    $('create-event-error').style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create event';
  }
}

// ─── Eventbrite ──────────────────────────────────────────────────────────────

let ebEvents = [];

function openEventbriteModal() {
  $('eb-modal-overlay').classList.add('open');
  if (BC.orgHasEventbrite) ebLoadEvents(); else ebRenderTokenStep();
}

function closeEventbriteModal() { $('eb-modal-overlay').classList.remove('open'); }

function ebRenderTokenStep(error = '') {
  $('eb-body').innerHTML = `
    <div class="eb-step">
      <div class="eb-step-label">Connect your Eventbrite account</div>
      <p class="hint">Paste your Eventbrite <b>private token</b>. Find it under Account Settings → Developer Links → API Keys. It's saved for your whole organisation, and only admins can see or change it.</p>
      <div style="display:flex;gap:8px">
        <input class="eb-input" type="password" id="eb-token-input" placeholder="Private token" autocomplete="off" onkeydown="if(event.key==='Enter') ebSaveToken()">
        <button class="btn primary" onclick="ebSaveToken()">Connect</button>
      </div>
      ${error ? `<div class="eb-status error">${esc(error)}</div>` : ''}
    </div>`;
  setTimeout(() => $('eb-token-input')?.focus(), 50);
}

async function ebSaveToken() {
  if (await saveOrgToken('eb-token-input', null)) ebLoadEvents();
}

async function ebLoadEvents() {
  $('eb-body').innerHTML = '<div class="eb-status info"><div class="eb-spinner"></div><span>Loading your Eventbrite events…</span></div>';
  try {
    ebEvents = await bcFetch(orgPath('/eventbrite/events'));
  } catch (e) {
    return ebRenderTokenStep(e.message);
  }
  $('eb-body').innerHTML = `
    <div class="eb-step">
      <div style="display:flex; gap:8px; align-items:center">
        <input class="eb-input" type="search" id="eb-event-search" placeholder="Filter events…" oninput="ebRenderEvents()">
        <button class="btn btn-sm btn-ghost" onclick="ebRenderTokenStep()" title="Use a different Eventbrite token">Change token</button>
      </div>
      <div class="eb-events-list" id="eb-events-list"></div>
      <div id="eb-import-status"></div>
    </div>`;
  ebRenderEvents();
  $('eb-event-search').focus();
}

function ebRenderEvents() {
  const q = ($('eb-event-search')?.value || '').toLowerCase();
  const list = ebEvents.filter(e => e.name.toLowerCase().includes(q));
  $('eb-events-list').innerHTML = list.length ? list.map(ev => `
    <div class="eb-event-item" onclick="ebImport('${esc(ev.id)}')">
      <div class="eb-event-dot" style="${['live', 'started'].includes(ev.status) ? '' : 'background:var(--text3)'}"></div>
      <div class="eb-event-info">
        <div class="eb-event-name">${esc(ev.name)}</div>
        <div class="eb-event-meta">${esc(formatDate(ev.start))}${ev.capacity ? ` · ${ev.capacity} capacity` : ''} · ${esc(ev.status || '')}</div>
      </div>
      <span class="btn btn-sm ${ev.imported ? '' : 'primary'}">${ev.imported ? 'Open & sync' : 'Import'}</span>
    </div>`).join('') : `<div class="list-empty">${ebEvents.length ? 'No events match.' : 'No events found on this Eventbrite account.'}</div>`;
}

async function ebImport(ebId) {
  const status = $('eb-import-status');
  status.innerHTML = '<div class="eb-status info"><div class="eb-spinner"></div><span>Importing attendees… large events can take a minute.</span></div>';
  $('eb-events-list').style.pointerEvents = 'none';
  try {
    const res = await bcFetch(orgPath('/eventbrite/import'), { method: 'POST', body: { eventbrite_event_id: ebId } });
    closeEventbriteModal();
    await loadEvents();
    await selectEvent(res.event.event_id);
    showToast(`Imported ${res.event.name}: ${res.sync.total} attendees (${res.sync.added} new)`, 'success');
  } catch (e) {
    status.innerHTML = `<div class="eb-status error">${esc(e.message)}</div>`;
  } finally {
    const list = $('eb-events-list');
    if (list) list.style.pointerEvents = '';
  }
}

async function syncEventbrite() {
  if (!BC.event || BC.event.source !== 'eventbrite') return;
  const btn = $('eb-sync-btn');
  btn.disabled = true;
  btn.lastChild.textContent = ' Syncing…';
  try {
    const res = await bcFetch(orgPath(`/events/${encodeURIComponent(BC.event.event_id)}/sync`), { method: 'POST' });
    Object.assign(BC.event, res.event);
    await loadAttendees();
    renderHeaderContext();
    showToast(`Synced: ${res.sync.added} new, ${res.sync.updated} updated${res.sync.cancelled ? `, ${res.sync.cancelled} cancelled` : ''}`, 'success');
  } catch (e) {
    showAlert('Sync failed', e.message);
  } finally {
    btn.disabled = false;
    btn.lastChild.textContent = ' Sync';
  }
}

// ─── Global keys & start-up ─────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    for (const id of ['attendee-overlay', 'csv-overlay', 'eb-modal-overlay', 'create-event-overlay', 'org-settings-modal']) {
      const el = $(id);
      if (el?.classList.contains('open')) {
        if (id === 'attendee-overlay') closeAttendeeModal(); else el.classList.remove('open');
        return;
      }
    }
    if ($('generic-modal-overlay').style.display === 'flex') closeGenericModal();
  }
  // "/" jumps to the check-in search from anywhere on the desk
  if (e.key === '/' && BC.tab === 'desk' && BC.event && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
    e.preventDefault();
    $('desk-search').focus();
  }
});

bcInit();
