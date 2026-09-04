/**
 * Workshop front end.
 *
 * Imports the exact same validator the server and CI run, so an artist can
 * never see one verdict here and a different one on the pull request.
 */
import { validate, canvasOf } from '/lib/validate.mjs';

const $ = id => document.getElementById(id);
const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const ST_ORDER = { open: 0, claimed: 1, review: 2, approved: 3 };
const ST_LABEL = { open: 'OPEN', claimed: 'CLAIMED', review: 'IN REVIEW', approved: 'APPROVED' };

let CAT = null, CFG = null, sel = 0, filt = 'all', lastFile = null, lastResult = null;
const artistFromUrl = new URLSearchParams(location.search).get('artist');

const boot = async () => {
  [CFG, CAT] = await Promise.all([
    fetch('/api/config').then(r => r.json()),
    fetch('/api/catalogue').then(r => r.json()),
  ]);
  const firstOpen = CAT.slots.findIndex(s => s.status === 'open' && s.blocks === 'v0');
  sel = firstOpen < 0 ? 0 : firstOpen;
  render();
};

const stats = () => {
  const c = { open: 0, claimed: 0, review: 0, approved: 0 };
  CAT.slots.forEach(s => c[s.status] !== undefined && c[s.status]++);
  const v0 = CAT.slots.filter(s => s.blocks === 'v0' && s.status !== 'approved').length;
  $('stats').innerHTML =
    `<div class="stat o"><b>${c.open}</b><span>OPEN</span></div>
     <div class="stat r"><b>${c.review}</b><span>IN REVIEW</span></div>
     <div class="stat a"><b>${c.approved}</b><span>APPROVED</span></div>
     <div class="stat"><b>${v0}</b><span>BLOCK V0</span></div>`;
  $('bar').innerHTML =
    `<span>assets repo <code>${esc(CFG.repo)}</code></span><span>·</span>` +
    `<span>slots from <code>${esc(CFG.store)}</code></span><span>·</span>` +
    `<span>standard <code>${esc(CAT.standard)}</code></span>` +
    (CFG.canWrite ? '' : '<span>·</span><span style="color:var(--warn)">submissions disabled: server has no GitHub App credentials</span>');
};

const slotList = () => {
  const rows = CAT.slots.map((s, i) => ({ s, i }))
    .filter(({ s }) => filt === 'all' || (filt === 'v0' ? s.blocks === 'v0' : s.status === filt))
    .sort((a, b) => (ST_ORDER[a.s.status] - ST_ORDER[b.s.status]) || a.s.id.localeCompare(b.s.id));
  $('slotCount').textContent = `${rows.length} / ${CAT.slots.length}`;
  const box = $('slotList'); box.innerHTML = '';
  for (const { s, i } of rows) {
    const d = canvasOf(CAT.classes[s.class]);
    const b = el('button', 'slot',
      `<span class="dot ${s.status}"></span><span class="id">${esc(s.id)}</span>` +
      (s.blocks === 'v0' ? '<span class="blocks v0">V0</span>' : '') +
      `<span class="px">${d.w}×${d.h}</span>`);
    b.setAttribute('aria-current', i === sel);
    b.onclick = () => { sel = i; lastFile = lastResult = null; render(); };
    box.appendChild(b);
  }
};

const detail = () => {
  const s = CAT.slots[sel], cls = CAT.classes[s.class], d = canvasOf(cls);
  const rows = [['CLASS', s.class], ['CANVAS', `${d.w} × ${d.h} px`],
    ['FRAMES', cls.frames + (cls.strip ? ' (vertical strip)' : cls.grid ? ` (${cls.grid})` : '')],
    ['ANCHOR', cls.anchor], ['MAX COLOURS', cls.colors], ['ALPHA', 'binary only'],
    ['FORMAT', 'PNG-32'], ['FILE', `${s.id}@1x.png`]];

  $('detail').innerHTML = `
    <div>
      <div class="idrow"><h2>${esc(s.id)}</h2>
        <span class="pill ${s.status}">${ST_LABEL[s.status]}</span>
        ${s.blocks === 'v0' ? '<span class="blocks v0">BLOCKS FIRST PLAYABLE</span>' : ''}</div>
      <p class="brief" style="margin:8px 0 0">${esc(s.brief)}</p>
    </div>
    <div class="spec">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</div>
    <div class="card">
      <header><h2>SUBMIT</h2><span class="sub">${d.w}×${d.h} · ≤${cls.colors} colours · binary alpha</span></header>
      <div class="pad" style="display:flex;flex-direction:column;gap:11px">
        <div class="drop" id="drop" tabindex="0" role="button">
          <b>DROP A PNG, OR CLICK TO CHOOSE</b>
          <span>Checked in your browser first. Nothing leaves this page until you press submit.</span>
        </div>
        <div id="vout"></div>
        <div class="two">
          <div class="field"><label for="who">YOUR HANDLE</label>
            <input id="who" placeholder="pixelartist" value="${esc(artistFromUrl || localStorage.getItem('tf_artist') || '')}"></div>
          <div class="field"><label for="lic">LICENCE GRANT</label>
            <select id="lic">
              <option value="CC0">CC0, public domain</option>
              <option value="work-for-hire">Work for hire, commissioned</option>
              <option value="owned">I am the project owner</option>
            </select></div>
        </div>
        <div class="rowbtn">
          <button class="act" id="send" disabled>SUBMIT AND OPEN A PULL REQUEST</button>
        </div>
        <div id="sendout"></div>
      </div>
    </div>`;

  const dz = $('drop');
  const pick = () => { const i = el('input'); i.type = 'file'; i.accept = 'image/png';
    i.onchange = () => i.files[0] && check(i.files[0]); i.click(); };
  dz.onclick = pick;
  dz.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
  dz.ondragover = e => { e.preventDefault(); dz.classList.add('hot'); };
  dz.ondragleave = () => dz.classList.remove('hot');
  dz.ondrop = e => { e.preventDefault(); dz.classList.remove('hot');
    const f = e.dataTransfer.files[0]; if (f) check(f); };
  $('send').onclick = submit;
};

async function check(file) {
  const s = CAT.slots[sel], cls = CAT.classes[s.class];
  $('vout').innerHTML = '<div class="spin">reading pixels…</div>';
  const bytes = new Uint8Array(await file.arrayBuffer());
  const r = await validate(bytes, { ...cls, id: s.id });
  lastFile = { file, bytes }; lastResult = r;

  const out = $('vout'); out.innerHTML = '';
  out.appendChild(el('div', 'verdict ' + (r.ok ? 'pass' : 'fail'),
    r.ok ? `ACCEPTED · ${r.checks.length} checks passed${r.warnings.length ? ` · ${r.warnings.length} advisory` : ''}`
         : `REJECTED · ${r.blocking.length} rule${r.blocking.length > 1 ? 's' : ''} broken`));

  const grid = el('div', 'vgrid');
  const left = el('div');
  const pv = el('div', 'pv');
  const img = el('img'); img.src = URL.createObjectURL(file);
  img.onload = () => {
    const scale = Math.max(1, Math.floor(140 / Math.max(img.naturalWidth, img.naturalHeight)));
    img.style.width = (img.naturalWidth * scale) + 'px';
    img.style.height = (img.naturalHeight * scale) + 'px';
  };
  pv.appendChild(img); left.appendChild(pv);
  if (r.palette?.length) {
    const p = el('div', 'pal');
    r.palette.slice(0, 40).forEach(([k]) => {
      const i = el('i'); i.style.background = '#' + k.toString(16).padStart(6, '0'); p.appendChild(i);
    });
    left.appendChild(p);
    left.appendChild(el('div', 'note',
      `<span style="font-size:11px">${r.palette.length} colours · ${esc(file.name)} · ${(file.size / 1024).toFixed(1)}KB</span>`));
  }
  grid.appendChild(left);

  const ck = el('div', 'checks');
  r.checks.forEach(c => ck.appendChild(el('div', 'chk ' + (c.ok ? 'pass' : c.soft ? 'warn' : 'fail'),
    `<span class="mk">${c.ok ? '✓' : c.soft ? '!' : '✕'}</span>` +
    `<span class="lb">${esc(c.label)}</span><span class="vl">${esc(c.value)}</span>`)));
  grid.appendChild(ck);
  out.appendChild(grid);

  $('send').disabled = !r.ok || !CFG.canWrite;
}

async function submit() {
  const who = $('who').value.trim(), lic = $('lic').value, s = CAT.slots[sel];
  if (!who) { $('sendout').innerHTML = '<div class="warnbox">Add your handle so the art can be credited.</div>'; return; }
  if (!lastResult?.ok) return;
  localStorage.setItem('tf_artist', who);

  $('send').disabled = true;
  $('sendout').innerHTML = '<div class="spin">opening a pull request…</div>';
  let b = ''; const u8 = lastFile.bytes;
  for (let i = 0; i < u8.length; i++) b += String.fromCharCode(u8[i]);

  const res = await fetch('/api/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slotId: s.id, artist: who, licence: lic, pngBase64: btoa(b) }),
  });
  const d = await res.json();
  if (!res.ok) {
    $('sendout').innerHTML = `<div class="warnbox">${esc(d.error)}` +
      (d.blocking ? '<br>' + d.blocking.map(c => `✕ ${esc(c.label)}: ${esc(c.value)}`).join('<br>') : '') + '</div>';
    $('send').disabled = false; return;
  }
  $('sendout').innerHTML =
    `<div class="verdict pass">PULL REQUEST #${d.pr.number} OPENED · ` +
    `<a href="${esc(d.pr.url)}" target="_blank" rel="noopener">view it</a></div>`;
}

const render = () => { stats(); slotList(); detail(); };

$('filters').innerHTML = [['all', 'ALL'], ['v0', 'BLOCKS V0'], ['open', 'OPEN'], ['review', 'REVIEW'], ['approved', 'DONE']]
  .map(([k, l]) => `<button data-f="${k}" aria-pressed="${k === 'all'}">${l}</button>`).join('');
[...$('filters').children].forEach(b => b.onclick = () => {
  filt = b.dataset.f;
  [...$('filters').children].forEach(x => x.setAttribute('aria-pressed', x.dataset.f === filt));
  slotList();
});

boot().catch(e => { $('detail').innerHTML = `<div class="card pad warnbox">could not load: ${esc(e.message)}</div>`; });
