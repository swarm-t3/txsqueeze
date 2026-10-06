// TxSqueeze: merge many small CSV rows into one per period, keeping the file's own format. Client-side only.
const ARB_RPC = 'https://arb1.arbitrum.io/rpc';
const PAY_TO = '0x36c37d1b47737ba2b2a2cf1b5bc38509516b222f';
const PRICE_UNITS = 19_000_000n; // 19.00 in 6-decimal stablecoins
const PAY_TOKENS = {
  '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': 'USDT',
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 'USDC',
};
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const CODE_HASHES = ['fbbce9fe069b54b0302cd2db1b6638809d6afc185764686659f5978c74857b39']; // sha256 of unlock codes sold via Whop
const FREE_ROWS = 300; // files this small are free

const $ = (id) => document.getElementById(id);
function track(name) {
  try { window.goatcounter && window.goatcounter.count({ path: 'event-' + name, title: name, event: true }); } catch (e) {}
}

// ---------- CSV ----------
function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(f); f = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const esc = (v) => { v = v == null ? '' : String(v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
const toCSV = (header, rows) => [header.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n');

// ---------- decimals (exact sums) ----------
const SCALE = 18n, TEN = 10n ** SCALE;
function toBig(s) {
  s = String(s ?? '').trim().replace(/[\s$€£]/g, '');
  if (s === '') return null;
  if (/e/i.test(s)) { const n = Number(s); if (!isFinite(n)) return null; s = n.toFixed(18); }
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const neg = s.startsWith('-'); s = s.replace(/^[+-]/, '');
  const [a, b = ''] = s.split('.');
  const v = BigInt(a || '0') * TEN + BigInt((b + '0'.repeat(18)).slice(0, 18));
  return neg ? -v : v;
}
function fromBig(v) {
  const neg = v < 0n; if (neg) v = -v;
  let a = (v / TEN).toString(), b = (v % TEN).toString().padStart(18, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + a + (b ? '.' + b : '');
}
const isNum = (s) => toBig(s) !== null;

// ---------- dates ----------
function parseDate(s) {
  s = String(s || '').trim();
  let m = s.match(/^(\d{2,4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) { let y = +m[1]; if (y < 100) y += 2000; return Date.UTC(y, m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)); }
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return Date.UTC(+m[3], m[1] - 1, +m[2], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)); // US order
  if (/^\d{10}(\.\d+)?$/.test(s)) return Math.round(+s * 1000);
  if (/^\d{13}$/.test(s)) return +s;
  const t = Date.parse(s.replace(' UTC', 'Z'));
  return isNaN(t) ? null : t;
}
function periodKey(ms, p) {
  const d = new Date(ms);
  if (p === 'month') return d.toISOString().slice(0, 7);
  if (p === 'week') { const dow = (d.getUTCDay() + 6) % 7; return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow)).toISOString().slice(0, 10); }
  return d.toISOString().slice(0, 10);
}

// ---------- presets ----------
const REWARD_RE = 'interest|reward|distribution|airdrop|launchpool|launchpad|cashback|commission|dividend|staking|bonus|rebate|mining|savings';
const PRESETS = {
  binance: {
    name: 'Binance transaction history',
    match: (h) => ['UTC_Time', 'Operation', 'Coin', 'Change'].every((c) => h.includes(c)),
    date: 'UTC_Time',
    roles: (h) => Object.fromEntries(h.map((c) => [c, c === 'Change' ? 'sum' : ['User_ID', 'Account', 'Operation', 'Coin'].includes(c) ? 'key' : 'last'])),
    filterCol: 'Operation',
    filterRe: REWARD_RE,
    exclude: /subscription|redemption|purchase|transfer|buy|sell|spend|revenue|fee|deposit|withdraw|convert/i,
  },
  koinly: {
    name: 'Koinly universal CSV',
    match: (h) => ['Date', 'Sent Amount', 'Sent Currency', 'Received Amount', 'Received Currency'].every((c) => h.includes(c)),
    date: 'Date',
    roles: (h) => Object.fromEntries(h.map((c) => [c,
      ['Sent Amount', 'Received Amount', 'Fee Amount', 'Net Worth Amount'].includes(c) ? 'sum'
        : ['Sent Currency', 'Received Currency', 'Fee Currency', 'Net Worth Currency', 'Label'].includes(c) ? 'key' : 'last'])),
    filterCol: '',
    filterRe: '',
    // leave one-sided unlabeled rows (own-wallet transfers) alone so Koinly can match them
    eligible: (r, idx) => {
      const lab = (r[idx['Label']] || '').trim();
      const sent = (r[idx['Sent Amount']] || '').trim(), recv = (r[idx['Received Amount']] || '').trim();
      return lab !== '' || (sent !== '' && recv !== '');
    },
    onMerge: (r, idx, n) => {
      if (idx['TxHash'] != null) r[idx['TxHash']] = '';
      if (idx['Description'] != null) r[idx['Description']] = `Merged ${n} rows (TxSqueeze)`;
    },
  },
};

let FILE = null; // {name, header, rows, preset}
let OUT = null;

function guessRoles(header, rows) {
  const sample = rows.slice(0, 200);
  const roles = {};
  header.forEach((c, i) => {
    const vals = sample.map((r) => r[i]).filter((v) => v != null && v !== '');
    const numeric = vals.length > 0 && vals.every(isNum);
    const uniq = new Set(vals).size;
    if (/(^|_|\s)(u?id|hash|txid|order ?id|trade ?id|uuid)($|_|\s|\()|remark|note|memo|description/i.test(c)) roles[c] = 'last';
    else if (/price|rate|avg/i.test(c) && numeric) roles[c] = 'avg';
    else if (/time|date/i.test(c)) roles[c] = 'last';
    else if (numeric) roles[c] = 'sum';
    else if (uniq > Math.max(30, sample.length * 0.5)) roles[c] = 'last';
    else roles[c] = 'key';
  });
  return roles;
}
function guessDateCol(header, rows) {
  const byName = header.find((c) => /date|time/i.test(c));
  if (byName) return byName;
  return header.find((c, i) => rows.slice(0, 20).every((r) => parseDate(r[i]) !== null)) || header[0];
}

function loadFile(name, text) {
  const all = parseCSV(text);
  if (all.length < 2) { $('status').innerHTML = '<span class="err">That file has no data rows.</span>'; return; }
  const header = all[0].map((h) => h.trim());
  const rows = all.slice(1).map((r) => { while (r.length < header.length) r.push(''); return r; });
  let preset = null;
  for (const [k, p] of Object.entries(PRESETS)) if (p.match(header)) { preset = k; break; }
  FILE = { name, header, rows, preset };
  const p = preset && PRESETS[preset];
  const roles = p ? p.roles(header) : guessRoles(header, rows);
  const dateCol = p ? p.date : guessDateCol(header, rows);
  $('detected').textContent = `${rows.length.toLocaleString()} rows · ${p ? 'detected: ' + p.name : 'generic CSV: check the column roles'}`;
  $('dateCol').innerHTML = header.map((c) => `<option ${c === dateCol ? 'selected' : ''}>${c}</option>`).join('');
  $('filterCol').innerHTML = '<option value="">(all rows)</option>' + header.map((c) => `<option ${p && c === p.filterCol ? 'selected' : ''}>${c}</option>`).join('');
  $('filterRe').value = p ? p.filterRe : '';
  $('cols').innerHTML = '<tr><th>Column</th><th>Example</th><th>Role</th></tr>' + header.map((c, i) => `<tr><td>${c}</td><td>${(rows[0][i] || '').slice(0, 40)}</td><td><select data-col="${c}">
    <option value="key" ${roles[c] === 'key' ? 'selected' : ''}>keep apart</option>
    <option value="sum" ${roles[c] === 'sum' ? 'selected' : ''}>sum</option>
    <option value="avg" ${roles[c] === 'avg' ? 'selected' : ''}>average</option>
    <option value="last" ${roles[c] === 'last' ? 'selected' : ''}>last value</option></select></td></tr>`).join('');
  $('setup').hidden = false; $('out').hidden = true;
  $('status').textContent = '';
  track('load-' + (preset || 'generic'));
  if (preset) squeeze(); // presets: show the result straight away
}

function squeeze() {
  const { header, rows, preset } = FILE;
  const p = preset && PRESETS[preset];
  const idx = Object.fromEntries(header.map((c, i) => [c, i]));
  const roles = {};
  document.querySelectorAll('#cols select').forEach((s) => (roles[s.dataset.col] = s.value));
  const dateI = idx[$('dateCol').value];
  const period = $('period').value;
  const fcol = $('filterCol').value, fre = $('filterRe').value.trim();
  let re = null;
  try { re = fre ? new RegExp(fre, 'i') : null; } catch (e) { $('status').innerHTML = '<span class="err">The filter is not a valid regular expression.</span>'; return; }
  const keyI = header.map((c, i) => (roles[c] === 'key' && i !== dateI ? i : -1)).filter((i) => i >= 0);
  const sumI = header.map((c, i) => ((roles[c] === 'sum' || roles[c] === 'avg') && i !== dateI ? i : -1)).filter((i) => i >= 0);
  const isAvg = sumI.map((i) => roles[header[i]] === 'avg');

  const out = []; const groups = new Map(); let badDates = 0, merged = 0;
  rows.forEach((r, n) => {
    const t = parseDate(r[dateI]);
    let ok = t !== null;
    if (t === null) badDates++;
    if (ok && fcol && re) ok = re.test(r[idx[fcol]] || '') && !(p && p.exclude && p.exclude.test(r[idx[fcol]] || ''));
    if (ok && p && p.eligible) ok = p.eligible(r, idx);
    if (!ok) { out.push({ t: t ?? 0, n, row: r }); return; }
    const k = periodKey(t, period) + '\u0001' + keyI.map((i) => r[i]).join('\u0001');
    let g = groups.get(k);
    if (!g) { g = { t, n, row: r.slice(), sums: sumI.map(() => 0n), cnt: 0, numeric: sumI.map(() => true) }; groups.set(k, g); out.push(g); }
    sumI.forEach((i, j) => { const v = toBig(r[i]); if (v === null) { if ((r[i] || '').trim() !== '') g.numeric[j] = false; } else g.sums[j] += v; });
    if (t >= g.t) { const keep = g.row; g.row = r.slice(); keyI.forEach((i) => (g.row[i] = keep[i])); g.t = t; }
    g.cnt++;
  });
  const result = out.map((o) => {
    if (!o.cnt) return o.row;
    const row = o.row.slice();
    sumI.forEach((i, j) => {
      if (!o.numeric[j] || (o.sums[j] === 0n && (row[i] || '').trim() === '')) return;
      row[i] = isAvg[j] ? fromBig(o.sums[j] / BigInt(o.cnt)) : fromBig(o.sums[j]);
    });
    if (o.cnt > 1) { merged += o.cnt - 1; p && p.onMerge && p.onMerge(row, idx, o.cnt); }
    return row;
  });
  OUT = { header, rows: result, before: rows.length };
  const tier = (n) => n <= 100 ? 'Newbie' : n <= 1000 ? 'Hodler' : n <= 3000 ? 'Trader' : n <= 10000 ? 'Pro' : `Pro + ${Math.ceil((n - 10000) / 1000)}k extra`;
  $('result').innerHTML = `<div class="big"><b>${rows.length.toLocaleString()}</b> rows → <b>${result.length.toLocaleString()}</b> rows <span class="muted">(${Math.round(100 * (1 - result.length / rows.length))}% fewer)</span></div>
    <p>Koinly plan by row count (if this file were your whole account): <b>${tier(rows.length)}</b> → <b>${tier(result.length)}</b>.</p>
    ${badDates ? `<p class="warn">${badDates} rows had a date this page couldn't read and were left as they are. Check the date column.</p>` : ''}
    ${merged === 0 ? '<p class="warn">Nothing was merged. Check the filter and the keep-apart columns.</p>' : ''}`;
  $('pvinfo').textContent = 'first 20 rows';
  $('preview').innerHTML = '<tr>' + header.map((c) => `<th>${c}</th>`).join('') + '</tr>' + result.slice(0, 20).map((r) => '<tr>' + r.map((v) => `<td>${v}</td>`).join('') + '</tr>').join('');
  $('out').hidden = false;
  refreshLocks();
  track('squeezed');
}

// ---------- paywall ----------
const paidUnlock = () => localStorage.getItem('ts_unlocked');
const unlocked = () => paidUnlock() || (OUT && OUT.before <= FREE_ROWS);
function refreshLocks() {
  const u = !!unlocked();
  $('dl').classList.toggle('locked', !u);
  $('pay').hidden = u && !paidUnlock();
  if (paidUnlock()) $('paystatus').innerHTML = '<span class="ok">Unlocked on this browser. Thank you.</span>';
}
$('dl').onclick = () => {
  if (!OUT) return;
  if (!unlocked()) { track('paywall'); $('pay').scrollIntoView({ behavior: 'smooth' }); $('tx').focus(); return; }
  track('download');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([toCSV(OUT.header, OUT.rows)], { type: 'text/csv' }));
  a.download = FILE.name.replace(/\.csv$/i, '') + '-squeezed.csv'; a.click();
};
$('copy').onclick = () => { navigator.clipboard.writeText(PAY_TO); $('copy').textContent = 'copied'; track('copy-address'); };
async function rpc(method, params) {
  const r = await fetch(ARB_RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
}
$('verify').onclick = async () => {
  const tx = $('tx').value.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) { $('paystatus').innerHTML = '<span class="err">Paste the 66-character transaction hash.</span>'; return; }
  $('paystatus').textContent = 'Checking Arbitrum…'; track('verify-attempt');
  try {
    const rc = await rpc('eth_getTransactionReceipt', [tx]);
    if (!rc) { $('paystatus').innerHTML = '<span class="err">Transaction not found on Arbitrum One yet. Wait a few seconds and retry.</span>'; return; }
    if (rc.status !== '0x1') { $('paystatus').innerHTML = '<span class="err">That transaction failed on-chain.</span>'; return; }
    const to = '0x' + PAY_TO.slice(2).toLowerCase().padStart(64, '0');
    let paid = 0n, tok = '';
    for (const l of rc.logs) {
      const a = l.address.toLowerCase();
      if (PAY_TOKENS[a] && l.topics[0] === TRANSFER_TOPIC && l.topics[2] && l.topics[2].toLowerCase() === to) { paid += BigInt(l.data); tok = PAY_TOKENS[a]; }
    }
    if (paid >= PRICE_UNITS) { localStorage.setItem('ts_unlocked', tx); track('paid'); refreshLocks(); }
    else if (paid > 0n) $('paystatus').innerHTML = `<span class="err">Found ${Number(paid) / 1e6} ${tok}; the price is 19. Email us and we'll sort it out.</span>`;
    else $('paystatus').innerHTML = '<span class="err">No USDT/USDC transfer to the TxSqueeze address in that transaction.</span>';
  } catch (err) { $('paystatus').innerHTML = `<span class="err">${err.message}</span>`; }
};
async function sha256hex(t) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('');
}
$('redeem').onclick = async () => {
  const c = $('code').value.trim().toUpperCase();
  if (CODE_HASHES.includes(await sha256hex(c))) { localStorage.setItem('ts_unlocked', 'code:' + c); track('code-redeemed'); refreshLocks(); }
  else $('paystatus').innerHTML = '<span class="err">That code is not valid.</span>';
};

// ---------- wiring ----------
function readFile(f) {
  if (!f) return;
  $('status').textContent = `Reading ${f.name}…`;
  const r = new FileReader();
  r.onload = () => loadFile(f.name, r.result);
  r.readAsText(f);
}
$('file').onchange = (e) => readFile(e.target.files[0]);
const drop = $('drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); readFile(e.dataTransfer.files[0]); });
$('run').onclick = squeeze;
$('period').onchange = () => FILE && squeeze();
