'use strict';

const API = 'https://api.coingecko.com/api/v3';
const START_CASH = 100;
const REFRESH_MS = 60000;
const STORE_KEY = 'paper-coin:v2';

const $ = (s) => document.querySelector(s);
const coins = new Map();   // id -> latest market data
let order = [];            // ids in market-cap order (loaded pages)
let page = 1;
let query = '';
let results = null;        // ids from remote search
let selected = null;
let side = 'buy';
let state = loadState();

/* ---------- storage ---------- */
// Nothing is saved: every page load starts fresh with $100.
function loadState() {
  try { ['paper-coin:v1', 'paper-coin:v2'].forEach((k) => localStorage.removeItem(k)); } catch (e) { /* ignore */ }
  return { cash: START_CASH, deposited: START_CASH, holdings: {} };
}
function saveState() { /* intentionally does nothing */ }

/* ---------- helpers ---------- */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
function price(n) {
  if (n == null) return '–';
  if (n >= 1) return usd(n);
  return '$' + n.toPrecision(4).replace(/\.?0+$/, '');
}
function qtyFmt(q) { return q >= 1 ? q.toLocaleString('en-US', { maximumFractionDigits: 6 }) : q.toPrecision(4); }
const pct = (n) => (n == null ? '–' : (n >= 0 ? '+' : '') + n.toFixed(2) + '%');
const cls = (n) => (n == null ? '' : n >= 0 ? 'up' : 'down');
const signedUsd = (n) => (n >= 0 ? '+' : '−') + usd(Math.abs(n));

function spark(prices, up) {
  if (!prices || prices.length < 2) return '';
  const min = Math.min(...prices), max = Math.max(...prices), w = 84, h = 26;
  const step = w / (prices.length - 1);
  const pts = prices.map((p, i) => `${(i * step).toFixed(1)},${(h - 2 - ((p - min) / (max - min || 1)) * (h - 4)).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${up ? 'var(--gain)' : 'var(--loss)'}" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
}

/* ---------- data ---------- */
function fetchT(url, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  return fetch(url, { signal: ctl.signal }).finally(() => clearTimeout(t));
}
async function fetchMarkets(params) {
  const url = `${API}/coins/markets?vs_currency=usd&sparkline=true&price_change_percentage=24h&${params}`;
  const res = await fetchT(url);
  if (res.status === 429) throw new Error('Rate limited by CoinGecko. Retrying soon.');
  if (!res.ok) throw new Error('Could not load prices (' + res.status + ').');
  const list = await res.json();
  list.forEach((c) => coins.set(c.id, c));
  return list;
}

async function loadPage(p) {
  const list = await fetchMarkets(`order=market_cap_desc&per_page=100&page=${p}`);
  list.forEach((c) => { if (!order.includes(c.id)) order.push(c.id); });
}

function trackedIds() {
  const ids = new Set(Object.keys(state.holdings));
  if (selected) ids.add(selected);
  (results || []).forEach((id) => ids.add(id));
  order.forEach((id) => ids.delete(id));
  return [...ids].slice(0, 200);
}

/* Online clock: ask a time server, never trust the PC clock */
let timeOffset = 0;
let timeOnline = false;
const onlineNow = () => Date.now() + timeOffset;
const clockText = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

async function syncTime() {
  const sources = [
    async () => (await (await fetchT('https://worldtimeapi.org/api/timezone/Etc/UTC', 4000)).json()).unixtime * 1000,
    async () => Date.parse((await (await fetchT('https://timeapi.io/api/time/current/zone?timeZone=UTC', 4000)).json()).dateTime.slice(0, 23) + 'Z')
  ];
  for (const get of sources) {
    try {
      const t0 = Date.now();
      const server = await get();
      const t1 = Date.now();
      if (!Number.isFinite(server)) continue;
      timeOffset = server + (t1 - t0) / 2 - t1;
      timeOnline = true;
      return;
    } catch (e) { /* try next source */ }
  }
  timeOnline = false;
}

const RETRY_MS = 5000;
let refreshing = false;
let nextRefreshAt = 0;
let failures = 0;
let timeChecked = false;

async function loadAll() {
  for (let p = 1; p <= page; p++) await loadPage(p);
  const extra = trackedIds();
  if (extra.length) await fetchMarkets(`ids=${encodeURIComponent(extra.join(','))}&per_page=250`);
}
function stamp() {
  setStatus('Live · updated ' + clockText(onlineNow()) + (timeChecked && !timeOnline ? ' (device clock)' : ''), 'live');
}

/* Connects straight away: prices and the online clock load in parallel, prices never wait for the clock. */
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  const timeSync = syncTime();
  let ok = false;
  try {
    await loadAll();
    ok = true;
    failures = 0;
    renderAll();
    stamp();
  } catch (e) {
    failures++;
    const why = e.name === 'AbortError' ? 'Connection timed out.' : e instanceof TypeError ? 'No connection.' : e.message;
    setStatus(why + ' Trying again…', 'err');
  }
  await timeSync;
  timeChecked = true;
  if (ok) stamp();
  // success: wait a minute; failure: retry quickly (5s, 10s, 20s ... up to 1 min)
  nextRefreshAt = onlineNow() + (ok ? REFRESH_MS : Math.min(RETRY_MS * 2 ** (failures - 1), REFRESH_MS));
  refreshing = false;
}

function tick() {
  if (!nextRefreshAt) return;
  const left = Math.max(0, Math.ceil((nextRefreshAt - onlineNow()) / 1000));
  renderStatus(left);
  if (left === 0) refresh();
}

let searchTimer;
function onSearch() {
  query = $('#search').value.trim().toLowerCase();
  results = null;
  clearTimeout(searchTimer);
  renderTable();
  if (query.length < 2) return;
  searchTimer = setTimeout(async () => {
    try {
      const res = await fetchT(`${API}/search?query=${encodeURIComponent(query)}`);
      if (!res.ok) throw new Error('Search failed (' + res.status + ').');
      const ids = (await res.json()).coins.slice(0, 25).map((c) => c.id);
      if (!ids.length) { results = []; return renderTable(); }
      await fetchMarkets(`ids=${encodeURIComponent(ids.join(','))}&order=market_cap_desc&per_page=50`);
      results = ids.filter((id) => coins.has(id));
      renderTable();
    } catch (e) { setStatus(e.message, 'err'); }
  }, 400);
}

/* ---------- portfolio ---------- */
function holdingValue(id, h) {
  const c = coins.get(id);
  return c ? h.qty * c.current_price : null;
}
function totals() {
  let held = 0;
  for (const [id, h] of Object.entries(state.holdings)) {
    const v = holdingValue(id, h);
    held += v == null ? h.cost : v;
  }
  return { equity: state.cash + held };
}

/* ---------- trading ---------- */
function trade() {
  const c = coins.get(selected);
  const amount = parseFloat($('#amount').value);
  if (!c) return msg('Pick a coin first.', 'err');
  if (!(amount > 0)) return msg('Enter an amount in USD.', 'err');
  const p = c.current_price;
  let q = amount / p;
  const h = state.holdings[c.id];

  if (side === 'buy') {
    if (amount > state.cash + 1e-9) return msg('Not enough cash. You have ' + usd(state.cash) + '.', 'err');
    const spend = Math.min(amount, state.cash);
    const cur = h || { qty: 0, cost: 0 };
    state.holdings[c.id] = { qty: cur.qty + spend / p, cost: cur.cost + spend, name: c.name, symbol: c.symbol, image: c.image };
    state.cash -= spend;
    msg(`Bought ${qtyFmt(spend / p)} ${c.symbol.toUpperCase()} for ${usd(spend)}.`, 'ok');
  } else {
    if (!h) return msg('You don’t own any ' + c.name + '.', 'err');
    if (q > h.qty * (1 - 1e-9)) q = h.qty;
    if (amount > q * p + 0.005 && q !== h.qty) return msg('You only own ' + usd(h.qty * p) + ' of ' + c.name + '.', 'err');
    const proceeds = q * p;
    h.cost -= h.cost * (q / h.qty);
    h.qty -= q;
    if (h.qty <= 1e-12) delete state.holdings[c.id];
    state.cash += proceeds;
    msg(`Sold ${qtyFmt(q)} ${c.symbol.toUpperCase()} for ${usd(proceeds)}.`, 'ok');
  }
  saveState();
  $('#amount').value = '';
  renderAll();
}

function quickFill(pctVal) {
  const c = coins.get(selected);
  if (!c) return;
  const base = side === 'buy' ? state.cash : (holdingValue(selected, state.holdings[selected] || { qty: 0 }) || 0);
  const v = Math.floor((base * pctVal) / 100 * 100) / 100;
  $('#amount').value = pctVal === 100 ? (side === 'buy' ? state.cash.toFixed(2) : base.toFixed(2)) : v;
  renderPreview();
}

/* ---------- rendering ---------- */
let statusBase = 'Connecting…', statusKind = '';
function setStatus(text, kind) { statusBase = text; statusKind = kind || ''; renderStatus(); }
function renderStatus(left) {
  const el = $('#status');
  const next = left == null ? '' : refreshing ? ' · updating…' : ` · next update in ${left}s`;
  el.textContent = statusBase + next;
  el.className = 'status ' + statusKind;
}
function msg(text, kind) {
  const el = $('#msg');
  el.textContent = text;
  el.className = 'msg ' + (kind || '');
}

function renderAll() {
  renderSummary();
  renderTable();
  renderTrade();
  renderHoldings();
}

function renderSummary() {
  const { equity } = totals();
  const pl = equity - state.deposited;
  $('#equity').textContent = usd(equity);
  $('#cash').textContent = usd(state.cash);
  const el = $('#pl');
  el.textContent = signedUsd(pl) + ' (' + pct((pl / state.deposited) * 100) + ')';
  el.className = cls(pl);
}

function renderTable() {
  let ids;
  if (query) {
    ids = results !== null
      ? results
      : order.filter((id) => { const c = coins.get(id); return c.name.toLowerCase().includes(query) || c.symbol.toLowerCase().includes(query); });
  } else ids = order;

  if (!ids.length && !query) {
    $('#rows').innerHTML = '<tr><td colspan="6" class="empty">Connecting to live prices…</td></tr>';
    $('#more').hidden = true;
    return;
  }
  $('#rows').innerHTML = ids.map((id) => {
    const c = coins.get(id);
    if (!c) return '';
    const up = (c.price_change_percentage_24h ?? 0) >= 0;
    const h = state.holdings[id];
    const hv = h ? holdingValue(id, h) : null;
    const hpl = hv == null ? null : hv - h.cost;
    const pos = h
      ? `<span>Bought ${usd(h.cost)} · ${qtyFmt(h.qty)} ${esc(c.symbol.toUpperCase())}</span><b>Now ${usd(hv)}</b><small class="${cls(hpl)}">${signedUsd(hpl)} (${pct((hpl / h.cost) * 100)})</small>`
      : '';
    return `<tr data-id="${esc(id)}" class="${id === selected ? 'sel' : ''}" tabindex="0">
      <td class="rank">${c.market_cap_rank ?? '–'}</td>
      <td><div class="coin"><img src="${esc(c.image)}" alt="" loading="lazy"><div><b>${esc(c.name)}</b><br><span>${esc(c.symbol)}</span></div></div></td>
      <td class="num">${price(c.current_price)}</td>
      <td class="num ${cls(c.price_change_percentage_24h)}">${pct(c.price_change_percentage_24h)}</td>
      <td class="pos">${pos}</td>
      <td class="hide-sm">${spark(c.sparkline_in_7d && c.sparkline_in_7d.price, up)}</td>
    </tr>`;
  }).join('');
  $('#empty').hidden = !(query && results !== null && !ids.length);
  $('#more').hidden = !!query;
}

function renderTrade() {
  const c = coins.get(selected);
  $('#no-coin').hidden = !!c;
  $('#trade-body').hidden = !c;
  if (!c) return;
  $('#t-img').src = c.image;
  $('#t-name').textContent = c.name;
  $('#t-sym').textContent = c.symbol.toUpperCase();
  $('#t-price').textContent = price(c.current_price);
  const chg = $('#t-chg');
  chg.textContent = pct(c.price_change_percentage_24h) + ' today';
  chg.className = cls(c.price_change_percentage_24h);
  $('#tab-buy').classList.toggle('on', side === 'buy');
  $('#tab-sell').classList.toggle('on', side === 'sell');
  const btn = $('#submit');
  btn.textContent = (side === 'buy' ? 'Buy ' : 'Sell ') + c.symbol.toUpperCase();
  btn.classList.toggle('sell', side === 'sell');
  renderPreview();
}

function renderPreview() {
  const c = coins.get(selected);
  if (!c) return;
  const amount = parseFloat($('#amount').value);
  const h = state.holdings[selected];
  let t = side === 'buy' ? 'Cash available: ' + usd(state.cash) : (h ? `You own ${qtyFmt(h.qty)} ${c.symbol.toUpperCase()} (${usd(h.qty * c.current_price)})` : 'You don’t own this coin.');
  if (amount > 0) t += ` · ≈ ${qtyFmt(amount / c.current_price)} ${c.symbol.toUpperCase()}`;
  $('#preview').textContent = t;
}

function renderHoldings() {
  const entries = Object.entries(state.holdings);
  $('#no-hold').hidden = entries.length > 0;
  $('#holdings').innerHTML = entries.map(([id, h]) => {
    const v = holdingValue(id, h);
    const pl = v == null ? null : v - h.cost;
    return `<li data-id="${esc(id)}" tabindex="0">
      <div><b>${esc(h.name)}</b><small>${qtyFmt(h.qty)} ${esc(h.symbol.toUpperCase())}</small></div>
      <div class="h-r"><b>${v == null ? '…' : usd(v)}</b>
      <small class="${cls(pl)}">${pl == null ? '' : signedUsd(pl) + ' (' + pct((pl / h.cost) * 100) + ')'}</small></div>
    </li>`;
  }).join('');
}

function select(id) {
  if (!id) return;
  selected = id;
  if (!coins.has(id)) { const h = state.holdings[id]; if (h) return; }
  msg('');
  renderAll();
  if (window.innerWidth <= 920) window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ---------- events ---------- */
function rowHandler(e) {
  const el = e.target.closest('[data-id]');
  if (el && (e.type === 'click' || e.key === 'Enter')) select(el.dataset.id);
}
$('#rows').addEventListener('click', rowHandler);
$('#rows').addEventListener('keydown', rowHandler);
$('#holdings').addEventListener('click', rowHandler);
$('#holdings').addEventListener('keydown', rowHandler);
$('#search').addEventListener('input', onSearch);
$('#amount').addEventListener('input', renderPreview);
$('#submit').addEventListener('click', trade);
$('#tab-buy').addEventListener('click', () => { side = 'buy'; msg(''); renderTrade(); });
$('#tab-sell').addEventListener('click', () => { side = 'sell'; msg(''); renderTrade(); });
document.querySelectorAll('.quick button').forEach((b) => b.addEventListener('click', () => quickFill(Number(b.dataset.pct))));
$('#more').addEventListener('click', async () => {
  page++;
  $('#more').disabled = true;
  try { await loadPage(page); renderAll(); } catch (e) { page--; setStatus(e.message, 'err'); }
  $('#more').disabled = false;
});
$('#reset').addEventListener('click', () => {
  if (!confirm('Reset your portfolio to $100 and remove all coins?')) return;
  state = { cash: START_CASH, deposited: START_CASH, holdings: {} };
  saveState();
  msg('');
  renderAll();
});

const dlg = $('#add-dialog');
$('#add-money').addEventListener('click', () => { $('#add-msg').textContent = ''; dlg.showModal(); $('#add-amount').select(); });
document.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => { $('#add-amount').value = b.dataset.add; }));
$('#add-confirm').addEventListener('click', (e) => {
  e.preventDefault();
  const amt = parseFloat($('#add-amount').value);
  if (!(amt > 0)) return ($('#add-msg').textContent = 'Enter an amount above $0.');
  if (amt > 1e7) return ($('#add-msg').textContent = 'The most you can add at once is $10,000,000.');
  state.cash += amt;
  state.deposited += amt;
  saveState();
  dlg.close();
  renderAll();
  msg('Added ' + usd(amt) + ' to your cash.', 'ok');
});

/* Ad slot: put your own logic in here (open a link, track a click, swap the text, etc.) */
function onAdClick() {
  // TODO: handle the ad click
}
$('#ad-btn')?.addEventListener('click', onAdClick);

/* ---------- start ---------- */
renderAll();
refresh();
setInterval(tick, 1000);
window.addEventListener('online', refresh);                       // internet came back: reconnect now
document.addEventListener('visibilitychange', () => {            // came back to the tab: catch up now
  if (!document.hidden && nextRefreshAt && onlineNow() >= nextRefreshAt) refresh();
}); 
