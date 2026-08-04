/* Harvester web interface — vanilla JS, no build step, no external requests. */
'use strict';

/* ─────────────────────────────── plumbing ─────────────────────────────── */

const TOKEN = window.HARVEST_TOKEN;

/** Every API call goes through here so the session token is never forgotten. */
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      'x-harvest-token': TOKEN,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* some endpoints legitimately return nothing */
  }

  if (!res.ok) {
    const error = new Error(payload?.error || `${res.status} ${res.statusText}`);
    error.issues = payload?.issues;
    error.status = res.status;
    throw error;
  }
  return payload;
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function toast(message, kind = 'ok', ms = 4200) {
  const node = el('div', { class: `toast ${kind}`, text: message });
  $('#toasts').append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .25s';
    setTimeout(() => node.remove(), 250);
  }, ms);
}

const fmtNum = (n) => (typeof n === 'number' ? n.toLocaleString() : n ?? '—');

function fmtDuration(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function fmtAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/* ──────────────────────────────── state ──────────────────────────────── */

const state = {
  boot: null,
  view: 'inspect',
  recipe: { name: null, text: '', saved: true },
  analysis: null,
  run: { id: null, source: null, columns: [], rows: [], logs: [] },
};

/* ──────────────────────────────── views ──────────────────────────────── */

function showView(name) {
  state.view = name;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name !== 'run' && state.run.source) closeStream();
  document.title = name === 'editor' && state.recipe.name
    ? `${state.recipe.name} — Harvester`
    : 'Harvester';
}

/* ─────────────────────────────── sidebar ─────────────────────────────── */

async function refreshRecipes(select) {
  const recipes = await api('GET', '/api/recipes').catch(() => []);
  state.boot && (state.boot.recipes = recipes);
  const list = $('#recipe-list');
  list.textContent = '';

  if (recipes.length === 0) {
    list.append(el('div', { class: 'empty-hint' }, 'No recipes yet. Inspect a page or press + to create one.'));
    return;
  }

  for (const recipe of recipes) {
    const active = recipe.name === (select ?? state.recipe.name);
    list.append(el('button', {
      class: `recipe-item ${active ? 'active' : ''} ${recipe.valid ? '' : 'invalid'}`,
      title: recipe.valid ? (recipe.startUrl || recipe.name) : recipe.error,
      onclick: () => openRecipe(recipe.name),
    },
      el('div', { class: 'r-name', text: recipe.name }),
      el('div', { class: 'r-sub', text: recipe.startUrl || recipe.title || '—' }),
    ));
  }
}

async function refreshRuns() {
  const runs = await api('GET', '/api/runs').catch(() => []);
  const active = runs.filter((r) => r.status === 'running' || r.status === 'starting').length;
  const badge = $('#runs-badge');
  badge.hidden = active === 0;
  badge.textContent = active;

  const container = $('#runs-list');
  container.textContent = '';

  if (runs.length === 0) {
    container.append(el('div', { class: 'empty-state' },
      el('div', { class: 'big', text: '📊' }),
      el('h2', { text: 'No runs yet' }),
      el('p', { text: 'Open a recipe and press Run — progress and results appear here.' }),
    ));
    return;
  }

  for (const run of runs) {
    container.append(el('div', { class: 'run-card', onclick: () => openRun(run.id) },
      el('div', { class: `dot ${run.status}` }),
      el('div', { class: 'grow' },
        el('div', { class: 'run-name', text: run.name }),
        el('div', { class: 'run-meta', text:
          `${run.status} · ${fmtAgo(run.startedAt)} · ${fmtDuration(run.durationMs)}` +
          (run.error ? ` · ${run.error}` : '') }),
      ),
      el('div', { class: 'run-nums' },
        el('div', {},
          el('div', { class: 'run-num-value', text: fmtNum(run.items) }),
          el('div', { class: 'run-num-label', text: 'items' })),
        el('div', {},
          el('div', { class: 'run-num-value', text: fmtNum(run.pages) }),
          el('div', { class: 'run-num-label', text: 'pages' })),
        run.failed > 0 ? el('div', {},
          el('div', { class: 'run-num-value', style: 'color:var(--danger)', text: fmtNum(run.failed) }),
          el('div', { class: 'run-num-label', text: 'failed' })) : null,
      ),
      el('button', {
        class: 'icon-btn', title: 'Delete this run',
        onclick: async (event) => {
          event.stopPropagation();
          await api('DELETE', `/api/runs/${run.id}`).catch((e) => toast(e.message, 'error'));
          refreshRuns();
        },
      }, '×'),
    ));
  }
}

/* ─────────────────────────────── inspect ─────────────────────────────── */

async function runInspect(url, render) {
  const button = $('#inspect-btn');
  const results = $('#inspect-results');
  button.disabled = true;
  button.innerHTML = '<span class="spinner"></span> Analyzing';
  results.hidden = false;
  results.textContent = '';
  results.append(el('div', { class: 'empty-state' },
    el('div', { class: 'spinner' }),
    el('p', { style: 'margin-top:10px', text: render ? 'Rendering the page in a browser…' : 'Fetching and analyzing…' }),
  ));

  try {
    const result = await api('POST', '/api/inspect', { url, render });
    if (result.blocked) {
      results.textContent = '';
      results.append(el('div', { class: 'card' },
        el('div', { class: 'card-head' }, 'Blocked by robots.txt'),
        el('div', { class: 'card-body' },
          el('p', { text: result.message }),
          el('p', { class: 'form-help', text:
            'This site asks crawlers not to fetch that URL. You can override it in a recipe, but only if you have another basis for access.' }),
        ),
      ));
      return;
    }
    state.analysis = result.analysis;
    renderAnalysis(result.analysis);
  } catch (error) {
    results.textContent = '';
    results.append(el('div', { class: 'card' },
      el('div', { class: 'card-head' }, 'Could not analyze this page'),
      el('div', { class: 'card-body' }, el('p', { text: error.message })),
    ));
  } finally {
    button.disabled = false;
    button.textContent = 'Analyze';
  }
}

function renderAnalysis(a) {
  const results = $('#inspect-results');
  results.textContent = '';

  const cards = el('div', { class: 'cards' });

  /* Overview */
  const jsPill = a.needsJavaScript
    ? el('span', { class: 'pill warn', text: 'JavaScript required' })
    : el('span', { class: 'pill ok', text: 'Static HTML is enough' });

  cards.append(el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('span', { text: a.title || '(no title)' }),
      el('span', { class: 'muted', text: `${(a.bytes / 1024).toFixed(1)} KB · HTTP ${a.status}` }),
    ),
    el('div', { class: 'card-body' },
      el('dl', { class: 'kv' },
        el('dt', { text: 'URL' }), el('dd', {}, el('code', { text: a.url })),
        el('dt', { text: 'JavaScript' }), el('dd', {}, jsPill,
          el('div', { class: 'form-help', text: a.javaScriptReason })),
        el('dt', { text: 'robots.txt' }), el('dd', {},
          a.robots
            ? el('span', { class: `pill ${a.robots.allowed ? 'ok' : 'danger'}`, text: a.robots.allowed ? 'allowed' : 'disallowed' })
            : el('span', { class: 'pill', text: 'not checked' }),
          a.robots?.crawlDelay != null ? el('span', { class: 'form-help', text: `Crawl-delay: ${a.robots.crawlDelay}s` }) : null),
        el('dt', { text: 'Links' }), el('dd', { text: `${a.links.total} (${a.links.internal} internal)` }),
      ),
    ),
  ));

  /* Structured data */
  const sd = a.structuredData;
  if (sd.hasStructuredData || sd.openGraph.length) {
    const body = el('div', { class: 'card-body' });
    body.append(el('p', { class: 'form-help', style: 'margin-bottom:10px', text:
      'Prefer these over CSS selectors — sites keep them working across redesigns because search engines read them.' }));
    for (const block of sd.jsonLd) {
      body.append(el('div', { class: 'block-row' },
        el('span', { class: 'pill accent', text: 'JSON-LD' }),
        el('div', { class: 'grow' },
          el('strong', { text: block.type }),
          el('div', { class: 'block-sample', text: block.keys.join(', ') })),
      ));
    }
    for (const block of sd.microdata) {
      body.append(el('div', { class: 'block-row' },
        el('span', { class: 'pill', text: 'Microdata' }),
        el('div', { class: 'grow' },
          el('strong', { text: block.type }),
          el('div', { class: 'block-sample', text: block.keys.join(', ') })),
      ));
    }
    if (sd.openGraph.length) {
      body.append(el('div', { class: 'block-row' },
        el('span', { class: 'pill', text: 'OpenGraph' }),
        el('div', { class: 'grow block-sample', text: sd.openGraph.join(', ') }),
      ));
    }
    cards.append(el('div', { class: 'card' }, el('div', { class: 'card-head' }, 'Structured data'), body));
  }

  /* Repeated blocks */
  if (a.repeatedBlocks.length) {
    const body = el('div', { class: 'card-body' });
    a.repeatedBlocks.forEach((block, i) => {
      body.append(el('div', { class: 'block-row' },
        el('span', { class: 'rank', text: i === 0 ? '★' : `#${i + 1}` }),
        el('div', { class: 'grow' },
          el('code', { class: 'sel', text: block.selector }),
          el('div', { class: 'block-sample', text: block.sampleText || '—' })),
        el('span', { class: 'muted mono', text: `×${block.count}` }),
      ));
    });
    cards.append(el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('span', { text: 'Repeated blocks' }),
        el('span', { class: 'muted', text: 'candidates for the item container' })),
      body,
    ));
  }

  /* Tables */
  if (a.tables.length) {
    const body = el('div', { class: 'card-body' });
    for (const table of a.tables.slice(0, 6)) {
      body.append(el('div', { class: 'block-row' },
        el('span', { class: 'pill', text: `${table.rows} rows` }),
        el('div', { class: 'grow block-sample', text: table.headers.join(' | ') || table.caption || '—' }),
      ));
    }
    cards.append(el('div', { class: 'card' }, el('div', { class: 'card-head' }, 'Tables'), body));
  }

  /* Suggested fields */
  const fields = a.suggestions.itemSelector ? a.suggestions.listFields : a.suggestions.detailFields;
  const names = Object.keys(fields);
  if (names.length) {
    const body = el('div', { class: 'card-body' });
    for (const name of names) {
      const spec = fields[name];
      const extras = [
        spec.attr ? `@${spec.attr}` : null,
        spec.transform ? `→ ${[].concat(spec.transform).join(', ')}` : null,
      ].filter(Boolean).join('  ');
      body.append(el('div', { class: 'block-row' },
        el('strong', { style: 'min-width:110px', text: name }),
        el('div', { class: 'grow' }, el('code', { class: 'sel', text: spec.selector })),
        el('span', { class: 'muted mono', text: extras }),
      ));
    }
    cards.append(el('div', { class: 'card' }, el('div', { class: 'card-head' }, 'Suggested fields'), body));
  }

  /* Pagination */
  if (a.pagination) {
    cards.append(el('div', { class: 'card' },
      el('div', { class: 'card-head' }, 'Pagination'),
      el('div', { class: 'card-body' },
        el('p', {}, 'Next page found via ', el('code', { class: 'sel', text: a.pagination.detectedBy })),
        el('div', { class: 'form-help', text: a.pagination.url }),
      ),
    ));
  }

  /* Call to action */
  cards.append(el('div', { class: 'card' },
    el('div', { class: 'card-body', style: 'display:flex;align-items:center;gap:14px;flex-wrap:wrap' },
      el('div', { class: 'grow' },
        el('strong', { text: 'Ready to build a recipe?' }),
        el('div', { class: 'form-help', text:
          'Harvester will write one using everything above. You can edit it before running.' })),
      el('button', { class: 'btn btn-primary', onclick: () => promptGenerate(a.url) }, 'Create recipe'),
    ),
  ));

  results.append(cards);
}

function promptGenerate(url) {
  let host = 'my-scraper';
  try {
    host = new URL(url).hostname.replace(/^www\./, '').split('.')[0];
  } catch { /* keep the default */ }

  openModal({
    title: 'Create recipe',
    okLabel: 'Create',
    body: (body) => {
      body.append(el('div', { class: 'form-row' },
        el('label', { text: 'File name' }),
        el('input', { type: 'text', id: 'gen-name', value: `${host}.yaml` }),
        el('div', { class: 'form-help', text: 'Saved into your workspace folder.' }),
      ));
      body.append(el('div', { class: 'form-row' },
        el('label', { class: 'checkbox' },
          el('input', { type: 'checkbox', id: 'gen-render', ...(state.analysis?.needsJavaScript ? { checked: true } : {}) }),
          ' Analyze with a browser (needed if the page renders with JavaScript)'),
      ));
    },
    onOk: async () => {
      const name = $('#gen-name').value.trim();
      const render = $('#gen-render').checked;
      if (!name) return false;
      try {
        const { yaml } = await api('POST', '/api/generate', { url, render, name });
        await api('PUT', `/api/recipes/${encodeURIComponent(name)}`, { text: yaml });
        await refreshRecipes(name);
        await openRecipe(name);
        toast(`Created ${name}`, 'ok');
      } catch (error) {
        toast(error.message, 'error');
        return false;
      }
      return true;
    },
  });
}

/* ──────────────────────────────── editor ─────────────────────────────── */

const editor = $('#editor');
const gutter = $('#editor-gutter');
let validateTimer = null;

function syncGutter() {
  const lines = editor.value.split('\n').length;
  gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
  gutter.scrollTop = editor.scrollTop;
}

editor.addEventListener('scroll', () => { gutter.scrollTop = editor.scrollTop; });

editor.addEventListener('input', () => {
  syncGutter();
  markDirty();
  clearTimeout(validateTimer);
  validateTimer = setTimeout(validateNow, 500);
});

// Tab indents; Enter keeps the current indentation. Anything less makes
// hand-editing YAML in a plain textarea genuinely unpleasant.
editor.addEventListener('keydown', (event) => {
  if (event.key === 'Tab') {
    event.preventDefault();
    const { selectionStart: start, selectionEnd: end, value } = editor;
    if (start !== end && value.slice(start, end).includes('\n')) {
      const from = value.lastIndexOf('\n', start - 1) + 1;
      const block = value.slice(from, end);
      const shifted = event.shiftKey
        ? block.replace(/^ {1,2}/gm, '')
        : block.replace(/^/gm, '  ');
      editor.setRangeText(shifted, from, end, 'select');
    } else {
      editor.setRangeText('  ', start, end, 'end');
    }
    syncGutter();
    markDirty();
  } else if (event.key === 'Enter') {
    const { selectionStart: start, value } = editor;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const indent = (value.slice(lineStart, start).match(/^\s*/) ?? [''])[0];
    if (indent) {
      event.preventDefault();
      editor.setRangeText(`\n${indent}`, start, editor.selectionEnd, 'end');
      syncGutter();
      markDirty();
    }
  }
});

function markDirty() {
  state.recipe.saved = false;
  const status = $('#editor-status');
  status.textContent = 'unsaved';
  status.className = 'pill warn';
}

function markSaved() {
  state.recipe.saved = true;
  const status = $('#editor-status');
  status.textContent = 'saved';
  status.className = 'pill ok';
}

async function openRecipe(name) {
  try {
    const recipe = await api('GET', `/api/recipes/${encodeURIComponent(name)}`);
    state.recipe = { name, text: recipe.text, saved: true };
    $('#editor-name').textContent = name;
    editor.value = recipe.text;
    editor.readOnly = recipe.editable === false;
    syncGutter();
    markSaved();
    renderValidation(recipe);
    $('#test-panel').hidden = true;
    showView('editor');
    refreshRecipes(name);
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function validateNow() {
  const isJs = /\.m?js$/i.test(state.recipe.name ?? '');
  const payload = isJs ? { name: state.recipe.name } : { text: editor.value };
  try {
    renderValidation(await api('POST', '/api/validate', payload));
  } catch (error) {
    renderValidation({ valid: false, errors: [error.message], warnings: [] });
  }
}

function renderValidation(result) {
  const body = $('#validation-body');
  body.textContent = '';

  if (result.valid) {
    body.append(el('div', { class: 'issue' },
      el('span', { class: 'issue-mark', style: 'color:var(--ok)', text: '✓' }),
      el('span', { text: 'Recipe is valid' })));
  } else {
    for (const issue of result.errors ?? []) {
      body.append(el('div', { class: 'issue error' },
        el('span', { class: 'issue-mark', text: '✗' }), el('span', { text: issue })));
    }
  }

  for (const warning of result.warnings ?? []) {
    body.append(el('div', { class: 'issue warn' },
      el('span', { class: 'issue-mark', text: '!' }), el('span', { text: warning })));
  }

  const s = result.summary;
  if (s) {
    const rows = [
      ['Start URLs', s.startUrls.length === 1 ? s.startUrls[0] : `${s.startUrls.length} URLs`],
      ['Item selector', s.itemSelector || '—'],
      ['Fields', s.fields.length ? s.fields.join(', ') : (s.labels.length ? `by label: ${s.labels.join(', ')}` : '—')],
      ['Rate', `${s.requestsPerSecond}/s · ${s.concurrency} workers`],
      ['robots.txt', s.robots ? 'enforced' : 'DISABLED'],
      ['Rendering', s.render],
      ['Page limit', s.maxPages ?? 'unlimited'],
      ['Output', s.outputs.length ? s.outputs.join(', ') : 'stdout'],
    ];
    const list = el('div', { class: 'summary-list', style: 'margin-top:12px' });
    for (const [key, value] of rows) {
      list.append(el('div', { class: 'summary-row' },
        el('span', { text: key }), el('span', { text: String(value) })));
    }
    body.append(list);
  }

  $('#btn-run').disabled = !result.valid;
  $('#btn-test').disabled = !result.valid;
}

async function saveRecipe() {
  if (!state.recipe.name) return;
  try {
    const result = await api('PUT', `/api/recipes/${encodeURIComponent(state.recipe.name)}`, { text: editor.value });
    state.recipe.text = editor.value;
    markSaved();
    renderValidation(result);
    refreshRecipes(state.recipe.name);
    toast(`Saved ${state.recipe.name}`, 'ok', 2000);
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function testRecipe() {
  const panel = $('#test-panel');
  const body = $('#test-body');
  panel.hidden = false;
  body.textContent = '';
  body.append(el('div', { class: 'empty-state' }, el('div', { class: 'spinner' }),
    el('p', { style: 'margin-top:10px', text: 'Fetching one page…' })));
  body.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  try {
    const render = $('#opt-render').value;
    const result = await api('POST', '/api/test', {
      text: editor.value,
      render: render === '' ? null : render !== 'never',
    });
    renderTestResult(result);
  } catch (error) {
    body.textContent = '';
    body.append(el('p', { style: 'color:var(--danger)', text: error.message }));
  }
}

function renderTestResult(result) {
  const body = $('#test-body');
  body.textContent = '';

  if (result.blocked) {
    body.append(el('p', { style: 'color:var(--danger)', text: result.message }));
    return;
  }

  body.append(el('div', { class: 'stat-grid' },
    stat('Page', result.title || result.url, `HTTP ${result.status}${result.rendered ? ' · rendered' : ''}`, true),
    stat('Records', fmtNum(result.itemCount)),
    result.containerSelector
      ? stat('Containers', fmtNum(result.containersMatched), result.containerSelector)
      : null,
  ));

  if (result.containerSelector && result.containersMatched === 0) {
    body.append(el('p', { style: 'color:var(--danger);margin-bottom:12px' },
      `Nothing matched "${result.containerSelector}". Inspect the page to find the right container.`));
  }

  if (result.coverage.length) {
    const wrap = el('div', { style: 'margin-bottom:14px' });
    wrap.append(el('div', { class: 'panel-head', style: 'border:0;padding:0 0 8px' }, 'Field coverage'));
    for (const field of result.coverage) {
      const cls = field.rate === 0 ? 'bad' : field.rate < 50 ? 'warn' : '';
      wrap.append(el('div', { class: 'coverage-row' },
        el('span', { class: 'coverage-name', text: field.field }),
        el('div', { class: 'coverage-track' },
          el('div', { class: `coverage-fill ${cls}`, style: `width:${field.rate}%` })),
        el('span', { class: 'coverage-num', text: `${field.rate}%  ${field.filled}/${field.total}` }),
      ));
    }
    body.append(wrap);
  }

  if (result.issues.length) {
    const wrap = el('div', { style: 'margin-bottom:14px' });
    wrap.append(el('div', { class: 'panel-head', style: 'border:0;padding:0 0 6px' }, 'Issues'));
    for (const issue of result.issues) {
      wrap.append(el('div', { class: 'issue warn' },
        el('span', { class: 'issue-mark', text: '!' }), el('span', { text: issue })));
    }
    body.append(wrap);
  }

  if (result.items.length) {
    body.append(buildTable(result.items.slice(0, 25)));
  } else {
    body.append(el('p', { style: 'color:var(--text-dim)', text:
      'No records extracted. Check the item selector and field selectors above.' }));
  }
}

function stat(label, value, sub, small) {
  return el('div', { class: 'stat' },
    el('div', { class: 'stat-label', text: label }),
    el('div', { class: `stat-value ${small ? 'sm' : ''}`, text: String(value ?? '—'), title: String(value ?? '') }),
    sub ? el('div', { class: 'stat-sub', text: sub, title: sub }) : null,
  );
}

/** Build a scrollable table from a list of records, inferring the columns. */
function buildTable(items, columnsHint) {
  const columns = columnsHint ?? [...new Set(items.flatMap((item) => Object.keys(item)))]
    .filter((c) => c !== '_scraped_at')
    .slice(0, 14);

  const thead = el('thead', {}, el('tr', {}, columns.map((c) => el('th', { text: c }))));
  const tbody = el('tbody', {}, items.map((item) => el('tr', {}, columns.map((column) => {
    const value = item[column];
    if (value == null || value === '') return el('td', {}, el('span', { class: 'cell null', text: '—' }));
    if (typeof value === 'number') return el('td', {}, el('span', { class: 'cell num', text: fmtNum(value) }));
    if (typeof value === 'boolean') return el('td', {}, el('span', { class: 'cell', text: value ? 'true' : 'false' }));
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return el('td', {}, el('span', { class: 'cell', text, title: text }));
  }))));

  return el('div', { class: 'table-scroll' }, el('table', {}, thead, tbody));
}

/* ──────────────────────────────── runs ───────────────────────────────── */

function collectOverrides() {
  const overrides = {};
  const limit = $('#opt-limit').value;
  const rps = $('#opt-rps').value;
  const concurrency = $('#opt-concurrency').value;
  const render = $('#opt-render').value;

  if (limit) overrides.max_pages = Number(limit);
  if (rps) overrides.rate_limit = { requests_per_second: Number(rps) };
  if (concurrency) overrides.concurrency = Number(concurrency);
  if (render) overrides.render = { mode: render };
  if ($('#opt-cache').checked) overrides.cache = { enabled: true };
  if ($('#opt-resume').checked) overrides.resume = { enabled: true };
  return overrides;
}

async function startRun() {
  if (!state.recipe.saved) await saveRecipe();
  const preset = $('#opt-preset').value;
  try {
    const run = await api('POST', '/api/runs', {
      text: editor.value,
      name: state.recipe.name,
      presets: preset ? [preset] : [],
      overrides: collectOverrides(),
    });
    toast(`Run started`, 'ok', 2000);
    openRun(run.id);
    refreshRuns();
  } catch (error) {
    toast(error.message, 'error', 7000);
  }
}

function closeStream() {
  if (state.run.source) {
    state.run.source.close();
    state.run.source = null;
  }
}

async function openRun(id) {
  closeStream();
  cancelPendingRows();
  state.run = { id, source: null, columns: [], rows: [], logs: [], liveCount: 0 };
  showView('run');

  $('#run-log').textContent = '';
  $('#run-table').textContent = '';
  $('#run-report').textContent = '';
  $('#tab-count-data').textContent = '0';
  selectTab('data');

  const source = new EventSource(`/api/runs/${id}/stream?token=${encodeURIComponent(TOKEN)}`);
  state.run.source = source;

  source.addEventListener('snapshot', (event) => {
    const snap = JSON.parse(event.data);
    $('#run-title').textContent = snap.name;
    $('#run-subtitle').textContent = snap.startUrls?.[0] ?? '';
    renderRunStats(snap);
    for (const record of snap.logs ?? []) appendLog(record);
    if (snap.items?.length) appendRows(snap.items);
    if (snap.report) renderReport(snap.report);
    if (snap.status !== 'running' && snap.status !== 'starting') loadRunData(id);
  });

  source.addEventListener('stats', (event) => renderRunStats({ stats: JSON.parse(event.data), status: 'running' }));
  source.addEventListener('item', (event) => appendRows([JSON.parse(event.data)]));
  source.addEventListener('log', (event) => appendLog(JSON.parse(event.data)));
  source.addEventListener('status', (event) => {
    const { status } = JSON.parse(event.data);
    $('#btn-stop').hidden = status !== 'running';
  });

  source.addEventListener('end', (event) => {
    const summary = JSON.parse(event.data);
    $('#btn-stop').hidden = true;
    renderRunStats({ ...summary, stats: summary.stats ?? null });
    if (summary.report) renderReport(summary.report);
    closeStream();
    refreshRuns();
    loadRunData(id);
    toast(
      summary.status === 'failed'
        ? `Run failed: ${summary.error ?? 'unknown error'}`
        : `Run finished — ${fmtNum(summary.items)} items in ${fmtDuration(summary.durationMs)}`,
      summary.status === 'failed' ? 'error' : 'ok',
      6000,
    );
  });

  source.onerror = () => closeStream();
}

/** Once a run finishes, load the full record set from disk. */
async function loadRunData(id) {
  // A batched flush scheduled moments ago would otherwise land on top of the
  // table we are about to replace, duplicating its rows.
  cancelPendingRows();
  try {
    const { items, total } = await api('GET', `/api/runs/${id}/data?limit=2000`);
    if (!items.length) return;
    if (state.run.id !== id) return; // the user navigated away mid-request
    cancelPendingRows();
    state.run.rows = items;
    state.run.liveCount = total;
    $('#tab-count-data').textContent = fmtNum(total);
    $('#run-table').textContent = '';
    $('#run-table').append(buildTable(items));
    if (total > items.length) {
      $('#run-table').append(el('div', { class: 'empty-hint', text:
        `Showing the first ${fmtNum(items.length)} of ${fmtNum(total)} records — download for the rest.` }));
    }
  } catch { /* a run with no data is fine */ }
}

function renderRunStats(snap) {
  const s = snap.stats ?? {};
  const grid = $('#run-stats');
  grid.textContent = '';

  const statusPill = {
    running: ['accent', 'running'], starting: ['accent', 'starting'],
    done: ['ok', 'finished'], failed: ['danger', 'failed'],
    stopped: ['warn', 'stopped'], stopping: ['warn', 'stopping'],
  }[snap.status] ?? ['', snap.status ?? ''];

  grid.append(
    stat('Status', statusPill[1], snap.error ?? '', true),
    stat('Items', fmtNum(s.items ?? snap.items ?? 0),
      s.duplicates ? `${fmtNum(s.duplicates)} duplicates skipped` : ''),
    stat('Pages', fmtNum(s.completed ?? snap.pages ?? 0),
      [s.rendered ? `${s.rendered} rendered` : null, s.cached ? `${s.cached} cached` : null].filter(Boolean).join(' · ')),
    stat('Queued', fmtNum(s.queued ?? 0), s.inFlight ? `${s.inFlight} in flight` : ''),
    stat('Failed', fmtNum(s.failed ?? snap.failed ?? 0), s.skipped ? `${s.skipped} skipped` : ''),
    stat('Rate', `${s.rps ?? 0}/s`, fmtDuration(snap.durationMs)),
  );

  $('#btn-stop').hidden = snap.status !== 'running';

  const progress = $('#run-progress');
  const done = s.completed ?? 0;
  const total = done + (s.queued ?? 0) + (s.inFlight ?? 0);
  if (total > 0 && snap.status === 'running') {
    progress.hidden = false;
    $('#run-progress-bar').style.width = `${Math.min(100, (done / total) * 100)}%`;
  } else {
    progress.hidden = true;
  }
}

let pendingRows = [];
let rowFlush = null;

/** Drop any batched rows still waiting to render — used before a full redraw. */
function cancelPendingRows() {
  clearTimeout(rowFlush);
  rowFlush = null;
  pendingRows = [];
}

function appendRows(items) {
  pendingRows.push(...items);
  state.run.liveCount = (state.run.liveCount ?? 0) + items.length;
  $('#tab-count-data').textContent = fmtNum(state.run.liveCount);
  // Batch DOM writes: a fast run can emit hundreds of records a second.
  if (rowFlush) return;
  rowFlush = setTimeout(() => {
    const batch = pendingRows;
    pendingRows = [];
    rowFlush = null;
    const container = $('#run-table');
    let table = container.querySelector('table');
    if (!table) {
      container.textContent = '';
      container.append(buildTable(batch));
      state.run.columns = [...new Set(batch.flatMap((i) => Object.keys(i)))].filter((c) => c !== '_scraped_at').slice(0, 14);
      return;
    }
    const tbody = table.querySelector('tbody');
    const fragment = buildTable(batch, state.run.columns).querySelector('tbody');
    tbody.prepend(...[...fragment.children].reverse());
    while (tbody.children.length > 400) tbody.lastChild.remove();
  }, 250);
}

function appendLog(record) {
  const log = $('#run-log');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;

  const meta = Object.entries(record)
    .filter(([k]) => !['time', 'level', 'msg', 'stack'].includes(k))
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' ');

  log.append(el('div', { class: 'log-line' },
    el('span', { class: 'log-time', text: (record.time ?? '').slice(11, 19) }),
    el('span', { class: `log-level ${record.level}`, text: (record.level ?? '').toUpperCase() }),
    el('span', { class: 'log-msg' }, record.msg ?? '', meta ? el('span', { class: 'log-meta', text: ` ${meta}` }) : null),
  ));

  while (log.children.length > 600) log.firstChild.remove();
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function renderReport(report) {
  const container = $('#run-report');
  container.textContent = '';

  const problems = (report.fieldHealth ?? []).filter((f) => f.status !== 'ok');
  if (problems.length) {
    const card = el('div', { class: 'card', style: 'margin-bottom:14px' },
      el('div', { class: 'card-head' }, 'Field health'),
      el('div', { class: 'card-body' }));
    const body = card.querySelector('.card-body');
    body.append(el('p', { class: 'form-help', style: 'margin-bottom:10px', text:
      'A field that is mostly empty usually means its selector stopped matching.' }));
    for (const field of problems) {
      body.append(el('div', { class: 'coverage-row' },
        el('span', { class: 'coverage-name', text: field.field }),
        el('div', { class: 'coverage-track' },
          el('div', { class: `coverage-fill ${field.status === 'broken' ? 'bad' : 'warn'}`, style: `width:${field.fillRate}%` })),
        el('span', { class: 'coverage-num', text: `${field.fillRate}%` }),
      ));
    }
    container.append(card);
  }

  if (report.warnings?.length) {
    const card = el('div', { class: 'card', style: 'margin-bottom:14px' },
      el('div', { class: 'card-head' }, 'Warnings'),
      el('div', { class: 'card-body' }));
    for (const warning of report.warnings) {
      card.querySelector('.card-body').append(el('div', { class: 'issue warn' },
        el('span', { class: 'issue-mark', text: '!' }), el('span', { text: warning })));
    }
    container.append(card);
  }

  if (report.failures?.length) {
    const card = el('div', { class: 'card', style: 'margin-bottom:14px' },
      el('div', { class: 'card-head' }, 'Failures'),
      el('div', { class: 'card-body' }));
    for (const group of report.failures) {
      card.querySelector('.card-body').append(el('div', { class: 'block-row' },
        el('span', { class: 'pill danger', text: `×${group.count}` }),
        el('div', { class: 'grow' },
          el('strong', { text: group.reason }),
          el('div', { class: 'block-sample', text: group.examples?.[0]?.url ?? '' })),
      ));
    }
    container.append(card);
  }

  container.append(el('div', { class: 'card' },
    el('div', { class: 'card-head' }, 'Full report'),
    el('div', { class: 'card-body' }, el('pre', { class: 'json', text: JSON.stringify(report, null, 2) })),
  ));
}

function selectTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
}

/* ──────────────────────────────── modal ──────────────────────────────── */

let modalOk = null;

function openModal({ title, body, okLabel = 'OK', onOk }) {
  $('#modal-title').textContent = title;
  $('#modal-ok').textContent = okLabel;
  const container = $('#modal-body');
  container.textContent = '';
  body(container);
  modalOk = onOk;
  $('#modal').hidden = false;
  setTimeout(() => container.querySelector('input, select, textarea')?.focus(), 30);
}

function closeModal() {
  $('#modal').hidden = true;
  modalOk = null;
}

const TEMPLATE_DESCRIPTIONS = {
  basic: 'A single page of repeated items',
  crawl: 'Listing pages → detail pages',
  spa: 'JavaScript-heavy sites',
  api: "A site's own JSON API",
  structured: 'JSON-LD structured data',
  tables: 'HTML tables',
};

function promptNewRecipe() {
  let selected = 'basic';
  openModal({
    title: 'New recipe',
    okLabel: 'Create',
    body: (body) => {
      body.append(el('div', { class: 'form-row' },
        el('label', { text: 'File name' }),
        el('input', { type: 'text', id: 'new-name', value: 'my-scraper.yaml' }),
      ));
      body.append(el('div', { class: 'form-row' },
        el('label', { text: 'Start from' }),
        el('div', { class: 'template-grid', id: 'template-grid' },
          (state.boot?.templates ?? []).map((name) => el('button', {
            class: `template-card ${name === selected ? 'selected' : ''}`,
            'data-template': name,
            onclick: (event) => {
              selected = name;
              $$('.template-card').forEach((c) => c.classList.toggle('selected', c.dataset.template === name));
              event.preventDefault();
            },
          },
            el('div', { class: 't-name', text: name }),
            el('div', { class: 't-desc', text: TEMPLATE_DESCRIPTIONS[name] ?? '' }),
          ))),
      ));
    },
    onOk: async () => {
      const name = $('#new-name').value.trim();
      if (!name) return false;
      try {
        const template = await api('GET', `/api/templates/${selected}`);
        const text = template.text.replace(/\{\{name\}\}/g, name.replace(/\.[^.]+$/, ''));
        await api('PUT', `/api/recipes/${encodeURIComponent(name)}`, { text });
        await refreshRecipes(name);
        await openRecipe(name);
        toast(`Created ${name}`, 'ok');
      } catch (error) {
        toast(error.message, 'error');
        return false;
      }
      return true;
    },
  });
}

/* ─────────────────────────────── wiring ──────────────────────────────── */

$$('.nav-item').forEach((button) => {
  button.addEventListener('click', () => {
    showView(button.dataset.view);
    if (button.dataset.view === 'runs') refreshRuns();
  });
});

$('#inspect-form').addEventListener('submit', (event) => {
  event.preventDefault();
  runInspect($('#inspect-url').value.trim(), $('#inspect-render').checked);
});

$$('#inspect-examples .link-btn').forEach((button) => {
  button.addEventListener('click', () => {
    $('#inspect-url').value = button.dataset.url;
    runInspect(button.dataset.url, false);
  });
});

$('#new-recipe-btn').addEventListener('click', promptNewRecipe);
$('#btn-save').addEventListener('click', saveRecipe);
$('#btn-test').addEventListener('click', testRecipe);
$('#btn-run').addEventListener('click', startRun);
$('#close-test').addEventListener('click', () => { $('#test-panel').hidden = true; });

$('#btn-delete').addEventListener('click', () => {
  if (!state.recipe.name) return;
  openModal({
    title: 'Delete recipe',
    okLabel: 'Delete',
    body: (body) => body.append(el('p', { text: `Delete ${state.recipe.name}? This cannot be undone.` })),
    onOk: async () => {
      await api('DELETE', `/api/recipes/${encodeURIComponent(state.recipe.name)}`);
      toast(`Deleted ${state.recipe.name}`, 'ok');
      state.recipe = { name: null, text: '', saved: true };
      await refreshRecipes();
      showView('inspect');
      return true;
    },
  });
});

$('#btn-stop').addEventListener('click', async () => {
  if (!state.run.id) return;
  await api('POST', `/api/runs/${state.run.id}/stop`).catch((e) => toast(e.message, 'error'));
  toast('Stopping — in-flight requests will finish', 'warn');
});

$('#btn-download').addEventListener('click', (event) => {
  event.stopPropagation();
  $('#download-menu').classList.toggle('open');
});
document.addEventListener('click', () => $('#download-menu').classList.remove('open'));

$$('#download-menu button').forEach((button) => {
  button.addEventListener('click', () => {
    if (!state.run.id) return;
    const url = `/api/runs/${state.run.id}/download?format=${button.dataset.format}&token=${encodeURIComponent(TOKEN)}`;
    window.location.assign(url);
  });
});

$$('.tab').forEach((tab) => tab.addEventListener('click', () => selectTab(tab.dataset.tab)));

$('#modal-cancel').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (event) => { if (event.target.id === 'modal') closeModal(); });
$('#modal-ok').addEventListener('click', async () => {
  const button = $('#modal-ok');
  button.disabled = true;
  try {
    if (!modalOk || (await modalOk()) !== false) closeModal();
  } finally {
    button.disabled = false;
  }
});

$('#theme-toggle').addEventListener('click', () => {
  const current = document.documentElement.dataset.theme;
  const next = current === 'dark' ? 'light' : current === 'light' ? '' : 'dark';
  if (next) document.documentElement.dataset.theme = next;
  else delete document.documentElement.dataset.theme;
  localStorage.setItem('harvest-theme', next);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('#modal').hidden) closeModal();
  if (!(event.ctrlKey || event.metaKey)) return;
  if (event.key === 's' && state.view === 'editor') { event.preventDefault(); saveRecipe(); }
  if (event.key === 'Enter' && state.view === 'editor') { event.preventDefault(); startRun(); }
});

window.addEventListener('beforeunload', (event) => {
  if (state.view === 'editor' && !state.recipe.saved) {
    event.preventDefault();
    event.returnValue = '';
  }
});

/* ──────────────────────────────── boot ───────────────────────────────── */

(async function boot() {
  const savedTheme = localStorage.getItem('harvest-theme');
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;

  try {
    state.boot = await api('GET', '/api/bootstrap');
  } catch (error) {
    document.body.innerHTML =
      `<div class="empty-state"><h2>Could not reach the Harvester server</h2><p>${error.message}</p>
       <p class="form-help">Open the interface using the URL printed by <code>harvest ui</code>.</p></div>`;
    return;
  }

  $('#brand-version').textContent = `v${state.boot.version}`;
  $('#workspace-path').textContent = state.boot.workspace;
  $('#workspace-path').title = state.boot.workspace;
  $('#engine-status').textContent = state.boot.playwright
    ? `Node ${state.boot.node} · rendering ready`
    : `Node ${state.boot.node} · rendering unavailable`;

  const presetSelect = $('#opt-preset');
  for (const preset of state.boot.presets) {
    presetSelect.append(el('option', { value: preset, text: preset }));
  }

  await refreshRecipes();
  await refreshRuns();
  showView('inspect');
  $('#inspect-url').focus();

  // Keep the runs badge live while a scrape is going.
  setInterval(() => {
    if (state.view !== 'run') refreshRuns();
  }, 5000);
})();
