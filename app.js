(function () {
  'use strict';

  var LABELS = { crib: 'Down in crib', sleeping: 'Sleeping', awake: 'Awake', nursing: 'Nursing', crying: 'Crying' };
  var COLORS = { crib: '#FFF2CC', sleeping: '#CFE2F3', awake: '#B6D7A8', nursing: '#D9D2E9', crying: '#F4CCCC' };
  var URL_ = (window.SLEEP_CONFIG && window.SLEEP_CONFIG.url) || '';
  var MIN = 60000;
  var PX_PER_MIN = 1;       // Today screen: block height = minutes, with a floor so text fits
  var MIN_BLOCK_PX = 18;
  var TALL_PX = 38;         // blocks at least this tall get the two-line layout
  var NOW_BLOCK_PX = 64;    // the in-progress block always has room for its pill

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
    today: get('today', null),  // last Today payload from the server, plus asOf
    offset: 0,                  // "N min ago" chip
    customTs: null,             // exact time chosen with "Other…"
    ap: 'PM',
    apManual: false,
    flushing: false,
    syncMsg: '',
    syncBad: false,
  };

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  // ---- formatting ----
  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  function fmtElapsed(ms) {
    var m = Math.max(0, Math.floor(ms / MIN));
    if (m < 1) return 'just now';
    var h = Math.floor(m / 60);
    return (h ? h + 'h ' : '') + (m % 60) + 'm';
  }
  function fmtDur(ms) {
    var m = Math.round(ms / MIN);
    if (m < 1) return '<1m';
    var h = Math.floor(m / 60);
    return h ? h + 'h ' + (m % 60) + 'm' : m + 'm';
  }
  function agoText(ms) {
    return ms < MIN ? 'just now' : fmtElapsed(ms) + ' ago';
  }
  function startOfLocalDay(ts) {
    var d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  // ---- naps (from the server's Today payload) ----
  // While taps are still waiting to sync, the cached numbers freeze at the time they were fetched.
  function napTotals() {
    var t = state.today;
    if (!t) return null;
    var synced = state.queue.length === 0;
    var ms = 0, n = 0, live = false;
    t.intervals.forEach(function (i) {
      if (!i.nap) return;
      n++;
      var end = i.end;
      if (end === null) { end = synced ? Date.now() : t.asOf; live = synced; }
      ms += Math.max(0, end - i.start);
    });
    return { ms: ms, count: n, live: live, syncing: !synced };
  }

  function napsText(nt) {
    if (!nt) return '—';
    if (!nt.count) return 'No naps yet';
    return fmtDur(nt.ms) + ' · ' + nt.count + (nt.count === 1 ? ' nap' : ' naps');
  }

  function fillNaps(el) {
    var nt = napTotals();
    el.textContent = '';
    el.appendChild(document.createTextNode(napsText(nt)));
    if (nt && nt.live) {
      var small = document.createElement('small');
      var dot = document.createElement('span');
      dot.className = 'dot';
      small.appendChild(dot);
      small.appendChild(document.createTextNode(' counting'));
      el.appendChild(small);
    } else if (nt && nt.syncing) {
      var s = document.createElement('small');
      s.textContent = 'updating…';
      el.appendChild(s);
    }
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

    var custom = state.customTs !== null;
    document.querySelectorAll('.chip').forEach(function (c) {
      if (c.dataset.min === 'other') {
        c.textContent = custom ? fmtTime(state.customTs) : 'Other…';
        c.classList.toggle('on', custom);
      } else {
        c.classList.toggle('on', !custom && String(state.offset) === c.dataset.min);
      }
    });

    fillNaps($('napsVal'));
    if (!$('today').hidden) renderToday();
  }

  function setLast(l) {
    state.last = l;
    set('last', l);
    render();
  }

  function setToday(res) {
    if (!res || !res.today) return;
    var t = Object.assign({}, res.today, { asOf: res.serverTime });
    state.today = t;
    set('today', t);
    render();
  }

  // ---- Today screen ----
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function renderToday() {
    var box = $('timeline');
    var atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    var prevTop = box.scrollTop;
    var t = state.today;
    fillNaps($('todayNaps'));
    box.textContent = '';
    if (!t || !t.intervals.length) {
      box.appendChild(el('div', 'empty', t ? 'Nothing logged yet today.' : 'Loading today…'));
      return;
    }
    var synced = state.queue.length === 0;
    t.intervals.forEach(function (i) {
      var open = i.end === null;
      var end = open ? (synced ? Date.now() : t.asOf) : i.end;
      var shownStart = Math.max(i.start, t.dayStart);
      var minutes = Math.max(0, (end - shownStart) / MIN);
      var h = Math.max(minutes * PX_PER_MIN, MIN_BLOCK_PX);
      if (open) h = Math.max(h, NOW_BLOCK_PX);
      var tall = h >= TALL_PX || open;
      var blk = el('div', 'blk' + (tall ? ' tall' : '') + (open ? ' now' : ''));
      blk.style.height = Math.round(h) + 'px';
      blk.style.background = COLORS[i.event] || '#ddd';
      blk.dataset.event = i.event;
      blk.dataset.minutes = String(Math.round(minutes));
      var dur = fmtDur(end - i.start);
      var startTxt = i.start < t.dayStart ? fmtTime(i.start) + ' yesterday' : fmtTime(i.start);
      var left = el('span');
      if (tall) {
        left.appendChild(el('span', 't1', startTxt + ' – ' + (open ? 'now' : fmtTime(i.end))));
        left.appendChild(el('span', 'name', LABELS[i.event] || i.event));
      } else {
        left.textContent = startTxt + ' · ' + (LABELS[i.event] || i.event);
      }
      blk.appendChild(left);
      if (open) {
        var right = el('span', 'right');
        var pill = el('span', 'pill');
        pill.appendChild(el('span', 'dot'));
        pill.appendChild(document.createTextNode('Now'));
        right.appendChild(pill);
        right.appendChild(el('span', 'dur', dur));
        blk.appendChild(right);
      } else {
        blk.appendChild(el('span', 'dur', dur));
      }
      box.appendChild(blk);
    });
    box.scrollTop = atBottom ? box.scrollHeight : prevTop;
  }

  function openToday() {
    $('today').hidden = false;
    renderToday();
    $('timeline').scrollTop = $('timeline').scrollHeight; // start at "now"
    refresh();
  }
  function closeToday() { $('today').hidden = true; }

  // ---- "Other…" time ----
  function formatDigits(raw) {
    var d = String(raw).replace(/\D/g, '').slice(0, 4);
    return d.length <= 2 ? d : d.slice(0, -2) + ':' + d.slice(-2);
  }
  function parseDigits(raw) {
    var d = String(raw).replace(/\D/g, '').slice(0, 4);
    if (!d) return null;
    var h = d.length <= 2 ? Number(d) : Number(d.slice(0, -2));
    var m = d.length <= 2 ? 0 : Number(d.slice(-2));
    if (m > 59 || h > 23) return null;
    return { h: h, m: m };
  }
  // The most recent moment (within 24h, never in the future) with that wall-clock time.
  function resolveTime(hm, ap, nowMs) {
    var hour24;
    if (hm.h >= 13 || hm.h === 0) hour24 = hm.h;               // typed as 24-hour time
    else hour24 = (hm.h % 12) + (ap === 'PM' ? 12 : 0);
    var d = new Date(nowMs);
    d.setHours(hour24, hm.m, 0, 0);
    if (d.getTime() > nowMs) d.setDate(d.getDate() - 1);
    return d.getTime();
  }
  function autoAp(hm, nowMs) {
    if (hm.h >= 13 || hm.h === 0) return null;
    return resolveTime(hm, 'PM', nowMs) > resolveTime(hm, 'AM', nowMs) ? 'PM' : 'AM';
  }

  function updateTimeDialog() {
    var hm = parseDigits($('timeIn').value);
    $('timeErr').textContent = '';
    if (!hm) { $('timeHint').textContent = 'Type the digits, like 430. No colon needed.'; syncAp(); return; }
    var now = Date.now();
    if (!state.apManual) { var a = autoAp(hm, now); if (a) state.ap = a; }
    syncAp();
    var t = resolveTime(hm, state.ap, now);
    var day = startOfLocalDay(t) < startOfLocalDay(now) ? ' yesterday' : '';
    $('timeHint').textContent = fmtTime(t) + day + ' · ' + agoText(now - t);
  }
  function syncAp() {
    document.querySelectorAll('#ampm button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.ap === state.ap);
    });
  }
  function openOther() {
    $('timeIn').value = '';
    $('timeErr').textContent = '';
    state.apManual = false;
    state.ap = new Date().getHours() >= 12 ? 'PM' : 'AM';
    syncAp();
    $('timeHint').textContent = 'Type the digits, like 430. No colon needed.';
    var d = $('otherDlg');
    if (!d.open) d.showModal();
    $('timeIn').focus();
  }
  function useOtherTime() {
    var hm = parseDigits($('timeIn').value);
    if (!hm) { $('timeErr').textContent = 'Enter a time like 4:30.'; return; }
    state.customTs = resolveTime(hm, state.ap, Date.now());
    state.offset = 0;
    $('otherDlg').close();
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
        state.last = res.last;
        set('last', res.last);
        setToday(res);
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
        state.last = res.last;
        set('last', res.last);
        setToday(res);
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
    var ts = state.customTs !== null ? state.customTs : nowMs - state.offset * MIN;
    var op = { type: 'log', id: uid(), event: ev, ts: ts, who: get('name', '') };
    state.mine.push({ id: op.id, prev: state.last });
    if (state.mine.length > 20) state.mine.shift();
    set('mine', state.mine);
    state.queue.push(op);
    set('queue', state.queue);
    setLast({ event: ev, ts: op.ts, who: op.who });
    state.offset = 0;
    state.customTs = null;
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
      if (c.dataset.min === 'other') { openOther(); return; }
      state.offset = parseInt(c.dataset.min, 10);
      state.customTs = null;
      render();
    });
  });
  $('timeIn').addEventListener('input', function () {
    var f = formatDigits($('timeIn').value);
    if ($('timeIn').value !== f) $('timeIn').value = f;
    updateTimeDialog();
  });
  document.querySelectorAll('#ampm button').forEach(function (b) {
    b.addEventListener('click', function () {
      state.ap = b.dataset.ap;
      state.apManual = true;
      updateTimeDialog();
    });
  });
  $('timeUse').addEventListener('click', useOtherTime);
  $('timeCancel').addEventListener('click', function () { $('otherDlg').close(); });
  $('naps').addEventListener('click', openToday);
  $('todayBack').addEventListener('click', closeToday);
  $('undo').addEventListener('click', undo);
  $('gear').addEventListener('click', openSetup);
  $('setupSave').addEventListener('click', saveSetup);
  $('copyLink').addEventListener('click', copyLink);

  window.addEventListener('online', function () { flush().then(refresh); });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { render(); flush().then(refresh); }
  });
  setInterval(function () { if (!document.hidden) render(); }, 15000);
  setInterval(function () { if (!document.hidden) refresh(); }, 30000);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(function () { /* app works without it */ });
  }

  render();
  if (!ready()) openSetup(); else flush().then(refresh);
})();
