(function () {
  'use strict';

  var LABELS = { crib: 'Down in crib', sleeping: 'Sleeping', awake: 'Awake', nursing: 'Nursing', crying: 'Crying' };
  var COLORS = { crib: '#FFF2CC', sleeping: '#B6D7A8', awake: '#2a2f37', nursing: '#D9D2E9', crying: '#F4CCCC' };
  var TEXT_ON = { awake: '#c9ced6' };            // everything else uses dark text on its pastel
  var STRIPE = { awake: '#6b7280' };             // banner edge: Awake is quiet, but the stripe still needs to show
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
    todayDow: get('todayDow', null), // 0 = Monday, from the server
    view: { mode: 'day', dayOff: 0, weekOff: 0 }, // what the Day/Week screen shows (0 = now, -1 = before)
    weeks: loadWeeks(),         // weeks saved on this phone, by the Monday they start: {ms: {at, v}}
    inflight: {},               // week requests in progress, so the same one isn't sent twice
    warmed: false,
    viewErr: false,
    scrollReset: true,
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

  // ---- naps (from the server's day payloads) ----
  // While taps are still waiting to sync, today's cached numbers freeze at the time they were fetched.
  function napTotalsFor(d) {
    if (!d) return null;
    var synced = state.queue.length === 0;
    var ms = 0, n = 0, live = false;
    d.intervals.forEach(function (i) {
      if (!i.nap) return;
      n++;
      var end = i.end;
      if (end === null) {
        if (d.isToday !== false) { end = synced ? Date.now() : d.asOf; live = synced; }
        else end = d.dayEnd;
      }
      ms += Math.max(0, end - i.start);
    });
    return { ms: ms, count: n, live: live, syncing: d.isToday !== false && !synced };
  }
  function napTotals() { return napTotalsFor(state.today); }

  function napsText(nt) {
    if (!nt) return '—';
    if (!nt.count) return 'No naps yet';
    return fmtDur(nt.ms) + ' · ' + nt.count + (nt.count === 1 ? ' nap' : ' naps');
  }

  function fillNaps(el, nt) {
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
      now.style.borderLeftColor = STRIPE[l.event] || COLORS[l.event] || '#8b919a';
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

    fillNaps($('napsVal'), napTotals());
    if (!$('today').hidden) renderView();
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
    if (res.todayDow != null) { state.todayDow = res.todayDow; set('todayDow', res.todayDow); }
    render();
  }

  // ---- Day / Week screen ----
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DOWS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  var WEEK_PX_PER_MIN = 0.3;
  var MIN_OFFSET_DAYS = -400;
  var MIN_OFFSET_WEEKS = -57;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function todayDow() {
    if (state.todayDow != null) return state.todayDow;
    return (new Date(Date.now() - 4 * 3600000).getDay() + 6) % 7; // device clock, 4 AM day start
  }
  function fmtDurShort(ms) {
    var m = Math.round(ms / MIN);
    if (m < 60) return m + 'm';
    var r = m % 60;
    return Math.floor(m / 60) + 'h' + (r < 10 ? '0' : '') + r;
  }
  function fmtClockShort(ts) {
    var d = new Date(ts), h = d.getHours(), m = d.getMinutes();
    return ((h % 12) || 12) + ':' + (m < 10 ? '0' : '') + m + (h < 12 ? 'a' : 'p');
  }

  // Payloads cached by an older version of the app lack a few fields; fill them in.
  function normDay(d) {
    if (!d) return d;
    if (d.dayEnd == null) d.dayEnd = d.dayStart + 86400000;
    if (d.isToday == null) d.isToday = true;
    return d;
  }
  // ---- saved weeks (kept on this phone so screens open instantly, then refresh quietly) ----
  var KEEP_WEEKS = 8;
  var FRESH_THIS_WEEK_MS = 30000;      // the current week changes as you log
  var FRESH_PAST_WEEK_MS = 10 * 60000; // past weeks only change if you edit the Log by hand

  function loadWeeks() {
    var w = get('weeks', {});
    return w && typeof w === 'object' && !Array.isArray(w) ? w : {};
  }
  // Monday 4:00 AM (this phone's clock) of the week `off` weeks back. Saved weeks are matched on the
  // date they cover, not on a counter, so a week saved last Tuesday is "last week" this Tuesday.
  function mondayMs(off) {
    var d = new Date(Date.now() - 4 * 3600000);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - todayDow() + 7 * off, 4, 0, 0, 0).getTime();
  }
  function weekEntry(off) {
    var target = mondayMs(off), found = null;
    Object.keys(state.weeks).forEach(function (k) {
      if (Math.abs(Number(k) - target) < 6 * 3600000) found = state.weeks[k];
    });
    return found;
  }
  function weekAt(off) { var e = weekEntry(off); return e ? e.v : null; }
  function weekFresh(off) {
    var e = weekEntry(off);
    return !!e && Date.now() - e.at < (off === 0 ? FRESH_THIS_WEEK_MS : FRESH_PAST_WEEK_MS);
  }
  function saveWeeks() {
    var floor = mondayMs(-(KEEP_WEEKS - 1)) - 6 * 3600000;
    Object.keys(state.weeks).forEach(function (k) { if (Number(k) < floor) delete state.weeks[k]; });
    set('weeks', state.weeks);
  }
  // Something was logged: keep showing what we have, but fetch again the next time it is needed.
  function staleWeeks() {
    Object.keys(state.weeks).forEach(function (k) { state.weeks[k].at = 0; });
    set('weeks', state.weeks);
  }
  // A day is a slice of its week, so moving between days of a week needs no new request.
  function dayAt(off) {
    if (off === 0 && state.today) return normDay(state.today);
    var idx = todayDow() + off, w = Math.floor(idx / 7);
    var wk = weekAt(w);
    return wk ? normDay(wk.days[idx - 7 * w]) : null;
  }

  function logicalDate(off) { // device-clock fallback for titles while a payload is still loading
    var d = new Date(Date.now() - 4 * 3600000);
    d.setDate(d.getDate() + off);
    return d;
  }
  function dayTitleText(d, off) {
    if (off === 0) return 'Today';
    if (d && d.label) return DOWS[d.label.dow] + ' ' + MONTHS[d.label.m - 1] + ' ' + d.label.d;
    var x = logicalDate(off);
    return DOWS[(x.getDay() + 6) % 7] + ' ' + MONTHS[x.getMonth()] + ' ' + x.getDate();
  }
  function weekTitleText(w, off) {
    var a, b;
    if (w) { a = w.days[0].label; b = w.days[6].label; }
    else {
      var mon = logicalDate(7 * off - todayDow()), sun = logicalDate(7 * off - todayDow() + 6);
      a = { m: mon.getMonth() + 1, d: mon.getDate() };
      b = { m: sun.getMonth() + 1, d: sun.getDate() };
    }
    return MONTHS[a.m - 1] + ' ' + a.d + ' – ' + (a.m === b.m ? '' : MONTHS[b.m - 1] + ' ') + b.d;
  }

  // "7:10 PM Mon" / "yesterday" for a stretch that began before this day's 4 AM start (different calendar day only)
  function startPrefix(i, d) {
    if (i.start >= d.dayStart) return '';
    var a = new Date(i.start), b = new Date(d.dayStart);
    var diff = Math.round((new Date(b.getFullYear(), b.getMonth(), b.getDate()) -
      new Date(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000);
    if (diff <= 0) return '';
    return diff === 1 && d.isToday ? ' yesterday' : ' ' + a.toLocaleDateString([], { weekday: 'short' });
  }

  function renderView() {
    var v = state.view, week = v.mode === 'week';
    var off = week ? v.weekOff : v.dayOff;
    document.querySelectorAll('#vseg button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.mode === v.mode);
    });
    $('vNext').disabled = off >= 0;
    $('toToday').hidden = off >= 0;
    $('toToday').textContent = week ? 'Back to this week' : 'Back to today';
    $('timeline').hidden = week;
    $('todayHead').hidden = week;
    $('weekView').hidden = !week;
    if (week) renderWeek(); else renderDay();
  }

  function renderDay() {
    var off = state.view.dayOff, d = dayAt(off);
    $('vTitle').textContent = dayTitleText(d, off);
    var box = $('timeline');
    var atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    var prevTop = box.scrollTop;
    fillNaps($('todayNaps'), napTotalsFor(d));
    var bits = [];
    if (d && d.prevBed) bits.push('Prev bed ' + fmtTime(d.prevBed));
    if (d && d.wake) bits.push('Wake up ' + fmtTime(d.wake));
    $('todayWake').textContent = bits.join(' · ');
    box.textContent = '';
    if (!d || !d.intervals.length) {
      var msg = d ? (d.isToday ? 'Nothing logged yet today.' : 'Nothing logged this day.')
        : (state.viewErr ? "Can't load this day. Check your connection." : 'Loading…');
      box.appendChild(el('div', 'empty', msg));
      return;
    }
    var synced = state.queue.length === 0;
    d.intervals.forEach(function (i) {
      var open = i.end === null && d.isToday;
      var end = i.end === null ? (d.isToday ? (synced ? Date.now() : d.asOf) : d.dayEnd) : i.end;
      var shownStart = Math.max(i.start, d.dayStart);
      var shownEnd = Math.min(end, d.dayEnd);
      var minutes = Math.max(0, (shownEnd - shownStart) / MIN);
      var h = Math.max(minutes * PX_PER_MIN, MIN_BLOCK_PX);
      if (open) h = Math.max(h, NOW_BLOCK_PX);
      var tall = h >= TALL_PX || open;
      var blk = el('div', 'blk' + (tall ? ' tall' : '') + (open ? ' now' : ''));
      blk.style.height = Math.round(h) + 'px';
      blk.style.background = COLORS[i.event] || '#ddd';
      blk.style.color = TEXT_ON[i.event] || '#222';
      blk.dataset.event = i.event;
      blk.dataset.minutes = String(Math.round(minutes));
      var dur = fmtDur(end - i.start);
      var startTxt = fmtTime(i.start) + startPrefix(i, d);
      var endTxt = open ? 'now' : (i.end === null ? 'continues' : fmtTime(i.end));
      var left = el('span');
      if (tall) {
        left.appendChild(el('span', 't1', startTxt + ' – ' + endTxt));
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
    if (state.scrollReset) { box.scrollTop = d.isToday ? box.scrollHeight : 0; state.scrollReset = false; }
    else box.scrollTop = atBottom ? box.scrollHeight : prevTop;
  }

  function renderWeek() {
    var off = state.view.weekOff, w = weekAt(off);
    $('vTitle').textContent = weekTitleText(w, off);
    var sum = $('weekSum'), cols = $('weekCols');
    sum.textContent = '';
    cols.textContent = '';
    sum.className = '';
    cols.className = '';
    $('weekHint').hidden = !w;
    if (!w) {
      sum.appendChild(el('div', 'empty hint', state.viewErr ? "Can't load this week. Check your connection." : 'Loading…'));
      return;
    }
    var now = Date.now();
    sum.className = 'wgrid';
    sum.appendChild(el('div', 'lab'));
    w.days.forEach(function (d, i) {
      var hd = el('div', 'c hd' + (d.isToday ? ' today' : '') + (d.isFuture ? '' : ' tap'));
      hd.appendChild(document.createTextNode(DOWS[i][0]));
      hd.appendChild(document.createElement('br'));
      hd.appendChild(document.createTextNode(String(d.label.d)));
      hd.dataset.i = String(i);
      sum.appendChild(hd);
    });
    var totals = w.days.map(function (d) { return napTotalsFor(normDay(d)); });
    [['Prev bed', function (d) { return d.prevBed ? fmtClockShort(d.prevBed) : '–'; }],
     ['Wake up', function (d) { return d.wake ? fmtClockShort(d.wake) : '–'; }],
     ['# naps', function (d, t) { return String(t.count); }],
     ['Naptime', function (d, t) { return fmtDurShort(t.ms); }]].forEach(function (row) {
      sum.appendChild(el('div', 'lab', row[0]));
      w.days.forEach(function (d, i) {
        var blank = d.isFuture || !d.intervals.length;
        var c = el('div', 'c' + (row[0] === 'Naptime' ? ' nap' : ''), blank ? '–' : row[1](d, totals[i]));
        c.dataset.row = row[0];
        sum.appendChild(c);
      });
    });

    var H = 1440 * WEEK_PX_PER_MIN;
    cols.className = 'wcols';
    var axis = el('div', 'waxis');
    axis.style.height = H + 'px';
    [['4a', 0], ['8a', 240], ['12p', 480], ['4p', 720], ['8p', 960], ['12a', 1200]].forEach(function (a) {
      var t = el('span', null, a[0]);
      t.style.top = (a[1] * WEEK_PX_PER_MIN) + 'px';
      axis.appendChild(t);
    });
    cols.appendChild(axis);
    w.days.forEach(function (d, i) {
      var col = el('div', 'wcol' + (d.isFuture ? ' future' : ''));
      col.style.height = H + 'px';
      col.dataset.i = String(i);
      [0, 240, 480, 720, 960, 1200].forEach(function (m) {
        var hl = el('div', 'hl');
        hl.style.top = (m * WEEK_PX_PER_MIN) + 'px';
        col.appendChild(hl);
      });
      d.intervals.forEach(function (iv) {
        var start = Math.max(iv.start, d.dayStart);
        var end = iv.end === null ? (d.isToday ? now : d.dayEnd) : Math.min(iv.end, d.dayEnd);
        var a = (start - d.dayStart) / MIN, b = (end - d.dayStart) / MIN;
        var blk = el('div', 'b');
        blk.style.top = (a * WEEK_PX_PER_MIN) + 'px';
        blk.style.height = Math.max((b - a) * WEEK_PX_PER_MIN, 1.5) + 'px';
        blk.style.background = COLORS[iv.event] || '#ddd';
        blk.dataset.event = iv.event;
        col.appendChild(blk);
      });
      if (d.isToday) {
        var nl = el('div', 'nowline');
        nl.style.top = (Math.max(0, now - d.dayStart) / MIN * WEEK_PX_PER_MIN) + 'px';
        col.appendChild(nl);
      }
      cols.appendChild(col);
    });
  }

  // `quiet` = we already have something to show, so a failure shouldn't replace it with an error.
  function fetchWeek(off, quiet) {
    if (!URL_ || !get('token', '')) return Promise.resolve();
    if (state.inflight[off]) return state.inflight[off];
    if (!quiet) state.viewErr = false;
    var p = post({ action: 'week', offset: off }).then(function (res) {
      if (res && res.ok) {
        res.week.days.forEach(function (d) { d.asOf = res.serverTime; });
        state.weeks[String(res.week.days[0].dayStart)] = { at: Date.now(), v: res.week };
        saveWeeks();
        if (res.todayDow != null) { state.todayDow = res.todayDow; set('todayDow', res.todayDow); }
      } else if (res && res.error === 'unauthorized') {
        state.syncBad = true;
        state.syncMsg = 'Wrong setup code';
      } else if (!quiet) {
        state.viewErr = true;
      }
    }).catch(function () {
      if (!quiet) state.viewErr = true;
    }).finally(function () {
      delete state.inflight[off];
      if (!$('today').hidden) renderView();
    });
    state.inflight[off] = p;
    return p;
  }

  // Show what's saved right away; refresh in the background if it is out of date.
  // Today comes from the regular status refresh.
  function loadView() {
    var v = state.view;
    if (v.mode === 'day' && v.dayOff === 0) return refresh();
    var off = v.mode === 'week' ? v.weekOff : Math.floor((todayDow() + v.dayOff) / 7);
    var p = weekFresh(off) ? Promise.resolve() : fetchWeek(off, !!weekAt(off));
    if (off - 1 >= -(KEEP_WEEKS - 1) && !weekFresh(off - 1)) fetchWeek(off - 1, true); // for the ‹ arrow
    return p;
  }

  // Soon after the app opens, quietly load this week and last, so the screens are ready when you tap.
  function warmUp() {
    if (state.warmed || !URL_ || !get('token', '')) return;
    state.warmed = true;
    setTimeout(function () {
      if (state.queue.length || document.hidden) { state.warmed = false; return; } // taps first; try again later
      var first = weekFresh(0) ? Promise.resolve() : fetchWeek(0, true);
      first.then(function () { if (!weekFresh(-1) && !state.queue.length) return fetchWeek(-1, true); });
    }, 1500);
  }

  function goTo(mode, dayOff, weekOff) {
    state.view = { mode: mode, dayOff: dayOff, weekOff: weekOff };
    state.scrollReset = true;
    renderView();
    return loadView();
  }

  function setMode(m) {
    var v = state.view;
    if (v.mode === m) return;
    var dow = todayDow();
    var weekOff = v.weekOff, dayOff = v.dayOff;
    if (m === 'week') {
      weekOff = Math.floor((dow + v.dayOff) / 7);   // the week that contains the day you were on
    } else {
      var first = 7 * v.weekOff - dow, last = first + 6;
      if (dayOff < first || dayOff > last) dayOff = Math.min(0, last);
    }
    goTo(m, dayOff, weekOff);
  }

  function step(delta) {
    var v = state.view;
    if (v.mode === 'week') goTo('week', v.dayOff, Math.max(MIN_OFFSET_WEEKS, Math.min(0, v.weekOff + delta)));
    else goTo('day', Math.max(MIN_OFFSET_DAYS, Math.min(0, v.dayOff + delta)), v.weekOff);
  }

  function openDayFromWeek(i) {
    var w = weekAt(state.view.weekOff);
    if (!w || w.days[i].isFuture) return;
    goTo('day', 7 * state.view.weekOff + i - todayDow(), state.view.weekOff);
  }

  function openToday() {
    $('today').hidden = false;
    goTo('day', 0, 0);
    $('timeline').scrollTop = $('timeline').scrollHeight; // start at "now"
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
    placeDialogs();
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
      var v = state.view;
      if (!$('today').hidden && !state.queue.length && !(v.mode === 'day' && v.dayOff === 0)) loadView();
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
        warmUp();
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
    staleWeeks();
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
    staleWeeks();
    setLast(m.prev);
    flush();
  }

  // ---- setup dialog ----
  function ready() { return !!(get('name', '') && get('token', '') && URL_); }

  function openSetup() {
    var hasToken = !!get('token', '');
    $('setupTitle').textContent = ready() ? 'Settings' : 'Set up this phone';
    $('setupSave').textContent = ready() ? 'Done' : 'Save';
    $('nameIn').value = get('name', '');
    $('codeIn').value = '';
    $('codeIn').placeholder = hasToken ? 'saved (paste to replace)' : 'paste the code here';
    $('copyLink').hidden = !hasToken;
    $('setupHint').textContent = !URL_
      ? 'Not configured yet: set the web app URL in config.js.'
      : 'The setup code is created by the Sheet\'s "Sleep tracker" menu. Everyone logging uses the same code.';
    var d = $('setup');
    if (!d.open) d.showModal();
    placeDialogs();
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

  // ---- dialogs: stay above the on-screen keyboard, tap outside to close ----
  function placeDialogs() {
    var vv = window.visualViewport;
    if (!vv) return;
    var root = document.documentElement;
    root.classList.toggle('kb', window.innerHeight - vv.height > 120); // keyboard is up
    root.style.setProperty('--dlg-center', Math.round(vv.offsetTop + vv.height / 2) + 'px'); // middle of what's visible
    root.style.setProperty('--dlg-max', Math.round(vv.height - 24) + 'px');
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', placeDialogs);
    window.visualViewport.addEventListener('scroll', placeDialogs);
  }

  function onOutsideTap(dlg, fn) {
    dlg.addEventListener('click', function (e) {
      if (e.target !== dlg) return; // a click on the padding also lands here, so check the box
      var r = dlg.getBoundingClientRect();
      var inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) fn();
    });
  }

  // Settings closes like any settings sheet: whatever you typed is kept. First-run setup can't be skipped.
  function dismissSetup() {
    if (!ready()) return;
    var name = $('nameIn').value.trim();
    var code = $('codeIn').value.trim();
    if (name) set('name', name);
    if (code) { set('token', code); state.syncBad = false; state.syncMsg = ''; }
    $('setup').close();
    render();
    if (code) flush().then(refresh);
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
  onOutsideTap($('otherDlg'), function () { $('otherDlg').close(); });
  onOutsideTap($('setup'), dismissSetup);
  $('setup').addEventListener('cancel', function (e) { e.preventDefault(); dismissSetup(); }); // Escape / Android back
  function onEnter(id, fn) {
    $(id).addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); fn(); } });
  }
  onEnter('timeIn', useOtherTime);
  onEnter('nameIn', function () {
    if (get('token', '') || $('codeIn').value.trim()) saveSetup(); else $('codeIn').focus();
  });
  onEnter('codeIn', saveSetup);
  $('timeCancel').addEventListener('click', function () { $('otherDlg').close(); });
  $('naps').addEventListener('click', openToday);
  $('todayBack').addEventListener('click', closeToday);
  $('vPrev').addEventListener('click', function () { step(-1); });
  $('vNext').addEventListener('click', function () { step(1); });
  $('toToday').addEventListener('click', function () { goTo(state.view.mode, 0, 0); });
  document.querySelectorAll('#vseg button').forEach(function (b) {
    b.addEventListener('click', function () { setMode(b.dataset.mode); });
  });
  $('weekView').addEventListener('click', function (e) {
    var t = e.target.closest('[data-i]');
    if (t) openDayFromWeek(Number(t.dataset.i));
  });
  $('undo').addEventListener('click', undo);
  $('gear').addEventListener('click', openSetup);
  $('setupSave').addEventListener('click', saveSetup);
  $('copyLink').addEventListener('click', copyLink);

  window.addEventListener('online', function () { flush().then(refresh); });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { state.warmed = false; render(); flush().then(refresh); }
  });
  setInterval(function () { if (!document.hidden) render(); }, 15000);
  setInterval(function () {
    if (document.hidden) return;
    refresh();
    var v = state.view;
    if (!$('today').hidden && !(v.mode === 'day' && v.dayOff === 0)) loadView(); // keep past days/weeks fresh too
  }, 30000);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(function () { /* app works without it */ });
  }

  render();
  if (!ready()) openSetup(); else flush().then(refresh);
})();
