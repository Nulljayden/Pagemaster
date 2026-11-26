/* Pagemaster web UI - plain JS, no build step. */
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const app = $('#app');

  const state = { user: null, permissions: {}, sitePermissions: {}, siteAccess: {}, ssoEnabled: false, system: null, page: 'sites', timer: null, term: null, filesPath: '/', directory: null };

  // ------------------------------------------------------------------ helpers
  async function api(method, url, body, opts = {}) {
    const init = { method, headers: { 'x-pagemaster': '1' }, credentials: 'same-origin' };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    const res = await fetch(url, init);
    if (res.status === 401 && !opts.allow401) { state.user = null; renderLogin(); throw new Error('Session expired'); }
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.text();
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
    return data;
  }

  function toast(msg, kind = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), kind === 'error' ? 7000 : 3500);
  }

  function can(p) { return state.user && (state.user.isAdmin || state.user.permissions.includes(p)); }
  function pageVisible(p) { return !p.perm || can(p.perm) || !!(p.alt && p.alt()); }
  async function directory() {
    if (!state.directory) state.directory = await api('GET', '/api/users/directory');
    return state.directory;
  }
  function fmtNum(n) {
    n = n || 0;
    if (n < 10000) return n.toLocaleString();
    if (n < 1e6) return (n / 1000).toFixed(n < 1e5 ? 1 : 0).replace(/\.0$/, '') + 'K';
    return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  }

  function modal(html, { wide = false, onMount } = {}) {
    const root = $('#modal-root');
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal ${wide ? 'wide' : ''}">${html}</div>`;
    root.appendChild(bg);
    const close = () => bg.remove();
    bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
    $$('[data-close]', bg).forEach((b) => b.addEventListener('click', close));
    const m = $('.modal', bg);
    if (onMount) onMount(m, close);
    const first = $('input, textarea, select', m);
    if (first) first.focus();
    return { el: m, close };
  }

  function confirmBox(text, okLabel = 'Delete') {
    return new Promise((resolve) => {
      modal(`<h2>Are you sure?</h2><p>${esc(text)}</p>
        <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn danger solid" id="ok">${esc(okLabel)}</button></div>`, {
        onMount: (m, close) => {
          $('#ok', m).onclick = () => { close(); resolve(true); };
          $$('[data-close]', m).forEach((b) => b.addEventListener('click', () => resolve(false)));
        },
      });
    });
  }

  function fmtTime(ts) { return ts ? new Date(ts).toLocaleString() : '—'; }
  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    const u = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
  }
  function formData(form) {
    const o = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === 'checkbox') {
        if (el.dataset.group) { (o[el.dataset.group] = o[el.dataset.group] || []); if (el.checked) o[el.dataset.group].push(el.value); }
        else o[el.name] = el.checked;
      } else o[el.name] = el.value;
    }
    return o;
  }

  // ------------------------------------------------------------------ login
  async function renderLogin() {
    clearInterval(state.timer);
    const params = new URLSearchParams(location.search);
    const err = params.get('error');
    const next = nextUrl();
    if (err) history.replaceState(null, '', next ? '/?next=' + encodeURIComponent(next) : '/');
    let pub = { sso: { enabled: false } };
    try { pub = await api('GET', '/api/public', undefined, { allow401: true }); } catch (_) {}
    app.innerHTML = `
      <div class="login-wrap"><div class="card login">
        <div class="brand"><div class="brand-logo">P</div>Pagemaster</div>
        <p class="muted" style="text-align:center;margin-top:0">Sign in to manage your sites</p>
        ${err ? `<div class="alert error">${esc(err)}</div>` : ''}
        <div id="login-err"></div>
        <form id="login-form">
          <label class="field"><span>Username</span><input type="text" name="username" autocomplete="username" required autofocus></label>
          <label class="field"><span>Password</span><input type="password" name="password" autocomplete="current-password" required></label>
          <button class="btn primary block" type="submit">Sign in</button>
        </form>
        ${next ? '<div class="alert info small">Sign in to open a private site.</div>' : ''}
        ${pub.sso.enabled ? `<div class="divider">or</div><a class="btn block" href="/auth/sso/login${next ? '?next=' + encodeURIComponent(next) : ''}">${esc(pub.sso.label)}</a>` : ''}
      </div></div>`;
    $('#login-form').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('POST', '/api/login', formData(e.target), { allow401: true });
        boot();
      } catch (ex) {
        $('#login-err').innerHTML = `<div class="alert error">${esc(ex.message)}</div>`;
      }
    };
  }

  // After signing in, continue to a private site that sent us here
  function nextUrl() {
    const n = new URLSearchParams(location.search).get('next') || '';
    return n.startsWith('/auth/site?') ? n : '';
  }

  // ------------------------------------------------------------------ shell
  const PAGES = [
    { id: 'sites', label: 'Sites', icon: '🌐', perm: 'sites.view', alt: () => state.siteAccess.view || can('sites.manage') },
    { id: 'files', label: 'Files', icon: '📁', perm: 'files.read', alt: () => state.siteAccess.files },
    { id: 'terminal', label: 'Terminal', icon: '⌨️', perm: 'terminal' },
    { id: 'tunnels', label: 'Tunnels', icon: '☁️', perm: 'tunnels.manage' },
    { id: 'credentials', label: 'Git Credentials', icon: '🔑', perm: 'credentials.manage' },
    { id: 'users', label: 'Users', icon: '👥', perm: 'users.manage' },
    { id: 'settings', label: 'Settings', icon: '⚙️', perm: 'settings.manage' },
    { id: 'account', label: 'My Account', icon: '👤', perm: null },
  ];

  async function boot() {
    try {
      const me = await api('GET', '/api/me', undefined, { allow401: true });
      state.user = me.user;
      state.permissions = me.permissions;
      state.sitePermissions = me.sitePermissions || {};
      state.siteAccess = me.siteAccess || {};
      state.ssoEnabled = !!me.ssoEnabled;
      state.directory = null;
      state.system = await api('GET', '/api/system');
    } catch (_) {
      return renderLogin();
    }
    if (nextUrl()) { location.href = nextUrl(); return; }
    renderShell();
    const qs = new URLSearchParams(location.search);
    if (qs.get('error')) toast(qs.get('error'), 'error');
    if (qs.get('notice')) toast(qs.get('notice'), 'ok');
    if (qs.has('error') || qs.has('notice')) history.replaceState(null, '', '/' + location.hash);
    const fromHash = location.hash.slice(1);
    const allowed = PAGES.filter(pageVisible);
    go(allowed.some((p) => p.id === fromHash) ? fromHash : allowed[0].id);
    if (state.user.mustChangePassword && !sessionStorage.getItem('pm-skip-pw')) passwordPrompt();
  }

  function renderShell() {
    const u = state.user;
    app.innerHTML = `
      <div class="layout">
        <aside class="sidebar">
          <div class="brand"><div class="brand-logo">P</div>Pagemaster</div>
          <nav class="nav">${PAGES.filter(pageVisible).map((p) =>
            `<a href="#${p.id}" data-page="${p.id}"><span>${p.icon}</span><span>${p.label}</span></a>`).join('')}</nav>
          <div class="spacer"></div>
          <div class="userbox">
            <strong>${esc(u.displayName || u.username)}</strong>
            ${u.isAdmin ? 'Administrator' : (u.source === 'sso' ? 'SSO user' : 'User')}
            <div style="margin-top:8px"><button class="btn sm" id="logout">Sign out</button></div>
            <div class="small" style="margin-top:10px" title="Pagemaster version and image build">v${esc(state.system.version)} · build ${esc(state.system.build)}</div>
          </div>
        </aside>
        <main class="main" id="page"></main>
      </div>`;
    $$('.nav a').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); go(a.dataset.page); }));
    $('#logout').onclick = async () => { await api('POST', '/api/logout'); state.user = null; renderLogin(); };
  }

  function go(page) {
    clearInterval(state.timer);
    if (state.term) { state.term.dispose(); state.term = null; }
    state.page = page;
    history.replaceState(null, '', '#' + page);
    $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === page));
    const el = $('#page');
    el.innerHTML = '';
    ({ sites: pageSites, files: pageFiles, terminal: pageTerminal, tunnels: pageTunnels, credentials: pageCredentials, users: pageUsers, settings: pageSettings, account: pageAccount })[page](el);
  }

  function passwordPrompt() {
    modal(`<h2>Change the default password</h2>
      <div class="alert warn">You are using the default credentials. Change the password now to secure Pagemaster.</div>
      <form id="pw">
        <label class="field"><span>Current password</span><input type="password" name="current" required autocomplete="current-password"></label>
        <label class="field"><span>New password</span><input type="password" name="password" required minlength="8" autocomplete="new-password"><small>At least 8 characters.</small></label>
        <label class="field"><span>Confirm new password</span><input type="password" name="confirm" required autocomplete="new-password"></label>
        <div class="modal-foot"><button type="button" class="btn" data-close id="later">Later</button><button class="btn primary">Change password</button></div>
      </form>`, {
      onMount: (m, close) => {
        $('#later', m).addEventListener('click', () => sessionStorage.setItem('pm-skip-pw', '1'));
        $('#pw', m).onsubmit = async (e) => {
          e.preventDefault();
          const f = formData(e.target);
          if (f.password !== f.confirm) return toast('Passwords do not match', 'error');
          try {
            await api('POST', '/api/account/password', f);
            state.user.mustChangePassword = false;
            toast('Password changed', 'ok');
            close();
          } catch (ex) { toast(ex.message, 'error'); }
        };
      },
    });
  }

  // ------------------------------------------------------------------ sites
  // Base address for /<slug>/ links: Settings > Sites URL, else this host on the
  // published hosting port (no port shown when it is 80/443).
  function sitesBase() {
    const sys = state.system;
    if (sys.sitesUrl) return sys.sitesUrl.replace(/\/+$/, '');
    const port = sys.hostingPublicPort;
    const proto = port === 443 ? 'https:' : 'http:';
    const showPort = !(port === 80 || port === 443);
    return `${proto}//${location.hostname}${showPort ? ':' + port : ''}`;
  }

  // Ordered best-first
  function siteUrls(s) {
    const urls = [];
    for (const t of s.tunnelHosts || []) urls.push({ label: `Cloudflare tunnel "${t.tunnel}"`, url: `https://${t.hostname}/` });
    for (const d of s.domains || []) urls.push({ label: 'Custom domain', url: `http://${d}/` });
    if (state.system.sitesBaseDomain) urls.push({ label: 'Subdomain', url: `http://${s.slug}.${state.system.sitesBaseDomain}/` });
    urls.push({ label: 'Slug', url: `${sitesBase()}/${s.slug}/` });
    if (s.port) urls.push({ label: 'Dedicated port', url: `${location.protocol}//${location.hostname}:${s.port}/` });
    if (s.primaryUrl) {
      const norm = (u) => u.replace(/\/+$/, '').toLowerCase();
      const i = urls.findIndex((u) => norm(u.url) === norm(s.primaryUrl));
      const p = i >= 0 ? urls.splice(i, 1)[0] : { label: 'Custom address', url: s.primaryUrl };
      urls.unshift({ ...p, primary: true });
    }
    return urls;
  }

  // Preview uses the slug URL (works without any DNS)
  function previewUrl(s) {
    return `${sitesBase()}/${s.slug}/`;
  }

  async function pageSites(el) {
    const sys = state.system;
    el.innerHTML = `
      <div class="page-head">
        <div><h1>Sites</h1><p>Git repositories deployed as websites. Each site lives at <code>${esc(sitesBase())}/&lt;slug&gt;/</code></p></div>
        ${can('sites.manage') ? '<button class="btn primary" id="add-site">+ Add site</button>' : ''}
      </div>
      ${sys.storage && !sys.storage.ok ? `<div class="alert error"><b>Storage problem:</b> the /data volume can't run programs, so sites with install/build commands or App sites will fail (npm "Permission denied", exit code 126).<br>
        ${esc(sys.storage.problem)}<br><br>${esc(sys.storage.fix)}</div>` : ''}
      <div id="site-list" class="sites"><div class="muted">Loading…</div></div>`;
    if ($('#add-site')) $('#add-site').onclick = () => siteForm();
    const load = async () => {
      if (state.page !== 'sites') return;
      try { renderSiteList(await api('GET', '/api/sites')); } catch (e) { /* ignore poll errors */ }
    };
    await load();
    state.timer = setInterval(load, 4000);
  }

  function siteInfoHtml(s) {
    const status = s.deploying ? 'deploying' : (s.status || 'pending');
    const urls = siteUrls(s);
    const short = (u) => u.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const my = s.my || {};
    const st = s.stats7d || {};
    return `
        <div class="site-head">
          <h3>${esc(s.name)}</h3>
          <span class="badge ${esc(status)}">${esc(status)}</span>
          <span class="tag">${s.mode === 'node' ? 'App' : 'Static'}</span>
          ${s.access === 'private' ? '<span class="tag" title="Website: only signed-in Pagemaster users with access can open it">🔒 Private</span>' : '<span class="tag" title="Website: anyone with the address can open it">🌐 Public</span>'}
          ${s.panelVisibility === 'public' ? '<span class="tag" title="Every Pagemaster user can see this site in the panel">visible to all users</span>' : ''}
          ${s.autoPullMinutes ? `<span class="tag">auto-pull ${s.autoPullMinutes}m</span>` : ''}
          ${my.owner ? '' : `<span class="tag" title="Owner">👤 ${esc(s.ownerName)}</span>`}
          ${(s.members || []).length ? `<span class="tag" title="Shared with ${esc(s.members.map((m) => m.username).join(', '))}">shared · ${s.members.length}</span>` : ''}
        </div>
        <div class="site-meta">
          <div><span class="k">Address</span><a href="${esc(urls[0].url)}" target="_blank" rel="noopener" class="site-main-url">${esc(short(urls[0].url))}</a>${urls[0].primary ? ' <span class="tag" title="Primary address">primary</span>' : ''}${s.redirectToPrimary ? ' <span class="tag" title="Other addresses redirect here">redirects</span>' : ''}</div>
          ${urls.length > 1 ? `<div><span class="k">Also at</span>${urls.slice(1).map((u) => `<a class="tag" href="${esc(u.url)}" target="_blank" rel="noopener" title="${esc(u.label)}">${esc(short(u.url))}</a>`).join('')}</div>` : ''}
          <div><span class="k">Repo</span><span class="mono">${esc(s.repoUrl)}</span>${s.branch ? ` <span class="tag">${esc(s.branch)}</span>` : ''}</div>
          <div><span class="k">Commit</span>${esc(s.lastCommit || '—')} <span class="muted small">· ${fmtTime(s.lastDeploy)}</span></div>
          <div><span class="k">Last 7 days</span><a href="#" data-act="analytics">${fmtNum(st.visitors)} visitors · ${fmtNum(st.pageviews)} page views</a></div>
          ${s.lastError ? `<div class="err small">${esc(s.lastError)}</div>` : ''}
          ${s.status === 'waiting' ? `<div class="small">Waiting for the deploy key to be added to the repository.${my.manage ? ' <a href="#" data-act="deploykey">Show the key</a>' : ''}</div>` : ''}
        </div>
        <div class="row site-actions">
          <button class="btn sm" data-act="preview">👁 Preview</button>
          <button class="btn sm" data-act="analytics">📊 Analytics</button>
          ${can('tunnels.manage') && my.manage ? '<button class="btn sm" data-act="publish">☁ Publish</button>' : ''}
          ${my.deploy ? `<button class="btn sm" data-act="deploy">⟳ Pull &amp; deploy</button>
            ${s.enabled === false ? '<button class="btn sm" data-act="start">▶ Start</button>' : '<button class="btn sm" data-act="stop">■ Stop</button>'}` : ''}
          <button class="btn sm" data-act="log">Logs</button>
          ${my['files.read'] ? '<button class="btn sm" data-act="files">Files</button>' : ''}
          ${my.manage || my.share || my.transfer ? '<button class="btn sm" data-act="settings">⚙ Settings</button>' : ''}
        </div>`;
  }

  // Preview thumbnail: the real page, scaled down. Only reloaded when the site is
  // (re)deployed, started or stopped, never on the 4-second status refresh.
  function previewKey(s) { return [previewUrl(s), s.lastDeploy, s.enabled, s.status === 'live'].join('|'); }
  function thumbHtml(s) {
    if (s.enabled === false) return '<div class="thumb-empty">Stopped</div>';
    if (!s.lastDeploy) return '<div class="thumb-empty">Not deployed yet</div>';
    return `<iframe src="${esc(previewUrl(s))}" loading="lazy" tabindex="-1" referrerpolicy="origin"
      sandbox="allow-scripts allow-same-origin allow-forms" title="Preview of ${esc(s.name)}"></iframe>`;
  }

  function renderSiteList(list) {
    const box = $('#site-list');
    if (!box) return;
    box._sites = list;
    if (!list.length) {
      box.innerHTML = `<div class="card empty">${can('sites.manage') ? 'No sites yet. Click <b>+ Add site</b> to deploy a repository.' : 'No sites have been shared with you yet.'}</div>`;
      return;
    }
    if (!box.querySelector('.site')) box.innerHTML = '';
    const seen = new Set();
    list.forEach((s, i) => {
      seen.add(s.id);
      let card = box.querySelector(`.site[data-id="${CSS.escape(s.id)}"]`);
      if (!card) {
        card = document.createElement('div');
        card.className = 'card site';
        card.dataset.id = s.id;
        card.innerHTML = '<div class="site-thumb" title="Open preview"></div><div class="site-info"></div>';
        $('.site-thumb', card).onclick = () => siteAction('preview', box._sites.find((x) => x.id === s.id));
      }
      if (box.children[i] !== card) box.insertBefore(card, box.children[i] || null);
      const key = previewKey(s);
      if (card.dataset.pkey !== key) {
        card.dataset.pkey = key;
        $('.site-thumb', card).innerHTML = thumbHtml(s);
      }
      $('.site-info', card).innerHTML = siteInfoHtml(s);
      $$('[data-act]', card).forEach((b) => {
        b.onclick = (e) => { e.preventDefault(); siteAction(b.dataset.act, box._sites.find((x) => x.id === s.id)); };
      });
    });
    $$('.site', box).forEach((c) => { if (!seen.has(c.dataset.id)) box.removeChild(c); });
  }

  function showPreview(s) {
    const first = previewUrl(s);
    const urls = [{ url: first }, ...siteUrls(s).filter((u) => u.url !== first)];
    const sizes = { Desktop: '100%', Tablet: '820px', Phone: '390px' };
    modal(`<div class="row preview-bar">
        <h2 class="grow" style="margin:0">${esc(s.name)}</h2>
        <select id="pv-url" style="width:auto;max-width:340px">${urls.map((u) => `<option value="${esc(u.url)}">${esc(u.url.replace(/^https?:\/\//, ''))}</option>`).join('')}</select>
        <div class="seg">${Object.keys(sizes).map((k, i) => `<button class="btn sm ${i ? '' : 'on'}" data-size="${sizes[k]}">${k}</button>`).join('')}</div>
        <button class="btn sm" id="pv-reload" title="Reload">⟳</button>
        <a class="btn sm" id="pv-open" target="_blank" rel="noopener">Open ↗</a>
        <button class="btn sm" data-close>Close</button>
      </div>
      <div class="preview-stage"><iframe id="pv-frame" referrerpolicy="origin" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"></iframe></div>
      <p class="muted small" style="margin:8px 0 0">If the preview stays blank, the site may block embedding, or it is HTTP inside an HTTPS panel. Use <b>Open ↗</b>.</p>`, {
      wide: true,
      onMount: (m) => {
        m.classList.add('preview-modal');
        const frame = $('#pv-frame', m);
        const setUrl = () => { frame.src = $('#pv-url', m).value; $('#pv-open', m).href = $('#pv-url', m).value; };
        $('#pv-url', m).onchange = setUrl;
        $('#pv-reload', m).onclick = () => { frame.src = frame.src; };
        $$('[data-size]', m).forEach((b) => { b.onclick = () => {
          $$('[data-size]', m).forEach((x) => x.classList.toggle('on', x === b));
          frame.style.width = b.dataset.size;
        }; });
        setUrl();
      },
    });
  }

  async function siteAction(act, s) {
    try {
      if (act === 'deploy') { await api('POST', `/api/sites/${s.id}/deploy`); toast('Deploy started'); }
      if (act === 'start') { await api('POST', `/api/sites/${s.id}/start`); toast('Site started', 'ok'); }
      if (act === 'stop') { await api('POST', `/api/sites/${s.id}/stop`); toast('Site stopped'); }
      if (act === 'edit') siteForm(s);
      if (act === 'log') showLog(s);
      if (act === 'preview') { showPreview(s); return; }
      if (act === 'publish') { publishSite(s); return; }
      if (act === 'files') { state.filesPath = '/' + s.slug; go('files'); return; }
      if (act === 'webhook') showWebhook(s);
      if (act === 'analytics') { showAnalytics(s); return; }
      if (act === 'settings') { siteSettings(s); return; }
      if (act === 'addresses') { addressesForm(s); return; }
      if (act === 'visibility') { visibilityForm(s); return; }
      if (act === 'deploykey') { deployKeyModal(s); return; }
      if (act === 'share') { shareForm(s); return; }
      if (act === 'transfer') { transferForm(s); return; }
      if (act === 'delete') {
        if (!(await confirmBox(`Delete "${s.name}" and its cloned files? This cannot be undone.`))) return;
        await api('DELETE', `/api/sites/${s.id}`);
        toast('Site deleted');
      }
      if (state.page === 'sites') renderSiteList(await api('GET', '/api/sites'));
    } catch (e) { toast(e.message, 'error'); }
  }

  function showLog(s) {
    const m = modal(`<div class="row"><h2 class="grow" style="margin:0">Logs — ${esc(s.name)}</h2>
      <label class="check small"><input type="checkbox" id="follow" checked> Follow</label>
      <button class="btn sm" data-close>Close</button></div>
      <pre class="logbox mono" id="logbox" style="margin-top:12px">Loading…</pre>`, { wide: true });
    const load = async () => {
      if (!document.body.contains(m.el)) return clearInterval(t);
      try {
        const txt = await api('GET', `/api/sites/${s.id}/log`);
        const box = $('#logbox', m.el);
        box.textContent = txt || '(no log output yet)';
        if ($('#follow', m.el).checked) box.scrollTop = box.scrollHeight;
      } catch (_) {}
    };
    const t = setInterval(load, 2000);
    load();
  }

  function showWebhook(s) {
    modal(`<h2>Deploy webhook — ${esc(s.name)}</h2>
      <p class="muted">Add this URL as a <b>push</b> webhook in GitHub, GitLab, Gitea/Forgejo, Bitbucket etc. Every push will pull &amp; redeploy the site. It must be reachable from the git host (use your reverse proxy / Public URL).</p>
      <input type="text" readonly value="${esc(s.webhookUrl)}" id="wh" class="mono">
      <div class="modal-foot"><button class="btn danger" id="rotate">Regenerate secret</button><button class="btn" id="copy">Copy</button><button class="btn primary" data-close>Done</button></div>`, {
      onMount: (m, close) => {
        $('#copy', m).onclick = () => { navigator.clipboard.writeText($('#wh', m).value).then(() => toast('Copied', 'ok')); };
        $('#rotate', m).onclick = async () => {
          const r = await api('POST', `/api/sites/${s.id}/webhook/rotate`);
          $('#wh', m).value = r.webhookUrl;
          toast('Webhook secret regenerated — update it in your git host', 'ok');
        };
      },
    });
  }

  async function refreshSites() {
    if (state.page === 'sites') renderSiteList(await api('GET', '/api/sites'));
  }

  // One place for everything that changes a site's setup
  function siteSettings(s) {
    const my = s.my || {};
    const item = (act, title, text, cls = '') => `<button class="btn block settings-item ${cls}" data-go="${act}"><b>${title}</b><span class="muted small">${text}</span></button>`;
    modal(`<h2>${esc(s.name)}: settings</h2>
      <p class="muted small" style="margin-top:0">Owner: <b>${esc(s.ownerName)}</b>${my.owner ? ' (you)' : ''}</p>
      <div class="settings-list">
        ${my.manage ? item('edit', 'Edit site', 'Repository, build and start commands, custom domains, port. Saving redeploys.') : ''}
        ${my.manage ? item('addresses', 'Primary address', 'Choose which URL is the main one, and optionally redirect the others to it.') : ''}
        ${my.manage ? item('visibility', 'Visibility', `Website: <b>${s.access === 'private' ? 'private' : 'public'}</b> · In Pagemaster: <b>${s.panelVisibility === 'public' ? 'all users' : 'private'}</b>`) : ''}
        ${my.manage ? item('deploykey', 'Deploy key', 'This site\'s own SSH key, to add as a read-only deploy key on the repository.') : ''}
        ${my.manage ? item('webhook', 'Deploy webhook', 'URL your git host calls on every push.') : ''}
        ${my.share ? item('share', 'Sharing', 'Give other users access to just this site.') : ''}
        ${my.transfer ? item('transfer', 'Transfer ownership', 'Hand the site to another user.') : ''}
        ${my.share ? item('delete', 'Delete site', 'Removes the site, its files and analytics.', 'danger') : ''}
      </div>
      <div class="modal-foot"><button class="btn" data-close>Close</button></div>`, {
      onMount: (m, close) => {
        $$('[data-go]', m).forEach((b) => { b.onclick = () => { close(); siteAction(b.dataset.go, s); }; });
      },
    });
  }

  function visibilityFields(s, canPanel = true) {
    const r = (name, val, cur, title, text) => `<label class="check"><input type="radio" name="${name}" value="${val}" ${cur === val ? 'checked' : ''} ${name === 'panelVisibility' && !canPanel ? 'disabled' : ''}> <span><b>${title}</b><br><span class="muted small">${text}</span></span></label>`;
    return `<div class="grid2">
      <div><h3>Website</h3>
        ${r('access', 'private', s.access || 'private', '🔒 Private', 'Visitors must sign in to Pagemaster and have access to this site.')}
        ${r('access', 'public', s.access || 'private', '🌐 Public', 'Anyone with the address can open it.')}</div>
      <div><h3>In Pagemaster</h3>
        ${r('panelVisibility', 'private', s.panelVisibility || 'private', 'Private', 'Only the owner, people it is shared with, and admins see it.')}
        ${r('panelVisibility', 'public', s.panelVisibility || 'private', 'All users', 'Every Pagemaster user can see it (status, logs, analytics), and open it if the website is private.')}</div>
    </div>`;
  }

  function visibilityForm(s) {
    const canPanel = !!(s.my && s.my.share);
    modal(`<h2>Visibility: ${esc(s.name)}</h2>
      <form id="vis-form">${visibilityFields(s, canPanel)}
        ${canPanel ? '' : '<p class="muted small">Only the owner or an admin can change who sees the site in Pagemaster.</p>'}
        <div class="alert info small">Private websites send visitors to Pagemaster to sign in${state.system && !state.system.publicUrl ? '. Set <b>Settings → Public URL</b> so that works from outside your network (tunnels, domains)' : ''}. Signing out of Pagemaster signs them out of private sites too.</div>
        <div class="modal-foot"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save</button></div>
      </form>`, {
      onMount: (m, close) => {
        $('#vis-form', m).onsubmit = async (e) => {
          e.preventDefault();
          const body = { access: $('[name=access]:checked', m).value };
          if (canPanel) body.panelVisibility = $('[name=panelVisibility]:checked', m).value;
          try { await api('PUT', `/api/sites/${s.id}/visibility`, body); toast('Visibility saved', 'ok'); close(); refreshSites(); }
          catch (ex) { toast(ex.message, 'error'); }
        };
      },
    });
  }

  // Where to add a deploy key, for the common hosts
  function deployKeyPage(repoUrl) {
    const m = String(repoUrl || '').match(/^(?:[\w.-]+@|ssh:\/\/[\w.-]+@|https?:\/\/)([^/:]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/);
    if (!m) return null;
    const [, host, repo] = m;
    if (host === 'github.com') return { url: `https://github.com/${repo}/settings/keys/new`, where: 'GitHub → repository → Settings → Deploy keys → Add deploy key' };
    if (host === 'gitlab.com') return { url: `https://gitlab.com/${repo}/-/settings/repository`, where: 'GitLab → project → Settings → Repository → Deploy keys' };
    if (host === 'bitbucket.org') return { url: `https://bitbucket.org/${repo}/admin/access-keys/`, where: 'Bitbucket → repository settings → Access keys' };
    if (host === 'codeberg.org') return { url: `https://codeberg.org/${repo}/settings/keys`, where: 'Codeberg → repository → Settings → Deploy keys' };
    return { url: '', where: 'your git host: repository settings → Deploy keys (Gitea/Forgejo/GitLab) ' };
  }

  async function deployKeyModal(s, first = false) {
    let k;
    try { k = await api('GET', `/api/sites/${s.id}/deploy-key`); } catch (e) { return toast(e.message, 'error'); }
    const page = deployKeyPage(s.repoUrl);
    modal(`<h2>${first ? 'One more step: add the deploy key' : 'Deploy key: ' + esc(s.name)}</h2>
      <p>${first ? 'Pagemaster made an SSH key just for this site. ' : ''}Add this public key to the repository as a <b>read-only deploy key</b>${page ? ` in <b>${esc(page.where)}</b>` : ''}. Leave "allow write access" off.</p>
      <textarea readonly rows="3" class="mono" id="dk">${esc(k.publicKey)}</textarea>
      <div class="row" style="margin-top:8px">
        <button class="btn" id="dk-copy">Copy key</button>
        ${page && page.url ? `<a class="btn" href="${esc(page.url)}" target="_blank" rel="noopener">Open deploy key settings ↗</a>` : ''}
        <button class="btn danger" id="dk-regen">Regenerate</button>
      </div>
      ${k.inUse ? `<p class="muted small">This site clones <span class="mono">${esc(s.repoUrl)}</span> with this key.</p>`
        : `<div class="alert info small">This site doesn't use its deploy key yet (it uses ${s.credentialId === 'none' ? 'no credentials' : s.credentialId === 'auto' ? 'a token matched by host, or the shared SSH key' : 'a git token'}). After adding the key, click <b>Use this key</b>. HTTPS repository URLs are switched to SSH automatically.</div>`}
      <div class="modal-foot"><button class="btn" data-close>Close</button>
        ${k.inUse ? '<button class="btn primary" id="dk-deploy">I\'ve added it: deploy now</button>' : '<button class="btn primary" id="dk-use">Use this key &amp; deploy</button>'}</div>`, {
      onMount: (m, close) => {
        $('#dk-copy', m).onclick = () => navigator.clipboard.writeText($('#dk', m).value).then(() => toast('Copied', 'ok'));
        $('#dk-regen', m).onclick = async () => {
          if (!(await confirmBox('Regenerate the key? The old one stops working, so replace it on the repository too.', 'Regenerate'))) return;
          try { $('#dk', m).value = (await api('POST', `/api/sites/${s.id}/deploy-key/regenerate`)).publicKey; toast('New key made: update it on the repository', 'ok'); } catch (e) { toast(e.message, 'error'); }
        };
        if ($('#dk-deploy', m)) $('#dk-deploy', m).onclick = async () => {
          try { await api('POST', `/api/sites/${s.id}/deploy`); toast('Deploy started'); close(); refreshSites(); } catch (e) { toast(e.message, 'error'); }
        };
        if ($('#dk-use', m)) $('#dk-use', m).onclick = async () => {
          try { await api('PUT', `/api/sites/${s.id}`, { credentialId: 'deploykey' }); toast('Switched to the deploy key, deploying', 'ok'); close(); refreshSites(); } catch (e) { toast(e.message, 'error'); }
        };
      },
    });
  }

  function addressesForm(s) {
    const urls = siteUrls({ ...s, primaryUrl: '' });
    const norm = (u) => (u || '').replace(/\/+$/, '').toLowerCase();
    const cur = norm(s.primaryUrl);
    const known = urls.some((u) => norm(u.url) === cur);
    modal(`<h2>Primary address: ${esc(s.name)}</h2>
      <p class="muted">The primary address is shown first everywhere in Pagemaster. Pick one of the site's addresses, or type another one (e.g. a reverse proxy URL).</p>
      <form id="addr-form">
        <label class="check"><input type="radio" name="pick" value="" ${!cur ? 'checked' : ''}> <span>Automatic <span class="muted small">(best available: tunnel, then domain, then slug)</span></span></label>
        ${urls.map((u) => `<label class="check"><input type="radio" name="pick" value="${esc(u.url)}" ${cur && norm(u.url) === cur ? 'checked' : ''}> <span><span class="mono">${esc(u.url)}</span> <span class="muted small">· ${esc(u.label)}</span></span></label>`).join('')}
        <label class="check"><input type="radio" name="pick" value="__custom" ${cur && !known ? 'checked' : ''}> <span>Other address</span></label>
        <input type="text" id="addr-custom" placeholder="https://www.example.com/" value="${cur && !known ? esc(s.primaryUrl) : ''}" style="margin:4px 0 12px">
        <label class="check"><input type="checkbox" name="redirectToPrimary" ${s.redirectToPrimary ? 'checked' : ''}> <span><b>Redirect the other addresses to the primary one</b> (301)</span></label>
        <div class="alert warn small">Only turn this on once the primary address works. Visitors on any other hostname are sent there, so a primary address that only works on your LAN would lock out visitors coming through a tunnel. Pagemaster's own previews are never redirected.</div>
        <div class="modal-foot"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save</button></div>
      </form>`, {
      onMount: (m, close) => {
        $('#addr-custom', m).oninput = () => { $('[value="__custom"]', m).checked = true; };
        $('#addr-form', m).onsubmit = async (e) => {
          e.preventDefault();
          const pick = $('[name=pick]:checked', m).value;
          const primaryUrl = pick === '__custom' ? $('#addr-custom', m).value.trim() : pick;
          try {
            await api('PUT', `/api/sites/${s.id}/primary`, { primaryUrl, redirectToPrimary: $('[name=redirectToPrimary]', m).checked });
            toast('Primary address saved', 'ok');
            close();
            refreshSites();
          } catch (ex) { toast(ex.message, 'error'); }
        };
      },
    });
  }

  async function shareForm(s) {
    let users;
    try { users = await directory(); } catch (e) { return toast(e.message, 'error'); }
    const perms = state.sitePermissions;
    let members = (s.members || []).map((m) => ({ ...m, perms: [...m.perms] }));
    modal(`<h2>Share "${esc(s.name)}"</h2>
      <p class="muted">These users get access to <b>this site only</b>, on top of their global permissions. The owner (<b>${esc(s.ownerName)}</b>) and admins always have full access.</p>
      <div id="mem-list"></div>
      <div class="row" style="margin-top:12px"><select id="mem-add" class="grow" style="width:auto"></select><button type="button" class="btn" id="mem-add-btn">+ Add user</button></div>
      <p class="muted small">${Object.entries(perms).map(([k, d]) => `<code>${esc(k)}</code>: ${esc(d)}`).join('<br>')}</p>
      <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="mem-save">Save</button></div>`, {
      wide: true,
      onMount: (m, close) => {
        const draw = () => {
          $('#mem-list', m).innerHTML = members.length ? `<table><thead><tr><th>User</th>${Object.keys(perms).map((k) => `<th class="center">${esc(k)}</th>`).join('')}<th></th></tr></thead><tbody>
            ${members.map((mm, i) => `<tr data-i="${i}"><td><b>${esc(mm.username)}</b></td>
              ${Object.keys(perms).map((k) => `<td class="center"><input type="checkbox" data-p="${esc(k)}" ${mm.perms.includes(k) ? 'checked' : ''} aria-label="${esc(k)}"></td>`).join('')}
              <td style="text-align:right"><button type="button" class="btn sm danger" data-rm>Remove</button></td></tr>`).join('')}
            </tbody></table>` : '<div class="empty">Not shared with anyone.</div>';
          $$('#mem-list tr[data-i]', m).forEach((tr) => {
            const mm = members[+tr.dataset.i];
            $$('[data-p]', tr).forEach((c) => { c.onchange = () => { mm.perms = $$('[data-p]', tr).filter((x) => x.checked).map((x) => x.dataset.p); }; });
            $('[data-rm]', tr).onclick = () => { members.splice(+tr.dataset.i, 1); draw(); };
          });
          const avail = users.filter((u) => u.id !== s.ownerId && !members.some((mm) => mm.userId === u.id));
          $('#mem-add', m).innerHTML = avail.length ? avail.map((u) => `<option value="${esc(u.id)}">${esc(u.username)}${u.displayName ? ' (' + esc(u.displayName) + ')' : ''}</option>`).join('') : '<option value="">No more users</option>';
        };
        $('#mem-add-btn', m).onclick = () => {
          const u = users.find((x) => x.id === $('#mem-add', m).value);
          if (!u) return;
          members.push({ userId: u.id, username: u.username, perms: ['view'] });
          draw();
        };
        $('#mem-save', m).onclick = async () => {
          try {
            await api('PUT', `/api/sites/${s.id}/members`, { members: members.map((mm) => ({ userId: mm.userId, perms: mm.perms })) });
            toast('Sharing saved', 'ok');
            close();
            refreshSites();
          } catch (ex) { toast(ex.message, 'error'); }
        };
        draw();
      },
    });
  }

  async function transferForm(s) {
    let users;
    try { users = (await directory()).filter((u) => u.id !== s.ownerId); } catch (e) { return toast(e.message, 'error'); }
    if (!users.length) return toast('There is no other user to transfer to', 'error');
    const mine = s.my && s.my.owner;
    modal(`<h2>Transfer "${esc(s.name)}"</h2>
      <p>The new owner gets full control of the site, including sharing, transferring and deleting it.</p>
      <form id="xfer-form">
        <label class="field"><span>New owner</span><select name="userId">${users.map((u) => `<option value="${esc(u.id)}">${esc(u.username)}${u.displayName ? ' (' + esc(u.displayName) + ')' : ''}</option>`).join('')}</select></label>
        <label class="check"><input type="checkbox" name="keepAccess" ${mine ? 'checked' : ''}> <span>Keep ${mine ? 'my' : `<b>${esc(s.ownerName)}</b>'s`} access to the site (as a member with every site permission)</span></label>
        <div class="modal-foot"><button type="button" class="btn" data-close>Cancel</button><button class="btn danger solid">Transfer</button></div>
      </form>`, {
      onMount: (m, close) => {
        $('#xfer-form', m).onsubmit = async (e) => {
          e.preventDefault();
          try {
            await api('POST', `/api/sites/${s.id}/transfer`, formData(e.target));
            toast('Ownership transferred', 'ok');
            close();
            refreshSites();
          } catch (ex) { toast(ex.message, 'error'); }
        };
      },
    });
  }

  // ------------------------------------------------------------------ analytics
  const flag = (cc) => /^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 127397 + c.charCodeAt(0))) : '';
  function niceMax(v) {
    if (v <= 4) return 4;
    const p = 10 ** Math.floor(Math.log10(v));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }
  const fmtDay = (d, long) => new Date(d + 'T12:00:00').toLocaleDateString(undefined, long ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' });

  // Single-series column chart with hover tooltip, drawn as inline SVG
  function columnChart(box, series, key, label) {
    const W = Math.max(280, box.getBoundingClientRect().width - 1);
    const H = 210;
    const padL = 44;
    const padB = 24;
    const padT = 10;
    const plotH = H - padT - padB;
    const max = niceMax(Math.max(0, ...series.map((d) => d[key])));
    const n = series.length;
    const slot = (W - padL) / n;
    const bw = Math.max(2, Math.min(24, slot - 2));
    const y = (v) => padT + plotH - (v / max) * plotH;
    const ticks = [0, max / 2, max];
    const every = Math.ceil(n / Math.max(2, Math.floor((W - padL) / 70)));
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(label)} per day">`;
    for (const t of ticks) {
      svg += `<line x1="${padL}" x2="${W}" y1="${y(t)}" y2="${y(t)}" class="ch-grid"/><text x="${padL - 6}" y="${y(t) + 4}" text-anchor="end" class="ch-axis">${fmtNum(t)}</text>`;
    }
    series.forEach((d, i) => {
      const x = padL + i * slot + (slot - bw) / 2;
      const h = (d[key] / max) * plotH;
      if (h > 0) {
        const r = Math.min(4, bw / 2, h);
        const top = padT + plotH - h;
        svg += `<path class="ch-bar" d="M${x},${padT + plotH}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${padT + plotH}Z"/>`;
      }
      if (i % every === 0 || i === n - 1 && n <= 14) svg += `<text x="${padL + i * slot + slot / 2}" y="${H - 6}" text-anchor="middle" class="ch-axis">${esc(fmtDay(d.date))}</text>`;
      svg += `<rect class="ch-hit" data-i="${i}" x="${padL + i * slot}" y="${padT}" width="${slot}" height="${plotH}"/>`;
    });
    svg += '</svg><div class="ch-tip" hidden></div>';
    box.innerHTML = svg;
    const tip = $('.ch-tip', box);
    $$('.ch-hit', box).forEach((r) => {
      r.onmouseenter = () => {
        const d = series[+r.dataset.i];
        $$('.ch-hit', box).forEach((x) => x.classList.toggle('on', x === r));
        tip.innerHTML = `<b>${esc(fmtDay(d.date, true))}</b><br>${fmtNum(d.uv)} visitors<br>${fmtNum(d.pv)} page views<br>${fmtNum(d.req)} requests · ${fmtSize(d.bytes)}`;
        tip.hidden = false;
        const cx = +r.getAttribute('x') + slot / 2;
        tip.style.left = Math.min(Math.max(0, cx - 80), W - 170) + 'px';
      };
    });
    box.onmouseleave = () => { tip.hidden = true; $$('.ch-hit', box).forEach((x) => x.classList.remove('on')); };
  }

  function topTable(title, rows, total, fmtKey = esc) {
    return `<div class="card an-top"><h3>${title}</h3>${rows.length ? `<table><tbody>${rows.map((r) => `<tr>
      <td class="an-key"><div class="an-fill" style="width:${total ? Math.max(1, Math.round(r.count / rows[0].count * 100)) : 0}%"></div><span>${fmtKey(r.key)}</span></td>
      <td class="an-num">${fmtNum(r.count)}</td></tr>`).join('')}</tbody></table>` : '<div class="muted small">No data yet</div>'}</div>`;
  }

  function showAnalytics(s) {
    let days = 30;
    let metric = 'uv';
    let data = null;
    const m = modal(`<div class="row preview-bar">
        <h2 class="grow" style="margin:0">Analytics: ${esc(s.name)}</h2>
        <div class="seg" id="an-days">${[7, 30, 90].map((d) => `<button class="btn sm ${d === days ? 'on' : ''}" data-d="${d}">${d} days</button>`).join('')}</div>
        <button class="btn sm" data-close>Close</button>
      </div>
      <div id="an-body"><div class="muted" style="padding:20px">Loading…</div></div>`, { wide: true });
    const el = m.el;
    const render = () => {
      const t = data.totals;
      const errs = t.status['4xx'] + t.status['5xx'];
      const tile = (label, value, note = '') => `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${value}</div>${note ? `<div class="stat-note">${note}</div>` : ''}</div>`;
      $('#an-body', el).innerHTML = `
        <div class="stats">
          ${tile('Visitors', fmtNum(t.visitors), 'unique per day')}
          ${tile('Page views', fmtNum(t.pageviews))}
          ${tile('Requests', fmtNum(t.requests), 'pages, assets, API')}
          ${tile('Bandwidth', fmtSize(t.bytes))}
          ${tile('Errors', t.requests ? ((errs / t.requests) * 100).toFixed(1) + '%' : '0%', `${fmtNum(t.status['4xx'])} 4xx · ${fmtNum(t.status['5xx'])} 5xx`)}
          ${tile('Bots', fmtNum(t.bots), 'not counted as visitors')}
        </div>
        <div class="card">
          <div class="row"><h3 class="grow" style="margin:0">${metric === 'uv' ? 'Visitors' : 'Page views'} per day</h3>
            <div class="seg" id="an-metric"><button class="btn sm ${metric === 'uv' ? 'on' : ''}" data-m="uv">Visitors</button><button class="btn sm ${metric === 'pv' ? 'on' : ''}" data-m="pv">Page views</button></div></div>
          <div class="chart" id="an-chart"></div>
          <details class="small"><summary>Show as table</summary>
            <table><thead><tr><th>Day</th><th class="an-num">Visitors</th><th class="an-num">Page views</th><th class="an-num">Requests</th><th class="an-num">Bandwidth</th></tr></thead><tbody>
            ${data.series.slice().reverse().map((d) => `<tr><td>${esc(fmtDay(d.date, true))}</td><td class="an-num">${fmtNum(d.uv)}</td><td class="an-num">${fmtNum(d.pv)}</td><td class="an-num">${fmtNum(d.req)}</td><td class="an-num">${fmtSize(d.bytes)}</td></tr>`).join('')}
            </tbody></table></details>
        </div>
        <div class="an-grid">
          ${topTable('Top pages', data.paths, t.pageviews, (k) => `<span class="mono">${esc(k)}</span>`)}
          ${topTable('Referrers', data.referrers, t.pageviews)}
          ${topTable('Countries', data.countries, t.pageviews, (k) => `${flag(k)} ${esc(k)}`)}
          ${topTable('Addresses used', data.hosts, t.pageviews, (k) => `<span class="mono">${esc(k)}</span>`)}
        </div>
        <p class="muted small">Counted by Pagemaster from the requests it serves: no cookies, no tracking script. Visitors are counted once per day (an anonymous daily hash of IP + browser), so the total adds up each day's visitors. Countries come from Cloudflare and only show for traffic through a tunnel or Cloudflare proxy. Previews in this panel are not counted.</p>
        ${s.my && s.my.manage ? '<div class="row"><button class="btn sm danger" id="an-reset">Reset analytics</button></div>' : ''}`;
      columnChart($('#an-chart', el), data.series, metric, metric === 'uv' ? 'Visitors' : 'Page views');
      $$('#an-metric [data-m]', el).forEach((b) => { b.onclick = () => { metric = b.dataset.m; render(); }; });
      if ($('#an-reset', el)) $('#an-reset', el).onclick = async () => {
        if (!(await confirmBox(`Delete all analytics for "${s.name}"?`, 'Reset'))) return;
        try { await api('DELETE', `/api/sites/${s.id}/analytics`); load(); } catch (e) { toast(e.message, 'error'); }
      };
    };
    const load = async () => {
      try { data = await api('GET', `/api/sites/${s.id}/analytics?days=${days}`); render(); } catch (e) { toast(e.message, 'error'); }
    };
    $$('#an-days [data-d]', el).forEach((b) => { b.onclick = () => {
      days = +b.dataset.d;
      $$('#an-days [data-d]', el).forEach((x) => x.classList.toggle('on', x === b));
      load();
    }; });
    load();
  }

  async function siteForm(s) {
    const editing = !!s;
    s = s || { mode: 'static', credentialId: 'auto', autoPullMinutes: 0, domains: [] };
    let creds = [];
    try { creds = await api('GET', '/api/credentials/options'); } catch (_) {}
    const sys = state.system;
    const range = sys.sitePortRange ? `${sys.sitePortRange[0]}-${sys.sitePortRange[1]}` : 'any';
    const used = sys.usedPorts.filter((p) => !editing || p.port !== s.port).map((p) => p.port);
    modal(`<h2>${editing ? 'Edit site' : 'Add site'}</h2>
      <form id="site-form">
        <div class="grid2">
          <label class="field"><span>Name</span><input type="text" name="name" value="${esc(s.name)}" required></label>
          <label class="field"><span>Slug</span><input type="text" name="slug" value="${esc(s.slug)}" placeholder="auto from name" pattern="[a-z0-9-]+">
            <small>The site's address: <b>${esc(sitesBase())}/<i>slug</i>/</b>. Must be unique.</small></label>
        </div>
        <label class="field"><span>Repository URL</span><input type="text" name="repoUrl" value="${esc(s.repoUrl)}" required placeholder="https://github.com/user/repo.git  or  git@gitlab.com:user/repo.git">
          <small>Any git host: GitHub, GitLab, Bitbucket, Gitea/Forgejo, Azure DevOps, self-hosted… HTTPS uses tokens, SSH uses the deploy key.</small></label>
        <div class="grid2">
          <label class="field"><span>Branch</span><input type="text" name="branch" value="${esc(s.branch)}" placeholder="default branch"></label>
          <label class="field"><span>Git credential</span><select name="credentialId">
            <option value="auto" ${s.credentialId === 'auto' ? 'selected' : ''}>Auto (match by host)</option>
            <option value="none" ${s.credentialId === 'none' ? 'selected' : ''}>None (public repo)</option>
            <option value="deploykey" ${s.credentialId === 'deploykey' ? 'selected' : ''}>Deploy key for this site (SSH)</option>
            ${creds.map((c) => `<option value="${esc(c.id)}" ${s.credentialId === c.id ? 'selected' : ''}>${esc(c.name)} (${esc(c.host)})</option>`).join('')}
          </select><small id="cred-help"></small></label>
        </div>
        <div class="grid2">
          <label class="field"><span>Type</span><select name="mode" id="mode">
            <option value="static" ${s.mode !== 'node' ? 'selected' : ''}>Static site (HTML / built files)</option>
            <option value="node" ${s.mode === 'node' ? 'selected' : ''}>App (runs a server process)</option>
          </select></label>
          <label class="field"><span>Publish / working directory</span><input type="text" name="subdir" value="${esc(s.subdir)}" placeholder="repo root, or e.g. dist, build, public">
            <small>Folder inside the repo to serve (static) or run in (app).</small></label>
        </div>
        <div class="grid2">
          <label class="field"><span>Install command</span><input type="text" name="installCommand" value="${esc(s.installCommand)}" placeholder="optional, e.g. npm ci"></label>
          <label class="field"><span>Build command</span><input type="text" name="buildCommand" value="${esc(s.buildCommand)}" placeholder="optional, e.g. npm run build"></label>
        </div>
        <label class="field" id="start-field"><span>Start command</span><input type="text" name="startCommand" value="${esc(s.startCommand)}" placeholder="e.g. node server.js  or  npm start">
          <small>Must listen on <code>$PORT</code> (assigned automatically, never shared with another site).</small></label>
        <label class="field"><span>Auto-pull every (minutes)</span><input type="number" name="autoPullMinutes" min="0" max="1440" value="${esc(s.autoPullMinutes || 0)}" style="max-width:160px">
          <small>0 = off. Redeploys only when there is a new commit.</small></label>
        <label class="field"><span>Environment variables</span><textarea name="env" rows="3" placeholder="KEY=value (one per line)">${esc(s.env)}</textarea>
          <small>Available to install/build/start commands.</small></label>
        <label class="check"><input type="checkbox" name="spa" ${s.spa ? 'checked' : ''}> <span>Single-page app — serve <code>index.html</code> for unknown paths (React/Vue router etc.)</span></label>
        ${editing ? '' : `<div class="card" style="padding:12px 14px;margin:12px 0">${visibilityFields(s)}</div>`}
        <details class="adv" ${(s.domains || []).length || s.port ? 'open' : ''}><summary>Advanced: custom domains &amp; dedicated port</summary>
          <label class="field"><span>Custom domains</span><input type="text" name="domains" value="${esc((s.domains || []).join(', '))}" placeholder="www.example.com, example.com">
            <small>Hostnames you point at this server yourself (DNS / reverse proxy). For Cloudflare, use the <b>Tunnels</b> page instead. Each domain can only belong to one site.${sys.sitesBaseDomain ? ` Also served at <b>${esc(s.slug || 'slug')}.${esc(sys.sitesBaseDomain)}</b>.` : ''}</small></label>
          <label class="field"><span>Dedicated port</span><input type="number" name="port" value="${esc(s.port || '')}" placeholder="optional, range ${range}" style="max-width:220px">
            <small>Not needed normally. Only if something must reach this site on its own port. Range ${range}.${used.length ? ' In use: ' + used.join(', ') : ''}</small></label>
        </details>
        <div id="site-err"></div>
        <div class="modal-foot"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">${editing ? 'Save &amp; redeploy' : 'Add &amp; deploy'}</button></div>
      </form>`, {
      onMount: (m, close) => {
        const toggle = () => { $('#start-field', m).style.display = $('#mode', m).value === 'node' ? '' : 'none'; };
        $('#mode', m).onchange = toggle;
        toggle();
        const cred = $('[name=credentialId]', m);
        const repo = $('[name=repoUrl]', m);
        const credHelp = () => {
          $('#cred-help', m).textContent = cred.value === 'deploykey'
            ? (editing ? 'Uses this site\'s own SSH key. HTTPS URLs are switched to SSH.' : 'Pagemaster makes an SSH key for this site and shows it after you click Add, so you can add it to the repository before the first deploy.')
            : '';
        };
        cred.onchange = credHelp;
        // SSH URLs on a new site: default to a per-site deploy key
        repo.addEventListener('input', () => {
          if (!editing && cred.value === 'auto' && /^(ssh:\/\/|[\w.-]+@[\w.-]+:)/.test(repo.value.trim())) { cred.value = 'deploykey'; credHelp(); }
        });
        credHelp();
        $('#site-form', m).onsubmit = async (e) => {
          e.preventDefault();
          const btn = $('button.primary', m);
          btn.disabled = true;
          try {
            const body = formData(e.target);
            if (!editing) {
              body.access = $('[name=access]:checked', m).value;
              body.panelVisibility = $('[name=panelVisibility]:checked', m).value;
            }
            let saved;
            if (editing) saved = await api('PUT', `/api/sites/${s.id}`, body);
            else saved = await api('POST', '/api/sites', body);
            state.system = await api('GET', '/api/system');
            close();
            if (!editing && saved.status === 'waiting') deployKeyModal(saved, true);
            else toast(editing ? 'Saved — redeploying' : 'Site added — deploying', 'ok');
            if (state.page === 'sites') renderSiteList(await api('GET', '/api/sites'));
          } catch (ex) {
            $('#site-err', m).innerHTML = `<div class="alert error" style="white-space:pre-wrap">${esc(ex.message)}</div>`;
          } finally { btn.disabled = false; }
        };
      },
    });
  }

  // ------------------------------------------------------------------ files
  async function pageFiles(el) {
    const w = can('files.write') || state.siteAccess.files;
    el.innerHTML = `
      <div class="page-head">
        <div><h1>Files</h1><p>Browse the cloned site folders.${can('files.read') ? '' : ' You see the sites shared with you.'}</p></div>
        ${w ? `<div class="row" id="file-tools">
          <button class="btn" id="new-folder">New folder</button>
          <button class="btn" id="new-file">New file</button>
          <label class="btn primary">Upload<input type="file" id="upload" multiple hidden></label>
        </div>` : ''}
      </div>
      <div class="card dropzone" id="filecard">
        <div class="crumbs" id="crumbs"></div>
        <div id="filelist" style="margin-top:10px"></div>
      </div>`;
    if (w) {
      $('#new-folder').onclick = async () => {
        const name = prompt('Folder name');
        if (!name) return;
        try { await api('POST', '/api/files/mkdir', { path: joinPath(state.filesPath, name) }); loadFiles(); } catch (e) { toast(e.message, 'error'); }
      };
      $('#new-file').onclick = () => editFile(null);
      $('#upload').onchange = (e) => uploadFiles(e.target.files);
      const card = $('#filecard');
      card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('drag'); });
      card.addEventListener('dragleave', () => card.classList.remove('drag'));
      card.addEventListener('drop', (e) => { e.preventDefault(); card.classList.remove('drag'); if (state.filesWritable) uploadFiles(e.dataTransfer.files); else toast('You cannot upload here', 'error'); });
    }
    loadFiles();
  }

  function joinPath(a, b) { return (a.replace(/\/+$/, '') + '/' + b).replace(/\/+/g, '/'); }

  async function uploadFiles(list) {
    if (!list || !list.length) return;
    const fd = new FormData();
    for (const f of list) fd.append('files', f);
    try {
      const r = await api('POST', '/api/files/upload?path=' + encodeURIComponent(state.filesPath), fd);
      toast(`Uploaded ${r.count} file(s)`, 'ok');
      loadFiles();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function loadFiles() {
    let data;
    try { data = await api('GET', '/api/files/list?path=' + encodeURIComponent(state.filesPath)); }
    catch (e) { toast(e.message, 'error'); state.filesPath = '/'; data = await api('GET', '/api/files/list?path=/'); }
    state.filesPath = data.path;
    state.filesWritable = !!data.writable;
    if ($('#file-tools')) $('#file-tools').style.visibility = data.writable ? '' : 'hidden';
    const parts = data.path.split('/').filter(Boolean);
    $('#crumbs').innerHTML = `<a href="#" data-p="/">sites</a>` + parts.map((p, i) =>
      ` / <a href="#" data-p="/${esc(parts.slice(0, i + 1).join('/'))}">${esc(p)}</a>`).join('');
    $$('#crumbs a').forEach((a) => a.onclick = (e) => { e.preventDefault(); state.filesPath = a.dataset.p; loadFiles(); });
    const w = data.writable;
    $('#filelist').innerHTML = data.entries.length ? `<table>
      <thead><tr><th>Name</th><th class="hide-sm">Size</th><th class="hide-sm">Modified</th><th></th></tr></thead>
      <tbody>
      ${parts.length ? '<tr><td colspan="4"><span class="file-name" data-up="1"><span class="ic">↩</span>..</span></td></tr>' : ''}
      ${data.entries.map((f) => `<tr data-name="${esc(f.name)}" data-dir="${f.dir ? 1 : 0}">
        <td><span class="file-name" data-open="1"><span class="ic">${f.dir ? '📁' : '📄'}</span>${esc(f.name)}</span></td>
        <td class="hide-sm muted">${f.dir ? '' : fmtSize(f.size)}</td>
        <td class="hide-sm muted">${fmtTime(f.mtime)}</td>
        <td style="text-align:right;white-space:nowrap">
          ${f.dir ? '' : '<button class="btn sm" data-a="dl">Download</button>'}
          ${w ? '<button class="btn sm" data-a="mv">Rename</button><button class="btn sm danger" data-a="rm">Delete</button>' : ''}
        </td></tr>`).join('')}
      </tbody></table>` : `<div class="empty">Empty folder${parts.length ? ' — <a href="#" id="up">go up</a>' : ''}</div>`;
    const up = () => { state.filesPath = '/' + parts.slice(0, -1).join('/'); loadFiles(); };
    if ($('#up')) $('#up').onclick = (e) => { e.preventDefault(); up(); };
    if ($('[data-up]')) $('[data-up]').onclick = up;
    $$('#filelist tr[data-name]').forEach((tr) => {
      const name = tr.dataset.name;
      const p = joinPath(state.filesPath, name);
      $('[data-open]', tr).onclick = () => {
        if (tr.dataset.dir === '1') { state.filesPath = p; loadFiles(); } else editFile(p);
      };
      $$('[data-a]', tr).forEach((b) => b.onclick = async () => {
        try {
          if (b.dataset.a === 'dl') location.href = '/api/files/download?path=' + encodeURIComponent(p);
          if (b.dataset.a === 'mv') {
            const nn = prompt('New name', name);
            if (!nn || nn === name) return;
            await api('POST', '/api/files/rename', { from: p, to: joinPath(state.filesPath, nn) });
            loadFiles();
          }
          if (b.dataset.a === 'rm') {
            if (!(await confirmBox(`Delete ${p}?`))) return;
            await api('DELETE', '/api/files/delete?path=' + encodeURIComponent(p));
            loadFiles();
          }
        } catch (e) { toast(e.message, 'error'); }
      });
    });
  }

  async function editFile(p) {
    let content = '';
    let w = state.filesWritable;
    if (p) {
      try { const r = await api('GET', '/api/files/read?path=' + encodeURIComponent(p)); content = r.content; w = r.writable; }
      catch (e) {
        if (confirm(e.message + '\n\nDownload it?')) location.href = '/api/files/download?path=' + encodeURIComponent(p);
        return;
      }
    }
    modal(`<div class="row" style="margin-bottom:10px">
        ${p ? `<h2 class="grow mono" style="margin:0">${esc(p)}</h2>` : `<input type="text" id="fname" class="grow" placeholder="file name, e.g. index.html" style="width:auto">`}
      </div>
      <textarea class="editor mono" id="editor" spellcheck="false" ${w ? '' : 'readonly'}>${esc(content)}</textarea>
      <div class="modal-foot"><button class="btn" data-close>Close</button>${w ? '<button class="btn primary" id="save">Save</button>' : ''}</div>`, {
      wide: true,
      onMount: (m, close) => {
        const ta = $('#editor', m);
        ta.addEventListener('keydown', (e) => {
          if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('  ', s, ta.selectionEnd, 'end'); }
          if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); $('#save', m) && $('#save', m).click(); }
        });
        if ($('#save', m)) $('#save', m).onclick = async () => {
          const target = p || ($('#fname', m).value.trim() && joinPath(state.filesPath, $('#fname', m).value.trim()));
          if (!target) return toast('Enter a file name', 'error');
          try {
            await api('PUT', '/api/files/write', { path: target, content: ta.value });
            toast('Saved', 'ok');
            if (!p) { close(); loadFiles(); }
          } catch (e) { toast(e.message, 'error'); }
        };
      },
    });
  }

  // ------------------------------------------------------------------ terminal
  function pageTerminal(el) {
    el.innerHTML = `
      <div class="page-head"><div><h1>Terminal</h1><p>Shell inside the Pagemaster container (starts in <code>/data/sites</code>).</p></div>
        <button class="btn" id="reconnect">Reconnect</button></div>
      <div class="term-wrap"><div id="term"></div></div>`;
    const connect = () => {
      if (state.term) state.term.dispose();
      const term = new window.Terminal({ cursorBlink: true, fontSize: 13, fontFamily: 'ui-monospace, Menlo, Consolas, monospace', theme: { background: '#0c1018' } });
      const fit = new window.FitAddon.FitAddon();
      term.loadAddon(fit);
      term.open($('#term'));
      fit.fit();
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/terminal`);
      const sendSize = () => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); };
      ws.onopen = () => { sendSize(); term.focus(); };
      ws.onmessage = (e) => term.write(e.data);
      ws.onclose = () => term.write('\r\n\x1b[33m[disconnected — click Reconnect]\x1b[0m\r\n');
      term.onData((d) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data: d })); });
      const onResize = () => { try { fit.fit(); sendSize(); } catch (_) {} };
      window.addEventListener('resize', onResize);
      const origDispose = term.dispose.bind(term);
      term.dispose = () => { window.removeEventListener('resize', onResize); try { ws.close(); } catch (_) {} origDispose(); };
      state.term = term;
    };
    $('#reconnect').onclick = connect;
    connect();
  }

  // ------------------------------------------------------------------ credentials
  const PROVIDERS = {
    github: { label: 'GitHub', host: 'github.com', username: 'x-access-token', help: 'Personal access token (classic: <b>repo</b> scope, or fine-grained: <b>Contents: read</b>).' },
    gitlab: { label: 'GitLab', host: 'gitlab.com', username: 'oauth2', help: 'Personal/project access token with <b>read_repository</b>.' },
    bitbucket: { label: 'Bitbucket', host: 'bitbucket.org', username: 'x-token-auth', help: 'Repository/workspace access token. For an App password, put your Bitbucket username instead.' },
    gitea: { label: 'Gitea / Forgejo / Codeberg', host: 'codeberg.org', username: '', help: 'Use your username and an access token with repository read access. Change host for self-hosted.' },
    azure: { label: 'Azure DevOps', host: 'dev.azure.com', username: 'pat', help: 'Personal access token with Code (Read).' },
    other: { label: 'Other / self-hosted', host: '', username: '', help: 'Any HTTPS git server that accepts username + token/password (Basic auth).' },
  };

  async function pageCredentials(el) {
    el.innerHTML = `
      <div class="page-head"><div><h1>Git Credentials</h1><p>Tokens for private repositories. Stored encrypted on the /data volume.</p></div>
        <button class="btn primary" id="add-cred">+ Add token</button></div>
      <div class="card" id="cred-list">Loading…</div>
      <div class="card">
        <h2>SSH deploy key</h2>
        <p class="muted">For <code>git@host:owner/repo.git</code> or <code>ssh://</code> URLs on any git server. Add the public key as a read-only <b>deploy key</b> on the repository (or to your account).</p>
        <div id="ssh-box"></div>
      </div>`;
    $('#add-cred').onclick = () => credForm();
    loadCreds();
    loadSsh();
  }

  async function loadCreds() {
    const list = await api('GET', '/api/credentials');
    $('#cred-list').innerHTML = list.length ? `<table><thead><tr><th>Name</th><th>Host</th><th class="hide-sm">Username</th><th class="hide-sm">Added</th><th></th></tr></thead><tbody>
      ${list.map((c) => `<tr data-id="${esc(c.id)}"><td>${esc(c.name)}</td><td class="mono">${esc(c.host)}</td><td class="hide-sm mono">${esc(c.username)}</td>
        <td class="hide-sm muted">${fmtTime(c.createdAt)}</td>
        <td style="text-align:right"><button class="btn sm" data-a="edit">Edit</button><button class="btn sm danger" data-a="rm">Delete</button></td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">No tokens yet. Public repos work without one.</div>';
    $$('#cred-list tr[data-id]').forEach((tr) => {
      const c = list.find((x) => x.id === tr.dataset.id);
      $('[data-a=edit]', tr).onclick = () => credForm(c);
      $('[data-a=rm]', tr).onclick = async () => {
        if (!(await confirmBox(`Delete credential "${c.name}"?`))) return;
        await api('DELETE', `/api/credentials/${c.id}`);
        loadCreds();
      };
    });
  }

  async function loadSsh() {
    const r = await api('GET', '/api/ssh');
    $('#ssh-box').innerHTML = r.publicKey
      ? `<textarea readonly rows="3" class="mono" id="sshkey">${esc(r.publicKey)}</textarea>
         <div class="row" style="margin-top:8px"><button class="btn" id="copy-ssh">Copy</button><button class="btn danger" id="gen-ssh">Regenerate</button></div>`
      : '<button class="btn primary" id="gen-ssh">Generate SSH key</button>';
    if ($('#copy-ssh')) $('#copy-ssh').onclick = () => navigator.clipboard.writeText(r.publicKey).then(() => toast('Copied', 'ok'));
    $('#gen-ssh').onclick = async () => {
      if (r.publicKey && !(await confirmBox('Regenerating replaces the key; repos using the old key will stop working until you add the new one.', 'Regenerate'))) return;
      await api('POST', '/api/ssh/generate');
      loadSsh();
    };
  }

  function credForm(c) {
    const editing = !!c;
    c = c || {};
    modal(`<h2>${editing ? 'Edit' : 'Add'} git token</h2>
      <form id="cred-form">
        ${editing ? '' : `<label class="field"><span>Provider</span><select id="prov">${Object.entries(PROVIDERS).map(([k, p]) => `<option value="${k}">${esc(p.label)}</option>`).join('')}</select>
          <small id="prov-help"></small></label>`}
        <label class="field"><span>Name</span><input type="text" name="name" value="${esc(c.name)}" required placeholder="e.g. My GitHub"></label>
        <div class="grid2">
          <label class="field"><span>Host</span><input type="text" name="host" value="${esc(c.host)}" required placeholder="github.com"><small>Sites on this host use the token automatically.</small></label>
          <label class="field"><span>Username</span><input type="text" name="username" value="${esc(c.username)}" placeholder="token user"></label>
        </div>
        <label class="field"><span>Token</span><input type="password" name="token" ${editing ? 'placeholder="leave blank to keep current"' : 'required'} autocomplete="off"></label>
        <div class="modal-foot"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save</button></div>
      </form>`, {
      onMount: (m, close) => {
        const prov = $('#prov', m);
        if (prov) {
          const apply = () => {
            const p = PROVIDERS[prov.value];
            $('[name=host]', m).value = p.host;
            $('[name=username]', m).value = p.username;
            if (!$('[name=name]', m).value || Object.values(PROVIDERS).some((x) => x.label === $('[name=name]', m).value)) $('[name=name]', m).value = p.label;
            $('#prov-help', m).innerHTML = p.help;
          };
          prov.onchange = apply;
          apply();
        }
        $('#cred-form', m).onsubmit = async (e) => {
          e.preventDefault();
          try {
            const body = formData(e.target);
            if (editing) await api('PUT', `/api/credentials/${c.id}`, body);
            else await api('POST', '/api/credentials', body);
            close();
            loadCreds();
            toast('Saved', 'ok');
          } catch (ex) { toast(ex.message, 'error'); }
        };
      },
    });
  }

  // ------------------------------------------------------------------ cloudflare tunnels
  async function pageTunnels(el) {
    el.innerHTML = `
      <div class="page-head">
        <div><h1>Cloudflare Tunnels</h1><p>Publish sites on your own domains through <b>your</b> Cloudflare account. No ports or port-forwarding needed.${state.user.isAdmin ? ' As an admin you see everyone\'s tunnels.' : ' Only you can see and change your tunnels.'}</p></div>
        <button class="btn primary" id="add-tunnel">+ Connect Cloudflare</button>
      </div>
      <div id="tunnel-list"><div class="muted">Loading…</div></div>`;
    $('#add-tunnel').onclick = () => tunnelForm();
    const load = async () => {
      if (state.page !== 'tunnels') return;
      try { renderTunnels(await api('GET', '/api/tunnels')); } catch (_) {}
    };
    await load();
    state.timer = setInterval(load, 5000);
  }

  function renderTunnels(list) {
    const box = $('#tunnel-list');
    if (!box) return;
    if (!list.length) {
      box.innerHTML = `<div class="card empty">No tunnels yet.<br><br>Click <b>+ Connect Cloudflare</b> and paste a Cloudflare API token. Pagemaster creates the tunnel and DNS records for you.</div>`;
      return;
    }
    const badge = { connected: 'live', starting: 'deploying', error: 'error', stopped: 'stopped' };
    box.innerHTML = list.map((t) => `
      <div class="card" data-id="${esc(t.id)}">
        <div class="site-head">
          <h3>${esc(t.name)}</h3>
          <span class="badge ${badge[t.status] || ''}">${esc(t.status)}</span>
          <span class="tag">${t.mode === 'api' ? 'API managed' : 'Token'}</span>
          ${t.accountName ? `<span class="tag">${esc(t.accountName)}</span>` : ''}
          ${state.user.isAdmin && t.userId !== state.user.id ? `<span class="tag">owner: ${esc(t.owner)}</span>` : ''}
        </div>
        ${t.lastError ? `<div class="err small" style="margin-top:6px">${esc(t.lastError)}</div>` : ''}
        <table style="margin-top:10px">
          <thead><tr><th>Public address</th><th>Site</th><th></th></tr></thead>
          <tbody>
          ${t.routes.length ? t.routes.map((r) => `<tr data-rid="${esc(r.id)}">
              <td><a href="https://${esc(r.hostname)}/" target="_blank" rel="noopener">https://${esc(r.hostname)}</a>
                ${r.dnsManual ? ' <button class="btn sm" data-a="dns" title="Pagemaster could not create the DNS record">⚠ DNS record needed</button>' : ''}</td>
              <td>${esc(r.siteName)}</td>
              <td style="text-align:right"><button class="btn sm danger" data-a="unroute">Remove</button></td></tr>`).join('')
            : '<tr><td colspan="3" class="muted">No public hostnames yet.</td></tr>'}
          </tbody>
        </table>
        <div class="row site-actions">
          <button class="btn sm primary" data-a="route">+ Publish a site</button>
          ${t.enabled ? '<button class="btn sm" data-a="stop">■ Stop</button>' : '<button class="btn sm" data-a="start">▶ Start</button>'}
          <button class="btn sm" data-a="log">Logs</button>
          ${t.mode === 'api' ? '<button class="btn sm" data-a="token">Update API token</button>' : ''}
          <button class="btn sm" data-a="transfer">Transfer</button>
          <button class="btn sm danger" data-a="delete">Delete tunnel</button>
        </div>
      </div>`).join('');
    $$('#tunnel-list .card[data-id]').forEach((card) => {
      const t = list.find((x) => x.id === card.dataset.id);
      $$('[data-a]', card).forEach((b) => b.onclick = async () => {
        try {
          const a = b.dataset.a;
          if (a === 'route') return routeForm(t);
          if (a === 'log') return showTunnelLog(t);
          if (a === 'token') return updateTokenForm(t);
          if (a === 'transfer') return transferTunnel(t);
          if (a === 'dns') {
            const r = t.routes.find((x) => x.id === b.closest('tr').dataset.rid);
            return manualDnsModal(`Pagemaster could not create the DNS record for ${r.hostname} because the API token lacks DNS permission.`,
              { type: 'CNAME', name: r.hostname, target: r.dnsTarget, proxied: true });
          }
          if (a === 'start') await api('POST', `/api/tunnels/${t.id}/start`);
          if (a === 'stop') await api('POST', `/api/tunnels/${t.id}/stop`);
          if (a === 'unroute') {
            const rid = b.closest('tr').dataset.rid;
            const r = t.routes.find((x) => x.id === rid);
            if (!(await confirmBox(`Stop publishing https://${r.hostname}?${t.mode === 'api' ? ' Its DNS record will be removed from Cloudflare.' : ''}`, 'Remove'))) return;
            await api('DELETE', `/api/tunnels/${t.id}/routes/${rid}`);
          }
          if (a === 'delete') {
            if (!(await confirmBox(`Delete tunnel "${t.name}"?${t.mode === 'api' ? ' The tunnel and the DNS records Pagemaster created will be removed from Cloudflare.' : ''}`))) return;
            const r = await api('DELETE', `/api/tunnels/${t.id}`);
            if (r.warnings && r.warnings.length) toast('Deleted, with warnings:\n' + r.warnings.join('\n'), 'error');
          }
          renderTunnels(await api('GET', '/api/tunnels'));
        } catch (e) { toast(e.message, 'error'); }
      });
    });
  }

  function tunnelForm(onCreated) {
    modal(`<h2>Connect Cloudflare</h2>
      <form id="tun-form">
        <label class="field"><span>How do you want to connect?</span><select name="mode" id="tun-mode">
          <option value="api">API token: Pagemaster creates the tunnel and DNS for you (recommended)</option>
          <option value="token">Tunnel token: I already made a tunnel in the Zero Trust dashboard</option>
        </select></label>
        <label class="field"><span>Name</span><input type="text" name="name" required placeholder="e.g. My domains" maxlength="60"></label>
        <div id="tun-api">
          <div class="alert info small">${TOKEN_HELP}</div>
          <label class="field"><span>Cloudflare API token</span>
            <div class="row"><input type="password" name="apiToken" class="grow" style="width:auto" autocomplete="off"><button type="button" class="btn" id="tun-check">Check token</button></div></label>
          <label class="field"><span>Account</span><select name="accountId" id="tun-acct" disabled><option value="">Check the token first</option></select></label>
        </div>
        <div id="tun-token" style="display:none">
          <div class="alert info small">In Zero Trust → Networks → Tunnels, create a <b>Cloudflared</b> tunnel and copy the token from the install command.
            Then add public hostnames there with service <code>HTTP</code> → <code>localhost:${state.system.hostingPort}</code>, and register the same hostnames here with <b>+ Publish a site</b>.</div>
          <label class="field"><span>Tunnel token</span><textarea name="token" rows="3" placeholder="eyJhIjoi... (or paste the whole 'cloudflared ... --token ...' command)"></textarea></label>
        </div>
        <div class="modal-foot"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" id="tun-save">Create tunnel</button></div>
      </form>`, {
      onMount: (m, close) => {
        const mode = $('#tun-mode', m);
        const sync = () => {
          $('#tun-api', m).style.display = mode.value === 'api' ? '' : 'none';
          $('#tun-token', m).style.display = mode.value === 'token' ? '' : 'none';
        };
        mode.onchange = sync;
        sync();
        $('#tun-check', m).onclick = async () => {
          const btn = $('#tun-check', m);
          btn.disabled = true;
          try {
            const r = await api('POST', '/api/cloudflare/inspect', { apiToken: $('[name=apiToken]', m).value });
            const sel = $('#tun-acct', m);
            sel.innerHTML = r.accounts.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
            sel.disabled = false;
            toast(`Token OK: ${r.accounts.length} account(s)`, 'ok');
          } catch (e) { toast(e.message, 'error'); } finally { btn.disabled = false; }
        };
        $('#tun-form', m).onsubmit = async (e) => {
          e.preventDefault();
          const btn = $('#tun-save', m);
          btn.disabled = true;
          btn.textContent = 'Creating…';
          try {
            const created = await api('POST', '/api/tunnels', formData(e.target));
            toast('Tunnel created, starting cloudflared…', 'ok');
            close();
            if (onCreated) onCreated(created);
            else renderTunnels(await api('GET', '/api/tunnels'));
          } catch (ex) { toast(ex.message, 'error'); } finally { btn.disabled = false; btn.textContent = 'Create tunnel'; }
        };
      },
    });
  }

  async function routeForm(t, opts = {}) {
    let sites = [];
    let zones = [];
    try {
      sites = await api('GET', '/api/tunnels/sites');
      if (t.mode === 'api') zones = await api('GET', `/api/tunnels/${t.id}/zones`);
    } catch (e) { return toast(e.message, 'error'); }
    if (!sites.length) return toast('Add a site first', 'error');
    if (t.mode === 'api' && !zones.length) return toast('This API token cannot see any domains. Give it Zone → Zone → Read and DNS → Edit for your domain.', 'error');
    modal(`<h2>Publish a site through "${esc(t.name)}"</h2>
      <form id="route-form">
        <label class="field"><span>Site</span><select name="siteId" id="rt-site">${sites.map((s) => `<option value="${esc(s.id)}" data-slug="${esc(s.slug)}" ${s.id === opts.siteId ? 'selected' : ''}>${esc(s.name)} (/${esc(s.slug)}/)</option>`).join('')}</select></label>
        ${t.mode === 'api' ? `
        <div class="grid2">
          <label class="field"><span>Subdomain</span><input type="text" name="subdomain" id="rt-sub" placeholder="blank = the domain itself"></label>
          <label class="field"><span>Domain</span><select name="zoneId" id="rt-zone">${zones.map((z) => `<option value="${esc(z.id)}" data-name="${esc(z.name)}">${esc(z.name)}</option>`).join('')}</select></label>
        </div>` : `
        <label class="field"><span>Hostname</span><input type="text" name="hostname" id="rt-host" required placeholder="blog.example.com">
          <small>Must match a public hostname you added to this tunnel in the Cloudflare dashboard (service <code>http://localhost:${state.system.hostingPort}</code>).</small></label>`}
        <p>Address: <b id="rt-preview" class="mono"></b></p>
        <div class="modal-foot"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" id="rt-save">Publish</button></div>
      </form>`, {
      onMount: (m, close) => {
        const sub = $('#rt-sub', m);
        const prev = () => {
          let h = '';
          if (t.mode === 'api') {
            const zn = $('#rt-zone', m).selectedOptions[0].dataset.name;
            h = sub.value.trim() ? `${sub.value.trim().toLowerCase()}.${zn}` : zn;
          } else h = $('#rt-host', m).value.trim().toLowerCase();
          $('#rt-preview', m).textContent = h ? `https://${h}` : '';
        };
        if (sub) {
          // default subdomain = the site's slug
          const setDefault = () => { sub.value = $('#rt-site', m).selectedOptions[0].dataset.slug; prev(); };
          $('#rt-site', m).onchange = setDefault;
          $('#rt-zone', m).onchange = prev;
          sub.oninput = prev;
          setDefault();
        } else {
          $('#rt-host', m).oninput = prev;
        }
        $('#route-form', m).onsubmit = async (e) => {
          e.preventDefault();
          const btn = $('#rt-save', m);
          btn.disabled = true;
          try {
            const r = await api('POST', `/api/tunnels/${t.id}/routes`, formData(e.target));
            close();
            if (r.warning) manualDnsModal(r.warning.message, r.warning.record);
            else toast(`Published ${$('#rt-preview', m).textContent}. DNS can take a minute.`, 'ok');
            if (state.page === 'tunnels') renderTunnels(await api('GET', '/api/tunnels'));
            if (state.page === 'sites') renderSiteList(await api('GET', '/api/sites'));
          } catch (ex) { toast(ex.message, 'error'); } finally { btn.disabled = false; }
        };
      },
    });
  }

  const TOKEN_HELP = `Create it at <b>dash.cloudflare.com → My Profile → API Tokens → Create Token → Custom token</b>, and add <b>all three</b> permission rows:<br>
    • <b>Account</b> · Cloudflare Tunnel · Edit<br>
    • <b>Zone</b> · DNS · Edit<br>
    • <b>Zone</b> · Zone · Read<br>
    Under <b>Zone Resources</b> pick <i>Include → All zones</i> (or your domain). DNS is a <b>Zone</b> permission. Account-level "all permissions" does not include it.
    The token is stored encrypted and only used for your tunnels.`;

  function manualDnsModal(message, rec) {
    modal(`<h2>One DNS record to add</h2>
      <div class="alert warn">${esc(message)}</div>
      <p>Either add this record in <b>Cloudflare → your domain → DNS → Records → Add record</b>:</p>
      <table><tbody>
        <tr><th>Type</th><td class="mono">${esc(rec.type)}</td></tr>
        <tr><th>Name</th><td class="mono">${esc(rec.name)}</td></tr>
        <tr><th>Target</th><td class="mono">${esc(rec.target)} <button class="btn sm" id="cp-target">Copy</button></td></tr>
        <tr><th>Proxy status</th><td>Proxied (orange cloud)</td></tr>
      </tbody></table>
      <p>…or give the API token <b>Zone · DNS · Edit</b> and use <b>Update API token</b> on the Tunnels page. Pagemaster will then create the record itself.</p>
      <div class="modal-foot"><button class="btn primary" data-close>OK</button></div>`, {
      onMount: (m) => { $('#cp-target', m).onclick = () => navigator.clipboard.writeText(rec.target).then(() => toast('Copied', 'ok')); },
    });
  }

  function updateTokenForm(t) {
    modal(`<h2>Update API token: ${esc(t.name)}</h2>
      <div class="alert info small">${TOKEN_HELP}</div>
      <form id="tok-form">
        <label class="field"><span>New Cloudflare API token</span><input type="password" name="apiToken" required autocomplete="off"></label>
        <div class="modal-foot"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" id="tok-save">Save &amp; retry</button></div>
      </form>`, {
      onMount: (m, close) => {
        $('#tok-form', m).onsubmit = async (e) => {
          e.preventDefault();
          const btn = $('#tok-save', m);
          btn.disabled = true;
          try {
            const r = await api('PUT', `/api/tunnels/${t.id}/token`, formData(e.target));
            close();
            if (r.warnings && r.warnings.length) toast('Token saved, but:\n' + r.warnings.join('\n'), 'error');
            else toast('Token saved. Everything is set up.', 'ok');
            if (state.page === 'tunnels') renderTunnels(await api('GET', '/api/tunnels'));
          } catch (ex) { toast(ex.message, 'error'); } finally { btn.disabled = false; }
        };
      },
    });
  }

  // "☁ Publish" on a site card: pick (or create) your tunnel, then choose the hostname
  async function publishSite(site) {
    let tunnels = [];
    try { tunnels = await api('GET', '/api/tunnels'); } catch (e) { return toast(e.message, 'error'); }
    const mine = tunnels.filter((t) => t.userId === state.user.id);
    const usable = mine.length ? mine : tunnels;
    const next = (t) => routeForm(t, { siteId: site.id });
    if (!usable.length) {
      modal(`<h2>Publish "${esc(site.name)}" on your domain</h2>
        <p>Sites are published through a <b>Cloudflare Tunnel</b> on your own Cloudflare account, with no ports or port-forwarding.</p>
        <p class="muted">First connect your Cloudflare account (one time). Then you'll choose the address, e.g. <code>${esc(site.slug)}.yourdomain.com</code>.</p>
        <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="go-connect">Connect Cloudflare</button></div>`, {
        onMount: (m, close) => { $('#go-connect', m).onclick = () => { close(); tunnelForm(next); }; },
      });
      return;
    }
    if (usable.length === 1) return next(usable[0]);
    modal(`<h2>Publish "${esc(site.name)}"</h2>
      <label class="field"><span>Through which tunnel?</span><select id="pick-tun">${usable.map((t) =>
        `<option value="${esc(t.id)}">${esc(t.name)}${t.accountName ? ' (' + esc(t.accountName) + ')' : ''}${t.userId !== state.user.id ? ' [' + esc(t.owner) + ']' : ''}</option>`).join('')}</select></label>
      <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="pick-next">Next</button></div>`, {
      onMount: (m, close) => { $('#pick-next', m).onclick = () => { const id = $('#pick-tun', m).value; close(); next(usable.find((t) => t.id === id)); }; },
    });
  }

  async function transferTunnel(t) {
    let users;
    try { users = (await directory()).filter((u) => u.id !== t.userId && u.canTunnel); } catch (e) { return toast(e.message, 'error'); }
    if (!users.length) return toast('No other user has the tunnels.manage permission', 'error');
    modal(`<h2>Transfer tunnel "${esc(t.name)}"</h2>
      <p>The new owner can manage this tunnel and its public hostnames. Its Cloudflare API token goes with it, so they can act on that Cloudflare account through Pagemaster.</p>
      <form id="tt-form"><label class="field"><span>New owner</span><select name="userId">${users.map((u) => `<option value="${esc(u.id)}">${esc(u.username)}</option>`).join('')}</select></label>
      <div class="modal-foot"><button type="button" class="btn" data-close>Cancel</button><button class="btn danger solid">Transfer</button></div></form>`, {
      onMount: (m, close) => {
        $('#tt-form', m).onsubmit = async (e) => {
          e.preventDefault();
          try { await api('POST', `/api/tunnels/${t.id}/transfer`, formData(e.target)); toast('Tunnel transferred', 'ok'); close(); renderTunnels(await api('GET', '/api/tunnels')); }
          catch (ex) { toast(ex.message, 'error'); }
        };
      },
    });
  }

  function showTunnelLog(t) {
    const m = modal(`<div class="row"><h2 class="grow" style="margin:0">cloudflared — ${esc(t.name)}</h2><button class="btn sm" data-close>Close</button></div>
      <pre class="logbox mono" id="tlog" style="margin-top:12px">Loading…</pre>`, { wide: true });
    const load = async () => {
      if (!document.body.contains(m.el)) return clearInterval(timer);
      try {
        const box = $('#tlog', m.el);
        box.textContent = (await api('GET', `/api/tunnels/${t.id}/log`)) || '(no output yet)';
        box.scrollTop = box.scrollHeight;
      } catch (_) {}
    };
    const timer = setInterval(load, 3000);
    load();
  }

  // ------------------------------------------------------------------ users
  async function pageUsers(el) {
    el.innerHTML = `
      <div class="page-head"><div><h1>Users</h1><p>Local and SSO accounts with their permissions.</p></div>
        <button class="btn primary" id="add-user">+ Add user</button></div>
      <div class="card" id="user-list">Loading…</div>`;
    $('#add-user').onclick = () => userForm();
    loadUsers();
  }

  async function loadUsers() {
    const list = await api('GET', '/api/users');
    $('#user-list').innerHTML = `<table><thead><tr><th>User</th><th>Type</th><th class="hide-sm">Access</th><th class="hide-sm">Last login</th><th></th></tr></thead><tbody>
      ${list.map((u) => `<tr data-id="${esc(u.id)}">
        <td><b>${esc(u.username)}</b>${u.email ? `<div class="muted small">${esc(u.email)}</div>` : ''}</td>
        <td>${u.source === 'sso' ? '<span class="tag">SSO</span>' : '<span class="tag">Local</span>'}${u.source !== 'sso' && u.ssoLinked ? `<span class="tag" title="Can also sign in with SSO as ${esc(u.ssoName)}">+ SSO</span>` : ''}${u.disabled ? ' <span class="badge error">disabled</span>' : ''}</td>
        <td class="hide-sm">${u.isAdmin ? '<span class="badge live">Admin</span>' : (u.permissions.length ? u.permissions.map((p) => `<span class="tag">${esc(p)}</span>`).join('') : '<span class="muted">no access</span>')}</td>
        <td class="hide-sm muted">${fmtTime(u.lastLogin)}</td>
        <td style="text-align:right;white-space:nowrap"><button class="btn sm" data-a="edit">Edit</button>${u.id !== state.user.id ? '<button class="btn sm danger" data-a="rm">Delete</button>' : ''}</td>
      </tr>`).join('')}</tbody></table>`;
    $$('#user-list tr[data-id]').forEach((tr) => {
      const u = list.find((x) => x.id === tr.dataset.id);
      $('[data-a=edit]', tr).onclick = () => userForm(u, list);
      if ($('[data-a=rm]', tr)) $('[data-a=rm]', tr).onclick = async () => {
        if (!(await confirmBox(`Delete user "${u.username}"? Sites they own will be transferred to you, and their Cloudflare tunnels are deleted.`))) return;
        try { await api('DELETE', `/api/users/${u.id}`); loadUsers(); } catch (e) { toast(e.message, 'error'); }
      };
    });
  }

  function permChecks(selected, group = 'permissions') {
    return Object.entries(state.permissions).map(([k, d]) => `
      <label class="check"><input type="checkbox" name="perm_${k}" data-group="${group}" value="${k}" ${selected.includes(k) ? 'checked' : ''}>
      <span><code>${esc(k)}</code> <span class="muted small">— ${esc(d)}</span></span></label>`).join('');
  }

  function userForm(u, all = []) {
    const editing = !!u;
    const ssoUsers = editing ? all.filter((x) => x.id !== u.id && x.ssoLinked && x.id !== state.user.id) : [];
    u = u || { permissions: ['sites.view'], source: 'local' };
    modal(`<h2>${editing ? 'Edit user' : 'Add user'}</h2>
      <form id="user-form">
        <label class="field"><span>Username</span><input type="text" name="username" value="${esc(u.username)}" required></label>
        ${u.source === 'local' ? `<label class="field"><span>${editing ? 'Reset password' : 'Password'}</span><input type="password" name="password" ${editing ? 'placeholder="leave blank to keep"' : 'required minlength="8"'} autocomplete="new-password"></label>
        <label class="check"><input type="checkbox" name="mustChangePassword" ${!editing ? 'checked' : ''}> <span>Ask user to change password on next login</span></label>` : '<p class="muted small">SSO account — signs in through your identity provider.</p>'}
        ${state.user.isAdmin ? `<label class="check"><input type="checkbox" name="isAdmin" id="isadmin" ${u.isAdmin ? 'checked' : ''}> <span><b>Administrator</b> — full access to everything</span></label>` : ''}
        ${editing && u.id !== state.user.id ? `<label class="check"><input type="checkbox" name="disabled" ${u.disabled ? 'checked' : ''}> <span>Disabled (cannot sign in)</span></label>` : ''}
        ${editing && u.ssoLinked ? `<div class="card" style="margin:10px 0;padding:10px 12px"><b>SSO identity:</b> <span class="mono">${esc(u.ssoName || 'linked')}</span>
          ${u.hasPassword ? '<label class="check"><input type="checkbox" name="unlinkSso"> <span>Unlink SSO (the user keeps signing in with their password)</span></label>' : ''}</div>` : ''}
        ${editing && state.user.isAdmin && ssoUsers.length ? `<label class="field"><span>Link an SSO user into this account</span><select name="linkFrom">
            <option value="">— no change —</option>
            ${ssoUsers.map((x) => `<option value="${esc(x.id)}">${esc(x.username)}${x.ssoName ? ' (' + esc(x.ssoName) + ')' : ''}</option>`).join('')}</select>
          <small>Use this when SSO created a second account for the same person. That account's SSO login, sites, shares and tunnels move here, and it is deleted.</small></label>` : ''}
        <h3 style="margin-top:14px">Permissions</h3>
        <div id="perms">${permChecks(u.permissions)}</div>
        <div class="modal-foot"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save</button></div>
      </form>`, {
      onMount: (m, close) => {
        const adm = $('#isadmin', m);
        const sync = () => { if (adm) $('#perms', m).style.opacity = adm.checked ? .4 : 1; };
        if (adm) adm.onchange = sync;
        sync();
        $('#user-form', m).onsubmit = async (e) => {
          e.preventDefault();
          const body = formData(e.target);
          if (!body.password) delete body.password;
          if (!state.user.isAdmin) delete body.isAdmin;
          const linkFrom = body.linkFrom;
          delete body.linkFrom;
          if (linkFrom) {
            const from = ssoUsers.find((x) => x.id === linkFrom);
            if (!(await confirmBox(`Merge "${from.username}" into "${u.username}"? "${from.username}" will be deleted and its SSO login will sign in as "${u.username}".`, 'Merge'))) return;
          }
          try {
            if (editing) await api('PUT', `/api/users/${u.id}`, body);
            else await api('POST', '/api/users', body);
            if (linkFrom) await api('POST', `/api/users/${u.id}/link-sso`, { fromUserId: linkFrom });
            state.directory = null;
            close();
            loadUsers();
            toast('Saved', 'ok');
          } catch (ex) { toast(ex.message, 'error'); }
        };
      },
    });
  }

  // ------------------------------------------------------------------ settings
  async function pageSettings(el) {
    const s = await api('GET', '/api/settings');
    el.innerHTML = `
      <div class="page-head"><div><h1>Settings</h1></div></div>
      <form id="settings-form">
      <div class="card">
        <h2>General</h2>
        <label class="field"><span>Public URL of this admin panel</span><input type="text" name="publicUrl" value="${esc(s.publicUrl)}" placeholder="https://pagemaster.example.com">
          <small>Used for SSO redirects and webhook URLs. Leave blank to use the address in your browser.</small></label>
        <label class="field"><span>Sites URL</span><input type="text" name="sitesUrl" value="${esc(s.sitesUrl)}" placeholder="e.g. http://192.168.1.50 or https://sites.example.com">
          <small>The address people use to reach your sites. Each site is shown as <code>&lt;Sites URL&gt;/&lt;slug&gt;/</code>. Leave blank to use this server's address with port ${state.system.hostingPublicPort}. Sites published through a Cloudflare tunnel always use their tunnel hostname.</small></label>
        <label class="field"><span>Sites base domain</span><input type="text" name="sitesBaseDomain" value="${esc(s.sitesBaseDomain)}" placeholder="sites.example.com">
          <small>Optional. Every site is also served at <code>&lt;slug&gt;.&lt;base domain&gt;</code> on the shared hosting port (${state.system.hostingPort}) — point a wildcard DNS record / reverse proxy at it.</small></label>
      </div>
      <div class="card">
        <h2>Single sign-on (OpenID Connect)</h2>
        <p class="muted">Works with Authentik, Authelia, Keycloak, Zitadel, Pocket ID, Google, Microsoft Entra, GitLab and other OIDC providers. Local login always stays available.</p>
        <label class="check"><input type="checkbox" name="sso_enabled" ${s.sso.enabled ? 'checked' : ''}> <span><b>Enable SSO login</b></span></label>
        <div class="grid2" style="margin-top:10px">
          <label class="field"><span>Button label</span><input type="text" name="sso_label" value="${esc(s.sso.label)}"></label>
          <label class="field"><span>Scopes</span><input type="text" name="sso_scopes" value="${esc(s.sso.scopes)}"></label>
        </div>
        <label class="field"><span>Issuer URL</span><input type="text" name="sso_issuer" value="${esc(s.sso.issuer)}" placeholder="https://auth.example.com/application/o/pagemaster/">
          <small>The URL that serves <code>/.well-known/openid-configuration</code>.</small></label>
        <div class="grid2">
          <label class="field"><span>Client ID</span><input type="text" name="sso_clientId" value="${esc(s.sso.clientId)}"></label>
          <label class="field"><span>Client secret</span><input type="password" name="sso_clientSecret" placeholder="${s.sso.hasClientSecret ? '•••••• (saved, blank = keep)' : 'leave blank for public clients'}" autocomplete="off"></label>
        </div>
        <label class="field"><span>Redirect URI (add this in your provider)</span><input type="text" readonly value="${esc(s.ssoRedirectUri)}" class="mono"></label>
        <label class="check"><input type="checkbox" name="sso_autoCreate" ${s.sso.autoCreate ? 'checked' : ''}> <span>Automatically create accounts for new SSO users</span></label>
        <h3 style="margin-top:14px">Default permissions for new SSO users</h3>
        <p class="muted small">New SSO users get only these until an admin changes them in <b>Users</b>. Leave them all off to give new users nothing but the sites shared with them (or set to "All users" in the panel).</p>
        ${permChecks(s.sso.defaultPermissions, 'sso_defaultPermissions')}
      </div>
      <button class="btn primary">Save settings</button>
      </form>`;
    $('#settings-form').onsubmit = async (e) => {
      e.preventDefault();
      const f = formData(e.target);
      const body = {
        publicUrl: f.publicUrl,
        sitesUrl: f.sitesUrl,
        sitesBaseDomain: f.sitesBaseDomain,
        sso: {
          enabled: f.sso_enabled, label: f.sso_label, scopes: f.sso_scopes, issuer: f.sso_issuer,
          clientId: f.sso_clientId, clientSecret: f.sso_clientSecret, autoCreate: f.sso_autoCreate,
          defaultPermissions: f.sso_defaultPermissions || [],
        },
      };
      try {
        await api('PUT', '/api/settings', body);
        state.system = await api('GET', '/api/system');
        toast('Settings saved', 'ok');
        pageSettings(el);
      } catch (ex) { toast(ex.message, 'error'); }
    };
  }

  // ------------------------------------------------------------------ account
  function pageAccount(el) {
    const u = state.user;
    el.innerHTML = `
      <div class="page-head"><div><h1>My Account</h1></div></div>
      ${u.mustChangePassword ? '<div class="alert warn">You are still using a default/temporary password. Please change it below.</div>' : ''}
      <div class="card"><h2>Username</h2>
        <form id="un-form" class="row"><input type="text" name="username" value="${esc(u.username)}" style="max-width:300px" required><button class="btn primary">Save</button></form>
      </div>
      ${state.ssoEnabled || u.ssoLinked ? `<div class="card" style="max-width:520px"><h2>Single sign-on</h2>
        ${u.ssoLinked
          ? `<p>Linked to the SSO account <b class="mono">${esc(u.ssoName || '(linked)')}</b>. Signing in with SSO opens this account.</p>
             ${u.hasPassword ? '<button class="btn danger" id="sso-unlink">Unlink SSO</button>' : '<p class="muted small">This account has no password, so SSO is its only way to sign in.</p>'}`
          : `<p>Link your SSO account so <b>${esc(state.ssoEnabled ? 'Sign in with SSO' : 'SSO')}</b> opens this account (with its sites and permissions) instead of creating a new one. Your password keeps working.</p>
             <button class="btn primary" id="sso-link">Link SSO account</button>`}
      </div>` : ''}
      ${u.hasPassword || u.source === 'local' ? `<div class="card" style="max-width:520px"><h2>Change password</h2>
        <form id="pw-form">
          <label class="field"><span>Current password</span><input type="password" name="current" required autocomplete="current-password"></label>
          <label class="field"><span>New password</span><input type="password" name="password" required minlength="8" autocomplete="new-password"></label>
          <label class="field"><span>Confirm new password</span><input type="password" name="confirm" required autocomplete="new-password"></label>
          <button class="btn primary">Change password</button>
        </form></div>` : '<div class="card muted">You sign in with SSO, so there is no local password.</div>'}
      <div class="card"><h2>Your permissions</h2>${u.isAdmin ? '<span class="badge live">Administrator</span>' : (u.permissions.map((p) => `<span class="tag">${esc(p)}</span>`).join('') || '<span class="muted">none — ask an admin for access</span>')}</div>`;
    $('#un-form').onsubmit = async (e) => {
      e.preventDefault();
      try { await api('POST', '/api/account/username', formData(e.target)); u.username = formData(e.target).username; toast('Username changed', 'ok'); renderShell(); go('account'); }
      catch (ex) { toast(ex.message, 'error'); }
    };
    if ($('#sso-link')) $('#sso-link').onclick = async () => {
      try { location.href = (await api('POST', '/api/account/sso/link')).url; } catch (ex) { toast(ex.message, 'error'); }
    };
    if ($('#sso-unlink')) $('#sso-unlink').onclick = async () => {
      if (!(await confirmBox('Unlink SSO? You will only be able to sign in with your password.', 'Unlink'))) return;
      try { state.user = (await api('POST', '/api/account/sso/unlink')).user; toast('SSO unlinked', 'ok'); go('account'); } catch (ex) { toast(ex.message, 'error'); }
    };
    if ($('#pw-form')) $('#pw-form').onsubmit = async (e) => {
      e.preventDefault();
      const f = formData(e.target);
      if (f.password !== f.confirm) return toast('Passwords do not match', 'error');
      try { await api('POST', '/api/account/password', f); u.mustChangePassword = false; toast('Password changed', 'ok'); e.target.reset(); go('account'); }
      catch (ex) { toast(ex.message, 'error'); }
    };
  }

  boot();
})();
