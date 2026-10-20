// WebSocket client with auto-reconnect. The reconnect token lives in
// sessionStorage (per tab) so two tabs on one machine can be two players, and a
// refresh drops you right back into your seat.

const TOKEN_KEY = 'ink.play.token';

export class Net {
  constructor(handlers) {
    this.h = handlers;
    this.ws = null;
    this.rid = 0;
    this.pending = new Map();   // rid -> resolve
    this.backoff = 500;
    this.name = '';
    this.connect();
  }
  get token() { return sessionStorage.getItem(TOKEN_KEY); }
  set token(t) { sessionStorage.setItem(TOKEN_KEY, t); }

  connect() {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/play`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 500;
      this.send({ t: 'hello', token: this.token, name: this.name });
      this.h.onStatus?.('online');
    };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'welcome') this.token = m.token;
      if (m.rid != null && this.pending.has(m.rid)) {
        this.pending.get(m.rid)(m.t === 'err' ? { ok: false, error: m.msg } : { ok: true });
        this.pending.delete(m.rid);
      }
      this.h.onMessage?.(m);
    };
    ws.onclose = () => {
      this.h.onStatus?.('offline');
      for (const r of this.pending.values()) r({ ok: false, error: 'Connection lost' });
      this.pending.clear();
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(8000, this.backoff * 1.8);
    };
  }
  send(m) {
    if (this.ws?.readyState === WebSocket.OPEN) { this.ws.send(JSON.stringify(m)); return true; }
    return false;
  }
  // Game action; resolves {ok, error?} once the server accepts or rejects it.
  act(a) {
    const rid = ++this.rid;
    return new Promise((resolve) => {
      if (!this.send({ t: 'act', a, rid })) { resolve({ ok: false, error: 'Not connected' }); return; }
      this.pending.set(rid, resolve);
      setTimeout(() => { if (this.pending.has(rid)) { this.pending.delete(rid); resolve({ ok: false, error: 'Timed out' }); } }, 8000);
    });
  }
}
