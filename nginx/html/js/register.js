// Public event registration (/r/<code>) and reception kiosk (/r/<code>?kiosk=1)
const code = location.pathname.split('/').filter(Boolean).pop();
const kiosk = new URLSearchParams(location.search).has('kiosk');
if (kiosk) document.documentElement.classList.add('kiosk');

const card = document.getElementById('card');
let event = null;
let resetTimer = null;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatDate(d) {
  if (!d) return '';
  const date = new Date(d.length === 10 ? d + 'T00:00:00' : d);
  return isNaN(date) ? d : date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

async function load() {
  try {
    const res = await fetch(`/api/public/events/${encodeURIComponent(code)}`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || 'Registration is closed');
    event = await res.json();
  } catch (e) {
    card.innerHTML = `<div class="closed"><h1 style="font-size:20px;margin-bottom:8px">Registration closed</h1><p>${esc(e.message)}</p></div>`;
    return;
  }
  document.title = (kiosk ? 'Welcome — ' : 'Register — ') + event.name;
  render();
}

function fieldInput(f) {
  const id = 'f-' + f.key;
  const req = f.required ? 'required' : '';
  const label = `<label for="${esc(id)}">${esc(f.label)}${f.required ? ' <span class="req">*</span>' : ''}</label>`;
  if (f.type === 'select' && f.options?.length) {
    return `<div>${label}<select id="${esc(id)}" name="${esc(f.key)}" ${req}><option value="">Choose…</option>${f.options.map(o => `<option>${esc(o)}</option>`).join('')}</select></div>`;
  }
  const type = { email: 'email', tel: 'tel' }[f.type] || 'text';
  const auto = { first_name: 'given-name', last_name: 'family-name', email: 'email', company: 'organization', job_title: 'organization-title', name: 'name' }[f.key] || 'on';
  return `<div>${label}<input id="${esc(id)}" name="${esc(f.key)}" type="${type}" autocomplete="${kiosk ? 'off' : auto}" ${req} maxlength="300"></div>`;
}

function render() {
  const fields = event.fields;
  // Show first + last name side by side
  let inputs = '';
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i], next = fields[i + 1];
    if (f.key === 'first_name' && next?.key === 'last_name') { inputs += `<div class="row-2">${fieldInput(f)}${fieldInput(next)}</div>`; i++; }
    else inputs += fieldInput(f);
  }
  card.innerHTML = `
    <div class="card-head">
      ${event.org_name ? `<div class="org">${esc(event.org_name)}</div>` : ''}
      <h1>${kiosk ? 'Welcome to ' : ''}${esc(event.name)}</h1>
      ${kiosk ? '<p class="welcome">Not on the guest list? Sign in here and we’ll print your badge.</p>' : `
      <div class="meta">${event.start_date ? `<span>📅 ${esc(formatDate(event.start_date))}</span>` : ''}${event.location ? `<span>📍 ${esc(event.location)}</span>` : ''}</div>
      ${event.description ? `<p class="desc">${esc(event.description)}</p>` : ''}`}
    </div>
    <form id="reg-form" novalidate>
      ${inputs}
      <div class="hp" aria-hidden="true"><label>Website <input name="website" tabindex="-1" autocomplete="off"></label></div>
      <div class="error" id="err"></div>
      <button type="submit" id="submit">${kiosk ? 'Sign in' : 'Register'}</button>
    </form>
    <div class="done" id="done"></div>
    ${kiosk ? '' : '<div class="foot">Powered by BadgeCraft</div>'}`;
  document.getElementById('reg-form').addEventListener('submit', submit);
  if (kiosk) setTimeout(() => card.querySelector('input, select')?.focus(), 50);
}

async function submit(e) {
  e.preventDefault();
  const form = e.target;
  const err = document.getElementById('err');
  err.style.display = 'none';
  if (!form.reportValidity()) return;
  const data = {};
  event.fields.forEach(f => { data[f.key] = form.elements[f.key].value.trim(); });
  const btn = document.getElementById('submit');
  btn.disabled = true;
  try {
    const res = await fetch(`/api/public/events/${encodeURIComponent(code)}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data, kiosk, website: form.elements.website.value }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.detail || 'Something went wrong — please try again');
    showDone(data);
  } catch (ex) {
    err.textContent = ex.message;
    err.style.display = 'block';
  } finally {
    btn.disabled = false;
  }
}

function showDone(data) {
  const first = data.first_name || (data.name || '').split(' ')[0] || '';
  document.getElementById('reg-form').style.display = 'none';
  const done = document.getElementById('done');
  done.style.display = 'block';
  done.innerHTML = kiosk
    ? `<div class="tick">✓</div><h2>Thanks${first ? ', ' + esc(first) : ''}!</h2><p>You’re signed in. Please collect your badge from the reception desk.</p>`
    : `<div class="tick">✓</div><h2>You’re registered${first ? ', ' + esc(first) : ''}!</h2><p>We look forward to seeing you at ${esc(event.name)}. Just give your name at reception on the day.</p>`;
  if (kiosk) {
    clearTimeout(resetTimer);
    resetTimer = setTimeout(render, 7000);
    done.addEventListener('click', () => { clearTimeout(resetTimer); render(); }, { once: true });
  }
}

load();
