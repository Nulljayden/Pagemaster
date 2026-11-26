/* Pagemaster web UI - plain JS, no build step. */
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const app = $('#app');

  const state = { user: null, permissions: {}, system: null, page: 'sites', timer: null, term: null, filesPath: '/' };

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
    if (err) history.replaceState(null, '', '/');
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
        ${pub.sso.enabled ? `<div class="divider">or</div><a class="btn block" href="/auth/sso/login">${esc(pub.sso.label)}</a>` : ''}
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

  // ------------------------------------------------------------------ shell
  const PAGES = [
    { id: 'sites', label: 'Sites', icon: '🌐', perm: 'sites.view' },
    { id: 'files', label: 'Files', icon: '📁', perm: 'files.read' },
    { id: 'terminal', label: 'Terminal', icon: '⌨️', perm: 'terminal' },
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
      state.system = await api('GET', '/api/system');
    } catch (_) {
      return renderLogin();
    }
    renderShell();
    const fromHash = location.hash.slice(1);
    const allowed = PAGES.filter((p) => !p.perm || can(p.perm));
    go(allowed.some((p) => p.id === fromHash) ? fromHash : allowed[0].id);
    if (state.user.mustChangePassword && !sessionStorage.getItem('pm-skip-pw')) passwordPrompt();
  }

  function renderShell() {
    const u = state.user;
    app.innerHTML = `
      <div class="layout">
        <aside class="sidebar">
          <div class="brand"><div class="brand-logo">P</div>Pagemaster</div>
          <nav class="nav">${PAGES.filter((p) => !p.perm || can(p.perm)).map((p) =>
            `<a href="#${p.id}" data-page="${p.id}"><span>${p.icon}</span><span>${p.label}</span></a>`).join('')}</nav>
          <div class="spacer"></div>
          <div class="userbox">
            <strong>${esc(u.displayName || u.username)}</strong>
            ${u.isAdmin ? 'Administrator' : (u.source === 'sso' ? 'SSO user' : 'User')}
            <div style="margin-top:8px"><button class="btn sm" id="logout">Sign out</button></div>
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
    ({ sites: pageSites, files: pageFiles, terminal: pageTerminal, credentials: pageCredentials, users: pageUsers, settings: pageSettings, account: pageAccount })[page](el);
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
  function siteUrls(s) {
    const host = location.hostname;
    const urls = [];
    for (const d of s.domains || []) urls.push({ label: 'Domain', url: `http://${d}/` });
    if (state.system.sitesBaseDomain) urls.push({ label: 'Subdomain', url: `http://${s.slug}.${state.system.sitesBaseDomain}/` });
    if (s.port) urls.push({ label: 'Own port', url: `${location.protocol}//${host}:${s.port}/` });
    urls.push({ label: 'Shared port', url: `${location.protocol}//${host}:${state.system.hostingPort}/${s.slug}/` });
    return urls;
  }

  async function pageSites(el) {
    el.innerHTML = `
      <div class="page-head">
        <div><h1>Sites</h1><p>Git repositories deployed as websites.</p></div>
        ${can('sites.manage') ? '<button class="btn primary" id="add-site">+ Add site</button>' : ''}
      </div>
      <div id="site-list" class="sites"><div class="muted">Loading…</div></div>`;
    if ($('#add-site')) $('#add-site').onclick = () => siteForm();
    const load = async () => {
      if (state.page !== 'sites') return;
      try { renderSiteList(await api('GET', '/api/sites')); } catch (e) { /* ignore poll errors */ }
    };
    await load();
    state.timer = setInterval(load, 4000);
  }

  function renderSiteList(list) {
    const box = $('#site-list');
    if (!box) return;
    if (!list.length) {
      box.innerHTML = `<div class="card empty">No sites yet.${can('sites.manage') ? ' Click <b>+ Add site</b> to deploy a repository.' : ''}</div>`;
      return;
    }
    box.innerHTML = list.map((s) => {
      const status = s.deploying ? 'deploying' : (s.status || 'pending');
      return `<div class="card site" data-id="${esc(s.id)}">
        <div class="site-head">
          <h3>${esc(s.name)}</h3>
          <span class="badge ${esc(status)}">${esc(status)}</span>
          <span class="tag">${s.mode === 'node' ? 'App' : 'Static'}</span>
          ${s.autoPullMinutes ? `<span class="tag">auto-pull ${s.autoPullMinutes}m</span>` : ''}
        </div>
        <div class="site-meta">
          <div><span class="k">Repo</span><span class="mono">${esc(s.repoUrl)}</span>${s.branch ? ` <span class="tag">${esc(s.branch)}</span>` : ''}</div>
          <div><span class="k">Commit</span>${esc(s.lastCommit || '—')} <span class="muted small">· ${fmtTime(s.lastDeploy)}</span></div>
          <div><span class="k">URLs</span>${siteUrls(s).map((u) => `<a class="tag" href="${esc(u.url)}" target="_blank" rel="noopener" title="${esc(u.label)}">${esc(u.url)}</a>`).join('')}</div>
          ${s.lastError ? `<div class="err small">${esc(s.lastError)}</div>` : ''}
        </div>
        <div class="row site-actions">
          ${can('sites.deploy') ? `<button class="btn sm" data-act="deploy">⟳ Pull &amp; deploy</button>
            ${s.enabled === false ? '<button class="btn sm" data-act="start">▶ Start</button>' : '<button class="btn sm" data-act="stop">■ Stop</button>'}` : ''}
          <button class="btn sm" data-act="log">Logs</button>
          ${can('files.read') ? '<button class="btn sm" data-act="files">Files</button>' : ''}
          ${can('sites.manage') ? '<button class="btn sm" data-act="webhook">Webhook</button><button class="btn sm" data-act="edit">Edit</button><button class="btn sm danger" data-act="delete">Delete</button>' : ''}
        </div>
      </div>`;
    }).join('');
    box._sites = list;
    $$('[data-act]', box).forEach((b) => {
      b.onclick = () => {
        const id = b.closest('.site').dataset.id;
        siteAction(b.dataset.act, box._sites.find((x) => x.id === id));
      };
    });
  }

  async function siteAction(act, s) {
    try {
      if (act === 'deploy') { await api('POST', `/api/sites/${s.id}/deploy`); toast('Deploy started'); }
      if (act === 'start') { await api('POST', `/api/sites/${s.id}/start`); toast('Site started', 'ok'); }
      if (act === 'stop') { await api('POST', `/api/sites/${s.id}/stop`); toast('Site stopped'); }
      if (act === 'edit') siteForm(s);
      if (act === 'log') showLog(s);
      if (act === 'files') { state.filesPath = '/' + s.slug; go('files'); return; }
      if (act === 'webhook') showWebhook(s);
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
            <small>Folder name and path on the shared port (/<i>slug</i>/). Must be unique.</small></label>
        </div>
        <label class="field"><span>Repository URL</span><input type="text" name="repoUrl" value="${esc(s.repoUrl)}" required placeholder="https://github.com/user/repo.git  or  git@gitlab.com:user/repo.git">
          <small>Any git host: GitHub, GitLab, Bitbucket, Gitea/Forgejo, Azure DevOps, self-hosted… HTTPS uses tokens, SSH uses the deploy key.</small></label>
        <div class="grid2">
          <label class="field"><span>Branch</span><input type="text" name="branch" value="${esc(s.branch)}" placeholder="default branch"></label>
          <label class="field"><span>Git credential</span><select name="credentialId">
            <option value="auto" ${s.credentialId === 'auto' ? 'selected' : ''}>Auto (match by host)</option>
            <option value="none" ${s.credentialId === 'none' ? 'selected' : ''}>None (public repo)</option>
            ${creds.map((c) => `<option value="${esc(c.id)}" ${s.credentialId === c.id ? 'selected' : ''}>${esc(c.name)} (${esc(c.host)})</option>`).join('')}
          </select></label>
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
        <label class="field"><span>Custom domains</span><input type="text" name="domains" value="${esc((s.domains || []).join(', '))}" placeholder="www.example.com, example.com">
          <small>Requests to the shared hosting port (${sys.hostingPort}) with these hostnames go to this site. Each domain can only belong to one site.${sys.sitesBaseDomain ? ` Also served at <b>${esc(s.slug || 'slug')}.${esc(sys.sitesBaseDomain)}</b>.` : ''}</small></label>
        <div class="grid2">
          <label class="field"><span>Dedicated port (optional)</span><input type="number" name="port" value="${esc(s.port || '')}" placeholder="range ${range}">
            <small>Gives this site its own port. Range ${range}.${used.length ? ' In use: ' + used.join(', ') : ''}</small></label>
          <label class="field"><span>Auto-pull every (minutes)</span><input type="number" name="autoPullMinutes" min="0" max="1440" value="${esc(s.autoPullMinutes || 0)}">
            <small>0 = off. Redeploys only when there is a new commit.</small></label>
        </div>
        <label class="field"><span>Environment variables</span><textarea name="env" rows="3" placeholder="KEY=value (one per line)">${esc(s.env)}</textarea>
          <small>Available to install/build/start commands.</small></label>
        <label class="check"><input type="checkbox" name="spa" ${s.spa ? 'checked' : ''}> <span>Single-page app — serve <code>index.html</code> for unknown paths (React/Vue router etc.)</span></label>
        <div id="site-err"></div>
        <div class="modal-foot"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">${editing ? 'Save &amp; redeploy' : 'Add &amp; deploy'}</button></div>
      </form>`, {
      onMount: (m, close) => {
        const toggle = () => { $('#start-field', m).style.display = $('#mode', m).value === 'node' ? '' : 'none'; };
        $('#mode', m).onchange = toggle;
        toggle();
        $('#site-form', m).onsubmit = async (e) => {
          e.preventDefault();
          const btn = $('button.primary', m);
          btn.disabled = true;
          try {
            const body = formData(e.target);
            if (editing) await api('PUT', `/api/sites/${s.id}`, body);
            else await api('POST', '/api/sites', body);
            state.system = await api('GET', '/api/system');
            toast(editing ? 'Saved — redeploying' : 'Site added — deploying', 'ok');
            close();
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
    const w = can('files.write');
    el.innerHTML = `
      <div class="page-head">
        <div><h1>Files</h1><p>Browse the cloned site folders.</p></div>
        ${w ? `<div class="row">
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
      card.addEventListener('drop', (e) => { e.preventDefault(); card.classList.remove('drag'); uploadFiles(e.dataTransfer.files); });
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
    const parts = data.path.split('/').filter(Boolean);
    $('#crumbs').innerHTML = `<a href="#" data-p="/">sites</a>` + parts.map((p, i) =>
      ` / <a href="#" data-p="/${esc(parts.slice(0, i + 1).join('/'))}">${esc(p)}</a>`).join('');
    $$('#crumbs a').forEach((a) => a.onclick = (e) => { e.preventDefault(); state.filesPath = a.dataset.p; loadFiles(); });
    const w = can('files.write');
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
    if (p) {
      try { content = (await api('GET', '/api/files/read?path=' + encodeURIComponent(p))).content; }
      catch (e) {
        if (confirm(e.message + '\n\nDownload it?')) location.href = '/api/files/download?path=' + encodeURIComponent(p);
        return;
      }
    }
    const w = can('files.write');
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
        <td>${u.source === 'sso' ? '<span class="tag">SSO</span>' : '<span class="tag">Local</span>'}${u.disabled ? ' <span class="badge error">disabled</span>' : ''}</td>
        <td class="hide-sm">${u.isAdmin ? '<span class="badge live">Admin</span>' : (u.permissions.length ? u.permissions.map((p) => `<span class="tag">${esc(p)}</span>`).join('') : '<span class="muted">no access</span>')}</td>
        <td class="hide-sm muted">${fmtTime(u.lastLogin)}</td>
        <td style="text-align:right;white-space:nowrap"><button class="btn sm" data-a="edit">Edit</button>${u.id !== state.user.id ? '<button class="btn sm danger" data-a="rm">Delete</button>' : ''}</td>
      </tr>`).join('')}</tbody></table>`;
    $$('#user-list tr[data-id]').forEach((tr) => {
      const u = list.find((x) => x.id === tr.dataset.id);
      $('[data-a=edit]', tr).onclick = () => userForm(u);
      if ($('[data-a=rm]', tr)) $('[data-a=rm]', tr).onclick = async () => {
        if (!(await confirmBox(`Delete user "${u.username}"?`))) return;
        try { await api('DELETE', `/api/users/${u.id}`); loadUsers(); } catch (e) { toast(e.message, 'error'); }
      };
    });
  }

  function permChecks(selected, group = 'permissions') {
    return Object.entries(state.permissions).map(([k, d]) => `
      <label class="check"><input type="checkbox" name="perm_${k}" data-group="${group}" value="${k}" ${selected.includes(k) ? 'checked' : ''}>
      <span><code>${esc(k)}</code> <span class="muted small">— ${esc(d)}</span></span></label>`).join('');
  }

  function userForm(u) {
    const editing = !!u;
    u = u || { permissions: ['sites.view'], source: 'local' };
    modal(`<h2>${editing ? 'Edit user' : 'Add user'}</h2>
      <form id="user-form">
        <label class="field"><span>Username</span><input type="text" name="username" value="${esc(u.username)}" required></label>
        ${u.source === 'local' ? `<label class="field"><span>${editing ? 'Reset password' : 'Password'}</span><input type="password" name="password" ${editing ? 'placeholder="leave blank to keep"' : 'required minlength="8"'} autocomplete="new-password"></label>
        <label class="check"><input type="checkbox" name="mustChangePassword" ${!editing ? 'checked' : ''}> <span>Ask user to change password on next login</span></label>` : '<p class="muted small">SSO account — signs in through your identity provider.</p>'}
        ${state.user.isAdmin ? `<label class="check"><input type="checkbox" name="isAdmin" id="isadmin" ${u.isAdmin ? 'checked' : ''}> <span><b>Administrator</b> — full access to everything</span></label>` : ''}
        ${editing && u.id !== state.user.id ? `<label class="check"><input type="checkbox" name="disabled" ${u.disabled ? 'checked' : ''}> <span>Disabled (cannot sign in)</span></label>` : ''}
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
          try {
            if (editing) await api('PUT', `/api/users/${u.id}`, body);
            else await api('POST', '/api/users', body);
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
        <p class="muted small">New SSO users get only these until an admin changes them in <b>Users</b>. Lowest access (just <code>sites.view</code>) is recommended.</p>
        ${permChecks(s.sso.defaultPermissions, 'sso_defaultPermissions')}
      </div>
      <button class="btn primary">Save settings</button>
      </form>`;
    $('#settings-form').onsubmit = async (e) => {
      e.preventDefault();
      const f = formData(e.target);
      const body = {
        publicUrl: f.publicUrl,
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
      ${u.source === 'local' ? `<div class="card" style="max-width:520px"><h2>Change password</h2>
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
