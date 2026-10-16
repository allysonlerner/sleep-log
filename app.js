(function () {
  'use strict';

  var LABELS = { crib: 'Down in crib', sleeping: 'Sleeping', awake: 'Awake', nursing: 'Nursing', crying: 'Crying' };
  var COLORS = { crib: '#FFF2CC', sleeping: '#CFE2F3', awake: '#B6D7A8', nursing: '#D9D2E9', crying: '#F4CCCC' };
  var URL_ = (window.SLEEP_CONFIG && window.SLEEP_CONFIG.url) || '';

  // ---- storage (can throw in private windows; the app still works for the session) ----
  var mem = {};
  function get(k, fallback) {
    try {
      var v = localStorage.getItem('st.' + k);
      return v === null ? (k in mem ? mem[k] : fallback) : JSON.parse(v);
    } catch (e) { return k in mem ? mem[k] : fallback; }
  }
  function set(k, v) {
    mem[k] = v;
    try { localStorage.setItem('st.' + k, JSON.stringify(v)); } catch (e) { /* ignore */ }
  }

  // Token arrives once via the link fragment (#t=...), then lives in localStorage.
  (function readFragment() {
    var m = /[#&]t=([^&]+)/.exec(location.hash);
    if (m) {
      set('token', decodeURIComponent(m[1]));
      history.replaceState(null, '', location.pathname + location.search);
    }
  })();

  var $ = function (id) { return document.getElementById(id); };
  var state = {
    queue: get('queue', []),    // pending ops: {type:'log'|'undo', id, event, ts, who}
    mine: get('mine', []),      // my recent taps, for undo: [{id, prev}]
    last: get('last', null),    // what the banner shows: {event, ts, who}
    offset: 0,
    flushing: false,
    syncMsg: '',
    syncBad: false,
  };

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  function fmtElapsed(ms) {
    var m = Math.max(0, Math.floor(ms / 60000));
    if (m < 1) return 'just now';
    var h = Math.floor(m / 60);
    return (h ? h + 'h ' : '') + (m % 60) + 'm';
  }

  // ---- rendering ----
  function render() {
    var now = $('now');
    var l = state.last;
    if (l) {
      $('nowMain').textContent = LABELS[l.event] || l.event;
      $('nowSub').textContent = 'since ' + fmtTime(l.ts) + ' (' + fmtElapsed(Date.now() - l.ts) + ') · ' + (l.who || '');
      now.style.borderLeftColor = COLORS[l.event] || '#8b919a';
    } else {
      $('nowMain').textContent = 'Nothing logged yet';
      $('nowSub').textContent = '';
      now.style.borderLeftColor = '#8b919a';
    }
    var pending = state.queue.length;
    var s = $('sync');
    s.className = state.syncBad ? 'bad' : '';
    s.textContent = state.syncMsg || (pending ? pending + ' waiting to sync' : '');
    $('undo').disabled = state.mine.length === 0;
    var custom = [0, 5, 10, 15, 30].indexOf(state.offset) < 0;
    document.querySelectorAll('.chip').forEach(function (c) {
      if (c.dataset.min === 'other') {
        c.textContent = custom ? state.offset + ' min ago' : 'Other…';
        c.classList.toggle('on', custom);
      } else {
        c.classList.toggle('on', String(state.offset) === c.dataset.min);
      }
    });
  }

  function setLast(l) {
    state.last = l;
    set('last', l);
    render();
  }

  // ---- network ----
  function post(body) {
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, 20000);
    // text/plain avoids a CORS preflight, which Apps Script cannot answer.
    return fetch(URL_, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ token: get('token', '') }, body)),
      signal: ctl.signal,
    }).then(function (r) { return r.json(); }).finally(function () { clearTimeout(timer); });
  }

  function flush() {
    if (state.flushing || !URL_) return Promise.resolve();
    state.flushing = true;
    function step() {
      if (!state.queue.length) return Promise.resolve(null);
      var op = state.queue[0];
      var body = op.type === 'undo'
        ? { action: 'undo', id: op.id }
        : { action: 'log', id: op.id, event: op.event, ts: op.ts, who: op.who };
      return post(body).then(function (res) {
        if (res && res.ok) {
          state.queue.shift();
          set('queue', state.queue);
          state.syncBad = false;
          state.syncMsg = '';
          return state.queue.length ? step() : res;
        }
        if (res && res.error === 'unauthorized') {
          state.syncBad = true;
          state.syncMsg = 'Wrong setup code';
          return null; // keep the queue; fixing the code lets it send
        }
        if (res && (res.error === 'busy' || res.error === 'server')) {
          state.syncMsg = 'Retrying…';
          return null;
        }
        state.queue.shift(); // bad_request: will never succeed, don't block the rest
        set('queue', state.queue);
        return state.queue.length ? step() : res;
      });
    }
    return step().then(function (res) {
      if (res && res.ok && !state.queue.length) {
        setLast(res.last);
        state.syncMsg = '';
      }
    }).catch(function () {
      state.syncBad = false;
      state.syncMsg = "Can't sync";
    }).finally(function () {
      state.flushing = false;
      render();
    });
  }

  function refresh() {
    if (!URL_ || state.queue.length || !get('token', '')) return flush();
    return post({ action: 'status' }).then(function (res) {
      if (res && res.ok && !state.queue.length) {
        setLast(res.last);
        state.syncBad = false;
        state.syncMsg = '';
      } else if (res && res.error === 'unauthorized') {
        state.syncBad = true;
        state.syncMsg = 'Wrong setup code';
      }
      render();
    }).catch(function () {
      state.syncMsg = "Can't sync";
      render();
    });
  }

  // ---- actions ----
  var lastTapAt = 0;
  function tap(ev) {
    if (!ready()) { openSetup(); return; }
    var nowMs = Date.now();
    if (nowMs - lastTapAt < 600) return; // swallow double taps
    lastTapAt = nowMs;
    var op = { type: 'log', id: uid(), event: ev, ts: nowMs - state.offset * 60000, who: get('name', '') };
    state.mine.push({ id: op.id, prev: state.last });
    if (state.mine.length > 20) state.mine.shift();
    set('mine', state.mine);
    state.queue.push(op);
    set('queue', state.queue);
    setLast({ event: ev, ts: op.ts, who: op.who });
    state.offset = 0;
    render();
    if (navigator.vibrate) navigator.vibrate(25);
    var btn = document.querySelector('.ev[data-ev="' + ev + '"]');
    btn.classList.add('flash');
    setTimeout(function () { btn.classList.remove('flash'); }, 250);
    flush();
  }

  function undo() {
    var m = state.mine.pop();
    if (!m) return;
    set('mine', state.mine);
    var i = state.queue.findIndex(function (q) { return q.type === 'log' && q.id === m.id; });
    if (i >= 0) state.queue.splice(i, 1); // never sent, just drop it
    else state.queue.push({ type: 'undo', id: m.id });
    set('queue', state.queue);
    setLast(m.prev);
    flush();
  }

  // ---- setup dialog ----
  function ready() { return !!(get('name', '') && get('token', '') && URL_); }

  function openSetup() {
    var hasToken = !!get('token', '');
    $('setupTitle').textContent = ready() ? 'Settings' : 'Set up this phone';
    $('nameIn').value = get('name', '');
    $('codeIn').value = '';
    $('codeIn').placeholder = hasToken ? 'saved (paste to replace)' : 'paste the code here';
    $('copyLink').hidden = !hasToken;
    $('setupHint').textContent = !URL_
      ? 'Not configured yet: set the web app URL in config.js.'
      : 'The setup code is created by the Sheet\'s "Sleep tracker" menu. Everyone logging uses the same code.';
    var d = $('setup');
    if (!d.open) d.showModal();
  }

  function saveSetup() {
    var name = $('nameIn').value.trim();
    var code = $('codeIn').value.trim();
    if (!name) { $('nameIn').focus(); return; }
    if (!get('token', '') && !code) { $('codeIn').focus(); return; }
    set('name', name);
    if (code) set('token', code);
    state.syncBad = false;
    state.syncMsg = '';
    $('setup').close();
    render();
    flush().then(refresh);
  }

  function copyLink() {
    var link = location.origin + location.pathname + '#t=' + encodeURIComponent(get('token', ''));
    var done = function () { $('setupHint').textContent = 'Link copied. Send it to your partner; opening it sets them up.'; };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done, function () { prompt('Copy this link:', link); });
    else prompt('Copy this link:', link);
  }

  // ---- wiring ----
  document.querySelectorAll('.ev').forEach(function (b) {
    b.addEventListener('click', function () { tap(b.dataset.ev); });
  });
  document.querySelectorAll('.chip').forEach(function (c) {
    c.addEventListener('click', function () {
      if (c.dataset.min === 'other') {
        var v = parseInt(prompt('How many minutes ago?', '20'), 10);
        if (v > 0 && v <= 720) state.offset = v;
      } else {
        state.offset = parseInt(c.dataset.min, 10);
      }
      render();
    });
  });
  $('undo').addEventListener('click', undo);
  $('gear').addEventListener('click', openSetup);
  $('setupSave').addEventListener('click', saveSetup);
  $('copyLink').addEventListener('click', copyLink);

  window.addEventListener('online', function () { flush().then(refresh); });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { render(); flush().then(refresh); }
  });
  setInterval(function () { if (!document.hidden) render(); }, 30000);
  setInterval(function () { if (!document.hidden) refresh(); }, 30000);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(function () { /* app works without it */ });
  }

  render();
  if (!ready()) openSetup(); else flush().then(refresh);
})();
