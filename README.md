# Pagemaster

A self-hosted control panel for hosting websites straight from git repositories. Runs as one Docker container, so it works on **TrueNAS SCALE**, **Proxmox** (Docker in an LXC or VM), Portainer, Dockge, Unraid, or plain `docker compose`.

- **Web UI** to add any number of repos from any git host (GitHub, GitLab, Bitbucket, Gitea/Forgejo/Codeberg, Azure DevOps, or self-hosted). HTTPS repos use tokens and SSH repos use a deploy key.
- **Git tokens.** GitHub, GitLab and other tokens are stored encrypted, and each site picks up the matching token by host automatically.
- **Static sites or apps.** Optional install and build commands (`npm ci`, `npm run build`, …), a publish folder (`dist`, `build`, …), SPA fallback, or a start command that keeps a server process running (Node/Express, Next.js standalone, etc.).
- **Auto-deploy** from a push webhook or a polling interval.
- **File browser** to browse, edit, upload, download, rename and delete files.
- **Built-in terminal**, a full shell inside the container in your browser.
- **User management** with fine-grained permissions. The default login is **`admin` / `admin`**, and you get a prompt to change it on first sign-in.
- **SSO (OpenID Connect)** for Authentik, Authelia, Keycloak, Zitadel, Pocket ID, Google, Entra ID and others. Local login stays available. New SSO users get the **lowest access** (`sites.view` only) until an admin raises it.
- **No port or URL overlap.** Each slug, domain and dedicated port can belong to only one site. Pagemaster rejects ports already used by another site, the admin UI, the shared hosting port, or any other program, so two repos never answer on the same address.

---

## Ports

| Port | Purpose |
|---|---|
| `8080` | Admin web UI (`ADMIN_PORT`) |
| `8081` | Shared hosting port (`HOSTING_PORT`). Serves every site by **domain**, by **`<slug>.<base domain>`**, or by path **`/<slug>/`** |
| `8100-8199` | Range a site can claim as its **own dedicated port** (`SITE_PORT_RANGE`) |

App-type sites also get an internal port (`20000-20999`, loopback only). Pagemaster assigns it, it never collides with another site, and the app reads it from `$PORT`.

> The ports published in Docker must match the env vars. If you change `SITE_PORT_RANGE` to `9000-9050`, publish `9000-9050:9000-9050`.

### Ways to reach a site

1. **Path:** `http://SERVER:8081/<slug>/`. Works right away, but sites that use absolute asset paths (`/assets/app.js`) may break when served under a sub-path.
2. **Dedicated port:** `http://SERVER:8100/`. Easiest, with no reverse proxy needed.
3. **Domain:** point `www.example.com` at your reverse proxy, forward it to `SERVER:8081`, and add the domain to the site.
4. **Wildcard:** set **Settings → Sites base domain** to `sites.example.com`, point `*.sites.example.com` at port 8081, and every site appears at `<slug>.sites.example.com`.

---

## Install

The image is built by GitHub Actions and published to `ghcr.io/nulljayden/pagemaster:latest` (amd64 + arm64).

> **First time only:** after the first workflow run, open GitHub → your profile → **Packages → pagemaster → Package settings** and set visibility to **Public**. Otherwise TrueNAS/Proxmox need registry credentials to pull it.

### TrueNAS SCALE (24.10 Electric Eel or newer)

1. Create a dataset for the data, e.g. `tank/apps/pagemaster`.
2. **Apps → Discover Apps → ⋮ (top right) → Install via YAML**.
3. Name it `pagemaster` and paste:

```yaml
services:
  pagemaster:
    image: ghcr.io/nulljayden/pagemaster:latest
    restart: unless-stopped
    environment:
      - TZ=America/New_York
      - ADMIN_PORT=8080
      - HOSTING_PORT=8081
      - SITE_PORT_RANGE=8100-8199
    ports:
      - "8080:8080"
      - "8081:8081"
      - "8100-8199:8100-8199"
    volumes:
      - /mnt/tank/apps/pagemaster:/data
```

4. Open `http://TRUENAS-IP:8080` and sign in with `admin` / `admin`.

If 8080 or 8081 is already taken on the NAS, change **both** the env var and the port mapping, e.g. `ADMIN_PORT=9080` with `"9080:9080"`.

### Proxmox VE

**Option A: Docker in an LXC (recommended)**

1. Create a Debian 12 LXC (unprivileged is fine) with **Options → Features → `nesting=1` and `keyctl=1`**.
2. Inside it, install Docker:

```bash
apt update && apt install -y curl && curl -fsSL https://get.docker.com | sh
```

3. Copy `docker-compose.yml` from this repo into e.g. `/opt/pagemaster/`, then:

```bash
cd /opt/pagemaster && docker compose up -d
```

4. Open `http://LXC-IP:8080`.

**Option B: a VM.** Same steps as A, inside any Linux VM with Docker.

**Option C: OCI image as an LXC (Proxmox VE 9.1+, tech preview).** Newer Proxmox versions can create a container straight from an OCI image. Pull `ghcr.io/nulljayden/pagemaster:latest` from the storage's *Pull from OCI Registry* option, create the CT from it, and add a mount point at `/data`. With an LXC there's no port mapping, so the ports above are served directly on the CT's IP.

### Plain Docker

```bash
docker run -d --name pagemaster --restart unless-stopped \
  -p 8080:8080 -p 8081:8081 -p 8100-8199:8100-8199 \
  -v /srv/pagemaster:/data ghcr.io/nulljayden/pagemaster:latest
```

Build it yourself instead:

```bash
docker build -t pagemaster . && docker compose up -d
```

(After building, change `image:` to `pagemaster`, or uncomment `build: .` in the compose file.)

---

## Using it

1. **Sign in** with `admin` / `admin`, then change the password when prompted (or later under **My Account**, where you can also rename the admin user).
2. **Private repos.** Go to **Git Credentials → Add token**, pick the provider (GitHub, GitLab, …) and paste the token. For SSH URLs, use **Generate SSH key** and add the public key as a deploy key on the repo.
3. **Add a site.** Go to **Sites → + Add site** and fill in the repo URL, branch, and optionally build commands, publish folder, domains or a dedicated port.
4. **Auto-deploy.** Under **Webhook** on a site, copy the URL into your git host as a push webhook, or set *Auto-pull every N minutes*.

Typical setups:

| Project | Type | Install | Build | Publish dir | Start |
|---|---|---|---|---|---|
| Plain HTML | Static | | | *(blank)* or `public` | |
| Vite / React / Vue | Static + SPA | `npm ci` | `npm run build` | `dist` | |
| Create React App | Static + SPA | `npm ci` | `npm run build` | `build` | |
| Astro / Hugo-like output | Static | `npm ci` | `npm run build` | `dist` | |
| Express / Node server | App | `npm ci` | | | `node server.js` |
| Next.js | App | `npm ci` | `npm run build` | | `npm start` |

The image includes Node 22, npm, git and ssh. If you need another runtime (Python, PHP, Hugo, …), install it from the Terminal (it won't survive container updates) or extend the image with your own `FROM ghcr.io/nulljayden/pagemaster`.

## Permissions

| Permission | Allows |
|---|---|
| `sites.view` | See sites, status and logs *(SSO default)* |
| `sites.deploy` | Pull / redeploy / start / stop |
| `sites.manage` | Add, edit, delete sites |
| `credentials.manage` | Git tokens & SSH key |
| `files.read` / `files.write` | File browser read / write |
| `terminal` | Shell in the container. **This is effectively full access**, so only give it to people you trust |
| `users.manage` | Manage users (non-admins can only grant permissions they have themselves) |
| `settings.manage` | SSO & system settings |

Admins have everything. At least one active admin always has to exist.

## SSO setup (OIDC)

1. In your identity provider, create an OIDC / OAuth2 application with a confidential client and the *authorization code* flow.
2. Set the redirect URI to `https://YOUR-PAGEMASTER/auth/sso/callback`. The exact value is shown in **Settings**, so set **Public URL** first if you use a reverse proxy.
3. In Pagemaster **Settings**, enter the issuer URL, client ID and secret, then tick **Enable SSO login**.
4. New SSO users only get the permissions ticked under *Default permissions*. Raise their access in **Users**.

## Reverse proxy / HTTPS

Put Nginx Proxy Manager, Traefik, Caddy, etc. in front of it:

- `pagemaster.example.com` → `SERVER:8080`. Set `TRUST_PROXY=true` and `COOKIE_SECURE=true`, and set **Public URL** in Settings. Enable WebSocket support so the terminal works.
- `example.com`, `*.sites.example.com` → `SERVER:8081`.

## Storage requirements (important on TrueNAS)

`npm ci`/builds and App sites need to **execute files** inside `/data/sites` (e.g. `node_modules/.bin/*`, native modules). That fails, with `npm error code 126` / `sh: cross-env: Permission denied`, when the storage behind `/data` has:

- **Exec = Off** (mounted `noexec`), or
- **ACL Mode = Restricted**, which is the TrueNAS **SMB** dataset preset. `chmod +x` is silently ignored there.

Pagemaster checks this at startup and before each build, and shows a red banner on the Sites page if the storage can't run programs. Static sites without install/build commands still work.

**Fix (pick one):**

1. **Fix the dataset.** In TrueNAS go to Datasets → your dataset → Edit → Advanced Options, then set **Exec: On** and **ACL Mode: Passthrough** (or Discard). Or create a new dataset with the **Generic** or **Apps** preset instead of SMB. Redeploy the site afterwards. Delete the site's folder first so npm re-installs with the right permissions, or just delete and re-add the site.
2. **Keep the dataset, put the sites on a Docker volume.** Docker named volumes always allow exec:

```yaml
    volumes:
      - /mnt/tank/apps/pagemaster:/data
      - pagemaster-sites:/data/sites   # sites + node_modules live here
volumes:
  pagemaster-sites:
```

Settings, users and tokens stay on your dataset. The cloned sites live in the volume, which you can rebuild from git anytime.

### Apps that redirect to absolute paths

Many apps redirect to `/login`, `/dashboard`, etc. Those break on the shared `/<slug>/` path. Give such sites a **dedicated port** (e.g. `8102`) or a **domain** instead.

## Data & backup

Everything lives in `/data`:

- `pagemaster.json`: users, sites, settings
- `secret.key`: encryption key for tokens
- `sites/`: cloned repos
- `logs/`
- `ssh/`

Snapshot that dataset or folder to back up. Deleting `pagemaster.json` resets the panel to `admin` / `admin`.

## Environment variables

| Var | Default | |
|---|---|---|
| `ADMIN_PORT` | `8080` | Admin UI port |
| `HOSTING_PORT` | `8081` | Shared hosting port |
| `SITE_PORT_RANGE` | `8100-8199` | Allowed dedicated site ports |
| `APP_PORT_RANGE` | `20000-20999` | Internal app ports (not published) |
| `DATA_DIR` | `/data` | Data location |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-*` headers |
| `COOKIE_SECURE` | `false` | HTTPS-only session cookie |
| `SESSION_DAYS` | `7` | Login session lifetime |
