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
- **Slug URLs, no ports.** Every site lives at `http://server/<slug>/`. Apps that redirect to `/login` or link to `/assets/...` still work under the slug: redirects and cookies are rewritten, and absolute links get routed back into the right site.
- **Live site previews.** Each site card shows a thumbnail, and the preview window has desktop, tablet and phone sizes.
- **Cloudflare Tunnels per user.** Each user connects their own Cloudflare account (API token) and publishes sites at `https://<sub>.<their domain>`. Pagemaster creates the tunnel, public hostnames and DNS records, and runs `cloudflared`. A pasted tunnel token also works.
- **No port or URL overlap.** Each slug, domain and dedicated port can belong to only one site. Pagemaster rejects ports already used by another site, the admin UI, the shared hosting port, or any other program, so two repos never answer on the same address.

---

## Ports & addresses

| Container port | Published as | Purpose |
|---|---|---|
| `38080` | `38080` | Admin web UI (`ADMIN_PORT`) |
| `38081` | `38081` | All sites (`HOSTING_PORT`), at **`http://server:38081/<slug>/`**, and where Cloudflare tunnels deliver traffic |
| `8100-8199` | *(not published by default)* | Optional dedicated per-site ports (Advanced, rarely needed) |

Keep the container port and the published port the same (`38081:38081`). If you do publish on a different host port, set `HOSTING_PUBLIC_PORT` to it so the links in the UI match. With Cloudflare Tunnels the port never shows up anywhere public: visitors use `https://<sub>.yourdomain.com`. App-type sites also get an internal loopback port (`20000-20999`), assigned automatically, never shared, and passed to the app as `$PORT`.

### Ways to reach a site

1. **Slug (local):** `http://SERVER:38081/<slug>/`. Works right away on your LAN, with no DNS needed.
2. **Cloudflare Tunnel:** `https://<slug>.yourdomain.com` from anywhere, with no port-forwarding. See [Cloudflare Tunnels](#cloudflare-tunnels-per-user).
3. **Your own domain / reverse proxy:** point `www.example.com` at `SERVER:38081` and add the domain to the site (Edit → Advanced).
4. **Wildcard:** set **Settings → Sites base domain** to `sites.example.com`, point `*.sites.example.com` at the server, and every site appears at `<slug>.sites.example.com`.

If you reach the sites through a reverse proxy, set **Settings → Sites URL** (e.g. `https://sites.example.com`) so the panel shows `https://sites.example.com/<slug>/`.

**How slug paths handle apps written for `/`:** Pagemaster rewrites app redirects (`/login` becomes `/<slug>/login`) and scopes the app's cookies to `/<slug>/`, so two apps can't overwrite each other's logins. When a page under `/<slug>/` requests an absolute path like `/static/app.css`, it redirects that request into `/<slug>/static/app.css`, using the page's Referer or a "last site visited" cookie to pick the site. One limit: if an app links to `/foo/...` and another site has the slug `foo`, that link goes to the `foo` site. Use a tunnel or domain for that app.

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
      - ADMIN_PORT=38080
      - HOSTING_PORT=38081
    ports:
      - "38080:38080"
      - "38081:38081"
    volumes:
      - /mnt/tank/apps/pagemaster:/data        # settings, users, tokens, logs
      - pagemaster-sites:/data/sites           # cloned sites + node_modules
volumes:
  pagemaster-sites:
```

   The second volume keeps the site files (and `node_modules`) on a Docker volume, which always allows running programs. A TrueNAS dataset with the SMB preset or `exec=off` would otherwise break `npm ci` with "Permission denied" (exit code 126). See [Storage requirements](#storage-requirements-important-on-truenas). You can still browse and edit the files with the built-in **Files** page.

4. Open `http://TRUENAS-IP:38080` and sign in with `admin` / `admin`.

> **Updating:** TrueNAS does not re-download `:latest` when you redeploy. To update, open **System → Shell** and run `docker pull ghcr.io/nulljayden/pagemaster:latest`, then stop and start the app. Or pin a version in the YAML, e.g. `image: ghcr.io/nulljayden/pagemaster:sha-5e8c8bc`, and change it to update. Every build is tagged `sha-<commit>`.
>
> Ports 38080/38081 don't clash with the TrueNAS UI or common apps. To use different ones, change **both** the env var and the mapping (e.g. `ADMIN_PORT=40080` with `"40080:40080"`). Tunnels follow `HOSTING_PORT` automatically.

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

4. Open `http://LXC-IP:38080`.

**Option B: a VM.** Same steps as A, inside any Linux VM with Docker.

**Option C: OCI image as an LXC (Proxmox VE 9.1+, tech preview).** Newer Proxmox versions can create a container straight from an OCI image. Pull `ghcr.io/nulljayden/pagemaster:latest` from the storage's *Pull from OCI Registry* option, create the CT from it, and add a mount point at `/data`. With an LXC there's no port mapping, so the ports above are served directly on the CT's IP.

### Plain Docker

```bash
docker run -d --name pagemaster --restart unless-stopped \
  -p 38080:38080 -p 38081:38081 \
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
| `tunnels.manage` | Connect **their own** Cloudflare account and publish sites through **their own** tunnels. Users only ever see their own tunnels; admins see all |
| `users.manage` | Manage users (non-admins can only grant permissions they have themselves) |
| `settings.manage` | SSO & system settings |

Admins have everything. At least one active admin always has to exist.

## SSO setup (OIDC)

1. In your identity provider, create an OIDC / OAuth2 application with a confidential client and the *authorization code* flow.
2. Set the redirect URI to `https://YOUR-PAGEMASTER/auth/sso/callback`. The exact value is shown in **Settings**, so set **Public URL** first if you use a reverse proxy.
3. In Pagemaster **Settings**, enter the issuer URL, client ID and secret, then tick **Enable SSO login**.
4. New SSO users only get the permissions ticked under *Default permissions*. Raise their access in **Users**.

## Cloudflare Tunnels (per user)

Each user with the `tunnels.manage` permission can connect **their own** Cloudflare account on the **Tunnels** page. Users can't see or change each other's tunnels; admins can see all of them. When a user is deleted, their tunnels are deleted too, including the tunnel and DNS records Pagemaster created in their Cloudflare account.

**API token mode (recommended).** Pagemaster does all the Cloudflare work.

1. In Cloudflare, go to **My Profile → API Tokens → Create Token → Custom token** with these permissions:
   - Account → **Cloudflare Tunnel** → Edit
   - Zone → **DNS** → Edit
   - Zone → **Zone** → Read

   Under *Zone Resources*, pick **Include → All zones** (or your domain). DNS is a **Zone** permission: picking "all permissions" in the Account section does **not** include it. Without it you get `Authentication error (10000)` when publishing.

   If your token is missing DNS permission, Pagemaster still publishes the site and shows the exact `CNAME` record to add by hand. You can also fix the token and use **Update API token** on the tunnel; Pagemaster then creates any missing DNS records itself.
2. In Pagemaster, go to **Tunnels → + Connect Cloudflare**, paste the token, click **Check token**, pick the account, then **Create tunnel**.
3. Click **+ Publish a site**, pick the site, a subdomain (defaults to the slug) and the domain. Pagemaster adds the tunnel's public hostname and a proxied `CNAME` record. The site is live at `https://<sub>.<domain>` within a minute.

Removing a hostname or deleting the tunnel cleans up the DNS records and the tunnel in Cloudflare. Pagemaster refuses to touch a DNS name that already has a different record, so it won't overwrite an existing site.

**Tunnel token mode.** Use this if you already manage the tunnel yourself.

1. In Zero Trust go to **Networks → Tunnels → Create a tunnel (Cloudflared)**, and copy the install command or token.
2. In Pagemaster, go to **Tunnels → + Connect Cloudflare → Tunnel token** and paste it. Any of Cloudflare's install commands works.
3. In the Cloudflare dashboard, add a public hostname with service **HTTP** → `localhost:38081`. Then in Pagemaster use **+ Publish a site** with the same hostname.

`cloudflared` runs inside the Pagemaster container, one process per tunnel. It restarts automatically and shows its status (connected, starting, error) and logs on the Tunnels page. Tunnels connect outbound only, so you don't need port-forwarding or a public IP, and the sites port never needs to be exposed outside your LAN.

## Reverse proxy / HTTPS

Put Nginx Proxy Manager, Traefik, Caddy, etc. in front of it:

- `pagemaster.example.com` → `SERVER:38080`. Set `TRUST_PROXY=true` and `COOKIE_SECURE=true`, and set **Public URL** in Settings. Enable WebSocket support so the terminal works.
- `example.com`, `*.sites.example.com` → `SERVER:38081`.

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
| `ADMIN_PORT` | `38080` | Admin UI port |
| `HOSTING_PORT` | `38081` | Sites port (slug paths, domains, Cloudflare tunnels) |
| `HOSTING_PUBLIC_PORT` | same as `HOSTING_PORT` | Only if the sites port is published on a different host port; used for links in the UI |
| `CLOUDFLARED_BIN` | `cloudflared` | Path to cloudflared (bundled in the image) |
| `SITE_PORT_RANGE` | `8100-8199` | Allowed dedicated site ports |
| `APP_PORT_RANGE` | `20000-20999` | Internal app ports (not published) |
| `DATA_DIR` | `/data` | Data location |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-*` headers |
| `COOKIE_SECURE` | `false` | HTTPS-only session cookie |
| `SESSION_DAYS` | `7` | Login session lifetime |
