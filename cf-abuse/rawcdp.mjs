/**
 * rawcdp.mjs — minimal, Runtime'suz CDP istemcisi.
 * Turnstile Runtime.enable'i tespit edip widget'i bastiriyor; bu yuzden bu
 * istemci YALNIZCA Page / DOM / Input domainlerini kullanir. Runtime hic acilmaz.
 */
export class RawCdp {
  static async connect(debugPort) {
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("page target yok");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    return new RawCdp(ws);
  }

  constructor(ws) {
    this.ws = ws;
    this.msgId = 0;
    this.pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)(m);
        this.pending.delete(m.id);
      }
    };
  }

  cdp(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.msgId;
      const timer = setTimeout(() => reject(new Error("cdp timeout: " + method)), 30000);
      this.pending.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async call(method, params = {}) {
    const r = await this.cdp(method, params);
    if (r.error) throw new Error(`${method}: ${r.error.message}`);
    return r.result ?? {};
  }

  async navigate(url) {
    await this.call("Page.enable");
    await this.call("Page.navigate", { url });
  }

  async screenshot(path, quality = 65) {
    const r = await this.call("Page.captureScreenshot", { format: "jpeg", quality });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, Buffer.from(r.data, "base64"));
  }

  /** selector'un VIEWPORT icindeki kutusu (yoksa null). DOM domain — guvenli.
   *  getBoxModel sayfa-koordinat dondurur; Input viewport ister — fark
   *  Page.getLayoutMetrics uzerinden dusulur (Runtime'suz scroll okuma). */
  async box(selector) {
    const doc = await this.call("DOM.getDocument", { depth: -1 });
    const q = await this.call("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
    if (!q.nodeId) return null;
    const read = async () => {
      const lm = await this.call("Page.getLayoutMetrics", {}).catch(() => null);
      const bm = await this.call("DOM.getBoxModel", { nodeId: q.nodeId }).catch(() => null);
      if (!bm?.model) return null;
      const vw = lm?.visualViewport;
      const sx = vw?.pageX ?? 0;
      const sy = vw?.pageY ?? 0;
      const c = bm.model.content;
      return {
        x: c[0] - sx, y: c[1] - sy, w: c[2] - c[0], h: c[5] - c[1],
        nodeId: q.nodeId, vwW: vw?.clientWidth ?? 0, vwH: vw?.clientHeight ?? 0,
      };
    };
    // scrollIntoViewIfNeeded + settle; viewport disindaysa yeniden kaydir/oku
    for (let i = 0; i < 3; i++) {
      await this.cdp("DOM.scrollIntoViewIfNeeded", { nodeId: q.nodeId }).catch(() => {});
      await new Promise((s) => setTimeout(s, 900));
      const b = await read();
      if (!b) return null;
      if (b.y >= 0 && b.y + b.h <= b.vwH && b.x >= 0 && b.x + b.w <= b.vwW) return b;
      // viewport disinda — bir daha kaydir ve bekle
      await new Promise((s) => setTimeout(s, 700));
    }
    return await read();
  }

  /** nodeId icin viewport kutusu (scroll duzeltmeli). */
  async boxForNode(nodeId) {
    await this.cdp("DOM.scrollIntoViewIfNeeded", { nodeId }).catch(() => {});
    await new Promise((s) => setTimeout(s, 800));
    const bm = await this.call("DOM.getBoxModel", { nodeId }).catch(() => null);
    if (!bm?.model) return null;
    const lm = await this.call("Page.getLayoutMetrics", {}).catch(() => null);
    const sx = lm?.visualViewport?.pageX ?? 0;
    const sy = lm?.visualViewport?.pageY ?? 0;
    const c = bm.model.content;
    return { x: c[0] - sx, y: c[1] - sy, w: c[2] - c[0], h: c[5] - c[1] };
  }

  /** Elementin disabled attribute'u var mi (DOM domain). */
  async isDisabled(nodeId) {
    const r = await this.call("DOM.getAttributes", { nodeId });
    const attrs = r.attributes ?? [];
    return attrs.includes("disabled");
  }

  /** Elementin gorunur metni icin outerHTML (DOM domain, Runtime degil). */
  async outerHTML(selector) {
    const doc = await this.call("DOM.getDocument", { depth: -1 });
    const q = await this.call("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
    if (!q.nodeId) return "";
    const r = await this.call("DOM.getOuterHTML", { nodeId: q.nodeId });
    return r.outerHTML ?? "";
  }

  async click(x, y) {
    await this.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: x - 55, y: y - 40 });
    await sleep(300 + Math.random() * 250);
    await this.call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await sleep(200 + Math.random() * 250);
    await this.call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await sleep(70 + Math.random() * 80);
    await this.call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  async clickSelector(selector, offsetX = 8, offsetY = null) {
    const b = await this.box(selector);
    if (!b) return false;
    await this.click(b.x + offsetX, offsetY ?? b.y + b.h / 2);
    return true;
  }

  async typeText(text, delayMs = 35) {
    // Input.insertText: trusted text girisi (tek parca). Insansilaştirmak icin parcala.
    for (const ch of text) {
      await this.call("Input.insertText", { text: ch });
      await sleep(delayMs + Math.random() * delayMs);
    }
  }

  /** Trusted key event (Input domain). key: "Tab", " ", "Enter" ... */
  async key(k) {
    const code = k === "Tab" ? "Tab" : k === " " ? "Space" : k;
    const keyCode = k === "Tab" ? 9 : k === " " ? 32 : 13;
    for (const type of ["keyDown", "keyUp"]) {
      await this.call("Input.dispatchKeyEvent", {
        type, key: k, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
      });
      await sleep(60 + Math.random() * 80);
    }
  }

  async wheel(deltaY) {
    await this.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: 460, y: 500, deltaX: 0, deltaY });
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

export function sleep(ms) {
  return new Promise((s) => setTimeout(s, ms));
}
