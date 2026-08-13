/* PBD://OPS — panel mantığı */
'use strict';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let currentView = 'overview';
let visitsPage = 1;
let pollTimer = null;

// ── fetch wrapper (401 → login) ────────────────────────────────────────────
async function api(path, opts) {
  const res = await fetch(path, opts ? { ...opts, headers: { 'Content-Type': 'application/json' } } : undefined);
  if (res.status === 401) {
    showLogin();
    throw new Error('auth');
  }
  return res.json();
}

function showLogin() { $('#loginWrap').style.display = 'flex'; $('#loginUser').focus(); }
function hideLogin() { $('#loginWrap').style.display = 'none'; }

async function doLogin() {
  const u = $('#loginUser').value.trim();
  const p = $('#loginPass').value;
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ u, p }),
  });
  if (res.ok) {
    $('#loginErr').textContent = '';
    $('#loginPass').value = '';
    hideLogin();
    boot();
  } else {
    $('#loginErr').textContent = 'erişim reddedildi — kullanıcı/parola yanlış';
  }
}

$('#loginBtn').addEventListener('click', doLogin);
$('#loginPass').addEventListener('keydown', (e) => e.key === 'Enter' && doLogin());
$('#logoutBtn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.reload();
});

// ── görünüm değiştirme ─────────────────────────────────────────────────────
$('#nav').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (!btn) return;
  currentView = btn.dataset.view;
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + currentView));
  refreshView();
});

function refreshView() {
  clearInterval(pollTimer);
  if (currentView === 'overview') { loadOverview(); pollTimer = setInterval(loadOverview, 3000); }
  if (currentView === 'visits') loadVisits();
  if (currentView === 'sites') loadSites();
  if (currentView === 'profiles') loadProfiles();
  if (currentView === 'positions') loadPositions();
  if (currentView === 'reports') { loadCfReports(); pollTimer = setInterval(loadCfReports, 4000); }
}

// ── yardımcılar ────────────────────────────────────────────────────────────
const fmtTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};
const fmtDateTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit' }) + ' ' + fmtTime(iso);
};
const statusChip = (s) => {
  const map = { visited: ['', 'ZİYARET'], missed: ['amber', 'MISS'], captcha: ['purple', 'CAPTCHA'], error: ['red', 'HATA'], skipped: ['gray', 'SKIP'] };
  const [cls, label] = map[s] ?? ['gray', s];
  return `<span class="chip ${cls}">${label}</span>`;
};

// ── GENEL BAKIŞ ────────────────────────────────────────────────────────────
async function loadOverview() {
  try {
    const [ov, cal] = await Promise.all([api('/api/overview'), api('/api/calendar')]);
    const e = ov.engine;

    $('#engDot').classList.toggle('on', e.running);
    $('#engLabel').textContent = e.running ? 'MOTOR AKTİF' : 'MOTOR KAPALI';

    $('#stEngine').textContent = e.running ? 'AKTİF' : 'KAPALI';
    $('#stEngine').classList.toggle('dim', !e.running);
    $('#stEngineSub').textContent = `${e.activeBrowsers} tarayıcı uçuşta`;
    $('#toggleEngine').textContent = e.running ? '■ DURDUR' : '▶ BAŞLAT';
    $('#toggleEngine').className = 'btn sm ' + (e.running ? 'danger' : '');

    $('#stRamp').textContent = 'GÜN ' + e.rampDay;
    $('#stQuota').textContent = `${e.visitsToday}/${e.todayQuota}`;
    $('#stQuotaBar').style.width = (e.todayQuota ? Math.min(100, (e.visitsToday / e.todayQuota) * 100) : 0) + '%';
    $('#stVisits').textContent = e.visitsToday;
    $('#stVisitsSub').textContent = `plan ${e.completed}/${e.planned} tamam`;
    const wr = ov.wallRate ?? { rate: 0, walls: 0, total: 0 };
    const wpct = Math.round(wr.rate * 100);
    const wallEl = $('#stWall');
    wallEl.textContent = '%' + wpct;
    wallEl.style.color = wpct <= 40 ? 'var(--ok)' : wpct <= 70 ? 'var(--warn)' : 'var(--fail)';
    $('#stWallSub').textContent = `${wr.walls}/${wr.total} duvar · eşik %40`;
    $('#stSolver').textContent = ov.solver.today;
    $('#stSolverSub').textContent = `toplam ${ov.solver.total} · ${ov.solver.cleared} çözüldü`;
    $('#stProfiles').textContent = e.profiles;

    const v = ov.vault ?? {};
    $('#stTrust').textContent = `kullanılabilir ${v.usable ?? 0} · cooldown ${v.cooling ?? 0}`;

    // aktivite terminali
    const log = $('#activityLog');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.innerHTML = (ov.activity ?? []).map((a) => {
      let cls = '';
      if (/HATA|çözülemedi|ERR/.test(a.text)) cls = 'line-err';
      else if (/TAMAM|çözüldü/.test(a.text)) cls = 'line-ok';
      else if (/^>>/.test(a.text)) cls = 'line-cmd';
      return `<div><span class="t">${fmtTime(a.ts)}</span><span class="${cls}">${esc(a.text)}</span></div>`;
    }).join('') || '<span class="muted"># henüz aktivite yok — motor kapalıyken manuel tetik: Siteler sekmesi</span>';
    if (atBottom) log.scrollTop = log.scrollHeight;

    // rampa şeridi
    const maxQ = Math.max(...(cal.upcoming ?? []).map((u) => u.quota), 1);
    $('#rampStrip').innerHTML = (cal.upcoming ?? []).map((u) =>
      `<div class="ramp-day ${u.day === e.rampDay ? 'cur' : ''}">
        <div class="bar" style="height:${Math.round((u.quota / maxQ) * 52)}px"></div>
        <div class="lb">G${u.day}·${u.quota}</div>
      </div>`).join('');

    // bugünkü plan
    $('#planBody').innerHTML = (cal.plan ?? []).map((p) =>
      `<tr>
        <td class="dim">${String(p.scheduledHour).padStart(2, '0')}:00</td>
        <td class="host">${esc(p.profileName)}</td>
        <td>${esc(p.keyword)}</td>
        <td class="host">${esc(p.targetDomain)}</td>
        <td>${p.done ? '<span class="chip">TAMAM</span>' : '<span class="chip gray">BEKLİYOR</span>'}</td>
      </tr>`).join('') || '<tr><td colspan="5" class="dim" style="padding:14px"># plan yok — site ekle veya motoru başlat</td></tr>';
  } catch (err) {
    if (String(err) !== 'Error: auth') console.warn(err);
  }
}

$('#toggleEngine').addEventListener('click', async () => {
  const ov = await api('/api/overview');
  await api('/api/engine', { method: 'POST', body: JSON.stringify({ enabled: !ov.engine.running }) });
  loadOverview();
});

// ── ZİYARETLER ─────────────────────────────────────────────────────────────
async function loadVisits() {
  const params = new URLSearchParams({ page: visitsPage, per: 20 });
  if ($('#fStatus').value) params.set('status', $('#fStatus').value);
  if ($('#fDomain').value) params.set('domain', $('#fDomain').value);
  if ($('#fProfile').value) params.set('profile', $('#fProfile').value);
  const data = await api('/api/visits?' + params);

  // filtre seçeneklerini doldur (bir kez)
  if (!$('#fDomain').dataset.filled) {
    const sites = await api('/api/sites');
    $('#fDomain').innerHTML = '<option value="">site: hepsi</option>' + sites.sites.map((s) => `<option>${esc(s.domain)}</option>`).join('');
    const health = await api('/api/health');
    $('#fProfile').innerHTML = '<option value="">profil: hepsi</option>' + health.stats.map((p) => `<option>${esc(p.profileName)}</option>`).join('');
    $('#fDomain').dataset.filled = '1';
  }

  const body = $('#visitsBody');
  body.innerHTML = '';
  for (const v of data.rows) {
    const shots = [v.serpShot, v.landShot, v.failShot].filter(Boolean).length;
    const tr = document.createElement('tr');
    tr.className = 'row-click';
    tr.innerHTML = `
      <td class="ghost">#${v.id}</td>
      <td class="dim">${fmtDateTime(v.startedAt)}</td>
      <td class="host">${esc(v.profileName)}</td>
      <td class="host">${esc(v.siteDomain)}</td>
      <td>${esc(v.keyword)}</td>
      <td>${v.position ?? '—'}</td>
      <td>${statusChip(v.status)}</td>
      <td class="dim">${v.dwellMs ? Math.round(v.dwellMs / 1000) + 'sn' : '—'}</td>
      <td class="dim">${v.internalClicks || '—'}</td>
      <td>${shots ? `<span class="chip cyan">${shots} kanıt</span>` : '<span class="ghost">—</span>'}</td>`;
    tr.addEventListener('click', () => toggleEvidence(tr, v));
    body.appendChild(tr);
  }
  if (!data.rows.length) {
    body.innerHTML = '<tr><td colspan="10" class="dim" style="padding:14px"># kayıt yok</td></tr>';
  }

  // sayfalama
  const pager = $('#visitsPager');
  const { page, pages, total } = data;
  let html = `<button ${page <= 1 ? 'disabled' : ''} data-p="${page - 1}">‹</button>`;
  const lo = Math.max(1, page - 3), hi = Math.min(pages, page + 3);
  if (lo > 1) html += `<button data-p="1">1</button><span class="muted">…</span>`;
  for (let p = lo; p <= hi; p++) html += `<button data-p="${p}" class="${p === page ? 'cur' : ''}">${p}</button>`;
  if (hi < pages) html += `<span class="muted">…</span><button data-p="${pages}">${pages}</button>`;
  html += `<button ${page >= pages ? 'disabled' : ''} data-p="${page + 1}">›</button>`;
  html += `<span class="total">${total} kayıt · sayfa ${page}/${pages}</span>`;
  pager.innerHTML = html;
}

$('#visitsPager').addEventListener('click', (e) => {
  const p = Number(e.target.dataset?.p);
  if (p > 0) { visitsPage = p; loadVisits(); }
});
['fStatus', 'fDomain', 'fProfile'].forEach((id) => $('#' + id).addEventListener('change', () => { visitsPage = 1; loadVisits(); }));

// kanıt genişletme
let openEvRow = null;
function toggleEvidence(tr, v) {
  if (openEvRow) { openEvRow.remove(); openEvRow = null; if (openEvRow?.dataset?.for === String(v.id)) return; }
  const evTr = document.createElement('tr');
  evTr.className = 'evidence-row';
  evTr.dataset.for = String(v.id);
  const shot = (name, cap) => name
    ? `<div class="ev-item"><div class="cap">${cap}</div><img src="/evidence/${esc(name)}" loading="lazy" onclick="zoom(this)"></div>`
    : '';
  const shots = shot(v.serpShot, 'SERP') + shot(v.landShot, 'VARIŞ') + shot(v.failShot, 'HATA ANI');
  evTr.innerHTML = `<td colspan="10">
    <div class="ev-box">${shots || '<span class="ev-empty"># bu ziyarete ait kanıt görüntüsü yok (retention süresi dolmuş olabilir)</span>'}</div>
    ${v.viaQuery ? `<div class="ev-meta"><b>tıklamayı getiren sorgu:</b> ${esc(v.viaQuery)} <span class="chip purple">DERİNLEŞTİRME</span></div>` : ''}
    ${v.landedUrl ? `<div class="ev-meta"><b>varış url:</b> ${esc(v.landedUrl)}</div>` : ''}
    ${v.error ? `<div class="err-band">${esc(v.error)}</div>` : ''}
    <div class="ev-meta"><b>başlangıç:</b> ${fmtDateTime(v.startedAt)} · <b>bitiş:</b> ${fmtDateTime(v.finishedAt)}</div>
  </td>`;
  tr.after(evTr);
  openEvRow = evTr;
}

function zoom(img) {
  $('#lightboxImg').src = img.src;
  $('#lightbox').style.display = 'flex';
}
$('#lightbox').addEventListener('click', () => { $('#lightbox').style.display = 'none'; });

// ── SİTELER ────────────────────────────────────────────────────────────────
async function loadSites() {
  const { sites } = await api('/api/sites');
  $('#siteGrid').innerHTML = sites.map((s) => `
    <div class="site-card">
      <div class="domain">${esc(s.domain)}</div>
      <div class="muted">ağırlık ${s.weight} · ${s.keywords.length} keyword</div>
      <div class="kw-row">
        ${s.keywords.map((k) => `<span class="kw" title="tıkla: bu keyword'ü şimdi çalıştır" onclick="runNow('${esc(s.domain)}','${esc(k)}')">${esc(k)}<span class="x" title="keyword'ü sil" onclick="event.stopPropagation();delKw(${s.id},'${esc(k)}','${esc(s.domain)}')">×</span></span>`).join('')}
      </div>
      <div class="ops">
        <button class="btn sm solid" onclick="runNow('${esc(s.domain)}')">▶ TÜMÜNÜ ÇALIŞTIR</button>
        <button class="btn sm cyan" onclick="addKw(${s.id},'${esc(s.domain)}')">+ KW</button>
        <button class="btn sm danger" onclick="delSite(${s.id},'${esc(s.domain)}')">SİL</button>
      </div>
    </div>`).join('') || '<div class="muted"># hedef site yok — üstten ekle (örn. milanbahis.com)</div>';
}

$('#addSiteBtn').addEventListener('click', async () => {
  const domain = $('#siteDomain').value.trim();
  const keywords = $('#siteKeywords').value.split(',').map((k) => k.trim()).filter(Boolean);
  const weight = Number($('#siteWeight').value) || 1;
  if (!domain || !keywords.length) return alert('domain ve en az bir keyword gir');
  await api('/api/sites', { method: 'POST', body: JSON.stringify({ domain, keywords, weight }) });
  $('#siteDomain').value = ''; $('#siteKeywords').value = '';
  $('#fDomain').dataset.filled = '';
  loadSites();
});

async function delSite(id, domain) {
  if (!confirm(`${domain} silinsin mi? (geçmiş ziyaret kayıtları kalır)`)) return;
  await api('/api/sites/' + id, { method: 'DELETE' });
  loadSites();
}

async function addKw(id, domain) {
  const kw = prompt(`${domain} için yeni keyword:`);
  if (!kw?.trim()) return;
  const { sites } = await api('/api/sites');
  const site = sites.find((s) => s.id === id);
  await api('/api/sites/' + id, { method: 'PUT', body: JSON.stringify({ keywords: [...site.keywords, kw.trim()] }) });
  loadSites();
}

async function delKw(id, kw, domain) {
  const { sites } = await api('/api/sites');
  const site = sites.find((s) => s.id === id);
  const rest = site.keywords.filter((k) => k !== kw);
  if (!rest.length) return alert('son keyword silinemez — siteyi komple sil');
  await api('/api/sites/' + id, { method: 'PUT', body: JSON.stringify({ keywords: rest }) });
  loadSites();
}

async function runNow(domain, keyword) {
  const r = await api('/api/run', { method: 'POST', body: JSON.stringify({ domain, keyword }) });
  alert(r.scheduled ? `${r.scheduled} ziyaret kuyruğa alındı — Genel Bakış'tan canlı izle` : 'uygun profil yok (hepsi cooldown/günlük cap dolmuş olabilir)');
}

// ── PROFİLLER ──────────────────────────────────────────────────────────────
async function loadProfiles() {
  const data = await api('/api/health');
  const stats = Object.fromEntries(data.stats.map((s) => [s.profileId, s]));
  $('#profGrid').innerHTML = (data.profiles ?? []).map((p) => {
    const st = stats[p.profileId] ?? {};
    const total7 = (st.visited7d ?? 0) + (st.failed7d ?? 0);
    const rate = total7 ? Math.round(((st.visited7d ?? 0) / total7) * 100) : null;
    const trustMap = { usable: ['ok', 'kullanılabilir'], recovering: ['warn', 'toparlanıyor'], captcha: ['fail', 'captcha'], quarantined: ['fail', 'karantina'] };
    const [trustCls, trustLabel] = trustMap[p.status] ?? ['gray', p.status || 'bilinmiyor'];
    return `<div class="prof-card">
      <div class="head">
        <span class="dot ${trustCls}"></span>
        <span class="name">${esc(p.name || p.profileId)}</span>
        <span class="chip ${p.device === 'mobile' ? 'cyan' : 'gray'}">${p.device === 'mobile' ? 'MOBİL' : 'MASAÜSTÜ'}</span>
      </div>
      <div class="rows">
        güven: <b>${esc(trustLabel)}</b>${p.nextRetryAt ? ` · cooldown bitiş <b>${fmtDateTime(p.nextRetryAt)}</b>` : ''}<br>
        bugün: <b>${st.today ?? 0} ziyaret</b> · 7g başarı: <b>${rate === null ? '—' : '%' + rate}</b> (${st.visited7d ?? 0}✓ / ${st.failed7d ?? 0}✗)<br>
        son durum: <b>${esc(st.lastStatus || '—')}</b> · ${st.lastAt ? fmtDateTime(st.lastAt) : ''}
        ${st.lastError ? `<div class="err-band">${esc(st.lastError)}</div>` : ''}
      </div>
    </div>`;
  }).join('') || '<div class="muted"># profil verisi yok</div>';
}

// ── POZİSYONLAR ────────────────────────────────────────────────────────────
async function loadPositions() {
  const { positions } = await api('/api/positions');
  $('#posBody').innerHTML = positions.map((p) => {
    const pts = (p.trend ?? []).filter((t) => t.position != null).map((t) => t.position);
    const spark = pts.length > 1 ? sparkline(pts) : '<span class="ghost">—</span>';
    const posCls = p.position == null ? 'gray' : p.position <= 10 ? '' : p.position <= 20 ? 'amber' : 'red';
    return `<tr>
      <td class="host">${esc(p.domain)}</td>
      <td>${esc(p.keyword)}</td>
      <td><span class="chip ${p.device === 'mobile' ? 'cyan' : 'gray'}">${p.device === 'mobile' ? 'MOB' : 'DST'}</span></td>
      <td><span class="chip ${posCls}">${p.position ?? 'YOK'}</span></td>
      <td>${spark}</td>
      <td class="dim">${fmtDateTime(p.measuredAt)}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="dim" style="padding:14px"># ölçüm yok — ./measure --now ile ilk turu at</td></tr>';
}

function sparkline(pts) {
  const w = 110, h = 26, max = Math.max(...pts, 10), min = 1;
  const step = w / (pts.length - 1);
  // pozisyon ters: 1 en iyi → üstte
  const poly = pts.map((p, i) => `${(i * step).toFixed(1)},${(h - 3 - ((max - p) / (max - min)) * (h - 6)).toFixed(1)}`).join(' ');
  return `<svg class="spark" width="${w}" height="${h}"><polyline points="${poly}"/></svg>`;
}

$('#trackBtn').addEventListener('click', async () => {
  await api('/api/track', { method: 'POST' });
  alert('ölçüm turu başladı — birkaç dakika sonra bu tabloyu yenile');
});

// ── ŞİKAYETLER ─────────────────────────────────────────────────────────────
async function loadCfReports() {
  const data = await api('/api/cf-reports');
  $('#cfState').textContent = data.running ? `calisiyor: ${data.running}` : '';
  const chip = (r) => {
    const map = { submitted: ['', 'GÖNDERİLDİ'], dedupe: ['amber', 'DEDUPE'], 'submit-error': ['red', 'HATA'], error: ['red', 'HATA'], 'dry-ok': ['cyan', 'DRY'], EXIT_DEAD: ['red', 'EXIT ÖLDÜ'] };
    const [cls, label] = map[r] ?? ['gray', r];
    return `<span class="chip ${cls}">${label}</span>`;
  };
  $('#cfBody').innerHTML = (data.reports ?? []).map((r) => `
    <tr>
      <td class="dim">${fmtDateTime(r.ts)}</td>
      <td class="host">${esc((r.target || '').slice(0, 45))}</td>
      <td>${esc(r.brand || '—')}</td>
      <td class="dim">${esc(r.profile || '')}</td>
      <td class="dim">${esc((r.identity || '').split('@')[0])}</td>
      <td>${chip(r.result)}</td>
      <td class="dim">${r.ms ? Math.round(r.ms / 1000) + 'sn' : '—'}</td>
    </tr>`).join('') || '<tr><td colspan="7" class="dim" style="padding:14px"># henüz rapor yok</td></tr>';
}

$('#cfStart').addEventListener('click', async () => {
  const target = $('#cfTarget').value.trim();
  const official = $('#cfOfficial').value.trim();
  const brand = $('#cfBrand').value.trim();
  if (!target || !official) return alert('sahte url + resmi url gerekli');
  const r = await api('/api/cf-report', { method: 'POST', body: JSON.stringify({ target, official, brand }) });
  if (r.error) return alert(r.error);
  $('#cfState').textContent = 'calisiyor: ' + target;
  loadCfReports();
});

// ── boot ───────────────────────────────────────────────────────────────────
async function boot() {
  refreshView();
}

// oturum açık mı?
fetch('/api/overview').then((r) => (r.status === 401 ? showLogin() : boot())).catch(showLogin);
