// Injected via page.addInitScript BEFORE any of the app's scripts run.
// Replaces window.WebSocket with a controllable fake (routed by URL: :8765 = backend feed,
// /party/ = worker feed) and stubs window.pywebview, so the REAL index.html runs with no
// game / backend / worker. Tests push server->app frames via window.__mock and read what the
// app sent back (post_fight / final_detail / commands).
(() => {
  const OPEN = 1, CLOSED = 3;
  const sockets = [];
  const sent = { backend: [], worker: [], other: [] };

  function classify(url) {
    const u = String(url);
    if (u.includes(':8765')) return 'backend';
    if (u.includes('/party/') || u.includes('workers.dev')) return 'worker';
    return 'other';
  }

  class FakeWebSocket {
    constructor(url) {
      this.url = String(url);
      this.channel = classify(url);
      this.readyState = 0;
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      this._listeners = {};
      sockets.push(this);
      setTimeout(() => { this.readyState = OPEN; this._emit('open', {}); }, 0);
    }
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
    removeEventListener(t, fn) { const a = this._listeners[t] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
    _emit(t, ev) {
      const h = this['on' + t];
      if (h) { try { h(ev); } catch (e) { console.error('[mock] on' + t, e); } }
      (this._listeners[t] || []).forEach(fn => { try { fn(ev); } catch (e) {} });
    }
    send(data) {
      let p; try { p = JSON.parse(data); } catch { p = data; }
      (sent[this.channel] || (sent[this.channel] = [])).push(p);
    }
    close() { this.readyState = CLOSED; this._emit('close', { code: 1000 }); }
    _deliver(obj) { this._emit('message', { data: typeof obj === 'string' ? obj : JSON.stringify(obj) }); }
  }
  FakeWebSocket.CONNECTING = 0; FakeWebSocket.OPEN = 1; FakeWebSocket.CLOSING = 2; FakeWebSocket.CLOSED = 3;
  window.WebSocket = FakeWebSocket;

  window.pywebview = window.pywebview || {
    api: new Proxy({}, { get: () => () => Promise.resolve(null) }),
    token: 'mock',
  };

  const open = ch => sockets.filter(s => s.channel === ch && s.readyState === OPEN);
  window.__mock = {
    sockets, sent,
    pushBackend(obj) { const s = open('backend'); s.forEach(x => x._deliver(obj)); return s.length; },
    pushWorker(obj) { const s = open('worker'); s.forEach(x => x._deliver(obj)); return s.length; },
    sentBackend() { return sent.backend; },
    sentWorker() { return sent.worker; },
    clearSent() { sent.backend.length = 0; sent.worker.length = 0; sent.other.length = 0; },
    counts() { return { total: sockets.length, backend: open('backend').length, worker: open('worker').length }; },
  };
})();
