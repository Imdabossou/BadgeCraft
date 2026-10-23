const PX_PER_MM = 3.7795;
let state = {
  pageW: 210, pageH: 297, cols: 2, rows: 4,
  marginTop: 10, marginRight: 10, marginBottom: 10, marginLeft: 10, gap: 5,
  badgeW: 86, badgeH: 54, badgeBg: '#ffffff',
  sizeMode: 'auto', elements: [], selectedId: null, currentRecord: 0,
  csvData: [], csvHeaders: [], snap: false, zoom: 1, darkMode: true,
  duplex: false, duplexLayout: 'horizontal', currentSide: 'front', designs: { front: [], back: [] }
};

let canvasScale = 1, badgeWpx = 0, badgeHpx = 0, isDragging = false, dragOffX = 0, dragOffY = 0;
const canvas = document.getElementById('badge-canvas');
const ctx = canvas.getContext('2d');
const imageCache = {}, qrCache = {};

function wrapTextToLines(text, maxWidth, measureFn) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let cur = '';
    for (const w of para.split(' ')) {
      const test = cur + (cur ? ' ' : '') + w;
      if (measureFn(test) > maxWidth && cur) { lines.push(cur); cur = w; }
      else cur = test;
    }
    lines.push(cur);
  }
  return lines;
}

// Replace {{field}} placeholders. With a record, missing fields print blank
// rather than the raw placeholder; without one (design mode) they stay visible.
function fillVars(text, record) {
  return (text || '').replace(/\{\{(.+?)\}\}/g, (m, k) => record ? (record[k.trim()] ?? '') : m);
}

function textFont(el, size) { return `${el.fontStyle||''} ${el.fontWeight||'normal'} ${size}px ${el.fontFamily||'sans-serif'}`; }

// "Fit" text shrinks to stay on one line within the element width (long names)
function fittedFontSize(el, text, mctx) {
  let size = el.fontSize || 14;
  mctx.font = textFont(el, size);
  if (el.fit) { while (size > 6 && mctx.measureText(text).width > el.w) { size -= 0.5; mctx.font = textFont(el, size); } }
  return size;
}

let gmOnDismiss = null;  // called when the generic modal is cancelled/closed without confirming

function closeGenericModal() {
  document.getElementById('generic-modal-overlay').style.display = 'none';
  const cb = gmOnDismiss; gmOnDismiss = null;
  if (cb) cb();
}

// Opens the shared modal. The confirm handler runs after the modal closes, so it
// can open another modal (e.g. "overwrite?") without that one being hidden.
function openGenericModal(title, message, { input = null, cancel = true, okLabel = 'Confirm', danger = false, onConfirm = null } = {}) {
  document.getElementById('gm-title').textContent = title;
  document.getElementById('gm-message').textContent = message;
  const inputEl = document.getElementById('gm-input');
  document.getElementById('gm-input-wrap').style.display = input === null ? 'none' : 'block';
  if (input !== null) inputEl.value = input;
  document.getElementById('gm-cancel-btn').style.display = cancel ? 'inline-flex' : 'none';
  const btn = document.getElementById('gm-confirm-btn');
  btn.textContent = okLabel;
  btn.className = 'btn ' + (danger ? 'danger' : 'primary');
  const confirm = () => {
    gmOnDismiss = null;
    closeGenericModal();
    if (onConfirm) onConfirm(inputEl.value);
  };
  btn.onclick = confirm;
  inputEl.onkeydown = e => { if (e.key === 'Enter') confirm(); };
  gmOnDismiss = null;
  document.getElementById('generic-modal-overlay').style.display = 'flex';
  setTimeout(() => (input !== null ? inputEl : btn).focus(), 50);
}

function showConfirm(title, message, onConfirm, okLabel = 'Confirm', danger = false) {
  openGenericModal(title, message, { okLabel, danger, onConfirm });
}

function showPrompt(title, message, defaultValue, onConfirm, okLabel = 'OK') {
  openGenericModal(title, message, { input: defaultValue || '', okLabel, onConfirm });
}

function showAlert(title, message) {
  openGenericModal(title, message, { cancel: false, okLabel: 'OK' });
}

// Promise versions: resolve true/value on confirm, false/null when dismissed
function askConfirm(title, message, okLabel = 'Confirm', danger = false) {
  return new Promise(resolve => {
    openGenericModal(title, message, { okLabel, danger, onConfirm: () => resolve(true) });
    gmOnDismiss = () => resolve(false);
  });
}
function askText(title, message, defaultValue = '', okLabel = 'OK') {
  return new Promise(resolve => {
    openGenericModal(title, message, { input: defaultValue, okLabel, onConfirm: v => resolve(v) });
    gmOnDismiss = () => resolve(null);
  });
}

function setSide(side) {
  if (state.currentSide === side) return;
  state.designs[state.currentSide] = [...state.elements];
  state.currentSide = side;
  state.elements = [...(state.designs[side] || [])];
  state.selectedId = null;
  document.getElementById('side-btn-front').classList.toggle('active', side === 'front');
  document.getElementById('side-btn-back').classList.toggle('active', side === 'back');
  redraw(); renderLayers(); renderProps(); updateStatus(); saveToLocal();
}

function copySide() {
  const otherSide = state.currentSide === 'front' ? 'back' : 'front';
  state.designs[otherSide] = JSON.parse(JSON.stringify(state.elements));
  showToast(`Copied ${state.currentSide} design to the ${otherSide}.`);
  saveToLocal();
}

function flipBack() {
  state.elements.forEach(el => {
    el.x = badgeWpx - el.x - el.w;
    if (el.type === 'text') {
      if (el.align === 'left') el.align = 'right';
      else if (el.align === 'right') el.align = 'left';
    }
  });
  redraw(); renderProps(); saveToLocal();
}

function updateDuplexUI() {
  document.getElementById('side-switcher').style.display = state.duplex ? 'block' : 'none';
  document.getElementById('duplex-layout-row').style.display = state.duplex ? 'flex' : 'none';
  if (!state.duplex && state.currentSide === 'back') { setSide('front'); }
}

function updatePage() {
  state.pageW = +document.getElementById('page-w').value || 210;
  state.pageH = +document.getElementById('page-h').value || 297;
  state.cols = +document.getElementById('cols').value || 1;
  state.rows = +document.getElementById('rows').value || 1;
  state.marginTop = +document.getElementById('margin-t').value || 0;
  state.marginRight = +document.getElementById('margin-r').value || 0;
  state.marginBottom = +document.getElementById('margin-b').value || 0;
  state.marginLeft = +document.getElementById('margin-l').value || 0;
  state.gap = +document.getElementById('gap').value || 0;
  state.sizeMode = document.getElementById('size-mode').value;
  state.duplexLayout = document.getElementById('duplex-layout').value;

  const wInput = document.getElementById('badge-w'), hInput = document.getElementById('badge-h');
  if (state.sizeMode === 'auto') {
    state.badgeW = (state.pageW - state.marginLeft - state.marginRight - (state.cols - 1) * state.gap) / state.cols;
    state.badgeH = (state.pageH - state.marginTop - state.marginBottom - (state.rows - 1) * state.gap) / state.rows;
    wInput.value = state.badgeW.toFixed(1); hInput.value = state.badgeH.toFixed(1);
    wInput.disabled = true; hInput.disabled = true;
  } else {
    state.badgeW = +wInput.value || 86; state.badgeH = +hInput.value || 54;
    wInput.disabled = false; hInput.disabled = false;
  }

  state.badgeBg = document.getElementById('badge-bg').value;
  document.getElementById('orient-portrait').classList.toggle('active', state.pageH >= state.pageW);
  document.getElementById('orient-landscape').classList.toggle('active', state.pageW > state.pageH);
  document.getElementById('badge-portrait').classList.toggle('active', state.badgeH > state.badgeW);
  document.getElementById('badge-landscape').classList.toggle('active', state.badgeW >= state.badgeH);

  document.getElementById('summary-text').innerHTML = `Page: ${state.pageW}×${state.pageH} mm<br>Grid: ${state.cols} cols × ${state.rows} rows<br>Badge: ${state.badgeW.toFixed(1)}×${state.badgeH.toFixed(1)} mm`;

  const area = document.getElementById('canvas-area');
  if (area && area.clientWidth > 0) {
    const scaleX = (area.clientWidth - 80) / (state.badgeW * PX_PER_MM);
    const scaleY = (area.clientHeight - 80) / (state.badgeH * PX_PER_MM);
    canvasScale = Math.min(scaleX, scaleY, 1) * state.zoom;
    badgeWpx = Math.round(state.badgeW * PX_PER_MM);
    badgeHpx = Math.round(state.badgeH * PX_PER_MM);
    canvas.width = badgeWpx; canvas.height = badgeHpx;
    canvas.style.width = Math.round(badgeWpx * canvasScale) + 'px';
    canvas.style.height = Math.round(badgeHpx * canvasScale) + 'px';
    document.getElementById('zoom-label').textContent = Math.round(canvasScale * 100) + '%';
  }
  document.getElementById('sb-size').textContent = state.badgeW.toFixed(1) + '×' + state.badgeH.toFixed(1) + ' mm';
  updateLayoutPreview(); redraw(); saveToLocal();
}

function getSlotInfo(i, recordsCount) {
  if (!state.duplex) return { recordIdx: i, isBack: false, valid: i < recordsCount };
  const bpp = state.cols * state.rows;
  const pageIdx = Math.floor(i / bpp);
  const localIdx = i % bpp;
  let recordIdx, isBack;
  if (state.duplexLayout === 'horizontal') {
    recordIdx = pageIdx * Math.floor(bpp / 2) + Math.floor(localIdx / 2);
    isBack = localIdx % 2 === 1;
  } else {
    const r = Math.floor(localIdx / state.cols);
    const c = localIdx % state.cols;
    const pairRow = Math.floor(r / 2);
    isBack = r % 2 === 1;
    recordIdx = pageIdx * (state.cols * Math.floor(state.rows / 2)) + (pairRow * state.cols + c);
    if (r === state.rows - 1 && state.rows % 2 === 1) return { valid: false };
  }
  return { recordIdx, isBack, valid: recordIdx < recordsCount };
}

function updateLayoutPreview() {
  const outline = document.getElementById('page-outline');
  if (!outline || outline.parentElement.clientWidth === 0) return;
  const scale = Math.min((outline.parentElement.clientWidth-80)/state.pageW, (outline.parentElement.clientHeight-80)/state.pageH);
  outline.style.width = (state.pageW * scale) + 'px'; outline.style.height = (state.pageH * scale) + 'px';
  let h = '';
  const bpp = state.cols * state.rows;
  for (let i=0; i<bpp; i++) {
      const r = Math.floor(i / state.cols), c = i % state.cols;
      const x = state.marginLeft + c*(state.badgeW+state.gap), y = state.marginTop + r*(state.badgeH+state.gap);
      const fits = (x+state.badgeW <= state.pageW-state.marginRight+0.1) && (y+state.badgeH <= state.pageH-state.marginBottom+0.1);
      const info = getSlotInfo(i, 999999);
      let label = (state.duplex && info.valid) ? (info.isBack ? "BACK" : "FRONT") : "";
      h += `<div class="badge-slot" style="left:${x*scale}px; top:${y*scale}px; width:${state.badgeW*scale}px; height:${state.badgeH*scale}px; border-color:${fits?'var(--accent)':'var(--danger)'}">${label}</div>`;
  }
  h += `<div style="position:absolute; border:1px dashed rgba(255,0,0,0.3); left:${state.marginLeft*scale}px; top:${state.marginTop*scale}px; right:${state.marginRight*scale}px; bottom:${state.marginBottom*scale}px; pointer-events:none"></div>`;
  outline.innerHTML = h;
}

function setOrientation(o) {
  const w = +document.getElementById('page-w').value, h = +document.getElementById('page-h').value;
  if ((o==='landscape' && h>w) || (o==='portrait' && w>h)) { document.getElementById('page-w').value = h; document.getElementById('page-h').value = w; }
  updatePage();
}

function setBadgeOrientation(o) {
  if (state.sizeMode === 'auto') {
    const c = +document.getElementById('cols').value, r = +document.getElementById('rows').value;
    const bW = (state.pageW-state.marginLeft-state.marginRight-(c-1)*state.gap)/c;
    const bH = (state.pageH-state.marginTop-state.marginBottom-(r-1)*state.gap)/r;
    if ((o==='landscape' && bH > bW) || (o==='portrait' && bW > bH)) { document.getElementById('cols').value = r; document.getElementById('rows').value = c; }
  } else {
    const w = +document.getElementById('badge-w').value, h = +document.getElementById('badge-h').value;
    if ((o==='landscape' && h>w) || (o==='portrait' && w>h)) { document.getElementById('badge-w').value = h; document.getElementById('badge-h').value = w; }
  }
  updatePage();
}

function addElement(type) {
  const cx = badgeWpx/2, cy = badgeHpx/2;
  let count = 1, name = type + '_' + count;
  while(state.elements.find(e => e.name === name)) { count++; name = type + '_' + count; }
  let el = { id: Date.now(), type, x: Math.round(cx-40), y: Math.round(cy-20), w: 80, h: 40, rotation: 0, name };
  if (type==='text') el = {...el, text: 'Text', fontSize: 16, fontWeight: 'bold', color: '#1a1916', align: 'center', fontFamily: 'DM Sans, sans-serif', allCaps: false};
  else if (type==='rect' || type==='ellipse') el = {...el, fill: '#3b82f6', stroke: 'none', strokeW: 1, rx: 4};
  else if (type==='line') el = {...el, stroke: '#000000', strokeW: 2, w: 80, h: 4};
  else if (type==='qr') el = {...el, qrData: '', mappings: { firstName: '', lastName: '', org: '', title: '', tel: '', email: '' }, w: 50, h: 50};
  else if (type==='image') el = {...el, src: '', w: 50, h: 50};
  state.elements.push(el); state.selectedId = el.id;
  if(type==='text') updateProp('fontSize', el.fontSize);
  updatePage(); renderLayers(); renderProps();
}

function deleteSelected() { if (!state.selectedId) return; state.elements = state.elements.filter(e => e.id !== state.selectedId); state.selectedId = null; redraw(); renderLayers(); renderProps(); updateStatus(); saveToLocal(); }

function getVCardData(record, mappings) {
  if (!record || !mappings) return '';
  const firstName = record[mappings.firstName] || '',
        lastName = record[mappings.lastName] || '',
        org = record[mappings.org] || '',
        title = record[mappings.title] || '',
        tel = record[mappings.tel] || '',
        email = record[mappings.email] || '';
  const fn = [firstName, lastName].filter(Boolean).join(' ');
  if (!fn && !org && !title && !tel && !email) return '';

  let lines = ['BEGIN:VCARD', 'VERSION:3.0'];
  if (fn) lines.push(`FN:${fn}`);
  if (lastName || firstName) lines.push(`N:${lastName};${firstName};;;`);
  if (org) lines.push(`ORG:${org}`);
  if (title) lines.push(`TITLE:${title}`);
  
  if (tel) {
    let t = tel.trim();
    // Converting UK 07... numbers to +44... format.
    // This is the most reliable way to stop Android from misinterpreting the number
    // as a US number and adding hyphens, while keeping the QR code generation stable.
    if (/^0\d{10}$/.test(t)) {
      t = '+44' + t.slice(1);
    }
    lines.push(`TEL;TYPE=CELL,VOICE;VALUE=text:${t}`);
  }
  
  if (email) lines.push(`EMAIL;TYPE=INTERNET,WORK:${email}`);
  lines.push('END:VCARD');
  return lines.join('\n');
}

function drawElement(el, ctx, record) {
  ctx.save();
  try {
  const cx = el.x + el.w / 2, cy = el.y + el.h / 2;
  ctx.translate(cx, cy); ctx.rotate((el.rotation || 0) * Math.PI / 180); ctx.translate(-cx, -cy);
  if (el.type === 'rect') {
    ctx.beginPath(); 
    if(el.rx) {
        const x=el.x, y=el.y, w=el.w, h=el.h, r=el.rx;
        ctx.moveTo(x+r, y); ctx.lineTo(x+w-r, y); ctx.quadraticCurveTo(x+w, y, x+w, y+r);
        ctx.lineTo(x+w, y+h-r); ctx.quadraticCurveTo(x+w, y+h, x+w-r, y+h);
        ctx.lineTo(x+r, y+h); ctx.quadraticCurveTo(x, y+h, x, y+h-r);
        ctx.lineTo(x, y+r); ctx.quadraticCurveTo(x, y, x+r, y);
    } else { ctx.rect(el.x, el.y, el.w, el.h); }
    if (el.fill && el.fill !== 'none') { ctx.fillStyle = el.fill; ctx.fill(); }
    if (el.stroke && el.stroke !== 'none') { ctx.strokeStyle = el.stroke; ctx.lineWidth = el.strokeW || 1; ctx.stroke(); }
  } else if (el.type === 'ellipse') {
    ctx.beginPath(); ctx.ellipse(el.x+el.w/2, el.y+el.h/2, el.w/2, el.h/2, 0, 0, Math.PI*2);
    if (el.fill && el.fill !== 'none') { ctx.fillStyle = el.fill; ctx.fill(); }
    if (el.stroke && el.stroke !== 'none') { ctx.strokeStyle = el.stroke; ctx.lineWidth = el.strokeW || 1; ctx.stroke(); }
  } else if (el.type === 'line') {
    ctx.beginPath(); ctx.moveTo(el.x, el.y + el.h/2); ctx.lineTo(el.x + el.w, el.y + el.h/2);
    ctx.strokeStyle = el.stroke || '#000000'; ctx.lineWidth = el.strokeW || 1; ctx.stroke();
  } else if (el.type === 'text') {
    let t = fillVars(el.text, record);
    if (el.allCaps) t = t.toUpperCase();
    const fs = fittedFontSize(el, t, ctx);
    ctx.fillStyle = el.color || '#000000'; ctx.font = textFont(el, fs);
    ctx.textAlign = el.align || 'left'; ctx.textBaseline = 'top';
    const tx = el.align==='center'?el.x+el.w/2:(el.align==='right'?el.x+el.w:el.x);
    const lines = el.fit ? [t] : wrapTextToLines(t, el.w, s => ctx.measureText(s).width);
    lines.forEach((line, i) => {
        const ly = el.y + i * (fs * 1.2); ctx.fillText(line, tx, ly);
        if(el.underline) { 
            const m = ctx.measureText(line); let ux = tx; if(el.align==='center') ux = tx-m.width/2; else if(el.align==='right') ux = tx-m.width;
            ctx.beginPath(); ctx.moveTo(ux, ly+fs*1.1); ctx.lineTo(ux+m.width, ly+fs*1.1); ctx.strokeStyle = el.color; ctx.lineWidth = Math.max(1, fs/15); ctx.stroke();
        }
    });
  } else if (el.type === 'qr') {
    let fData = el.qrData || '';
    if (el.mappings && record) {
      fData = getVCardData(record, el.mappings);
    } else if (fData.includes('{{') && record) { fData = fillVars(fData, record); }
    if(fData) { const q = getQRImage(fData); if(q && q.complete) ctx.drawImage(q, el.x, el.y, el.w, el.h); }
    else { ctx.strokeStyle = '#ccc'; ctx.setLineDash([2, 2]); ctx.strokeRect(el.x, el.y, el.w, el.h); ctx.setLineDash([]); }
  } else if (el.type === 'image') {
    if (el.src) {
      const img = imageCache[el.src];
      // Images from servers without CORS can be shown in the editor but would block printing
      if (img && !(img._tainted && ctx.canvas !== canvas)) ctx.drawImage(img, el.x, el.y, el.w, el.h); else if (!img) loadImageToCache(el.src);
    }
    else { ctx.strokeStyle='#ccc'; ctx.setLineDash([2, 2]); ctx.strokeRect(el.x, el.y, el.w, el.h); ctx.setLineDash([]); }
  }
  } catch(e) { console.warn('drawElement error:', e); }
  ctx.restore();
}

function redraw() {
  const rec = state.csvData[state.currentRecord];
  ctx.fillStyle = state.badgeBg; ctx.fillRect(0,0,canvas.width,canvas.height);
  state.elements.forEach(el => drawElement(el, ctx, rec));
  if (state.selectedId) {
    const el = state.elements.find(e => e.id === state.selectedId);
    if (el) { 
      ctx.save(); 
      const cx = el.x + el.w / 2, cy = el.y + el.h / 2;
      ctx.translate(cx, cy); ctx.rotate((el.rotation || 0) * Math.PI / 180); ctx.translate(-cx, -cy);
      ctx.strokeStyle = '#2a5c8a'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]); ctx.strokeRect(el.x-2, el.y-2, el.w+4, el.h+4); ctx.restore(); 
    }
  }
}

function getQRImage(data) {
  const key = `qr_${data}`; if (qrCache[key]) return qrCache[key];
  const div = document.createElement('div');
  try { new QRCode(div, { text: data, width: 256, height: 256, colorDark: "#000000", colorLight: "#ffffff", correctLevel: QRCode.CorrectLevel.M }); } catch(e) { return null; }
  const qcan = div.querySelector('canvas');
  if (qcan) {
    const img = new Image(); img.src = qcan.toDataURL();
    img.onload = () => redraw();
    qrCache[key] = img; return img;
  }
  return null;
}

// Async version for export — returns a Promise<HTMLImageElement> that resolves once loaded
function getQRImageAsync(data) {
  const key = `qr_${data}`;
  if (qrCache[key] && qrCache[key].complete && qrCache[key].naturalWidth > 0) {
    return Promise.resolve(qrCache[key]);
  }
  return new Promise((resolve) => {
    // If already in cache but not yet loaded, wait for it
    if (qrCache[key]) {
      const existing = qrCache[key];
      if (existing.complete) { resolve(existing); return; }
      existing.addEventListener('load', () => resolve(existing), { once: true });
      existing.addEventListener('error', () => resolve(null), { once: true });
      return;
    }
    const div = document.createElement('div');
    try {
      new QRCode(div, { text: data, width: 256, height: 256, colorDark: "#000000", colorLight: "#ffffff", correctLevel: QRCode.CorrectLevel.M });
    } catch(e) { resolve(null); return; }
    const qcan = div.querySelector('canvas');
    if (!qcan) { resolve(null); return; }
    const img = new Image();
    img.onload = () => { qrCache[key] = img; resolve(img); };
    img.onerror = () => resolve(null);
    img.src = qcan.toDataURL();
  });
}

// Pre-generate all QR images needed for an array of records + elements, returns when all are loaded
async function preloadQRImages(records, elements) {
  const promises = [];
  for (const el of elements) {
    if (el.type !== 'qr') continue;
    for (const record of records) {
      let fData = el.qrData || '';
      if (el.mappings && record) {
        fData = getVCardData(record, el.mappings);
      } else if (fData.includes('{{') && record) {
        fData = fillVars(fData, record);
      }
      if (fData) promises.push(getQRImageAsync(fData));
    }
  }
  // Process in batches of 20 to avoid overwhelming the browser
  const batchSize = 20;
  for (let i = 0; i < promises.length; i += batchSize) {
    await Promise.all(promises.slice(i, i + batchSize));
    await new Promise(r => setTimeout(r, 0)); // yield to UI
  }
}

const imageLoading = {};
function loadImageToCache(src) {
  if (!src || imageCache[src]) return Promise.resolve();
  if (imageLoading[src]) return imageLoading[src];
  return imageLoading[src] = new Promise(resolve => {
    const done = img => { imageCache[src] = img; delete imageLoading[src]; redraw(); resolve(); };
    const img = new Image();
    if (!src.startsWith('data:')) img.crossOrigin = 'anonymous';
    img.onload = () => done(img);
    img.onerror = () => {
      if (src.startsWith('data:')) { delete imageLoading[src]; return resolve(); }
      const plain = new Image(); plain._tainted = true;
      plain.onload = () => done(plain);
      plain.onerror = () => { delete imageLoading[src]; resolve(); };
      plain.src = src;
    };
    img.src = src;
  });
}
function handleImageUpload(e) {
  const file = e.target.files[0]; if(!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => { updateProp('src', ev.target.result); };
  reader.readAsDataURL(file);
}

function renderLayers() {
  const l = document.getElementById('layers-list');
  if(!state.elements.length) { l.innerHTML = '<div style="font-size:12px;opacity:0.5;padding:4px">No layers</div>'; return; }
  l.innerHTML = [...state.elements].reverse().map(el => `<div class="layer-item ${el.id===state.selectedId?'selected':''}" onclick="selectLayer(${el.id})"><div class="layer-dot" style="background:${el.fill||el.color||el.stroke||'#888'}"></div><span class="layer-name">${esc(el.name)}</span><button class="layer-del" onclick="delLayer(event, ${el.id})">✕</button></div>`).join('');
}
function selectLayer(id) { state.selectedId=id; redraw(); renderProps(); renderLayers(); updateStatus(); }
function delLayer(e, id) { e.stopPropagation(); state.elements = state.elements.filter(el => el.id !== id); if (state.selectedId === id) state.selectedId = null; redraw(); renderLayers(); renderProps(); updateStatus(); saveToLocal(); }

function renderProps() {
  const el = state.elements.find(e => e.id === state.selectedId);
  const p = document.getElementById('props-panel'), zs = document.getElementById('zorder-section'), vs = document.getElementById('vars-section');
  if (!el) { document.getElementById('props-empty').style.display='flex'; p.style.display='none'; zs.style.display='none'; vs.style.display='none'; return; }
  document.getElementById('props-empty').style.display='none'; p.style.display='block'; zs.style.display='block'; vs.style.display = state.csvHeaders.length ? 'block' : 'none';
  if(state.csvHeaders.length) { document.getElementById('vars-list').innerHTML = state.csvHeaders.map(h => `<span style="background:var(--accent-light);color:var(--accent);font-size:10px;padding:2px 4px;border-radius:3px;cursor:pointer" data-var="${esc(h)}" onclick="insertVar('{{' + this.dataset.var + '}}')">{{${esc(h)}}}</span>`).join(''); }
  let h = `<div class="prop-row"><label>Name</label><input type="text" value="${esc(el.name)}" oninput="updateProp('name',this.value)"></div>` +
          `<div class="prop-row"><label>X / Y</label><div style="display:flex;gap:4px;flex:1;min-width:0"><input type="number" value="${el.x}" oninput="updateProp('x',+this.value)"><input type="number" value="${el.y}" oninput="updateProp('y',+this.value)"></div></div>` +
          `<div class="prop-row"><label>W / H</label><div style="display:flex;gap:4px;flex:1;min-width:0"><input type="number" value="${el.w}" oninput="updateProp('w',+this.value)">${el.type==='line'?'':`<input type="number" value="${el.h}" oninput="updateProp('h',+this.value)">`}</div></div>` +
          `<div class="prop-row"><label>Rotation</label><input type="number" value="${el.rotation||0}" oninput="updateProp('rotation',+this.value)"></div>`;
  if(el.type==='text') {
    h += `<div class="prop-row"><label>Text</label><textarea oninput="updateProp('text',this.value)">${esc(el.text)}</textarea></div>`;
    h += `<div class="prop-row"><label>Font</label><select onchange="updateProp('fontFamily',this.value)"><option value="DM Sans, sans-serif" ${el.fontFamily.includes('DM Sans')?'selected':''}>DM Sans</option><option value="DM Mono, monospace" ${el.fontFamily.includes('DM Mono')?'selected':''}>DM Mono</option><option value="Arial, sans-serif" ${el.fontFamily==='Arial, sans-serif'?'selected':''}>Arial</option></select></div>`;
    h += `<div class="prop-row"><label>Size</label><input type="number" value="${el.fontSize}" oninput="updateProp('fontSize',+this.value)"></div>`;
    h += `<div class="prop-row"><label>Color</label><input type="color" value="${el.color||'#000000'}" onchange="updateProp('color',this.value)"></div>`;
    h += `<div class="prop-row"><label>Style</label><div style="display:flex;gap:4px;flex:1"><button class="btn ${el.fontWeight==='bold'?'active':''}" onclick="updateProp('fontWeight', state.elements.find(e=>e.id===state.selectedId).fontWeight==='bold'?'normal':'bold')" style="flex:1;padding:4px">B</button><button class="btn ${el.fontStyle==='italic'?'active':''}" onclick="updateProp('fontStyle', state.elements.find(e=>e.id===state.selectedId).fontStyle==='italic'?'normal':'italic')" style="flex:1;padding:4px">I</button><button class="btn ${el.underline?'active':''}" onclick="updateProp('underline', !state.elements.find(e=>e.id===state.selectedId).underline)" style="flex:1;padding:4px">U</button><button class="btn ${el.allCaps?'active':''}" onclick="updateProp('allCaps', !state.elements.find(e=>e.id===state.selectedId).allCaps)" style="flex:1;padding:4px" title="All Caps">AA</button><button class="btn ${el.fit?'active':''}" onclick="updateProp('fit', !state.elements.find(e=>e.id===state.selectedId).fit)" style="flex:1;padding:4px" title="Shrink to fit on one line (good for long names)">Fit</button></div></div>`;
  }
  if(el.type === 'qr') {
    h += `<div style="margin-top:10px; padding-top:10px; border-top:1px solid var(--border)"><div class="panel-section-title" style="margin-bottom:8px">vCard Mappings</div>`;
    const flds = [{k:'firstName',l:'First Name'},{k:'lastName',l:'Last Name'},{k:'org',l:'Company'},{k:'title',l:'Job Title'},{k:'tel',l:'Phone'},{k:'email',l:'Email'}];
    flds.forEach(f => { h += `<div class="prop-row"><label>${f.l}</label><select onchange="updateQRMapping('${f.k}', this.value)"><option value="">-- None --</option>${state.csvHeaders.map(head => `<option value="${esc(head)}" ${el.mappings?.[f.k] === head ? 'selected' : ''}>${esc(head)}</option>`).join('')}</select></div>`; });
    h += `</div>`;
  }
  if(['rect','ellipse','line'].includes(el.type)) {
     if(el.type !== 'line') h += `<div class="prop-row"><label>Fill</label><input type="color" value="${el.fill && el.fill!=='none' ? el.fill : '#ffffff'}" onchange="updateProp('fill',this.value)"></div>`;
     h += `<div class="prop-row"><label>Stroke</label><div style="display:flex;gap:4px;flex:1"><input type="color" value="${el.stroke && el.stroke!=='none' ? el.stroke : '#000000'}" onchange="updateProp('stroke',this.value)"><button class="btn ${el.stroke==='none'?'active':''}" onclick="updateProp('stroke', 'none')" style="padding:4px">None</button></div></div>`;
     h += `<div class="prop-row"><label>Stroke W</label><input type="number" value="${el.strokeW||1}" oninput="updateProp('strokeW',+this.value)"></div>`;
  }
  if(el.type === 'image') {
    h += `<div class="prop-row"><label>Source URL</label><input type="text" value="${el.src && el.src.startsWith('data:') ? '(uploaded image)' : esc(el.src||'')}" oninput="updateProp('src',this.value)" placeholder="https://..."></div>`;
    h += `<div class="prop-row"><label></label><button class="btn" onclick="document.getElementById('img-upload').click()" style="width:100%">Upload Local File</button><input type="file" id="img-upload" style="display:none" onchange="handleImageUpload(event)" accept="image/*"></div>`;
  }
  p.innerHTML = h;
}
function updateProp(k, v) { 
  const el = state.elements.find(e => e.id === state.selectedId); 
  if(el){ 
    el[k]=v; 
    if(k==='src') loadImageToCache(v);
    if(el.type==='text' && !el.fit && (k==='fontSize' || k==='text' || k==='fontFamily' || k==='fontWeight' || k==='allCaps')) {
       ctx.font = `${el.fontStyle||''} ${el.fontWeight||'normal'} ${el.fontSize}px ${el.fontFamily||'sans-serif'}`;
       let text = (el.text || 'Text').replace(/\{\{(.+?)\}\}/g, 'W');
       if (el.allCaps) text = text.toUpperCase();
       const m = ctx.measureText(text);
       el.w = Math.ceil(m.width) + 10;
       el.h = Math.ceil(el.fontSize * 1.2);
    }
    redraw(); saveToLocal(); updateStatus(); 
    if(['name','stroke','fit','fontWeight','fontStyle','underline','allCaps'].includes(k)) { renderLayers(); renderProps(); } 
  } 
}
function updateQRMapping(f, v) { const el = state.elements.find(e => e.id === state.selectedId); if(el && el.type === 'qr'){ if(!el.mappings) el.mappings = {}; el.mappings[f] = v; redraw(); saveToLocal(); } }
function insertVar(v) { const el = state.elements.find(e => e.id === state.selectedId); if(el && el.type==='text'){ el.text += v; updateProp('text', el.text); redraw(); renderProps(); } }

function updateStatus() {
  document.getElementById('sb-count').textContent = state.elements.length; document.getElementById('sb-records').textContent = state.csvData.length;
  const sel = state.elements.find(e => e.id === state.selectedId); document.getElementById('sb-sel').style.display = sel ? '' : 'none'; if(sel) document.getElementById('sb-sel-name').textContent = sel.name;
}

let previewRun = 0;
async function renderPreview() {
  const run = ++previewRun;
  const grid = document.getElementById('preview-grid');
  const records = state.csvData.length ? state.csvData : [null];
  // QR codes and images load asynchronously; wait for them so every badge draws complete
  const allElements = state.duplex ? [...(state.designs.front || []), ...(state.designs.back || [])] : state.elements;
  if (allElements.some(el => el.type === 'qr' || el.type === 'image')) {
    document.getElementById('preview-info').textContent = 'Preparing preview…';
    await Promise.all([preloadImages(allElements), preloadQRImages(records.filter(Boolean), allElements)]);
    if (run !== previewRun) return; // a newer preview started while we waited
  }
  grid.innerHTML = '';
  const bpp = state.cols * state.rows;
  let recordsPerPage = state.duplex ? (state.duplexLayout === 'horizontal' ? Math.floor(bpp / 2) : state.cols * Math.floor(state.rows / 2)) : bpp;
  const pages = Math.ceil(records.length / (recordsPerPage || 1));
  const scale = 0.6, pW = state.pageW*PX_PER_MM*scale, pH = state.pageH*PX_PER_MM*scale;
  const bW = state.badgeW*PX_PER_MM*scale, bH = state.badgeH*PX_PER_MM*scale;
  document.getElementById('preview-info').textContent = `${records.length} records ${state.duplex?'(double-sided)':''} / ${pages} page${pages!==1?'s':''}`;
  for (let p=0; p<pages; p++) {
    const pDiv = document.createElement('div'); pDiv.className = 'preview-page'; pDiv.style.width = pW+'px'; pDiv.style.height = pH+'px';
    for (let i=0; i<bpp; i++) {
      const globalSlotIdx = p * bpp + i, info = getSlotInfo(globalSlotIdx, records.length);
      if (!info.valid) continue;
      const record = records[info.recordIdx], r = Math.floor(i/state.cols), c = i%state.cols;
      const bDiv = document.createElement('div'); bDiv.className = 'preview-badge'; bDiv.style.width = bW + 'px'; bDiv.style.height = bH + 'px';
      bDiv.style.left = (state.marginLeft + c*(state.badgeW+state.gap))*PX_PER_MM*scale + 'px';
      bDiv.style.top = (state.marginTop + r*(state.badgeH+state.gap))*PX_PER_MM*scale + 'px';
      const bcan = document.createElement('canvas'); bcan.width = state.badgeW*PX_PER_MM; bcan.height = state.badgeH*PX_PER_MM; bcan.style.width = '100%'; bcan.style.height = '100%';
      const bctx = bcan.getContext('2d'); bctx.fillStyle = state.badgeBg; bctx.fillRect(0,0,bcan.width,bcan.height);
      const sideElements = state.duplex ? (info.isBack ? state.designs.back : state.designs.front) : state.elements;
      (sideElements || []).forEach(el => drawElement(el, bctx, record));
      bDiv.appendChild(bcan); pDiv.appendChild(bDiv);
      if (state.duplex) {
         const label = document.createElement('div'); label.style = "position:absolute; bottom:2px; right:4px; font-size:9px; color:rgba(0,0,0,0.3); font-family:sans-serif; pointer-events:none";
         label.textContent = info.isBack ? 'BACK' : 'FRONT'; bDiv.appendChild(label);
      }
    }
    grid.appendChild(pDiv);
  }
}

function applyPreset() {
  const p = document.getElementById('page-preset').value, presets = { a4:[210,297], letter:[216,279], a5:[148,210] };
  if (presets[p]) { document.getElementById('page-w').value = presets[p][0]; document.getElementById('page-h').value = presets[p][1]; }
  updatePage();
}

function changeZoom(d) { state.zoom = Math.max(0.1, Math.min(5, state.zoom + d)); updatePage(); }
function resetZoom() { state.zoom = 1; updatePage(); }
function toggleDarkMode() { state.darkMode = !state.darkMode; applyTheme(); saveToLocal(); }
function applyTheme() { document.body.setAttribute('data-theme', state.darkMode ? 'dark' : 'light'); }
function reorder(dir) { const idx = state.elements.findIndex(e=>e.id===state.selectedId); if(idx<0) return; const el = state.elements.splice(idx,1)[0]; if(dir==='top') state.elements.push(el); else state.elements.unshift(el); redraw(); renderLayers(); saveToLocal(); }
function alignElement(dir) { const el = state.elements.find(e=>e.id===state.selectedId); if(!el) return; if(dir==='h-center') el.x = (badgeWpx-el.w)/2; else if(dir==='left') el.x=0; else if(dir==='right') el.x=badgeWpx-el.w; redraw(); renderProps(); saveToLocal(); }

function saveToLocal() {
  state.designs[state.currentSide] = [...state.elements];
  if (window.onDesignChanged) window.onDesignChanged();
  localStorage.setItem('badgecraft_design', JSON.stringify({...state, csvData:[], csvHeaders:[]}));
}
function loadFromLocal() {
  const saved = localStorage.getItem('badgecraft_design');
  if (saved) {
    try {
      const d = JSON.parse(saved);
      if (d.elements && (!d.designs || !d.designs.front)) { d.designs = { front: d.elements, back: [] }; }
      Object.assign(state, d);
      state.elements = [...(state.designs[state.currentSide || 'front'] || [])];
      updateUIFromState(); updateDuplexUI();
    } catch(e){ console.error("Load failed", e); }
  }
}
function updateUIFromState() {
  const fields = {'page-w':'pageW','page-h':'pageH','cols':'cols','rows':'rows','margin-t':'marginTop','margin-r':'marginRight','margin-b':'marginBottom','margin-l':'marginLeft','gap':'gap','badge-w':'badgeW','badge-h':'badgeH','badge-bg':'badgeBg','snap-grid':'snap','size-mode':'sizeMode','duplex-mode':'duplex'};
  for(let id in fields) { const el=document.getElementById(id); if(el) { if(el.type==='checkbox') el.checked=state[fields[id]]; else el.value=state[fields[id]]; } }
  // Reset page preset to custom since we can't reverse-lookup presets
  const presetEl = document.getElementById('page-preset'); if (presetEl) presetEl.value = 'custom';
}

function exportDesign() { 
  state.designs[state.currentSide] = [...state.elements];
  const d = { version:1, designs: state.designs, badgeW: state.badgeW, badgeH: state.badgeH, badgeBg: state.badgeBg, sizeMode: state.sizeMode, duplex: state.duplex };
  downloadJSON(d, 'design.json'); 
}
function exportLayout() {
  const l = { version:1, pageW: state.pageW, pageH: state.pageH, cols: state.cols, rows: state.rows, marginTop: state.marginTop, marginRight: state.marginRight, marginBottom: state.marginBottom, marginLeft: state.marginLeft, gap: state.gap };
  downloadJSON(l, 'layout.json');
}
function exportFull() { 
  state.designs[state.currentSide] = [...state.elements];
  // Build a clean export object with exact values to avoid floating-point drift
  const exportState = {
    ...state,
    marginTop: +document.getElementById('margin-t').value,
    marginRight: +document.getElementById('margin-r').value,
    marginBottom: +document.getElementById('margin-b').value,
    marginLeft: +document.getElementById('margin-l').value,
    pageW: +document.getElementById('page-w').value,
    pageH: +document.getElementById('page-h').value,
    cols: +document.getElementById('cols').value,
    rows: +document.getElementById('rows').value,
    gap: +document.getElementById('gap').value,
  };
  downloadJSON(exportState, 'full-project.json'); 
}
function downloadJSON(obj, name) {
  const d = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(obj, null, 2));
  const a = document.createElement('a'); a.setAttribute("href", d); a.setAttribute("download", name); a.click();
}

function importDesign(e, type) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const d = JSON.parse(ev.target.result);
      if (type === 'design') {
        if (d.designs) state.designs = d.designs; else if (d.elements) state.designs = { front: d.elements, back: [] };
        state.badgeW = d.badgeW || 86; state.badgeH = d.badgeH || 54; state.badgeBg = d.badgeBg || '#ffffff'; state.sizeMode = d.sizeMode || 'auto';
        state.duplex = !!d.duplex; state.elements = [...(state.designs[state.currentSide] || [])];
      } else if (type === 'layout') {
        state.pageW = d.pageW || 210; state.pageH = d.pageH || 297; state.cols = d.cols || 2; state.rows = d.rows || 4;
        state.marginTop = d.marginTop ?? 10; state.marginRight = d.marginRight ?? 10; state.marginBottom = d.marginBottom ?? 10; state.marginLeft = d.marginLeft ?? 10; state.gap = d.gap ?? 5;
      } else {
        // Full import — preserve all state fields exactly as exported
        const csvData = state.csvData, csvHeaders = state.csvHeaders; // keep live CSV
        Object.assign(state, d);
        state.csvData = csvData; state.csvHeaders = csvHeaders;
        if (!state.designs) state.designs = { front: state.elements || [], back: [] };
        state.elements = [...(state.designs[state.currentSide || 'front'] || [])];
        state.currentSide = state.currentSide || 'front';
      }
      updateUIFromState(); updateDuplexUI();
      // Defer updatePage so the canvas area has real dimensions in the DOM
      requestAnimationFrame(() => { updatePage(); renderLayers(); redraw(); renderProps(); });
    } catch(err) { showAlert('Import failed', 'That file is not a valid BadgeCraft JSON file.'); }
  };
  reader.readAsText(file);
}

// ─── SHARED HELPERS ─────────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showToast(message, type = '', action = null) {
  let wrap = document.getElementById('toast-wrap');
  if (!wrap) { wrap = document.createElement('div'); wrap.id = 'toast-wrap'; document.body.appendChild(wrap); }
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  const text = document.createElement('span');
  text.textContent = message;
  t.appendChild(text);
  const dismiss = () => { t.classList.add('out'); setTimeout(() => t.remove(), 300); };
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.onclick = () => { dismiss(); action.onClick(); };
    t.appendChild(b);
  }
  wrap.appendChild(t);
  // Busy desks fire lots of these — keep only the latest few on screen
  [...wrap.children].slice(0, -3).forEach(old => old.remove());
  setTimeout(dismiss, action ? 12000 : (type === 'error' ? 6000 : 3200));
}

// Best display name for a record from any source (Eventbrite, CSV, walk-in form)
function recordName(r) {
  if (!r) return '';
  return String(r.name || [r.first_name, r.last_name].filter(Boolean).join(' ') || r.full_name || r.Name || '').trim();
}

// ─── RECORD NAVIGATION (design preview) ─────────────────────────
function updateRecordNav() {
  const nav = document.getElementById('record-nav');
  if (!nav) return;
  const n = state.csvData.length;
  nav.style.display = n ? 'flex' : 'none';
  if (state.currentRecord >= n) state.currentRecord = 0;
  document.getElementById('record-label').textContent = n ? `${state.currentRecord + 1} / ${n}` : '–';
  const who = document.getElementById('record-name');
  if (who) who.textContent = n ? recordName(state.csvData[state.currentRecord]) : '';
}
function prevRecord() { const n = state.csvData.length; if (!n) return; state.currentRecord = (state.currentRecord - 1 + n) % n; updateRecordNav(); redraw(); }
function nextRecord() { const n = state.csvData.length; if (!n) return; state.currentRecord = (state.currentRecord + 1) % n; updateRecordNav(); redraw(); }

// ─── HIGH-RESOLUTION BADGE RENDERING (reception printing) ───────
// A design here is the parsed JSON saved by the designer (the `state` shape).
function normalizeDesign(d) {
  d = d || {};
  const sides = d.designs && (d.designs.front || d.designs.back) ? d.designs : { front: d.elements || [], back: [] };
  const num = (v, def) => (v === undefined || v === null || v === '' || isNaN(+v)) ? def : +v;
  return {
    badgeW: num(d.badgeW, 86), badgeH: num(d.badgeH, 54), badgeBg: d.badgeBg || '#ffffff',
    duplex: !!d.duplex, front: sides.front || [], back: sides.back || [],
    pageW: num(d.pageW, 210), pageH: num(d.pageH, 297), cols: num(d.cols, 2), rows: num(d.rows, 4),
    marginTop: num(d.marginTop, 10), marginLeft: num(d.marginLeft, 10), gap: num(d.gap, 5),
  };
}

function currentDesignJSON() {
  state.designs[state.currentSide] = [...state.elements];
  return JSON.stringify({ ...state, csvData: [], csvHeaders: [], selectedId: null, currentRecord: 0 });
}

function preloadImages(elements) {
  return Promise.all(elements.filter(el => el.type === 'image' && el.src).map(el => loadImageToCache(el.src)));
}

async function prepareBadgeRender(design, records) {
  const els = [...design.front, ...(design.duplex ? design.back : [])];
  await Promise.all([preloadImages(els), preloadQRImages(records, els), document.fonts ? document.fonts.ready : null]);
}

function renderBadgeCanvas(design, record, side = 'front', dpi = 300) {
  const scale = dpi / 96;
  const w = Math.round(design.badgeW * PX_PER_MM), h = Math.round(design.badgeH * PX_PER_MM);
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale); c.height = Math.round(h * scale);
  const cx = c.getContext('2d');
  cx.scale(scale, scale);
  cx.fillStyle = design.badgeBg; cx.fillRect(0, 0, w, h);
  (side === 'back' ? design.back : design.front).forEach(el => drawElement(el, cx, record));
  return c;
}

// ─── EXPORT PANEL (bulk PDF) ────────────────────────────────────
let printMode = 'combined', exportCancelled = false;

function setPrintMode(mode) {
  printMode = mode;
  ['combined', 'page', 'individual'].forEach(m => document.getElementById('mode-btn-' + m).classList.toggle('active', m === mode));
  document.getElementById('zip-row').style.display = mode === 'combined' ? 'none' : 'flex';
  updatePrintSummary();
}

function refreshPrintTab() { updatePrintSummary(); }

function getExportRange() {
  const total = state.csvData.length || 1;
  const from = Math.max(1, parseInt(document.getElementById('range-from').value) || 1);
  const to = Math.min(total, parseInt(document.getElementById('range-to').value) || total);
  return { from: from - 1, to: Math.max(from, to) - 1 };
}

function updatePrintSummary() {
  const { from, to } = getExportRange();
  const count = state.csvData.length ? to - from + 1 : 0, bpp = state.cols * state.rows;
  const useZip = document.getElementById('zip-download').checked;
  const recordsPerPage = state.duplex ? (state.duplexLayout === 'horizontal' ? Math.floor(bpp / 2) : state.cols * Math.floor(state.rows / 2)) : bpp;
  const pages = Math.ceil(count / (recordsPerPage || 1));
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('ps-records', `${count} of ${state.csvData.length}`);
  set('ps-mode', printMode === 'combined' ? 'Combined PDF' : (printMode === 'page' ? 'One PDF per page' : 'One PDF per attendee'));
  set('ps-bpp', recordsPerPage + (state.duplex ? ' (double-sided)' : ''));
  set('ps-page', `${state.pageW}×${state.pageH} mm`);
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const files = printMode === 'combined' ? `1 PDF (${plural(pages, 'page')})` : `${useZip ? '1 ZIP of ' : ''}${plural(printMode === 'page' ? pages : count, 'PDF')}`;
  set('ps-files', files);
  set('filename-extension-label', printMode !== 'combined' && useZip ? '.zip' : '.pdf');
  const btn = document.getElementById('export-btn');
  btn.textContent = count ? `Export ${files}` : 'No attendees to export';
  btn.disabled = !count;
}

function buildFilename(record, idx) {
  return recordName(record) || `badge_${idx + 1}`;
}

async function startPrintExport() {
  if (!state.csvData.length) { showAlert('Nothing to export', 'This event has no attendees yet.'); return; }
  state.designs[state.currentSide] = [...state.elements];
  try {
    if (printMode === 'combined') await exportCombinedPDF();
    else if (printMode === 'page') await exportPagePDFs();
    else await exportIndividualPDFs();
  } catch (e) {
    console.error(e);
    showAlert('Export failed', e.message);
    document.getElementById('batch-progress-wrap').style.display = 'none';
    document.getElementById('cancel-btn').style.display = 'none';
    document.getElementById('export-btn').disabled = false;
  }
}

function cancelExport() { exportCancelled = true; }

async function exportPagePDFs() {
  const { jsPDF } = window.jspdf;
  const allRecords = state.csvData.length ? state.csvData : [null];
  const { from, to } = getExportRange();
  const records = allRecords.slice(from, to + 1);
  const bpp = state.cols * state.rows;
  let recordsPerPage = state.duplex ? (state.duplexLayout === 'horizontal' ? Math.floor(bpp / 2) : state.cols * Math.floor(state.rows / 2)) : bpp;
  const pages = Math.ceil(records.length / (recordsPerPage || 1));
  const useZip = document.getElementById('zip-download')?.checked;
  const wrap = document.getElementById('batch-progress-wrap'), fill = document.getElementById('batch-progress-fill'), label = document.getElementById('batch-progress-label'), cancelBtn = document.getElementById('cancel-btn'), exportBtn = document.getElementById('export-btn');
  exportCancelled = false; wrap.style.display = 'block'; cancelBtn.style.display = ''; exportBtn.disabled = true; fill.style.width = '0%';

  // Pre-generate all QR images
  const allElements = state.duplex ? [...state.designs.front, ...state.designs.back] : state.elements;
  await preloadImages(allElements);
  const hasQR = allElements.some(el => el.type === 'qr');
  if (hasQR) {
    label.textContent = 'Pre-generating QR codes…';
    await preloadQRImages(records, allElements);
    if (exportCancelled) { wrap.style.display = 'none'; cancelBtn.style.display = 'none'; exportBtn.disabled = false; return; }
  }

  const zip = useZip ? new JSZip() : null;
  const baseName = document.getElementById('combined-filename-input')?.value.trim() || 'page';

  for (let p = 0; p < pages; p++) {
    if (exportCancelled) break;

    const pdf = new jsPDF({ unit: 'mm', format: [state.pageW, state.pageH], orientation: state.pageH > state.pageW ? 'portrait' : 'landscape' });
    for (let i = 0; i < bpp; i++) {
      const globalSlotIdx = p * bpp + i, info = getSlotInfo(globalSlotIdx, records.length);
      if (!info.valid) continue;
      const record = records[info.recordIdx], col = i % state.cols, row = Math.floor(i / state.cols);
      const bX = state.marginLeft + col * (state.badgeW + state.gap), bY = state.marginTop + row * (state.badgeH + state.gap);
      const elements = state.duplex ? (info.isBack ? state.designs.back : state.designs.front) : state.elements;
      renderBadgeToPDF(pdf, record, bX, bY, elements);
    }

    const filename = `${baseName}_${p + 1}.pdf`;
    if (useZip) {
      zip.file(filename, pdf.output('arraybuffer'));
    } else {
      pdf.save(filename);
    }

    const pct = Math.round((p + 1) / pages * 100);
    fill.style.width = pct + '%';
    label.textContent = `Page ${p + 1} / ${pages}`;
    await new Promise(r => setTimeout(r, 0));
  }

  if (!exportCancelled && useZip) {
    label.textContent = 'Compressing…';
    const zipFilename = (document.getElementById('combined-filename-input')?.value.trim() || 'badges') + '-pages.zip';
    const blob = await zip.generateAsync({ type: 'blob' }, meta => {
      fill.style.width = meta.percent.toFixed(0) + '%';
      label.textContent = `Compressing… ${meta.percent.toFixed(0)}%`;
    });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = zipFilename; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  wrap.style.display = 'none'; cancelBtn.style.display = 'none'; exportBtn.disabled = false;
}

async function exportCombinedPDF() {
  const { jsPDF } = window.jspdf;
  const allRecords = state.csvData.length ? state.csvData : [null];
  const { from, to } = getExportRange();
  const records = allRecords.slice(from, to + 1);
  const bpp = state.cols * state.rows;
  let recordsPerPage = state.duplex ? (state.duplexLayout === 'horizontal' ? Math.floor(bpp / 2) : state.cols * Math.floor(state.rows / 2)) : bpp;
  const pages = Math.ceil(records.length / (recordsPerPage || 1));
  const wrap = document.getElementById('batch-progress-wrap'), fill = document.getElementById('batch-progress-fill'), label = document.getElementById('batch-progress-label'), cancelBtn = document.getElementById('cancel-btn'), exportBtn = document.getElementById('export-btn');
  exportCancelled = false; wrap.style.display = 'block'; cancelBtn.style.display = ''; exportBtn.disabled = true; fill.style.width = '0%';

  // Pre-generate all QR images
  const allElements = state.duplex ? [...state.designs.front, ...state.designs.back] : state.elements;
  await preloadImages(allElements);
  const hasQR = allElements.some(el => el.type === 'qr');
  if (hasQR) {
    label.textContent = 'Pre-generating QR codes…';
    await preloadQRImages(records, allElements);
    if (exportCancelled) { wrap.style.display = 'none'; cancelBtn.style.display = 'none'; exportBtn.disabled = false; return; }
  }

  const pdf = new jsPDF({ unit: 'mm', format: [state.pageW, state.pageH], orientation: state.pageH > state.pageW ? 'portrait' : 'landscape' });
  for (let p = 0; p < pages; p++) {
    if (exportCancelled) break;
    if (p > 0) pdf.addPage([state.pageW, state.pageH]);
    for (let i = 0; i < bpp; i++) {
      const globalSlotIdx = p * bpp + i, info = getSlotInfo(globalSlotIdx, records.length);
      if (!info.valid) continue;
      const record = records[info.recordIdx], col = i % state.cols, row = Math.floor(i / state.cols);
      const bX = state.marginLeft + col * (state.badgeW + state.gap), bY = state.marginTop + row * (state.badgeH + state.gap);
      const elements = state.duplex ? (info.isBack ? state.designs.back : state.designs.front) : state.elements;
      renderBadgeToPDF(pdf, record, bX, bY, elements);
    }
    const pct = Math.round((p + 1) / pages * 100); fill.style.width = pct + '%'; label.textContent = `Page ${p + 1} / ${pages}`;
    await new Promise(r => setTimeout(r, 0));
  }
  if (!exportCancelled) { const filename = (document.getElementById('combined-filename-input').value.trim() || 'badges') + '.pdf'; pdf.save(filename); }
  wrap.style.display = 'none'; cancelBtn.style.display = 'none'; exportBtn.disabled = false;
}

async function exportIndividualPDFs() {
  const { jsPDF } = window.jspdf;
  const allRecords = state.csvData.length ? state.csvData : [null];
  const { from, to } = getExportRange();
  const records = allRecords.slice(from, to + 1);
  const useZip = document.getElementById('zip-download')?.checked;
  const wrap = document.getElementById('batch-progress-wrap'), fill = document.getElementById('batch-progress-fill'), label = document.getElementById('batch-progress-label'), cancelBtn = document.getElementById('cancel-btn'), exportBtn = document.getElementById('export-btn');
  exportCancelled = false; wrap.style.display = 'block'; cancelBtn.style.display = ''; exportBtn.disabled = true; fill.style.width = '0%';

  // Pre-generate all QR images so they are cached and ready before PDF rendering
  const allElements = state.duplex ? [...state.designs.front, ...state.designs.back] : state.elements;
  await preloadImages(allElements);
  const hasQR = allElements.some(el => el.type === 'qr');
  if (hasQR) {
    label.textContent = 'Pre-generating QR codes…';
    await preloadQRImages(records, allElements);
    if (exportCancelled) { wrap.style.display = 'none'; cancelBtn.style.display = 'none'; exportBtn.disabled = false; return; }
  }

  const zip = useZip ? new JSZip() : null;

  for (let i = 0; i < records.length; i++) {
    if (exportCancelled) break;

    const record = records[i], globalIdx = from + i;
    const pdf = new jsPDF({ unit: 'mm', format: [state.pageW, state.pageH], orientation: state.pageH > state.pageW ? 'portrait' : 'landscape' });
    if (state.duplex) {
      renderBadgeToPDF(pdf, record, state.marginLeft, state.marginTop, state.designs.front);
      const nextX = state.marginLeft + (state.badgeW + state.gap);
      if (nextX + state.badgeW <= state.pageW - state.marginRight) { renderBadgeToPDF(pdf, record, nextX, state.marginTop, state.designs.back); }
      else { renderBadgeToPDF(pdf, record, state.marginLeft, state.marginTop + state.badgeH + state.gap, state.designs.back); }
    } else { renderBadgeToPDF(pdf, record, state.marginLeft, state.marginTop, state.elements); }

    const filename = (buildFilename(record, globalIdx) || `badge_${globalIdx + 1}`).replace(/[\\/:*?"<>|]/g, '_') + '.pdf';

    if (useZip) {
      zip.file(filename, pdf.output('arraybuffer'));
    } else {
      pdf.save(filename);
    }

    const pct = Math.round((i + 1) / records.length * 100);
    fill.style.width = pct + '%';
    label.textContent = `${i + 1} / ${records.length}`;

    // Yield every badge to keep UI responsive and allow cancel to register
    await new Promise(r => setTimeout(r, 0));
  }

  if (!exportCancelled && useZip) {
    label.textContent = 'Compressing…';
    const zipFilename = (document.getElementById('combined-filename-input')?.value.trim() || 'badges') + '-individual.zip';
    const blob = await zip.generateAsync({ type: 'blob' }, meta => {
      fill.style.width = meta.percent.toFixed(0) + '%';
      label.textContent = `Compressing… ${meta.percent.toFixed(0)}%`;
    });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = zipFilename; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  wrap.style.display = 'none'; cancelBtn.style.display = 'none'; exportBtn.disabled = false;
}

function renderBadgeToPDF(pdf, record, bX, bY, elements) {
  pdf.setFillColor(state.badgeBg); pdf.rect(bX, bY, state.badgeW, state.badgeH, 'F');
  for (const el of elements) {
    const x = bX + (el.x / PX_PER_MM), y = bY + (el.y / PX_PER_MM), w = el.w / PX_PER_MM, h = el.h / PX_PER_MM;
    if (el.type === 'rect') {
      pdf.setDrawColor(el.stroke === 'none' ? state.badgeBg : el.stroke); pdf.setFillColor(el.fill === 'none' ? state.badgeBg : el.fill);
      const style = (el.fill !== 'none' && el.stroke !== 'none') ? 'FD' : (el.fill !== 'none' ? 'F' : 'D');
      if (el.rx) pdf.roundedRect(x, y, w, h, el.rx / PX_PER_MM, el.rx / PX_PER_MM, style); else pdf.rect(x, y, w, h, style);
    } else if (el.type === 'ellipse') { pdf.setFillColor(el.fill === 'none' ? state.badgeBg : el.fill); pdf.ellipse(x + w/2, y + h/2, w/2, h/2, el.fill !== 'none' ? 'F' : 'D');
    } else if (el.type === 'line') { pdf.setDrawColor(el.stroke || '#000000'); pdf.setLineWidth((el.strokeW || 1) / PX_PER_MM); pdf.line(x, y + h/2, x + w, y + h/2);
    } else if (el.type === 'text') {
      let t = fillVars(el.text, record);
      if (el.allCaps) t = t.toUpperCase(); if (!t) continue;
      const _mctx2 = document.createElement('canvas').getContext('2d');
      const fs = fittedFontSize(el, t, _mctx2);
      const fontSizePt = fs * 0.75; pdf.setFontSize(fontSizePt); pdf.setTextColor(el.color || '#000000');
      let fontStyle = el.fontWeight === 'bold' ? (el.fontStyle === 'italic' ? 'bolditalic' : 'bold') : (el.fontStyle === 'italic' ? 'italic' : 'normal');
      pdf.setFont((el.fontFamily || '').includes('Serif') ? 'times' : 'helvetica', fontStyle);
      const lines = el.fit ? [t] : wrapTextToLines(t, el.w, s => _mctx2.measureText(s).width); pdf.text(lines, x + (el.align === 'center' ? w/2 : (el.align === 'right' ? w : 0)), y, { align: el.align, baseline: 'top', lineHeightFactor: 1.2 });
      if (el.underline) { pdf.setLineWidth(0.2); pdf.line(x, y + (lines.length * fontSizePt * 0.4), x + w, y + (lines.length * fontSizePt * 0.4)); }
    } else if (el.type === 'qr') {
      let fData = el.qrData || '';
      if (el.mappings && record) {
        fData = getVCardData(record, el.mappings);
      } else if (fData.includes('{{') && record) fData = fillVars(fData, record);
      if (fData) {
        const q = qrCache[`qr_${fData}`];
        if (q && q.complete && q.naturalWidth > 0) pdf.addImage(q, 'PNG', x, y, w, h);
      }
    } else if (el.type === 'image' && el.src) { const img = imageCache[el.src]; if (img && !img._tainted) pdf.addImage(img, 'PNG', x, y, w, h); }
  }
}

/* ── Mobile Support ── */
const isMobile = () => window.innerWidth <= 900;

function showMobileDesignFABs() {
  document.getElementById('mobile-panel-toggle').style.display = 'flex';
}
function hideMobileDesignFABs() {
  document.getElementById('mobile-panel-toggle').style.display = 'none';
}

let activeMobilePanel = null;
function toggleMobilePanel(side) {
  const panel = side === 'left'
    ? document.querySelector('#tab-design .panel-left')
    : document.querySelector('#tab-design .panel-right');
  const fab = side === 'left' ? document.getElementById('fab-layers') : document.getElementById('fab-props');
  const otherPanel = side === 'left'
    ? document.querySelector('#tab-design .panel-right')
    : document.querySelector('#tab-design .panel-left');
  const otherFab = side === 'left' ? document.getElementById('fab-props') : document.getElementById('fab-layers');

  // If already on this panel, do nothing — cannot deselect entirely
  if (activeMobilePanel === side) return;

  // Close the other panel
  otherPanel.classList.remove('mobile-open');
  otherFab.classList.remove('active');
  // Open this panel
  panel.classList.add('mobile-open');
  fab.classList.add('active');
  activeMobilePanel = side;
  // Scroll so the panel (below the canvas) is visible
  setTimeout(() => panel.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
}

function closeMobilePanels() {
  document.querySelector('#tab-design .panel-left')?.classList.remove('mobile-open');
  document.querySelector('#tab-design .panel-right')?.classList.remove('mobile-open');
  document.getElementById('fab-layers')?.classList.remove('active');
  document.getElementById('fab-props')?.classList.remove('active');
  activeMobilePanel = null;
}

// Touch support for canvas: convert touches to mouse events for drag
function touchToMouse(e, type) {
  if (e.touches.length !== 1) return;
  e.preventDefault();
  const touch = e.touches[0] || e.changedTouches[0];
  const mouseEvent = new MouseEvent(type, {
    clientX: touch.clientX, clientY: touch.clientY,
    bubbles: true, cancelable: true, view: window
  });
  e.target.dispatchEvent(mouseEvent);
}

const canvasElM = document.getElementById('badge-canvas');
canvasElM.addEventListener('touchstart', e => touchToMouse(e, 'mousedown'), { passive: false });
canvasElM.addEventListener('touchmove', e => touchToMouse(e, 'mousemove'), { passive: false });
canvasElM.addEventListener('touchend', e => {
  const touch = e.changedTouches[0];
  const mouseEvent = new MouseEvent('mouseup', { clientX: touch.clientX, clientY: touch.clientY, bubbles: true });
  window.dispatchEvent(mouseEvent);
}, { passive: false });

// On resize, show/hide FABs appropriately
window.addEventListener('resize', () => {
  if (!isMobile()) {
    hideMobileDesignFABs();
    // Ensure panels visible on desktop
    document.querySelector('#tab-design .panel-left')?.classList.remove('mobile-open');
    document.querySelector('#tab-design .panel-right')?.classList.remove('mobile-open');
    document.querySelector('#tab-design .panel-left').style.display = '';
    document.querySelector('#tab-design .panel-right').style.display = '';
    activeMobilePanel = null;
  } else {
    const activeTab = document.querySelector('.page.active');
    if (activeTab && activeTab.id === 'tab-design') {
      showMobileDesignFABs();
      // Auto-open left panel if nothing is open
      if (!activeMobilePanel) {
        const leftPanel = document.querySelector('#tab-design .panel-left');
        leftPanel.classList.add('mobile-open');
        document.getElementById('fab-layers').classList.add('active');
        activeMobilePanel = 'left';
      }
    }
  }
});

function init() { loadFromLocal(); state.selectedId = null; applyTheme(); renderLayers(); redraw(); requestAnimationFrame(() => { updatePage(); redraw(); }); }
const canvasEl = document.getElementById('badge-canvas');
function canvasPt(e) { const r = canvasEl.getBoundingClientRect(); return { x: (e.clientX-r.left)/canvasScale, y: (e.clientY-r.top)/canvasScale }; }
function hitTest(p) { 
  for(let i=state.elements.length-1; i>=0; i--) { 
    const el = state.elements[i], pad = el.type === 'line' ? 8 : 0;
    if(p.x>=el.x && p.x<=el.x+el.w && p.y>=el.y-pad && p.y<=el.y+el.h+pad) return el; 
  } 
  return null; 
}
canvasEl.addEventListener('mousedown', e => { const p = canvasPt(e), hit = hitTest(p); state.selectedId = hit ? hit.id : null; if(hit) { isDragging = true; dragOffX = p.x - hit.x; dragOffY = p.y - hit.y; } redraw(); renderLayers(); renderProps(); });
canvasEl.addEventListener('mousemove', e => { if(!isDragging) return; const p = canvasPt(e), el = state.elements.find(el=>el.id===state.selectedId); if(el) { el.x = Math.round(p.x - dragOffX); el.y = Math.round(p.y - dragOffY); if(state.snap) { el.x = Math.round(el.x/5)*5; el.y = Math.round(el.y/5)*5; } redraw(); renderProps(); } });
window.addEventListener('mouseup', () => { if(isDragging) saveToLocal(); isDragging=false; });
let wheelAccum = 0;
canvasEl.addEventListener('wheel', e => { e.preventDefault(); wheelAccum += e.deltaY; const step = 100; if (Math.abs(wheelAccum) >= step) { changeZoom(wheelAccum > 0 ? -0.1 : 0.1); wheelAccum = 0; } }, { passive: false });
window.addEventListener('resize', updatePage);
init();
