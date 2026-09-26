(function () {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const TABS = ['standings', 'schedule', 'players', 'rules'];

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v == null || v === '') localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

  const cfg = window.LADDER_CONFIG || {};
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { flowType: 'implicit', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  const state = {
    season: null, weeks: [], players: new Map(), emails: new Map(), matches: [], standings: [],
    loaded: false, failed: null,
    session: null, myPlayer: null, isAdmin: false,
    pick: lsGet('ladder.me') || '',
    tab: TABS.includes(lsGet('ladder.tab')) ? lsGet('ladder.tab') : 'standings',
    week: null
  };
  const h0 = (location.hash || '').slice(1);
  if (TABS.includes(h0)) state.tab = h0;

  // Whose matches to highlight: the signed-in player, otherwise the "Viewing as" pick.
  const meId = () => state.myPlayer || state.pick || '';
  const signedIn = () => !!state.session;
  const canSeeEmails = () => signedIn() && (state.myPlayer || state.isAdmin) && state.emails.size > 0;

  /* ---------- dates ---------- */
  function pd(iso) { const [y, m, d] = String(iso).split('-').map(Number); return new Date(y, m - 1, d); }
  function todayISO() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function range(w) {
    if (!w) return '';
    const a = pd(w.starts_on), b = pd(w.ends_on);
    return a.getMonth() === b.getMonth()
      ? `${MON[a.getMonth()]} ${a.getDate()}–${b.getDate()}`
      : `${MON[a.getMonth()]} ${a.getDate()} – ${MON[b.getMonth()]} ${b.getDate()}`;
  }
  function shortDate(iso) { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? '' : `${MON[d.getMonth()]} ${d.getDate()}`; }
  const weekObj = n => state.weeks.find(w => w.n === n);
  function currentWeekN() {
    const t = todayISO();
    if (!state.weeks.length) return 1;
    for (const w of state.weeks) if (t <= w.ends_on) return w.n;
    return state.weeks[state.weeks.length - 1].n;
  }
  function seasonOver() { const ws = state.weeks; return ws.length > 0 && todayISO() > ws[ws.length - 1].ends_on; }
  function weekPast(n) { const w = weekObj(n); return !!w && todayISO() > w.ends_on; }

  /* ---------- players & matches ---------- */
  const pname = id => (state.players.get(id) || {}).name || id || '—';
  const lastKey = n => { const p = String(n || '').trim().split(/\s+/); return (p[p.length - 1] + ' ' + p.slice(0, -1).join(' ')).toLowerCase(); };
  const byName = (a, b) => lastKey(a.name).localeCompare(lastKey(b.name));
  const byWeek = (a, b) => (a.week - b.week) || (a.ord - b.ord);
  const matchById = id => state.matches.find(m => m.id === id);
  const involves = (m, pid) => !!pid && (m.home === pid || m.away === pid);
  const resultOf = m => (m && m.outcome) ? { type: m.outcome, winner: m.winner, sets: m.sets || [] } : null;
  const canEditMatch = m => signedIn() && !!m && !!m.away && (state.isAdmin || involves(m, state.myPlayer));

  function scoreText(result) {
    if (!result) return '';
    if (result.type === 'default') return 'by default';
    const w = result.winner;
    const parts = (result.sets || []).map(s => {
      const x = w === 'home' ? s.h : s.a, y = w === 'home' ? s.a : s.h;
      let t = `${x}-${y}`;
      if (!s.mtb && s.tb != null && ((x === 7 && y === 6) || (x === 6 && y === 7))) t += `(${s.tb})`;
      return t;
    });
    let out = parts.join(', ');
    if (result.type === 'retired') out = (out ? out + ' ' : '') + 'ret.';
    return out;
  }
  function resultLine(m, result) {
    const w = result.winner === 'home' ? m.home : m.away, l = result.winner === 'home' ? m.away : m.home;
    return `${pname(w)} def. ${pname(l)} ${scoreText(result)}`.trim();
  }

  function rankedStandings() {
    const list = state.standings.map(r => Object.assign({}, r));
    const sd = r => r.sets_won - r.sets_lost, gd = r => r.games_won - r.games_lost;
    list.sort((x, y) => (y.w - x.w) || (x.l - y.l) || (sd(y) - sd(x)) || (gd(y) - gd(x)) || byName(x, y));
    let prev = null, rank = 0;
    list.forEach((r, i) => { const key = [r.w, r.l, sd(r), gd(r)].join('|'); if (key !== prev) rank = i + 1; r.rank = rank; prev = key; });
    list.forEach((r, i) => { r.tied = (list[i - 1] && list[i - 1].rank === r.rank) || (list[i + 1] && list[i + 1].rank === r.rank); });
    return list;
  }

  /* ---------- data ---------- */
  async function loadAll() {
    const [season, weeks, players, matches, standings] = await Promise.all([
      sb.from('season').select('*').eq('id', 1).maybeSingle(),
      sb.from('weeks').select('*').order('n'),
      sb.from('players').select('id,name'),
      sb.from('matches').select('*').order('week').order('ord'),
      sb.from('standings').select('*')
    ]);
    const err = [season, weeks, players, matches, standings].find(r => r.error);
    if (err) throw err.error;
    state.season = season.data;
    state.weeks = weeks.data || [];
    state.players = new Map((players.data || []).map(p => [p.id, p]));
    state.matches = matches.data || [];
    state.standings = standings.data || [];
    await loadEmails();
    state.loaded = true;
  }
  async function loadEmails() {
    state.emails = new Map();
    if (!signedIn()) return;
    const { data, error } = await sb.from('player_emails').select('player_id,email');
    if (!error && data) state.emails = new Map(data.map(r => [r.player_id, r.email]));
  }
  async function refreshMatches() {
    const [matches, standings] = await Promise.all([
      sb.from('matches').select('*').order('week').order('ord'),
      sb.from('standings').select('*')
    ]);
    if (!matches.error) state.matches = matches.data || [];
    if (!standings.error) state.standings = standings.data || [];
    render();
  }
  let refreshTimer = null;
  function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refreshMatches, 400); }

  async function loadIdentity() {
    state.myPlayer = null; state.isAdmin = false;
    if (!signedIn()) return;
    const [me, adm] = await Promise.all([sb.rpc('my_player_id'), sb.rpc('is_admin')]);
    state.myPlayer = me.data || null;
    state.isAdmin = adm.data === true;
  }

  /* ---------- render ---------- */
  function render() {
    renderHeader();
    renderTabs();
    if (state.failed) {
      for (const id of ['#p-standings', '#p-schedule', '#pTable', '#p-rules']) $(id).innerHTML = `<div class="loading">${esc(state.failed)}</div>`;
      return;
    }
    if (!state.loaded) return;
    renderMine();
    renderStandings();
    renderSchedule();
    renderPlayers();
    renderRules();
  }

  function renderHeader() {
    const s = state.season;
    if (s && s.name) { $('#seasonName').textContent = s.name; document.title = `${s.name} · Farm Tennis`; }
    const wl = $('#weekLine');
    const w = weekObj(currentWeekN());
    if (!state.loaded) wl.textContent = ' ';
    else if (seasonOver()) wl.textContent = 'Regular season complete · playoffs ' + ((s && s.playoffs) || 'TBD');
    else if (w) wl.innerHTML = `<b>Week ${w.n}</b> of ${state.weeks.length} · ${esc(range(w))}`;

    // identity area
    const inRoster = signedIn() && (state.myPlayer || state.isAdmin);
    $('#pickerField').hidden = signedIn() && !!state.myPlayer;
    $('#whoField').hidden = !signedIn();
    $('#signInBtn').hidden = signedIn();
    if (signedIn()) {
      const email = state.session.user && state.session.user.email;
      $('#whoName').textContent = state.myPlayer ? pname(state.myPlayer) : (state.isAdmin ? 'League admin' : email || 'Signed in');
    }
    const sel = $('#me');
    const players = Array.from(state.players.values()).sort(byName);
    const want = ['<option value="">Choose your name…</option>'].concat(players.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`)).join('');
    if (sel.dataset.sig !== want) { sel.innerHTML = want; sel.dataset.sig = want; }
    if (state.pick && state.loaded && !state.players.has(state.pick)) { state.pick = ''; lsSet('ladder.me', ''); }
    sel.value = state.pick || '';
    $('#reportBtn').hidden = !state.loaded || (signedIn() && !inRoster);

    const sum = $('#summary');
    if (state.loaded) {
      const real = state.matches.filter(m => m.away);
      const done = real.filter(m => m.outcome).length;
      const overdue = real.filter(m => !m.outcome && weekPast(m.week)).length;
      sum.innerHTML = `<span><b class="num">${done}</b> of <span class="num">${real.length}</span> matches reported</span>` +
        `<span><b class="num">${state.players.size}</b> players</span>` +
        (overdue ? `<span><b class="num">${overdue}</b> from past weeks still open</span>` : '') +
        `<span>Playoffs: ${esc((s && s.playoffs) || 'TBD')}</span>`;
      sum.hidden = false;
    } else sum.hidden = true;

    const note = $('#notice');
    if (signedIn() && !inRoster) {
      note.hidden = false;
      note.textContent = `${state.session.user.email} isn't on this season's roster, so it can't report scores. Sign out and use the email the league has on file, or ask the organizer to update it.`;
    } else note.hidden = true;
  }

  function renderTabs() {
    for (const t of TABS) {
      $('#t-' + t).setAttribute('aria-selected', String(state.tab === t));
      $('#p-' + t).hidden = state.tab !== t;
    }
  }

  function copyBtn(text, label) { return `<button type="button" class="copy" data-copy="${esc(text)}" aria-label="Copy ${esc(label || text)}">Copy</button>`; }
  function emailBits(pid, name) {
    const e = state.emails.get(pid);
    if (e) return `<span class="email">${esc(e)}</span>${copyBtn(e, name + "'s email")}`;
    return signedIn() ? '' : `<button type="button" class="link" data-signin="contact">Sign in to see email</button>`;
  }

  function reportButton(m, cls, label) {
    if (!m.away) return '';
    if (signedIn()) return canEditMatch(m) ? `<button type="button" class="${cls}" data-report="${esc(m.id)}">${label}</button>` : '';
    return involves(m, state.pick) ? `<button type="button" class="${cls}" data-report="${esc(m.id)}">${label}</button>` : '';
  }

  function renderMine() {
    const box = $('#mine');
    const id = meId();
    const me = id && state.players.get(id);
    if (!me) { box.hidden = true; box.innerHTML = ''; return; }
    const st = state.standings.find(r => r.player_id === me.id) || { w: 0, l: 0 };
    const mine = state.matches.filter(m => involves(m, me.id)).sort(byWeek);
    const open = mine.filter(m => m.away && !m.outcome);
    const bye = mine.find(m => !m.away);
    const cw = currentWeekN();
    let rows = open.map(m => {
      const oppId = m.home === me.id ? m.away : m.home;
      const home = m.home === me.id;
      const late = weekPast(m.week);
      return `<div class="todo-row">
        <div class="wk">Week ${m.week}<small>${esc(range(weekObj(m.week)))}</small></div>
        <div>
          <div class="opp">vs ${esc(pname(oppId))} ${late ? '<span class="pill late">Makeup</span>' : (m.week === cw ? '<span class="pill">This week</span>' : '')}</div>
          <div class="opp-meta">
            ${home ? '<span class="pill home">Home · bring balls</span>' : '<span class="pill">Away</span>'}
            ${emailBits(oppId, pname(oppId))}
          </div>
        </div>
        <div>${reportButton(m, 'btn ghost', 'Report')}</div>
      </div>`;
    }).join('');
    if (!rows) rows = `<p class="muted" style="margin:0">Every match on your schedule has a result.</p>`;
    box.innerHTML = `<div class="mine-head">
        <h2 id="mineTitle">${state.myPlayer ? 'Your matches' : esc(me.name) + "'s matches"}</h2>
        <span class="muted"><span class="rec num">${st.w}–${st.l}</span> · ${open.length} to play${bye ? ` · bye in week ${bye.week}` : ''}</span>
      </div>
      <div class="todo">${rows}</div>`;
    box.hidden = false;
  }

  function renderStandings() {
    const list = rankedStandings();
    const p = $('#p-standings');
    if (!list.length) { p.innerHTML = '<div class="loading">No players have been added yet.</div>'; return; }
    const body = list.map(r => {
      const me = r.player_id === meId();
      const pct = (r.w + r.l) ? (r.w / (r.w + r.l)).toFixed(3).replace(/^0/, '') : '—';
      return `<tr class="${me ? 'me' : ''}">
        <td class="rank num">${r.tied ? 'T' : ''}${r.rank}</td>
        <td>${esc(r.name)}${me ? '<span class="you">You</span>' : ''}</td>
        <td class="n big">${r.w}</td>
        <td class="n big">${r.l}</td>
        <td class="n">${pct}</td>
        <td class="n">${r.sets_won}–${r.sets_lost}</td>
        <td class="n">${r.games_won}–${r.games_lost}</td>
        <td class="n">${r.to_play}</td>
      </tr>`;
    }).join('');
    p.innerHTML = `<div class="tbl-wrap"><table>
      <thead><tr><th>#</th><th>Player</th><th class="n">W</th><th class="n">L</th><th class="n">Pct</th><th class="n">Sets</th><th class="n">Games</th><th class="n">To play</th></tr></thead>
      <tbody>${body}</tbody></table></div>
      <p class="foot-note">Ordered by wins, then fewest losses, then set difference, then game difference. A 10-point match tiebreak counts as one set and one game. Defaults count as a win and a loss with no sets or games.</p>`;
  }

  function matchCard(m) {
    if (!m.away) return `<div class="match byecard"><div class="bye"><span>${esc(pname(m.home))}</span><span class="muted">Bye</span></div></div>`;
    const r = resultOf(m);
    const mine = involves(m, meId());
    const row = side => {
      const won = r && r.winner === side;
      const cells = [];
      for (let i = 0; i < 3; i++) {
        const s = r && r.sets && r.sets[i];
        if (!s) { cells.push('<span class="g"></span>'); continue; }
        const x = side === 'home' ? s.h : s.a, y = side === 'home' ? s.a : s.h;
        const sup = (!s.mtb && s.tb != null && x === 6 && y === 7) ? `<sup>${esc(s.tb)}</sup>` : '';
        cells.push(`<span class="g${x > y ? ' w' : ''}${s.mtb ? ' mtb' : ''}">${esc(x)}${sup}</span>`);
      }
      return `<div class="sb-row${won ? ' win' : ''}${r && !won ? ' lose' : ''}">
        <span class="dot" aria-hidden="true"></span>
        <span class="nm">${esc(pname(m[side]))}${side === 'home' ? '<abbr class="h" title="Home player brings a new can of balls">H</abbr>' : ''}</span>
        ${cells.join('')}
      </div>`;
    };
    let foot;
    if (r) {
      const how = r.type === 'retired' ? 'Retired · ' : r.type === 'default' ? 'Won by default · ' : '';
      const when = m.source === 'import' ? 'From the original sheet' : `Reported ${shortDate(m.reported_at)}${m.reported_by ? ' by ' + esc(m.reported_by) : ''}`;
      foot = `<span>${how}${when}</span>${reportButton(m, 'link', 'Edit')}`;
    } else {
      const late = weekPast(m.week);
      foot = `<span class="${late ? 'late' : ''}">${late ? 'Not reported yet · can be made up before season end' : 'Scheduled'}</span>${reportButton(m, 'link', 'Report score')}`;
    }
    const label = r ? resultLine(m, r) : `${pname(m.home)} vs ${pname(m.away)}, not yet reported`;
    return `<article class="match${mine ? ' is-me' : ''}" aria-label="${esc(label)}"><div class="sb">${row('home')}${row('away')}</div><div class="m-foot">${foot}</div></article>`;
  }

  function renderSchedule() {
    const p = $('#p-schedule');
    const cw = currentWeekN();
    if (state.week == null || !weekObj(state.week)) state.week = cw;
    const pills = state.weeks.map(w => `<button type="button" class="wkbtn" data-week="${w.n}" aria-pressed="${w.n === state.week}"><b>Week ${w.n}${w.n === cw && !seasonOver() ? '<span class="now" title="Current week"></span>' : ''}</b><span>${esc(range(w))}</span></button>`).join('');
    const me = meId();
    const list = state.matches.filter(m => m.week === state.week).sort((a, b) => {
      const am = involves(a, me) ? 0 : 1, bm = involves(b, me) ? 0 : 1;
      return (am - bm) || ((a.away ? 0 : 1) - (b.away ? 0 : 1)) || (a.ord - b.ord);
    });
    const done = list.filter(m => m.away && m.outcome).length, total = list.filter(m => m.away).length;
    p.innerHTML = `<div class="weeks" role="group" aria-label="Choose a week">${pills}</div>
      <div class="week-head"><h2>Week ${state.week}</h2><span class="muted">${done} of ${total} reported</span></div>
      <div class="grid">${list.map(matchCard).join('') || '<p class="muted">No matches this week.</p>'}</div>`;
  }

  function renderPlayers() {
    const q = ($('#pSearch').value || '').trim().toLowerCase();
    const st = new Map(state.standings.map(r => [r.player_id, r]));
    const showEmail = canSeeEmails();
    $('#copyAll').hidden = !showEmail;
    const list = Array.from(state.players.values()).sort(byName)
      .filter(p => !q || p.name.toLowerCase().includes(q) || (showEmail && String(state.emails.get(p.id) || '').toLowerCase().includes(q)));
    const rows = list.map(p => {
      const r = st.get(p.id) || { w: 0, l: 0 };
      const e = state.emails.get(p.id);
      return `<tr class="${p.id === meId() ? 'me' : ''}">
        <td>${esc(p.name)}${p.id === meId() ? '<span class="you">You</span>' : ''}</td>
        ${showEmail ? `<td><span class="email">${esc(e || '')}</span></td><td>${e ? copyBtn(e, p.name + "'s email") : ''}</td>` : ''}
        <td class="n">${r.w}–${r.l}</td>
      </tr>`;
    }).join('');
    const note = showEmail ? '' : `<p class="foot-note">Email addresses are visible to league members after they sign in. <button type="button" class="link" data-signin="contact">Sign in</button></p>`;
    $('#pTable').innerHTML = list.length
      ? `<div class="tbl-wrap"><table><thead><tr><th>Player</th>${showEmail ? '<th>Email</th><th><span class="sr">Copy</span></th>' : ''}<th class="n">W–L</th></tr></thead><tbody>${rows}</tbody></table></div>${note}`
      : `<p class="muted">No players match “${esc(q)}”.</p>`;
  }

  function renderRules() {
    const rules = (state.season && Array.isArray(state.season.rules)) ? state.season.rules : [];
    $('#p-rules').innerHTML = `<div class="rules"><ul>${rules.map(r => `<li>${esc(r)}</li>`).join('')}</ul></div>`;
  }

  /* ---------- toast & copy ---------- */
  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }
  function selectText(el) {
    try { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } catch (e) { /* ignore */ }
  }
  function doCopy(text, btn) {
    const fallback = () => {
      const target = btn && btn.previousElementSibling && btn.previousElementSibling.classList.contains('email') ? btn.previousElementSibling : null;
      if (target) { selectText(target); toast('Selected — press Ctrl/⌘+C to copy'); } else toast("Couldn't copy");
    };
    try { navigator.clipboard.writeText(text).then(() => toast('Copied'), fallback); } catch (e) { fallback(); }
  }

  /* ---------- modals ---------- */
  let returnFocus = null;
  function openModal(id, focusSel) {
    returnFocus = document.activeElement;
    $('#' + id).hidden = false;
    document.body.style.overflow = 'hidden';
    setTimeout(() => { const f = focusSel && $(focusSel); if (f) try { f.focus(); } catch (e) { /* ignore */ } }, 30);
  }
  function closeModal(id) {
    $('#' + id).hidden = true;
    if ($$('.modal').every(m => m.hidden)) document.body.style.overflow = '';
    if (returnFocus && returnFocus.focus) try { returnFocus.focus(); } catch (e) { /* ignore */ }
  }

  /* ---------- sign in ---------- */
  let pendingReport = null;
  function openSignIn(reason, matchId) {
    pendingReport = matchId || null;
    $('#aReason').textContent = reason || "Sign in with the email address the league has on file. We'll email you a link. No password needed.";
    $('#authForm').hidden = false; $('#authSent').hidden = true; $('#aError').hidden = true;
    openModal('authModal', '#aEmail');
  }
  async function sendLink(e) {
    e.preventDefault();
    const email = $('#aEmail').value.trim().toLowerCase();
    const err = $('#aError');
    err.hidden = true;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { err.textContent = 'Enter a full email address, like name@example.com.'; err.hidden = false; return; }
    const btn = $('#aSend'); btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const ok = await sb.rpc('roster_email_ok', { p_email: email });
      if (ok.error) throw ok.error;
      if (!ok.data) { err.textContent = "That email isn't on this season's roster. Use the address the league has on file, or ask the organizer to add it."; err.hidden = false; return; }
      if (pendingReport) lsSet('ladder.pendingReport', pendingReport);
      const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname, shouldCreateUser: true } });
      if (error) throw error;
      $('#aSentTo').textContent = email;
      $('#authForm').hidden = true; $('#authSent').hidden = false;
    } catch (ex) {
      const status = ex && (ex.status || ex.code);
      err.textContent = (status === 429 || /rate limit/i.test(ex && ex.message || ''))
        ? 'Too many sign-in emails were requested. Wait a few minutes and try again.'
        : "The sign-in email didn't send. Try again in a minute; if it keeps failing, tell the organizer.";
      err.hidden = false;
    } finally {
      btn.disabled = false; btn.textContent = 'Email me a link';
    }
  }

  /* ---------- report dialog ---------- */
  const R = { matchId: null, type: 'completed', winner: null, clearArmed: false, saving: false };
  const setIds = ['s1h', 's1a', 's1t', 's2h', 's2a', 's2t', 's3h', 's3a', 's3t'];
  const num = id => { const v = $('#' + id).value.trim(); if (v === '') return null; const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : NaN; };

  function reportable() {
    return state.matches.filter(m => canEditMatch(m)).sort(byWeek);
  }
  function fillMatchOptions(selectedId) {
    const ms = reportable();
    const groups = state.weeks.map(w => {
      const opts = ms.filter(m => m.week === w.n).map(m => `<option value="${esc(m.id)}">${esc(pname(m.home))} vs ${esc(pname(m.away))}${m.outcome ? ' · reported' : ''}</option>`).join('');
      return opts ? `<optgroup label="Week ${w.n} · ${esc(range(w))}">${opts}</optgroup>` : '';
    }).join('');
    $('#rMatch').innerHTML = groups;
    $('#rMatch').value = selectedId;
  }
  function defaultMatchId() {
    const ms = reportable();
    const open = ms.filter(m => !m.outcome);
    const cw = currentWeekN();
    const pick = open.find(m => m.week <= cw) || open[0] || ms[0];
    return pick ? pick.id : null;
  }
  function setType(t) {
    R.type = t;
    $$('#rType button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.type === t)));
    $('#rBoardWrap').hidden = t === 'default';
    $('#rWinnerWrap').hidden = t === 'completed';
    updateForm();
  }
  function setWinner(w) {
    R.winner = w;
    $$('#rWinner button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.winner === w)));
    updateForm();
  }
  function loadMatch(id) {
    const m = matchById(id);
    R.matchId = id; R.clearArmed = false;
    if (!m) return;
    $('#eHome').textContent = pname(m.home);
    $('#eAway').textContent = pname(m.away);
    $('#rWinner').innerHTML = `<button type="button" data-winner="home" aria-pressed="false">${esc(pname(m.home))}</button><button type="button" data-winner="away" aria-pressed="false">${esc(pname(m.away))}</button>`;
    setIds.forEach(i => { $('#' + i).value = ''; });
    $('#rFullThird').checked = false;
    const r = resultOf(m);
    if (r) {
      r.sets.forEach((s, i) => {
        const k = i + 1; if (k > 3) return;
        $(`#s${k}h`).value = s.h; $(`#s${k}a`).value = s.a;
        if (s.tb != null) $(`#s${k}t`).value = s.tb;
        if (k === 3 && !s.mtb) $('#rFullThird').checked = true;
      });
      setType(r.type);
      setWinner(r.winner);
    } else {
      R.winner = null;
      setType('completed');
    }
    const clr = $('#rClear');
    clr.hidden = !r; clr.textContent = 'Clear result';
    $('#mTitle').textContent = r ? 'Edit score' : 'Report a score';
    $('#rSave').textContent = r ? 'Save changes' : 'Save score';
    $('#rError').hidden = true;
    updateForm();
  }
  function readForm() {
    const m = matchById(R.matchId);
    if (!m) return { ok: false, msg: 'Choose a match.' };
    const fullThird = $('#rFullThird').checked;
    const sets = [];
    if (R.type !== 'default') {
      for (let i = 1; i <= 3; i++) {
        const h = num(`s${i}h`), a = num(`s${i}a`), t = num(`s${i}t`);
        if (Number.isNaN(h) || Number.isNaN(a) || Number.isNaN(t)) return { ok: false, msg: `Set ${i}: use whole numbers.` };
        if (h === null && a === null) continue;
        if (h === null || a === null) return { ok: false, msg: `${i === 3 && !fullThird ? 'Tiebreak' : 'Set ' + i}: enter both players' scores.` };
        const s = { h, a };
        if (i === 3 && !fullThird) s.mtb = true;
        if (!s.mtb && ((h === 7 && a === 6) || (h === 6 && a === 7)) && t !== null) s.tb = t;
        sets.push(s);
      }
    }
    let winner = R.winner;
    if (R.type === 'completed') {
      if (!sets.length) return { ok: false, msg: null };
      if (sets.some(s => s.h === s.a)) return { ok: false, msg: "A set can't finish level. Check the scores." };
      if (sets.length === 3) {
        let h2 = 0, a2 = 0; sets.slice(0, 2).forEach(s => { if (s.h > s.a) h2++; else a2++; });
        if (h2 === 2 || a2 === 2) return { ok: false, msg: 'The first two sets already decided the match. Clear the third column.' };
      }
      let hw = 0, aw = 0; sets.forEach(s => { if (s.h > s.a) hw++; else aw++; });
      if (hw === aw) return { ok: false, msg: `Sets are split ${hw}–${aw}. Add the ${fullThird ? 'third set' : 'match tiebreak'}.` };
      winner = hw > aw ? 'home' : 'away';
    } else if (!winner) {
      return { ok: false, msg: 'Choose who won.' };
    }
    return { ok: true, m, result: { winner, type: R.type, sets } };
  }
  function updateForm() {
    const fullThird = $('#rFullThird').checked;
    $('#c3Label').textContent = fullThird ? 'Set 3' : 'Tiebreak';
    let anyTb = false;
    for (let i = 1; i <= 3; i++) {
      const h = num(`s${i}h`), a = num(`s${i}a`);
      const show = !(i === 3 && !fullThird) && ((h === 7 && a === 6) || (h === 6 && a === 7));
      $(`#s${i}t`).classList.toggle('inv', !show);
      $(`#s${i}t`).tabIndex = show ? 0 : -1;
      if (show) anyTb = true;
    }
    $('#tbLbl').classList.toggle('inv', !anyTb);
    const f = readForm();
    const pv = $('#rPreview'), er = $('#rError');
    if (f.ok) {
      pv.textContent = resultLine(f.m, f.result);
      pv.classList.remove('empty');
      if (!R.saving) er.hidden = true;
    } else {
      pv.textContent = R.type === 'completed' ? 'Enter the games won in each set.' : 'Choose who won.';
      pv.classList.add('empty');
      if (f.msg && R.type === 'completed') { er.textContent = f.msg; er.hidden = false; } else er.hidden = true;
    }
    $('#rSave').disabled = !f.ok || R.saving;
  }
  function openReport(id) {
    if (!state.loaded) return;
    if (!signedIn()) { openSignIn('Sign in to report a score. Use the email address the league has on file, and we\'ll email you a link.', id); return; }
    const mid = (id && canEditMatch(matchById(id))) ? id : defaultMatchId();
    if (!mid) { toast('You have no matches to report'); return; }
    fillMatchOptions(mid);
    loadMatch(mid);
    const m = matchById(mid);
    openModal('modal', m && m.outcome ? '#rMatch' : '#s1h');
  }
  function friendlyError(error) {
    const msg = error && error.message || '';
    if (/JWT|not authenticated|Sign in/i.test(msg)) return 'Your sign-in expired. Sign in again to save the score.';
    if (msg && msg.length < 160 && !/violates|syntax|function|relation/i.test(msg)) return msg;
    return "The score didn't save. Check your connection and try again.";
  }
  async function saveReport() {
    if (R.saving) return;
    const f = readForm();
    if (!f.ok) return;
    R.saving = true; $('#rSave').disabled = true; $('#rSave').textContent = 'Saving…';
    const { error } = await sb.rpc('report_result', {
      p_match_id: f.m.id, p_outcome: f.result.type, p_winner: f.result.winner, p_sets: f.result.sets
    });
    R.saving = false; $('#rSave').textContent = f.m.outcome ? 'Save changes' : 'Save score';
    if (error) { $('#rError').textContent = friendlyError(error); $('#rError').hidden = false; updateForm(); return; }
    closeModal('modal');
    toast('Score saved');
    refreshMatches();
  }
  async function clearResult() {
    const m = matchById(R.matchId);
    if (!m || !m.outcome || R.saving) return;
    if (!R.clearArmed) { R.clearArmed = true; $('#rClear').textContent = 'Tap again to clear'; return; }
    R.saving = true;
    const { error } = await sb.rpc('clear_result', { p_match_id: m.id });
    R.saving = false;
    if (error) { $('#rError').textContent = friendlyError(error); $('#rError').hidden = false; return; }
    closeModal('modal');
    toast('Result cleared');
    refreshMatches();
  }

  /* ---------- events ---------- */
  document.addEventListener('click', e => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.close) { closeModal(t.dataset.close); return; }
    if (t.dataset.tab) { state.tab = t.dataset.tab; lsSet('ladder.tab', state.tab); renderTabs(); return; }
    if (t.dataset.week) { state.week = Number(t.dataset.week); renderSchedule(); return; }
    if (t.dataset.report) { openReport(t.dataset.report); return; }
    if (t.dataset.copy) { doCopy(t.dataset.copy, t); return; }
    if (t.dataset.signin) { openSignIn(); return; }
    if (t.dataset.type) { setType(t.dataset.type); return; }
    if (t.dataset.winner) { setWinner(t.dataset.winner); return; }
    switch (t.id) {
      case 'reportBtn': openReport(null); break;
      case 'signInBtn': openSignIn(); break;
      case 'signOut': sb.auth.signOut(); break;
      case 'rSave': saveReport(); break;
      case 'rClear': clearResult(); break;
      case 'copyAll': {
        const list = Array.from(state.players.values()).sort(byName).map(p => state.emails.get(p.id)).filter(Boolean).join(', ');
        if (list) doCopy(list, null);
        break;
      }
    }
  });
  $$('.modal').forEach(m => m.addEventListener('click', e => { if (e.target === m) closeModal(m.id); }));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') $$('.modal').filter(m => !m.hidden).forEach(m => closeModal(m.id)); });
  $('#me').addEventListener('change', e => { state.pick = e.target.value; lsSet('ladder.me', state.pick); render(); });
  $('#pSearch').addEventListener('input', renderPlayers);
  $('#authForm').addEventListener('submit', sendLink);
  $('#rMatch').addEventListener('change', e => loadMatch(e.target.value));
  $('#rFullThird').addEventListener('change', updateForm);
  setIds.forEach(id => $('#' + id).addEventListener('input', () => { R.clearArmed = false; $('#rClear').textContent = 'Clear result'; updateForm(); }));
  $('#rBoard').addEventListener('keydown', e => { if (e.key === 'Enter' && !$('#rSave').disabled) saveReport(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.loaded) scheduleRefresh(); });

  /* ---------- boot ---------- */
  async function applySession(session) {
    state.session = session || null;
    await loadIdentity();
    if (state.loaded) await loadEmails();
    render();
    const pending = lsGet('ladder.pendingReport');
    if (pending && signedIn() && state.loaded) {
      lsSet('ladder.pendingReport', '');
      if (canEditMatch(matchById(pending))) openReport(pending);
    }
  }

  render();
  (async function boot() {
    try {
      const { data } = await sb.auth.getSession();
      state.session = data.session || null;
      await loadIdentity();
      await loadAll();
    } catch (e) {
      state.failed = "The ladder couldn't load. Check your connection and reload the page.";
    }
    render();
    const pending = lsGet('ladder.pendingReport');
    if (pending && signedIn()) { lsSet('ladder.pendingReport', ''); if (canEditMatch(matchById(pending))) openReport(pending); }

    sb.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') {
        const changed = (state.session && state.session.user && state.session.user.id) !== (session && session.user && session.user.id);
        if (changed || event === 'SIGNED_OUT') setTimeout(() => applySession(session), 0);
        if (event === 'SIGNED_IN' && changed) toast('Signed in');
      } else if (event === 'TOKEN_REFRESHED') {
        state.session = session;
      }
    });

    sb.channel('matches-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'matches' }, scheduleRefresh)
      .subscribe();
  })();
})();
