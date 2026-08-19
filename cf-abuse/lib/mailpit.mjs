/**
 * mailpit.mjs — catch-all mail okuma (meridyendijital.com)
 */
const BASE = "http://209.74.95.106:8025";
const AUTH = "Basic " + Buffer.from("admin:pbd2026").toString("base64");

async function api(path) {
  const r = await fetch(BASE + path, { headers: { Authorization: AUTH } });
  return r.json();
}

/** Belirli aliciya gelen mesajlari listele (en yeni once). sinceMs: epoch ms filtresi. */
export async function messagesFor(toAddr, sinceMs = 0) {
  const j = await api(`/api/v1/messages?limit=50`);
  const out = [];
  for (const m of j.messages ?? []) {
    const to = (m.To ?? []).map((t) => t.Address.toLowerCase());
    if (!to.includes(toAddr.toLowerCase())) continue;
    if (sinceMs && new Date(m.Created).getTime() < sinceMs) continue;
    out.push(m);
  }
  return out;
}

export async function messageBody(id) {
  const m = await api(`/api/v1/message/${id}`);
  return { subject: m.Subject, text: m.Text ?? "", html: m.HTML ?? "" };
}

/** Mesaj govdesinden regex ile ilk eslesen linki cek. */
export function extractLink(body, re) {
  const src = body.html || body.text;
  // HTML href'ler
  const hrefs = [...src.matchAll(/href="([^"]+)"/gi)].map((x) => x[1]);
  for (const h of hrefs) if (re.test(h)) return h.replace(/&amp;/g, "&");
  const urls = [...src.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((x) => x[0].replace(/[.,;)\]]+$/, ""));
  for (const u of urls) if (re.test(u)) return u;
  return null;
}

/** Poll: maxWaitMs boyunca intervalMs arayla toAddr icin re ile eslesen link ara. */
export async function waitForLink(toAddr, re, { sinceMs = Date.now() - 60000, maxWaitMs = 150000, intervalMs = 10000, subjectRe = null } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxWaitMs) {
    const msgs = await messagesFor(toAddr, sinceMs);
    for (const m of msgs) {
      if (subjectRe && !subjectRe.test(m.Subject ?? "")) continue;
      const body = await messageBody(m.ID);
      const link = extractLink(body, re);
      if (link) return { link, subject: m.Subject, id: m.ID };
    }
    await new Promise((s) => setTimeout(s, intervalMs));
  }
  return null;
}
