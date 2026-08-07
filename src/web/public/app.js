/* PBD Ops panel — tiny vanilla JS client for the JSON API. */

const $ = (sel) => document.querySelector(sel);

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function fmtDwell(ms) {
  if (!ms) return "—";
  return `${Math.round(ms / 1000)}s`;
}

const STATUS_TAG = {
  visited: ["ok", "ziyaret"],
  missed: ["warn", "yok"],
  captcha: ["bad", "captcha"],
  error: ["bad", "hata"],
  skipped: ["dim", "atlandı"],
};

// ── view switching ─────────────────────────────────────────────────────────

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    btn.classList.add("active");
    $(`#view-${btn.dataset.view}`).classList.add("active");
    loadView(btn.dataset.view);
  });
});

// ── loaders ────────────────────────────────────────────────────────────────

async function loadOverview() {
  try {
    const data = await api("/api/overview");
    const e = data.engine;
    $("#pill-engine").textContent = e.running ? `gün ${e.rampDay} · ${e.visitsToday}/${e.todayQuota}` : "durduruldu";
    $("#pill-vault").textContent = `vault ${data.vault.effective}/${data.vault.total} kullanılabilir`;
  } catch {
    /* panel still renders without the pills */
  }
}

async function loadCalendar() {
  const data = await api("/api/calendar");
  $("#ramp-strip").innerHTML =
    `<div class="ramp-days">` +
    data.upcoming
      .map(
        (d) => `
      <div class="ramp-day ${d.day === data.rampDay ? "current" : ""}">
        <div class="d">Gün ${d.day}</div>
        <div class="q">${d.quota}</div>
      </div>`
      )
      .join("") +
    `</div>
     <p class="muted" style="margin-top:12px">
       Bugün: gün ${data.rampDay} · kota ${data.todayQuota} · planlanan ${data.planned} ·
       tamamlanan ${data.completed} · yapılan ${data.visitsToday}
     </p>`;

  const tbody = $("#plan-table tbody");
  tbody.innerHTML = data.plan
    .map(
      (p) => `
    <tr>
      <td>${String(p.scheduledHour).padStart(2, "0")}:00</td>
      <td>${esc(p.profileName)}</td>
      <td>${esc(p.keyword)}</td>
      <td>${esc(p.targetDomain)}</td>
      <td>${p.done ? '<span class="tag ok">tamam</span>' : '<span class="tag dim">bekliyor</span>'}</td>
    </tr>`
    )
    .join("");
}

async function loadPositions() {
  const data = await api("/api/positions");
  const wrap = $("#positions-list");
  if (!data.positions.length) {
    wrap.innerHTML = '<p class="muted">Henüz ölçüm yok — rank tracker bir kez çalışınca burada listelenir.</p>';
    return;
  }
  wrap.innerHTML = data.positions
    .map((p) => {
      const trend = p.trend.map((t) => (t.position == null ? "·" : t.position)).join(" ");
      const pos = p.position == null ? "—" : `#${p.position}`;
      return `
      <div class="pos-card">
        <div class="head">
          <div><span class="kw">${esc(p.keyword)}</span> <span class="dom">${esc(p.domain)}</span></div>
          <div class="pos">${pos}</div>
        </div>
        <div class="trend">trend (eski → yeni): ${esc(trend) || "—"}</div>
      </div>`;
    })
    .join("");
}

async function loadVisits() {
  const data = await api("/api/visits?limit=200");
  $("#visits-table tbody").innerHTML = data.visits
    .map((v) => {
      const [cls, label] = STATUS_TAG[v.status] ?? ["dim", v.status];
      return `
      <tr>
        <td>${fmtTime(v.startedAt)}</td>
        <td>${esc(v.profileName)}</td>
        <td>${esc(v.keyword)}</td>
        <td>${esc(v.siteDomain)}</td>
        <td>${v.position ?? "—"}</td>
        <td><span class="tag ${cls}">${label}</span></td>
        <td>${fmtDwell(v.dwellMs)}</td>
        <td>${v.internalClicks || "—"}</td>
        <td class="muted">${esc(v.error).slice(0, 80)}</td>
      </tr>`;
    })
    .join("");
}

async function loadHealth() {
  const data = await api("/api/health");
  const v = data.vault;
  $("#vault-summary").innerHTML = `
    <div class="stat-grid">
      ${[
        ["toplam", v.total],
        ["kullanılabilir", v.usable],
        ["hazır", v.ready],
        ["soğumada", v.cooling],
        ["captcha", v.captcha],
        ["karantina", v.quarantined],
      ]
        .map(([k, val]) => `<div class="stat"><div class="k">${k}</div><div class="v">${val}</div></div>`)
        .join("")}
    </div>`;

  const TAG = { usable: "ok", captcha: "warn", quarantined: "bad", recovering: "warn" };
  $("#vault-table tbody").innerHTML = data.profiles
    .map(
      (p) => `
    <tr>
      <td>${esc(p.name)}</td>
      <td>${esc(p.device)}</td>
      <td><span class="tag ${TAG[p.status] ?? "dim"}">${esc(p.status)}</span></td>
      <td>${p.consecutiveFails}</td>
      <td>${p.totalSolves}</td>
      <td>${fmtTime(p.lastCleanAt)}</td>
      <td>${fmtTime(p.nextRetryAt)}</td>
    </tr>`
    )
    .join("");
}

function loadView(view) {
  loadOverview();
  if (view === "calendar") loadCalendar().catch(() => {});
  else if (view === "positions") loadPositions().catch(() => {});
  else if (view === "visits") loadVisits().catch(() => {});
  else if (view === "health") loadHealth().catch(() => {});
}

loadView("calendar");
setInterval(loadOverview, 30_000);
