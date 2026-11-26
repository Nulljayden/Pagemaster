// Per-site access: owner, admins, global permissions, and per-site members.
const { db } = require('./db');

// Permissions that can be granted on a single site
const SITE_PERMS = {
  view: 'See the site, its status, logs, notes and analytics',
  deploy: 'Pull / redeploy / start / stop, clear logs',
  manage: 'Edit settings, addresses and webhook (build/start commands run in the container)',
  'files.read': 'Browse and download its files',
  'files.write': 'Upload, edit and delete its files',
  'notes.edit': 'Edit the site notes',
  'passwords.view': 'See and copy the site\'s saved passwords',
  'passwords.edit': 'Add, change and delete saved passwords',
};

// Global permission that already covers each site permission on every site
// (Passwords have no global permission: only admins, the owner and members get them.)
const GLOBAL = { view: 'sites.view', deploy: 'sites.deploy', manage: 'sites.manage', 'files.read': 'files.read', 'files.write': 'files.write', 'notes.edit': 'sites.manage' };

function isStaff(user) {
  return !!user && (user.isAdmin || user.isLimitedAdmin);
}

function cleanSitePerms(list) {
  return [...new Set((Array.isArray(list) ? list : []).filter((p) => SITE_PERMS[p]))];
}

function member(site, user) {
  return (site.members || []).find((m) => m.userId === user.id);
}

function isOwner(user, site) {
  return !!user && site.ownerId === user.id;
}

function siteCan(user, site, perm) {
  if (!user || user.disabled || !site) return false;
  if (isStaff(user) || isOwner(user, site)) return true;
  if (GLOBAL[perm] && (user.permissions || []).includes(GLOBAL[perm])) return true;
  if (perm === 'view' && site.panelVisibility === 'public') return true;
  const m = member(site, user);
  if (!m || !m.perms.length) return false;
  if (m.perms.includes(perm)) return true;
  if (perm === 'view') return true; // any site permission implies seeing the site
  if (perm === 'deploy') return m.perms.includes('manage');
  if (perm === 'files.read') return m.perms.includes('files.write');
  if (perm === 'passwords.view') return m.perms.includes('passwords.edit');
  return false;
}

// Who may share the site with others and delete it
function canShare(user, site) {
  if (!user || user.disabled) return false;
  return isStaff(user) || isOwner(user, site) || (user.permissions || []).includes('sites.manage');
}

// Only the owner or an admin can give the site away
function canTransfer(user, site) {
  return !!user && !user.disabled && (isStaff(user) || isOwner(user, site));
}

function myAccess(user, site) {
  const o = {};
  for (const p of Object.keys(SITE_PERMS)) o[p] = siteCan(user, site, p);
  o.owner = isOwner(user, site);
  o.share = canShare(user, site);
  o.transfer = canTransfer(user, site);
  return o;
}

function visibleSites(user) {
  return db().sites.filter((s) => siteCan(user, s, 'view'));
}

// Does the user have this permission on at least one site?
function anySite(user, perm) {
  return db().sites.some((s) => siteCan(user, s, perm));
}

module.exports = { isStaff, SITE_PERMS, cleanSitePerms, siteCan, canShare, canTransfer, myAccess, visibleSites, anySite, isOwner };
