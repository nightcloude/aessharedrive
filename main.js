/**
 * AES Collaboration Drive — Cloudflare Worker (plain JS)
 *
 * 1:1 migration of the original PHP system with these changes:
 * - No real file uploads. "Upload" / "New File" becomes "Upload Share Link".
 * - Every item stores a Google Docs / Google Drive share URL.
 * - Clicking a listed file redirects the browser to that share URL.
 * - Folders, rename, delete, comments, version history (extra share links),
 *   My Drive / Shared Drive, login, and all original UI are preserved.
 *
 * Bindings expected in wrangler.toml:
 *   [[d1_databases]]
 *   binding = "DB"
 *   database_name = "ts-drive"
 *   database_id = "<your-d1-id>"
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function h(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'
    }
  });
}

function redirect(url, status = 303) {
  return new Response(null, {
    status,
    headers: { Location: url }
  });
}

function buildQueryUrl(params) {
  const clean = {};
  for (const [k, v] of Object.entries(params || {})) {
    if (v === null || v === undefined || v === '') continue;
    clean[k] = v;
  }
  const q = new URLSearchParams(clean).toString();
  return 'index.php' + (q ? '?' + q : '');
}

function safeName(name) {
  name = String(name || '').replace(/\\/g, '/').split('/').pop().trim();
  if (!name || name === '.' || name === '..') return '';
  return name;
}

function parseCookies(request) {
  const raw = request.headers.get('Cookie') || '';
  const out = {};
  raw.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}

function setCookie(name, value, maxAge = 60 * 60 * 24 * 30) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

function clearCookie(name) {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function isValidUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// D1 schema bootstrap
// ---------------------------------------------------------------------------

async function ensureSchema(db) {
  // teachers
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS teachers (
      teacher_id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      firstname TEXT,
      lastname TEXT,
      department_id INTEGER,
      location TEXT,
      about TEXT,
      teacher_status TEXT,
      teacher_stat TEXT
    )
  `).run();

  // folders (hierarchical)
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL,
      parent_id INTEGER,
      name TEXT NOT NULL,
      is_shared INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `).run();

  // items = share-link "files"
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_id INTEGER,
      name TEXT NOT NULL,
      share_url TEXT NOT NULL,
      created_by INTEGER NOT NULL,
      current_version INTEGER NOT NULL DEFAULT 1,
      is_shared INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `).run();

  // version history (extra share links)
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS item_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL,
      version_number INTEGER NOT NULL,
      share_url TEXT NOT NULL,
      comment TEXT,
      uploaded_by INTEGER NOT NULL,
      uploaded_at TEXT DEFAULT (datetime('now'))
    )
  `).run();

  // comments
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS comments (
      comment_id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL,
      teacher_id INTEGER NOT NULL,
      comment TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `).run();

  // sessions (simple)
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      teacher_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT
    )
  `).run();

  // seed demo + admin accounts if empty
  const count = await db.prepare('SELECT COUNT(*) AS c FROM teachers').first();
  if (count && count.c === 0) {
    await db.prepare(`
      INSERT INTO teachers (username, password, firstname, lastname)
      VALUES ('admin', 'admin', 'Master', 'Admin')
    `).run();
    await db.prepare(`
      INSERT INTO teachers (username, password, firstname, lastname)
      VALUES ('teacher', 'teacher123', 'Demo', 'Teacher')
    `).run();
  } else {
    // ensure admin always exists
    const admin = await db.prepare(
      "SELECT teacher_id FROM teachers WHERE username = 'admin' LIMIT 1"
    ).first();
    if (!admin) {
      await db.prepare(`
        INSERT INTO teachers (username, password, firstname, lastname)
        VALUES ('admin', 'admin', 'Master', 'Admin')
      `).run();
    }
  }
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

async function findTeacherLogin(db, username, password) {
  return db.prepare(
    'SELECT teacher_id, username, firstname, lastname FROM teachers WHERE username = ? AND password = ? LIMIT 1'
  ).bind(username, password).first();
}

async function findTeacherById(db, teacherId) {
  return db.prepare(
    'SELECT teacher_id, username, firstname, lastname FROM teachers WHERE teacher_id = ? LIMIT 1'
  ).bind(teacherId).first();
}

async function createSession(db, teacherId) {
  const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await db.prepare(
    'INSERT INTO sessions (token, teacher_id, expires_at) VALUES (?, ?, ?)'
  ).bind(token, teacherId, expires).run();
  return token;
}

async function getSessionTeacher(db, token) {
  if (!token) return null;
  const row = await db.prepare(`
    SELECT s.teacher_id, t.username, t.firstname, t.lastname
    FROM sessions s
    JOIN teachers t ON t.teacher_id = s.teacher_id
    WHERE s.token = ? AND (s.expires_at IS NULL OR s.expires_at > datetime('now'))
    LIMIT 1
  `).bind(token).first();
  return row || null;
}

async function destroySession(db, token) {
  if (!token) return;
  await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
}

// ---------------------------------------------------------------------------
// Folder / item helpers
// ---------------------------------------------------------------------------

async function getOrCreateRootFolder(db, ownerId, isShared) {
  let folder = await db.prepare(
    'SELECT id FROM folders WHERE owner_id = ? AND parent_id IS NULL AND is_shared = ? LIMIT 1'
  ).bind(ownerId, isShared ? 1 : 0).first();

  if (!folder) {
    // for shared drive we use a global shared root (owner_id = 0)
    const oid = isShared ? 0 : ownerId;
    const res = await db.prepare(
      'INSERT INTO folders (owner_id, parent_id, name, is_shared) VALUES (?, NULL, ?, ?)'
    ).bind(oid, isShared ? 'Shared Drive' : 'My Drive', isShared ? 1 : 0).run();
    folder = { id: res.meta.last_row_id };
  }
  return folder.id;
}

async function resolveFolderPath(db, ownerId, isShared, pathStr) {
  const rootId = await getOrCreateRootFolder(db, ownerId, isShared);
  if (!pathStr || pathStr === '') return { folderId: rootId, path: '' };

  const parts = pathStr.replace(/\\/g, '/').split('/').filter(Boolean);
  let currentId = rootId;
  let built = [];

  for (const part of parts) {
    const name = safeName(part);
    if (!name) continue;
    let child = await db.prepare(
      'SELECT id FROM folders WHERE parent_id = ? AND name = ? AND is_shared = ? LIMIT 1'
    ).bind(currentId, name, isShared ? 1 : 0).first();

    if (!child) {
      // create missing folder on the fly (same as PHP safe path behaviour)
      const res = await db.prepare(
        'INSERT INTO folders (owner_id, parent_id, name, is_shared) VALUES (?, ?, ?, ?)'
      ).bind(isShared ? 0 : ownerId, currentId, name, isShared ? 1 : 0).run();
      child = { id: res.meta.last_row_id };
    }
    currentId = child.id;
    built.push(name);
  }
  return { folderId: currentId, path: built.join('/') };
}

async function listFolderContents(db, folderId, isShared) {
  const folders = await db.prepare(`
    SELECT id, name, created_at AS modified
    FROM folders WHERE parent_id = ? AND is_shared = ?
    ORDER BY name COLLATE NOCASE
  `).bind(folderId, isShared ? 1 : 0).all();

  const items = await db.prepare(`
    SELECT i.id, i.name, i.share_url, i.current_version, i.updated_at AS modified,
           (SELECT COUNT(*) FROM comments c WHERE c.item_id = i.id) AS commentCount,
           (SELECT COUNT(*) FROM item_versions v WHERE v.item_id = i.id) AS versionCount
    FROM items i
    WHERE i.folder_id = ? AND i.is_shared = ?
    ORDER BY i.name COLLATE NOCASE
  `).bind(folderId, isShared ? 1 : 0).all();

  const result = [];
  for (const f of (folders.results || [])) {
    result.push({
      id: f.id,
      name: f.name,
      isDir: true,
      size: '--',
      modified: formatDate(f.modified),
      commentCount: 0,
      versionCount: 0
    });
  }
  for (const it of (items.results || [])) {
    result.push({
      id: it.id,
      name: it.name,
      isDir: false,
      share_url: it.share_url,
      size: 'Link',
      modified: formatDate(it.modified),
      commentCount: it.commentCount || 0,
      versionCount: it.versionCount || 0,
      currentVersion: it.current_version
    });
  }
  return result;
}

function formatDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso.includes('T') ? iso : iso + 'Z');
    return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
  } catch {
    return iso;
  }
}

async function getItemById(db, itemId) {
  return db.prepare('SELECT * FROM items WHERE id = ? LIMIT 1').bind(itemId).first();
}

async function getItemByName(db, folderId, name, isShared) {
  return db.prepare(
    'SELECT * FROM items WHERE folder_id = ? AND name = ? AND is_shared = ? LIMIT 1'
  ).bind(folderId, name, isShared ? 1 : 0).first();
}

async function getCommentsForItem(db, itemId, currentTeacherId) {
  const rows = await db.prepare(`
    SELECT c.comment_id, c.teacher_id, c.comment, c.created_at,
           t.username, t.firstname, t.lastname
    FROM comments c
    LEFT JOIN teachers t ON t.teacher_id = c.teacher_id
    WHERE c.item_id = ?
    ORDER BY c.created_at ASC, c.comment_id ASC
  `).bind(itemId).all();

  const versions = await db.prepare(`
    SELECT v.id, v.version_number, v.share_url, v.comment, v.uploaded_at,
           t.username, t.firstname, t.lastname
    FROM item_versions v
    LEFT JOIN teachers t ON t.teacher_id = v.uploaded_by
    WHERE v.item_id = ?
    ORDER BY v.uploaded_at ASC, v.id ASC
  `).bind(itemId).all();

  const comments = [];
  for (const row of (rows.results || [])) {
    const author = ((row.firstname || '') + ' ' + (row.lastname || '')).trim() || row.username || 'Unknown User';
    comments.push({
      id: row.comment_id,
      type: 'comment',
      author,
      text: row.comment,
      created_at: row.created_at,
      can_delete: row.teacher_id === currentTeacherId
    });
  }
  for (const row of (versions.results || [])) {
    const author = ((row.firstname || '') + ' ' + (row.lastname || '')).trim() || row.username || 'User';
    comments.push({
      id: row.id,
      type: 'version',
      author,
      text: row.comment || '',
      created_at: row.uploaded_at,
      version: row.version_number,
      view_url: row.share_url,
      can_delete: false
    });
  }
  comments.sort((a, b) => {
    const ta = new Date(a.created_at || 0).getTime();
    const tb = new Date(b.created_at || 0).getTime();
    if (ta === tb) return (a.id || 0) - (b.id || 0);
    return ta - tb;
  });
  return comments;
}

async function getVersionList(db, itemId) {
  const rows = await db.prepare(`
    SELECT v.*, t.username, t.firstname, t.lastname
    FROM item_versions v
    LEFT JOIN teachers t ON t.teacher_id = v.uploaded_by
    WHERE v.item_id = ?
    ORDER BY v.version_number DESC, v.id DESC
  `).bind(itemId).all();
  return rows.results || [];
}

// ---------------------------------------------------------------------------
// UI fragments (exact visual design from original drive_ui.php)
// ---------------------------------------------------------------------------

const CSS_LOGIN = `
:root{--navy:#081c2b;--navy-2:#062638;--blue:#4d91f7;--blue-dark:#367bdc;--green:#00c978;--green-dark:#00a968;--muted:#91a6b6;--text:#eef5fa;--border:rgba(255,255,255,.10);--glass:rgba(24,47,63,.78);}
*{box-sizing:border-box;}
html,body{width:100%;min-height:100%;margin:0;}
body{font-family:Inter,Arial,sans-serif;}
.login-page{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:#eef2f7;}
.login-wrapper{width:min(1180px,100%);min-height:700px;background:var(--navy);border-radius:20px;padding:10px;box-shadow:0 28px 70px rgba(8,28,43,.25);display:flex;overflow:hidden;}
.login-left{flex:0 0 44%;min-height:680px;border-radius:14px;overflow:hidden;position:relative;display:flex;flex-direction:column;justify-content:space-between;padding:34px;color:#fff;background:linear-gradient(145deg,rgba(8,28,43,.82),rgba(8,28,43,.30)),url("https://images.unsplash.com/photo-1497366754035-f200968a6e72?auto=format&fit=crop&w=1400&q=85") center/cover;}
.login-left:after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(8,28,43,.12),rgba(8,28,43,.70));pointer-events:none;}
.login-brand,.login-hero,.login-left-footer{position:relative;z-index:2;}
.login-brand{display:flex;align-items:center;gap:10px;font-size:21px;font-weight:500;}
.login-brand img{width:38px;height:38px;object-fit:contain;}
.login-brand strong{color:#fff;}
.login-hero{margin-top:auto;margin-bottom:auto;padding-top:120px;padding-bottom:80px;}
.login-hero small{display:block;color:#9ed9c0;text-transform:uppercase;letter-spacing:.16em;font-size:11px;font-weight:700;margin-bottom:15px;}
.login-hero h2{margin:0;max-width:420px;font-size:42px;line-height:1.08;letter-spacing:-1.5px;font-weight:600;}
.login-hero p{max-width:400px;margin:18px 0 0;color:rgba(255,255,255,.76);font-size:14px;line-height:1.7;}
.login-left-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;}
.login-left-footer a{color:#fff;text-decoration:none;border:1px solid rgba(0,201,120,.55);background:rgba(8,28,43,.65);padding:10px 14px;border-radius:9px;font-size:12px;}
.login-dots{display:flex;gap:6px;}
.login-dots span{width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,.35);}
.login-dots span.active{width:22px;border-radius:10px;background:var(--green);}
.login-right{flex:1;min-width:0;padding:52px 56px 32px;color:var(--text);display:flex;flex-direction:column;justify-content:center;}
.login-form-wrap{width:100%;max-width:440px;margin:0 auto;}
.login-eyebrow{color:var(--green);font-size:11px;font-weight:700;letter-spacing:.13em;text-transform:uppercase;margin-bottom:12px;}
.login-right h1{margin:0;font-size:31px;letter-spacing:-.7px;}
.login-subtitle{margin:9px 0 28px;color:var(--muted);font-size:13px;line-height:1.6;}
.login-error{padding:12px 14px;border-radius:10px;margin-bottom:16px;background:rgba(239,68,68,.13);border:1px solid rgba(239,68,68,.30);color:#ffb2b2;font-size:12px;}
.login-card{background:var(--glass);border:1px solid var(--border);border-radius:15px;padding:24px;backdrop-filter:blur(18px);box-shadow:0 18px 45px rgba(0,0,0,.18);}
.login-field{margin-bottom:16px;}
.login-field label{display:block;margin-bottom:7px;color:#c8d6df;font-size:12px;font-weight:600;}
.login-field input{width:100%;border:1px solid rgba(255,255,255,.12);background:rgba(5,24,36,.68);color:#fff;border-radius:10px;padding:12px 13px;font-family:inherit;font-size:13px;outline:none;transition:.2s;}
.login-field input::placeholder{color:#617889;}
.login-field input:focus{border-color:rgba(77,145,247,.8);box-shadow:0 0 0 3px rgba(77,145,247,.10);}
.login-button{width:100%;border:0;border-radius:10px;padding:13px;background:var(--blue);color:#fff;font-family:inherit;font-size:13px;font-weight:700;cursor:pointer;transition:.2s;}
.login-button:hover{background:var(--blue-dark);transform:translateY(-1px);}
.login-footer-note{text-align:center;color:#607789;font-size:10px;margin-top:22px;}
@media(max-width:900px){.login-wrapper{min-height:auto;}.login-left{display:none;}.login-right{padding:55px 30px;min-height:650px;}}
@media(max-width:520px){.login-page{padding:12px;align-items:stretch;}.login-wrapper{width:100%;min-height:calc(100vh - 24px);border-radius:15px;padding:7px;}.login-right{padding:32px 18px;}.login-right h1{font-size:26px;}.login-card{padding:18px;}}
`;

const CSS_DRIVE = `
:root{--navy:#081c2b;--navy-2:#062638;--blue:#4d91f7;--blue-dark:#367bdc;--green:#00c978;--green-dark:#00a968;--text:#172a38;--secondary:#405867;--muted:#718797;--surface:#ffffff;--soft:#eef2f7;--soft-2:#f5f8fa;--border:#dce5eb;--border-light:#edf1f4;--danger:#e85b5b;--shadow:0 10px 30px rgba(8,28,43,.07);--shadow-lg:0 20px 55px rgba(8,28,43,.14);}
*{box-sizing:border-box;}
html,body{width:100%;height:100%;}
body{margin:0;font-family:Inter,Arial,sans-serif;background:var(--soft);color:var(--text);overflow:hidden;}
button,input,textarea,select{font-family:inherit;}
.drive-header{height:70px;background:var(--navy);color:#fff;border-bottom:1px solid rgba(255,255,255,.07);display:flex;align-items:center;justify-content:space-between;padding:0 28px;position:relative;z-index:100;}
.logo-area{display:flex;align-items:center;font-size:19px;font-weight:400;min-width:0;}
.logo-area img{width:34px;height:34px;object-fit:contain;margin-right:9px;}
.logo-AES{color:var(--green);font-weight:700;}
.user-area{display:flex;align-items:center;gap:17px;font-size:12px;min-width:0;}
.user-name{color:#dce8ef;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.logout{color:#91a6b6;text-decoration:none;white-space:nowrap;transition:.2s;}
.logout:hover{color:#fff;}
.main-container{display:flex;height:calc(100vh - 70px);background:var(--soft);}
aside{width:270px;padding:20px 15px;display:flex;flex-direction:column;background:var(--navy);flex-shrink:0;overflow-y:auto;}
.btn-back-lms{padding:12px 15px;border-radius:10px;display:flex;align-items:center;gap:10px;cursor:pointer;font-size:12px;font-weight:600;width:100%;text-decoration:none;transition:.2s;background:rgba(255,255,255,.04);color:#b5c5ce;border:1px solid rgba(255,255,255,.08);margin-bottom:10px;}
.btn-back-lms:hover{background:rgba(255,255,255,.08);color:#fff;border-color:rgba(0,201,120,.35);}
.new-dropdown{position:relative;width:100%;display:block;margin-bottom:8px;}
.new-dropdown>summary{list-style:none;padding:12px 15px;border-radius:10px;display:flex;align-items:center;gap:10px;cursor:pointer;font-size:12px;font-weight:700;width:100%;transition:.2s;background:var(--blue);color:#fff;border:none;user-select:none;}
.new-dropdown>summary::-webkit-details-marker{display:none;}
.new-dropdown>summary:hover,.new-dropdown[open]>summary{background:var(--blue-dark);}
.new-menu{position:absolute;top:calc(100% + 7px);left:0;background:var(--navy-2);border:1px solid rgba(255,255,255,.12);box-shadow:var(--shadow-lg);border-radius:10px;width:205px;z-index:99999;padding:6px;color:#fff;}
.new-menu div{padding:10px 12px;cursor:pointer;font-size:12px;color:#c5d3dc;border-radius:7px;width:100%;}
.new-menu div:hover{background:rgba(255,255,255,.07);color:#fff;}
.nav-link{display:flex;align-items:center;gap:10px;padding:11px 13px;text-decoration:none;color:#91a6b6;border-radius:9px;font-size:12px;font-weight:500;margin-top:5px;border:1px solid transparent;transition:.2s;}
.nav-link:hover{background:rgba(255,255,255,.05);color:#fff;}
.nav-active{background:rgba(77,145,247,.15);color:#fff;font-weight:600;border-color:rgba(77,145,247,.25);}
.storage-container{background:rgba(255,255,255,.045);padding:14px;border-radius:11px;border:1px solid rgba(255,255,255,.08);margin-top:auto;}
.storage-label{font-size:10px;color:#91a6b6;line-height:1.5;}
.storage-bar{height:6px;background:rgba(255,255,255,.10);border-radius:4px;margin-top:9px;overflow:hidden;width:100%;}
.storage-fill{height:100%;background:var(--green);border-radius:4px;transition:width .25s;}
.content{flex-grow:1;background:#fff;margin:15px;border-radius:15px;border:1px solid var(--border);overflow:auto;box-shadow:var(--shadow);min-width:0;}
.drive-toolbar{min-height:61px;padding:14px 22px;border-bottom:1px solid var(--border);display:flex;align-items:center;background:#fff;position:sticky;top:0;z-index:20;}
.breadcrumb{font-size:13px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.breadcrumb-back{color:var(--blue);text-decoration:none;margin-right:12px;font-weight:600;}
.breadcrumb-back:hover{text-decoration:underline;}
.notice-banner{margin:14px 18px 0;padding:10px 13px;background:#edf5ff;color:#3169a8;border:1px solid #cfe1f8;border-radius:9px;font-size:11px;}
.drive-table-wrap{width:100%;overflow-x:auto;}
.drive-table{width:100%;border-collapse:collapse;}
.drive-table td,.drive-table th{padding:14px 20px;border-bottom:1px solid var(--border-light);text-align:left;font-size:12px;}
.drive-table th{background:#f5f8fa;font-weight:700;color:#718797;text-transform:uppercase;font-size:9px;letter-spacing:.06em;}
.drive-table td{color:var(--secondary);background:#fff;}
.drive-table tbody tr:hover td{background:#f8fafb;}
.file-name-link{color:#263d4c;text-decoration:none;font-weight:600;word-break:break-word;overflow-wrap:anywhere;}
.file-name-link:hover{color:var(--blue);}
.comment-count,.version-count{display:inline-flex;align-items:center;gap:3px;margin-left:6px;padding:3px 6px;border-radius:20px;background:#edf5ff;color:#3979c9;font-size:9px;font-weight:700;vertical-align:middle;}
.version-count{background:#edf9f4;color:#15915e;}
.mobile-file-date{display:none;font-size:10px;color:#91a6b6;margin-top:3px;}
.dots{cursor:pointer;padding:4px;border-radius:7px;width:29px;height:29px;display:inline-flex;align-items:center;justify-content:center;color:#8195a3;font-size:18px;}
.dots:hover{background:#edf5ff;color:var(--blue);}
.menu{display:none;position:fixed;background:var(--navy);border:1px solid rgba(255,255,255,.12);box-shadow:var(--shadow-lg);z-index:99999;border-radius:10px;padding:6px;min-width:190px;text-align:left;}
.menu a{display:block;padding:9px 12px;color:#c5d3dc;text-decoration:none;font-size:12px;border-radius:7px;}
.menu a:hover{background:rgba(255,255,255,.07);color:#fff;}
.empty-drive{padding:80px 20px;text-align:center;color:var(--muted);}
.empty-drive-icon{font-size:42px;margin-bottom:12px;}
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(8,28,43,.55);z-index:100000;align-items:center;justify-content:center;padding:20px;}
.share-card,.version-card{background:#fff;border-radius:14px;padding:22px;width:100%;max-width:440px;box-shadow:var(--shadow-lg);}
.version-card h2{margin:0 0 6px;font-size:17px;}
.version-subtitle{font-size:11px;color:var(--muted);margin-bottom:14px;}
.version-file-field{display:flex;flex-direction:column;gap:6px;margin-bottom:12px;}
.version-file-field label{font-size:10px;color:#607687;font-weight:700;}
.version-file-field input,.version-file-field textarea{width:100%;padding:10px 11px;border:1px solid var(--border);border-radius:9px;background:#fff;font-family:inherit;font-size:12px;outline:none;}
.version-file-field textarea{min-height:70px;resize:vertical;}
.share-link-box{background:#f5f8fa;border:1px solid var(--border);border-radius:9px;padding:12px;font-size:11px;word-break:break-all;margin-bottom:14px;color:#334957;}
.secondary-button,.download-button{display:inline-block;padding:9px 14px;border-radius:9px;font-size:11px;font-weight:700;cursor:pointer;border:1px solid var(--border);background:#fff;color:#334957;text-decoration:none;}
.download-button{background:var(--blue);border-color:var(--blue);color:#fff;}
.preview-container{position:fixed;inset:0;background:#fff;z-index:50000;display:flex;flex-direction:column;}
.preview-header{min-height:70px;background:var(--navy);color:#fff;display:flex;align-items:center;justify-content:space-between;padding:0 24px;}
.preview-header-title{font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.preview-header-actions{display:flex;gap:8px;}
.preview-content{flex:1;display:flex;overflow:hidden;}
.preview-media{flex:1;display:flex;align-items:center;justify-content:center;background:#f4f7fa;padding:20px;overflow:auto;}
.preview-media a.big-link{display:inline-block;padding:16px 28px;background:var(--blue);color:#fff;border-radius:12px;font-size:14px;font-weight:700;text-decoration:none;}
.comments-panel{width:340px;border-left:1px solid var(--border);display:flex;flex-direction:column;background:#fff;}
.comments-header{padding:14px 16px;border-bottom:1px solid var(--border);font-size:13px;font-weight:700;}
.comments-list{flex:1;overflow-y:auto;padding:12px;}
.comment-item{padding:12px;border-bottom:1px solid #edf1f4;}
.comment-author{font-size:12px;font-weight:700;color:#263d4c;}
.comment-date{font-size:10px;color:#91a1ac;margin-top:2px;}
.comment-text{font-size:12px;color:#405867;margin-top:6px;white-space:pre-wrap;}
.comment-delete{font-size:10px;color:#e85b5b;text-decoration:none;}
.comment-empty{padding:30px;text-align:center;color:var(--muted);font-size:12px;}
.comment-form{padding:13px;border-top:1px solid var(--border);background:#f5f8fa;}
.comment-form textarea{width:100%;min-height:75px;resize:vertical;border:1px solid var(--border);border-radius:8px;padding:9px 10px;background:#fff;color:var(--text);outline:none;font-size:11px;}
.comment-submit{margin-top:7px;width:100%;background:var(--blue);color:#fff;border:none;border-radius:8px;padding:9px 12px;cursor:pointer;font-size:11px;font-weight:700;}
@media(max-width:900px){
  html,body{height:auto;min-height:100%;overflow-x:hidden;overflow-y:auto;}
  .main-container{height:auto;min-height:calc(100vh - 70px);display:flex;flex-direction:column;}
  aside{width:100%;height:auto;padding:10px;flex-direction:row;align-items:center;overflow-x:auto;overflow-y:hidden;gap:6px;}
  .btn-back-lms,.new-dropdown,.nav-link{flex:0 0 auto;width:auto;margin:0;}
  .storage-container{display:none;}
  .content{margin:10px;min-height:auto;flex:1;overflow:visible;box-shadow:none;}
  .preview-content{flex-direction:column;}
  .comments-panel{width:100%;height:380px;}
}
@media(max-width:650px){
  .drive-header{height:60px;padding:0 14px;}
  .user-name{display:none;}
  .drive-table th:nth-child(3),.drive-table td:nth-child(3){display:none;}
  .mobile-file-date{display:block;}
}
`;

function renderLogin(loginError = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AES Sharer</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>${CSS_LOGIN}</style>
</head>
<body>
<div class="login-page">
<div class="login-wrapper">
<section class="login-left">
<div class="login-brand">
<img src="https://raw.githubusercontent.com/nightcloude/amaris/main/antipolox.png" alt="AES">
<span><strong>AES</strong> Drive</span>
</div>
<div class="login-hero">
<small>Collaboration Workspace</small>
<h2>Organize Files.<br>Share Knowledge.</h2>
<p>A secure workspace for AES Heads to store, share, preview and collaborate on resources via Google share links.</p>
</div>
<div class="login-left-footer">

<div class="login-dots"><span class="active"></span><span></span><span></span></div>
</div>
</section>
<section class="login-right">
<div class="login-form-wrap">
<div class="login-eyebrow">AES Sharer</div>
<h1>Welcome back</h1>
<div class="login-subtitle">Sign in to continue to your teacher workspace.</div>
${loginError ? `<div class="login-error">${h(loginError)}</div>` : ''}
<div class="login-card">
<form method="post">
<input type="hidden" name="login_cmd" value="login">
<div class="login-field">
<label for="drive-user">Username</label>
<input id="drive-user" type="text" name="user" autocomplete="username" placeholder="Enter your username" required>
</div>
<div class="login-field">
<label for="drive-pass">Password</label>
<input id="drive-pass" type="password" name="pass" autocomplete="current-password" placeholder="Enter your password" required>
</div>
<button type="submit" class="login-button">Sign In to Drive</button>
</form>
</div>
<div class="login-footer-note">AES Sharer · Cloudflare Worker</div>
</div>
</section>
</div>
</div>
</body>
</html>`;
}

function renderDrive(opts) {
  const {
    teacherName, teacherUsername, isSharedDrive, currentPath, items,
    notice, backUrl, sharedUrl, teacherId, previewData, comments, isAdmin
  } = opts;

  const storageDisplay = 'Share-link workspace · no local storage used';
  const storagePercent = 0;

  let itemsHtml = '';
  if (!items || items.length === 0) {
    itemsHtml = `<div class="empty-drive">
      <div class="empty-drive-icon">${isSharedDrive ? '👥' : '📁'}</div>
      <div style="font-size:14px;font-weight:700;color:#334957">This folder is empty</div>
      <div style="font-size:11px;margin-top:7px">Add a share link or create a new folder to get started.</div>
    </div>`;
  } else {
    const rows = items.map((item, index) => {
      const name = item.name;
      const isDir = item.isDir;
      // IMPORTANT: escape for HTML attribute so onclick="doRename("x")" does not break
      const jsName = h(JSON.stringify(name));
      const jsPath = h(JSON.stringify(currentPath || ''));
      const jsShareUrl = h(JSON.stringify(item.share_url || ''));
      let itemHref, openAction;

      if (isDir) {
        const newPath = currentPath ? currentPath + '/' + name : name;
        itemHref = buildQueryUrl({ shared: isSharedDrive ? '1' : null, path: newPath });
        openAction = `href="${h(itemHref)}"`;
      } else {
        // Clicking a file redirects to the external share link
        openAction = `href="${h(item.share_url)}" target="_blank" rel="noopener noreferrer"`;
      }

      const commentBadge = (!isDir && item.commentCount > 0)
        ? `<span class="comment-count">💬 ${item.commentCount}</span>` : '';
      const versionBadge = (!isDir && isSharedDrive && item.versionCount > 0)
        ? `<span class="version-count">↻ ${item.versionCount}</span>` : '';

      const commentsUrl = buildQueryUrl({
        view: name,
        shared: isSharedDrive ? '1' : null,
        path: currentPath || null
      });
      const deleteUrl = buildQueryUrl({
        del: name,
        path: currentPath || null,
        shared: isSharedDrive ? '1' : null
      });
      const historyUrl = buildQueryUrl({
        shared: '1',
        path: currentPath || null,
        history: name
      });

      return `<tr>
<td>
  <a ${openAction} class="file-name-link">${h(name)}</a>
  ${commentBadge}${versionBadge}
  <div class="mobile-file-date">${h(item.modified)}</div>
</td>
<td>${h(item.size)}</td>
<td>${h(item.modified)}</td>
<td style="text-align:right">
  <div class="dots" onclick="toggleMenu(event, ${index});">⋮</div>
  <div class="menu" id="menu-${index}">
    ${!isDir ? `<a href="${h(item.share_url)}" target="_blank" rel="noopener">Open Link</a>` : ''}
    ${!isDir ? `<a href="${h(commentsUrl)}">Comments${item.commentCount > 0 ? ' (' + item.commentCount + ')' : ''}</a>` : ''}
    <a href="#" onclick="event.preventDefault();doRename(${jsName});return false;">Rename</a>
    <a href="#" onclick="event.preventDefault();openShare(${jsName},${jsPath},${isDir ? 'true' : 'false'},${isSharedDrive ? 'true' : 'false'},${jsShareUrl});return false;">Share</a>
    ${!isDir && isSharedDrive ? `<a href="#" onclick="event.preventDefault();openVersionUpload(${jsName});return false;">Upload New Version</a>` : ''}
    ${!isDir && isSharedDrive ? `<a href="${h(historyUrl)}">Version History</a>` : ''}
    <a href="${h(deleteUrl)}" onclick="return confirm('Are you sure you want to delete this item?');" style="color:#ff8585">Delete</a>
  </div>
</td>
</tr>`;
    }).join('');

    itemsHtml = `<div class="drive-table-wrap">
<table class="drive-table">
<thead><tr><th>Name</th><th>Type</th><th>Last Modified</th><th style="width:65px"></th></tr></thead>
<tbody>${rows}</tbody>
</table>
</div>`;
  }

  // Preview panel (comments + open link)
  let previewHtml = '';
  if (previewData) {
    const commentsList = (comments || []).map(c => {
      if (c.type === 'version') {
        return `<div class="comment-item">
          <div class="comment-top" style="display:flex;justify-content:space-between;">
            <div>
              <div class="comment-author">${h(c.author)} added a new version</div>
              <div class="comment-date">${h(c.created_at)}</div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;margin:7px 0;">
            <span style="display:inline-block;padding:3px 7px;border-radius:6px;background:#edf5ff;color:#3979c9;font-size:9px;font-weight:700">V${h(c.version)}</span>
            <a href="${h(c.view_url)}" target="_blank" rel="noopener" style="font-size:10px;color:var(--blue);font-weight:700;text-decoration:none">View</a>
          </div>
          ${c.text ? `<div class="comment-text">${h(c.text)}</div>` : ''}
        </div>`;
      }
      return `<div class="comment-item">
        <div style="display:flex;justify-content:space-between;">
          <div>
            <div class="comment-author">${h(c.author)}</div>
            <div class="comment-date">${h(c.created_at)}</div>
          </div>
          ${c.can_delete ? `<a href="${h(buildQueryUrl({ view: previewData.name, path: currentPath, shared: isSharedDrive ? '1' : null, del_comment: c.id }))}" class="comment-delete" onclick="return confirm('Delete this comment?');">Delete</a>` : ''}
        </div>
        <div class="comment-text">${h(c.text)}</div>
      </div>`;
    }).join('') || '<div class="comment-empty">No comments yet. Be the first to comment!</div>';

    const closeUrl = buildQueryUrl({ shared: isSharedDrive ? '1' : null, path: currentPath || null });

    previewHtml = `
<div class="preview-container">
  <div class="preview-header">
    <div class="preview-header-title">${h(previewData.name)}</div>
    <div class="preview-header-actions">
      <a href="${h(previewData.share_url)}" target="_blank" rel="noopener" class="download-button">Open Share Link</a>
      <a href="${h(closeUrl)}" class="secondary-button">Close</a>
    </div>
  </div>
  <div class="preview-content">
    <div class="preview-media">
      <a class="big-link" href="${h(previewData.share_url)}" target="_blank" rel="noopener">Open in Google Drive / Docs →</a>
    </div>
    <div class="comments-panel">
      <div class="comments-header">Comments ${(comments && comments.length) ? '(' + comments.length + ')' : ''}</div>
      <div class="comments-list">${commentsList}</div>
      <form method="post" class="comment-form">
        <input type="hidden" name="cmd" value="add_comment">
        <input type="hidden" name="fileName" value="${h(previewData.name)}">
        <input type="hidden" name="currentPath" value="${h(currentPath || '')}">
        <input type="hidden" name="shared" value="${isSharedDrive ? '1' : '0'}">
        <textarea name="comment" placeholder="Write a comment..." required></textarea>
        <button type="submit" class="comment-submit">Post Comment</button>
      </form>
    </div>
  </div>
</div>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AES Sharer</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>${CSS_DRIVE}</style>
<script>
function closeNewMenu(){const d=document.getElementById('newDropdown');if(d)d.removeAttribute('open');}
function createFolder(e){if(e){e.preventDefault();e.stopPropagation();}closeNewMenu();const name=prompt('Folder Name:');if(name===null)return;const clean=name.trim();if(!clean)return;document.getElementById('cmd').value='new_folder';document.getElementById('newName').value=clean;document.getElementById('mainForm').submit();}
function doRename(oldName){const name=prompt('Rename to:',oldName);if(name===null||!name.trim()||name===oldName)return;document.getElementById('cmd').value='rename';document.getElementById('oldName').value=oldName;document.getElementById('newName').value=name.trim();document.getElementById('mainForm').submit();}
function toggleMenu(e,id){if(e)e.stopPropagation();closeNewMenu();const target=document.getElementById('menu-'+id);const open=target&&target.style.display==='block';document.querySelectorAll('.menu').forEach(m=>m.style.display='none');if(!target||open)return;target.style.display='block';const rect=(e.currentTarget||e.target).getBoundingClientRect();const mw=target.offsetWidth||190;const mh=target.offsetHeight||260;const vh=window.innerHeight,vw=window.innerWidth;if(vh-rect.bottom<mh&&rect.top>vh-rect.bottom){target.style.top=Math.max(10,rect.top-mh-4)+'px';}else{target.style.top=Math.min(vh-mh-10,rect.bottom+4)+'px';}let left=rect.right-mw;if(left<10)left=10;if(left+mw>vw-10)left=vw-mw-10;target.style.left=left+'px';target.style.right='auto';}
function openShare(fileName,userSubPath,isDir,isSharedDrive,originalUrl){const modal=document.getElementById('shareModal');const nameEl=document.getElementById('shareFileName');const linkEl=document.getElementById('shareLink');const origEl=document.getElementById('originalShareLink');const origBox=document.getElementById('originalShareBox');if(!modal||!nameEl||!linkEl)return;let currentPath=String(userSubPath||'').replace(/^\\/+|\\/+$/g,'');const base=window.location.origin+window.location.pathname;const shareUrl=base+'?share='+encodeURIComponent(fileName)+'&p='+encodeURIComponent(isSharedDrive?'shared'+(currentPath?'/'+currentPath:''):('teacher/'+currentPath));nameEl.textContent=fileName+(isDir?' (Shared Folder)':'');linkEl.textContent=shareUrl;linkEl.setAttribute('data-share-url',shareUrl);if(origEl&&origBox){if(originalUrl&&!isDir){origEl.textContent=originalUrl;origEl.setAttribute('data-share-url',originalUrl);origBox.style.display='block';}else{origBox.style.display='none';}}modal.style.display='flex';}
function copyLink(which){const el=document.getElementById(which==='original'?'originalShareLink':'shareLink');const btn=document.getElementById(which==='original'?'copyOrigBtn':'copyBtn');if(!el)return;const text=el.getAttribute('data-share-url')||el.textContent||'';if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(()=>{if(btn){btn.innerText='Copied!';setTimeout(()=>btn.innerText=which==='original'?'Copy Google link':'Copy link',2000);}});}else{const ta=document.createElement('textarea');ta.value=text;document.body.appendChild(ta);ta.select();try{document.execCommand('copy');}catch(e){}document.body.removeChild(ta);if(btn){btn.innerText='Copied!';setTimeout(()=>btn.innerText=which==='original'?'Copy Google link':'Copy link',2000);}}}
function openVersionUpload(fileName){const modal=document.getElementById('versionUploadModal');const nameEl=document.getElementById('versionUploadName');const target=document.getElementById('versionTargetName');const link=document.getElementById('versionShareLink');const comment=document.getElementById('versionComment');if(!modal)return;nameEl.textContent=fileName;target.value=fileName;link.value='';comment.value='';modal.style.display='flex';link.focus();}
function openShareLinkModal(){const modal=document.getElementById('shareLinkModal');const n=document.getElementById('shareLinkName');const l=document.getElementById('shareLinkUrl');const c=document.getElementById('shareLinkComment');if(!modal)return;n.value='';l.value='';c.value='';modal.style.display='flex';n.focus();}
function closeModal(id){const m=document.getElementById(id);if(m)m.style.display='none';}
document.addEventListener('click',function(e){if(e.target.closest('.dots'))return;document.querySelectorAll('.menu').forEach(m=>{if(!m.contains(e.target))m.style.display='none';});});
window.addEventListener('scroll',()=>document.querySelectorAll('.menu').forEach(m=>m.style.display='none'),true);
window.addEventListener('resize',()=>document.querySelectorAll('.menu').forEach(m=>m.style.display='none'));
</script>
</head>
<body>
<form id="mainForm" method="post" style="display:none">
<input type="hidden" name="cmd" id="cmd" value="">
<input type="hidden" name="oldName" id="oldName" value="">
<input type="hidden" name="newName" id="newName" value="">
<input type="hidden" name="currentPath" id="currentPath" value="${h(currentPath || '')}">
<input type="hidden" name="shared" value="${isSharedDrive ? '1' : '0'}">
</form>

<header class="drive-header">
<div class="logo-area">
<img src="https://raw.githubusercontent.com/nightcloude/amaris/main/antipolox.png" alt="AES">
<span class="logo-AES">AES</span>&nbsp;Sharer
</div>
<div class="user-area">
<span class="user-name">${h(teacherName)}${teacherUsername ? ` <span style="color:#91a6b6;font-weight:400">(@${h(teacherUsername)})</span>` : ''}</span>
<a href="?logout=1" class="logout">Log Out</a>
</div>
</header>

<div class="main-container">
<aside>



<details class="new-dropdown" id="newDropdown">
<summary>
<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
<span>New</span>
</summary>
<div class="new-menu">
<div onclick="createFolder(event);">New Folder</div>
<div onclick="event.preventDefault();event.stopPropagation();closeNewMenu();openShareLinkModal();">Upload Share Link</div>
</div>
</details>

<a href="?" class="nav-link ${isSharedDrive ? '' : 'nav-active'}">
<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg>
My Drive
</a>
<a href="?shared=1" class="nav-link ${isSharedDrive ? 'nav-active' : ''}">
<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>
Shared Drive
</a>
${isAdmin ? `<a href="?admin=1" class="nav-link">
<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><line x1="19" y1="8" x2="19" y2="14"></line><line x1="22" y1="11" x2="16" y2="11"></line></svg>
Users
</a>` : ''}

<div class="storage-container">
<div class="storage-label">${h(storageDisplay)}</div>
<div class="storage-bar"><div class="storage-fill" style="width:${storagePercent}%"></div></div>
</div>
</aside>

<div class="content">
<div class="drive-toolbar">
<div class="breadcrumb">
${currentPath ? `<a href="${h(backUrl)}" class="breadcrumb-back">← Back</a><span>${h(currentPath)}</span>` : `<span>${isSharedDrive ? 'Shared Drive' : 'My Drive'}</span>`}
</div>
</div>
${notice ? `<div class="notice-banner">${h(notice)}</div>` : ''}
${itemsHtml}
</div>
</div>

<!-- SHARE MODAL -->
<div id="shareModal" class="modal-overlay">
<div class="share-card">
<div style="font-weight:700;font-size:17px;margin-bottom:5px">Share Link</div>
<div id="shareFileName" style="font-size:11px;color:var(--muted);margin-bottom:15px"></div>
<div style="font-size:10px;font-weight:700;color:#607687;margin-bottom:6px">Public Drive Link</div>
<div id="shareLink" class="share-link-box"></div>
<div id="originalShareBox" style="display:none;margin-top:12px">
<div style="font-size:10px;font-weight:700;color:#607687;margin-bottom:6px">Original Google Share Link</div>
<div id="originalShareLink" class="share-link-box" style="background:#edf9f4;border-color:#b8e6d0"></div>
</div>
<div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:12px">
<button type="button" class="secondary-button" onclick="closeModal('shareModal');">Close</button>
<button type="button" id="copyBtn" class="download-button" onclick="copyLink('public');">Copy link</button>
<button type="button" id="copyOrigBtn" class="download-button" style="background:#00c978;border-color:#00c978" onclick="copyLink('original');">Copy Google link</button>
</div>
</div>
</div>

<!-- VERSION UPLOAD MODAL -->
<div id="versionUploadModal" class="modal-overlay">
<div class="version-card">
<h2>Add Version</h2>
<div class="version-subtitle" id="versionUploadName"></div>
<form method="post">
<input type="hidden" name="cmd" value="upload_version">
<input type="hidden" name="shared" value="1">
<input type="hidden" name="currentPath" value="${h(currentPath || '')}">
<input type="hidden" name="targetFilename" id="versionTargetName" value="">
<div class="version-file-field">
<label>Share Link</label>
<input type="url" name="versionLink" id="versionShareLink" placeholder="Paste the Google Drive / Docs share link" required>
</div>
<div class="version-file-field">
<label>Comment</label>
<textarea name="versionComment" id="versionComment" placeholder="What changed in this version?"></textarea>
</div>
<div style="display:flex;justify-content:flex-end;gap:8px">
<button type="button" class="secondary-button" onclick="closeModal('versionUploadModal');">Cancel</button>
<button type="submit" class="download-button">Add Version</button>
</div>
</form>
</div>
</div>

<!-- UPLOAD SHARE LINK MODAL -->
<div id="shareLinkModal" class="modal-overlay">
<div class="version-card">
<h2>Upload Share Link</h2>
<div class="version-subtitle">Add a Google Docs or Google Drive share link as a new item.</div>
<form method="post">
<input type="hidden" name="cmd" value="create_share_link">
<input type="hidden" name="shared" value="${isSharedDrive ? '1' : '0'}">
<input type="hidden" name="currentPath" value="${h(currentPath || '')}">
<div class="version-file-field">
<label>Display Name</label>
<input type="text" name="linkName" id="shareLinkName" placeholder="e.g. Curriculum Guide 2026" required>
</div>
<div class="version-file-field">
<label>Share Link</label>
<input type="url" name="versionLink" id="shareLinkUrl" placeholder="https://docs.google.com/... or https://drive.google.com/..." required>
</div>
<div class="version-file-field">
<label>Comment (optional)</label>
<textarea name="versionComment" id="shareLinkComment" placeholder="Optional note"></textarea>
</div>
<div style="display:flex;justify-content:flex-end;gap:8px">
<button type="button" class="secondary-button" onclick="closeModal('shareLinkModal');">Cancel</button>
<button type="submit" class="download-button">Save Link</button>
</div>
</form>
</div>
</div>

${previewHtml}
</body>
</html>`;
}

function renderHistory(opts) {
  const { historyName, historyVersions, historyNotice, historyPath, historyCurrentFileUrl, historyDownloadUrl } = opts;
  const rows = (historyVersions || []).map(v => {
    const author = ((v.firstname || '') + ' ' + (v.lastname || '')).trim() || v.username || 'Unknown';
    return `<tr>
      <td><span style="font-weight:700;color:#4d91f7">V${h(v.version_number)}</span></td>
      <td>${h(author)}</td>
      <td>${h(v.uploaded_at)}</td>
      <td style="white-space:pre-wrap;color:#536876">${h(v.comment || '')}</td>
      <td><a href="${h(v.share_url)}" target="_blank" rel="noopener" style="font-size:10px;color:#4d91f7;font-weight:700">Open Version</a></td>
    </tr>`;
  }).join('') || '<tr><td colspan="5" style="padding:40px;text-align:center;color:#718797">No additional versions yet.</td></tr>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Version History — ${h(historyName)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--navy:#081c2b;--blue:#4d91f7;--green:#00c978;--border:#dce5eb;--muted:#718797;--text:#172a38;}
*{box-sizing:border-box;}body{margin:0;min-height:100vh;background:#eef2f7;color:var(--text);font-family:Inter,Arial,sans-serif;}
.history-header{min-height:70px;background:var(--navy);color:#fff;padding:0 30px;display:flex;align-items:center;}
.history-logo{display:flex;align-items:center;gap:8px;font-size:19px;}.history-logo strong{color:var(--green);}
.history-main{padding:30px;}
.history-card{max-width:1150px;margin:0 auto;background:#fff;border:1px solid var(--border);border-radius:15px;overflow:hidden;box-shadow:0 15px 40px rgba(8,28,43,.08);}
.history-title{padding:19px 22px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:20px;}
.history-name{font-size:15px;font-weight:600;}
.button{display:inline-block;border-radius:8px;padding:8px 12px;text-decoration:none;font-size:10px;font-weight:700;border:1px solid var(--border);color:#334957;background:#fff;}
.button-primary{background:var(--blue);border-color:var(--blue);color:#fff;}
.history-notice{margin:15px 20px 0;padding:10px 12px;background:#edf5ff;border:1px solid #cfe1f8;color:#3169a8;border-radius:8px;font-size:11px;}
table{width:100%;border-collapse:collapse;}th,td{padding:13px 17px;text-align:left;border-bottom:1px solid #edf1f4;font-size:11px;}
th{font-size:9px;text-transform:uppercase;color:#718797;background:#f5f8fa;}
.version-upload{padding:20px;border-top:1px solid var(--border);background:#f5f8fa;}
.version-upload h3{margin:0 0 14px;font-size:13px;}
.version-upload-field{display:flex;flex-direction:column;gap:6px;margin-bottom:11px;}
.version-upload-field label{font-size:10px;color:#607687;font-weight:700;}
.version-upload-field input,.version-upload-field textarea{width:100%;padding:9px 10px;border:1px solid var(--border);border-radius:8px;background:#fff;font-family:inherit;font-size:11px;}
.version-upload-button{border:0;border-radius:8px;padding:9px 14px;background:var(--blue);color:#fff;font-family:inherit;font-size:10px;font-weight:700;cursor:pointer;}
</style>
</head>
<body>
<header class="history-header"><div class="history-logo"><strong>AES</strong> <span>Drive</span></div></header>
<main class="history-main">
<div class="history-card">
<div class="history-title">
<div class="history-name">${h(historyName)}</div>
<div style="display:flex;gap:8px;">
<a href="${h(historyCurrentFileUrl)}" class="button" target="_blank" rel="noopener">Open Current Link</a>
</div>
</div>
${historyNotice ? `<div class="history-notice">${h(historyNotice)}</div>` : ''}
<div style="overflow-x:auto;"><table>
<thead><tr><th>Version</th><th>Added By</th><th>Date</th><th>Comment</th><th>Link</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>
<div class="version-upload">
<h3>Add Another Version</h3>
<form method="post">
<input type="hidden" name="cmd" value="upload_version">
<input type="hidden" name="shared" value="1">
<input type="hidden" name="currentPath" value="${h(historyPath || '')}">
<input type="hidden" name="targetFilename" value="${h(historyName)}">
<div class="version-upload-field"><label>Share Link</label>
<input type="url" name="versionLink" placeholder="Paste the Google share link" required></div>
<div class="version-upload-field"><label>Comment</label>
<textarea name="versionComment" placeholder="What changed?"></textarea></div>
<button type="submit" class="version-upload-button">Add Version</button>
</form>
</div>
</div>
</main>
</body>
</html>`;
}

function renderAdminUsers(opts) {
  const { teacherName, teacherUsername, users, notice } = opts;
  const rows = (users || []).map(u => {
    const full = ((u.firstname || '') + ' ' + (u.lastname || '')).trim() || u.username;
    const isSelf = u.username === 'admin';
    return `<tr>
      <td style="font-weight:600">${h(full)}</td>
      <td>@${h(u.username)}</td>
      <td style="font-family:monospace;font-size:11px">${h(u.password)}</td>
      <td>
        <form method="post" style="display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap">
          <input type="hidden" name="cmd" value="admin_change_pin">
          <input type="hidden" name="target_id" value="${u.teacher_id}">
          <input type="text" name="new_pin" placeholder="New PIN" required style="padding:6px 8px;border:1px solid #dce5eb;border-radius:7px;font-size:11px;width:110px">
          <button type="submit" class="download-button" style="padding:6px 10px;font-size:10px">Change PIN</button>
        </form>
        ${!isSelf ? `<form method="post" style="display:inline;margin-left:6px" onsubmit="return confirm('Delete user @${h(u.username)}?');">
          <input type="hidden" name="cmd" value="admin_delete_user">
          <input type="hidden" name="target_id" value="${u.teacher_id}">
          <button type="submit" style="padding:6px 10px;font-size:10px;border:1px solid #e85b5b;background:#fff;color:#e85b5b;border-radius:7px;cursor:pointer;font-weight:700">Delete</button>
        </form>` : '<span style="font-size:10px;color:#91a6b6;margin-left:8px">Protected</span>'}
      </td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Users — AES Sharer Admin</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--navy:#081c2b;--blue:#4d91f7;--green:#00c978;--border:#dce5eb;--muted:#718797;--text:#172a38;}
*{box-sizing:border-box;}body{margin:0;min-height:100vh;background:#eef2f7;color:var(--text);font-family:Inter,Arial,sans-serif;}
.header{min-height:70px;background:var(--navy);color:#fff;padding:0 28px;display:flex;align-items:center;justify-content:space-between;}
.logo{display:flex;align-items:center;gap:8px;font-size:19px;}.logo strong{color:var(--green);}
.main{padding:30px;}
.card{max-width:1100px;margin:0 auto;background:#fff;border:1px solid var(--border);border-radius:15px;overflow:hidden;box-shadow:0 15px 40px rgba(8,28,43,.08);}
.title{padding:18px 22px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:12px;}
.title h1{margin:0;font-size:16px;}
.notice{margin:14px 22px 0;padding:10px 13px;background:#edf5ff;color:#3169a8;border:1px solid #cfe1f8;border-radius:9px;font-size:11px;}
table{width:100%;border-collapse:collapse;}th,td{padding:13px 18px;text-align:left;border-bottom:1px solid #edf1f4;font-size:12px;}
th{font-size:9px;text-transform:uppercase;color:#718797;background:#f5f8fa;}
.add-box{padding:20px 22px;border-top:1px solid var(--border);background:#f5f8fa;}
.add-box h3{margin:0 0 14px;font-size:13px;}
.grid{display:grid;grid-template-columns:1fr 1fr 1fr 1fr auto;gap:10px;align-items:end;}
.field label{display:block;font-size:10px;color:#607687;font-weight:700;margin-bottom:5px;}
.field input{width:100%;padding:9px 10px;border:1px solid var(--border);border-radius:8px;font-size:12px;}
.download-button{display:inline-block;padding:9px 14px;border-radius:9px;font-size:11px;font-weight:700;cursor:pointer;border:1px solid var(--blue);background:var(--blue);color:#fff;text-decoration:none;}
.secondary-button{display:inline-block;padding:9px 14px;border-radius:9px;font-size:11px;font-weight:700;cursor:pointer;border:1px solid var(--border);background:#fff;color:#334957;text-decoration:none;}
@media(max-width:800px){.grid{grid-template-columns:1fr 1fr;}}
</style>
</head>
<body>
<header class="header">
  <div class="logo"><strong>AES</strong> <span>Sharer · Admin</span></div>
  <div style="display:flex;align-items:center;gap:16px;font-size:12px">
    <span style="color:#dce8ef">${h(teacherName)} (@${h(teacherUsername)})</span>
    <a href="?" class="secondary-button" style="padding:7px 12px">← Back to Drive</a>
  </div>
</header>
<main class="main">
<div class="card">
  <div class="title">
    <h1>User Management</h1>
  </div>
  ${notice ? `<div class="notice">${h(notice)}</div>` : ''}
  <div style="overflow-x:auto">
  <table>
    <thead><tr><th>Name</th><th>Username</th><th>PIN</th><th>Actions</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="4" style="padding:40px;text-align:center;color:#718797">No users yet.</td></tr>'}</tbody>
  </table>
  </div>
  <div class="add-box">
    <h3>Add New User</h3>
    <form method="post">
      <input type="hidden" name="cmd" value="admin_add_user">
      <div class="grid">
        <div class="field"><label>Username</label><input type="text" name="username" required placeholder="username"></div>
        <div class="field"><label>PIN / Password</label><input type="text" name="password" required placeholder="pin"></div>
        <div class="field"><label>First name</label><input type="text" name="firstname" placeholder="First"></div>
        <div class="field"><label>Last name</label><input type="text" name="lastname" placeholder="Last"></div>
        <button type="submit" class="download-button">Add User</button>
      </div>
    </form>
  </div>
</div>
</main>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main request handler
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const db = env.DB;
    if (!db) {
      return html('<h1>D1 binding "DB" is missing. Add it in wrangler.toml.</h1>', 500);
    }

    // Auto-create schema on every cold start (idempotent)
    await ensureSchema(db);

    const url = new URL(request.url);
    const path = url.pathname;
    // Treat any path as the app (Worker routes everything)
    const cookies = parseCookies(request);
    const sessionToken = cookies['drive_session'] || '';
    let teacher = await getSessionTeacher(db, sessionToken);
    const isLoggedIn = !!teacher;

    // ---------- Logout ----------
    if (url.searchParams.get('logout') === '1') {
      await destroySession(db, sessionToken);
      const res = redirect('?');
      res.headers.append('Set-Cookie', clearCookie('drive_session'));
      return res;
    }

    // ---------- Login POST ----------
    if (request.method === 'POST') {
      const form = await request.formData();
      const loginCmd = form.get('login_cmd');

      if (loginCmd === 'login') {
        const user = String(form.get('user') || '').trim();
        const pass = String(form.get('pass') || '').trim();
        const found = await findTeacherLogin(db, user, pass);
        if (!found) {
          return html(renderLogin('Invalid username or password.'));
        }
        const token = await createSession(db, found.teacher_id);
        const res = redirect('?');
        res.headers.append('Set-Cookie', setCookie('drive_session', token));
        return res;
      }

      // All other POSTs require login
      if (!isLoggedIn) {
        return html(renderLogin());
      }

      const cmd = String(form.get('cmd') || '');
      const isSharedDrive = String(form.get('shared') || '0') === '1';
      const currentPath = String(form.get('currentPath') || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      const ownerId = isSharedDrive ? 0 : teacher.teacher_id;
      const { folderId } = await resolveFolderPath(db, ownerId, isSharedDrive, currentPath);

      // New folder
      if (cmd === 'new_folder') {
        const name = safeName(form.get('newName'));
        if (name) {
          const exists = await db.prepare(
            'SELECT id FROM folders WHERE parent_id = ? AND name = ? AND is_shared = ? LIMIT 1'
          ).bind(folderId, name, isSharedDrive ? 1 : 0).first();
          if (!exists) {
            await db.prepare(
              'INSERT INTO folders (owner_id, parent_id, name, is_shared) VALUES (?, ?, ?, ?)'
            ).bind(ownerId, folderId, name, isSharedDrive ? 1 : 0).run();
          }
        }
        return redirect(buildQueryUrl({ shared: isSharedDrive ? '1' : null, path: currentPath || null }));
      }

      // Rename
      if (cmd === 'rename') {
        const oldName = safeName(form.get('oldName'));
        const newName = safeName(form.get('newName'));
        if (oldName && newName && oldName !== newName) {
          // try folder first
          await db.prepare(
            'UPDATE folders SET name = ? WHERE parent_id = ? AND name = ? AND is_shared = ?'
          ).bind(newName, folderId, oldName, isSharedDrive ? 1 : 0).run();
          // then item
          await db.prepare(
            'UPDATE items SET name = ?, updated_at = datetime(\'now\') WHERE folder_id = ? AND name = ? AND is_shared = ?'
          ).bind(newName, folderId, oldName, isSharedDrive ? 1 : 0).run();
        }
        return redirect(buildQueryUrl({ shared: isSharedDrive ? '1' : null, path: currentPath || null }));
      }

      // Create share link (new item)
      if (cmd === 'create_share_link') {
        const linkName = safeName(form.get('linkName'));
        const shareLink = String(form.get('versionLink') || '').trim();
        const comment = String(form.get('versionComment') || '').trim();

        if (!linkName) {
          return redirect(buildQueryUrl({ shared: isSharedDrive ? '1' : null, path: currentPath || null, notice: 'Display name required.' }));
        }
        if (!shareLink || !isValidUrl(shareLink)) {
          return redirect(buildQueryUrl({ shared: isSharedDrive ? '1' : null, path: currentPath || null, notice: 'Valid share link required.' }));
        }

        // upsert item
        let item = await getItemByName(db, folderId, linkName, isSharedDrive);
        if (!item) {
          const res = await db.prepare(
            'INSERT INTO items (folder_id, name, share_url, created_by, current_version, is_shared) VALUES (?, ?, ?, ?, 1, ?)'
          ).bind(folderId, linkName, shareLink, teacher.teacher_id, isSharedDrive ? 1 : 0).run();
          const itemId = res.meta.last_row_id;
          // initial version
          await db.prepare(
            'INSERT INTO item_versions (item_id, version_number, share_url, comment, uploaded_by) VALUES (?, 1, ?, ?, ?)'
          ).bind(itemId, shareLink, comment || 'Initial share link.', teacher.teacher_id).run();
        } else {
          // update existing
          await db.prepare(
            'UPDATE items SET share_url = ?, updated_at = datetime(\'now\') WHERE id = ?'
          ).bind(shareLink, item.id).run();
        }

        return redirect(buildQueryUrl({
          shared: isSharedDrive ? '1' : null,
          path: currentPath || null,
          notice: 'Share link saved.'
        }));
      }

      // Upload version (extra share link)
      if (cmd === 'upload_version') {
        const targetFilename = safeName(form.get('targetFilename') || form.get('fileName'));
        const versionLink = String(form.get('versionLink') || '').trim();
        const versionComment = String(form.get('versionComment') || '').trim();

        if (!targetFilename || !versionLink || !isValidUrl(versionLink)) {
          return redirect(buildQueryUrl({ shared: '1', path: currentPath || null, notice: 'Valid target name and share link required.' }));
        }

        let item = await getItemByName(db, folderId, targetFilename, true);
        if (!item) {
          // create the item first
          const res = await db.prepare(
            'INSERT INTO items (folder_id, name, share_url, created_by, current_version, is_shared) VALUES (?, ?, ?, ?, 1, 1)'
          ).bind(folderId, targetFilename, versionLink, teacher.teacher_id).run();
          item = { id: res.meta.last_row_id, current_version: 1 };
        }

        const newVersion = (item.current_version || 1) + 1;
        await db.prepare(
          'INSERT INTO item_versions (item_id, version_number, share_url, comment, uploaded_by) VALUES (?, ?, ?, ?, ?)'
        ).bind(item.id, newVersion, versionLink, versionComment, teacher.teacher_id).run();

        await db.prepare(
          'UPDATE items SET current_version = ?, share_url = ?, updated_at = datetime(\'now\') WHERE id = ?'
        ).bind(newVersion, versionLink, item.id).run();

        return redirect(buildQueryUrl({
          shared: '1',
          path: currentPath || null,
          notice: 'Added link as version ' + newVersion + '.'
        }));
      }

      // Add comment
      if (cmd === 'add_comment') {
        const fileName = safeName(form.get('fileName'));
        const comment = String(form.get('comment') || '').trim();
        if (fileName && comment) {
          const item = await getItemByName(db, folderId, fileName, isSharedDrive);
          if (item) {
            await db.prepare(
              'INSERT INTO comments (item_id, teacher_id, comment) VALUES (?, ?, ?)'
            ).bind(item.id, teacher.teacher_id, comment).run();
          }
        }
        return redirect(buildQueryUrl({
          shared: isSharedDrive ? '1' : null,
          path: currentPath || null,
          view: fileName || null
        }));
      }

      // ---------- Admin commands ----------
      const isAdminUser = teacher.username === 'admin';

      if (cmd === 'admin_add_user' && isAdminUser) {
        const username = String(form.get('username') || '').trim();
        const password = String(form.get('password') || '').trim();
        const firstname = String(form.get('firstname') || '').trim();
        const lastname = String(form.get('lastname') || '').trim();
        if (!username || !password) {
          return redirect('?admin=1&notice=' + encodeURIComponent('Username and PIN required.'));
        }
        const exists = await db.prepare(
          'SELECT teacher_id FROM teachers WHERE username = ? LIMIT 1'
        ).bind(username).first();
        if (exists) {
          return redirect('?admin=1&notice=' + encodeURIComponent('Username already exists.'));
        }
        await db.prepare(
          'INSERT INTO teachers (username, password, firstname, lastname) VALUES (?, ?, ?, ?)'
        ).bind(username, password, firstname, lastname).run();
        return redirect('?admin=1&notice=' + encodeURIComponent('User @' + username + ' created.'));
      }

      if (cmd === 'admin_delete_user' && isAdminUser) {
        const targetId = parseInt(form.get('target_id'), 10);
        if (targetId > 0) {
          const target = await findTeacherById(db, targetId);
          if (target && target.username !== 'admin') {
            await db.prepare('DELETE FROM sessions WHERE teacher_id = ?').bind(targetId).run();
            await db.prepare('DELETE FROM teachers WHERE teacher_id = ?').bind(targetId).run();
            return redirect('?admin=1&notice=' + encodeURIComponent('User deleted.'));
          }
        }
        return redirect('?admin=1&notice=' + encodeURIComponent('Cannot delete this user.'));
      }

      if (cmd === 'admin_change_pin' && isAdminUser) {
        const targetId = parseInt(form.get('target_id'), 10);
        const newPin = String(form.get('new_pin') || '').trim();
        if (targetId > 0 && newPin) {
          await db.prepare(
            'UPDATE teachers SET password = ? WHERE teacher_id = ?'
          ).bind(newPin, targetId).run();
          return redirect('?admin=1&notice=' + encodeURIComponent('PIN updated.'));
        }
        return redirect('?admin=1&notice=' + encodeURIComponent('Invalid PIN.'));
      }
    }

    // ---------- Public share redirect ----------
    if (url.searchParams.has('share')) {
      const shareName = safeName(url.searchParams.get('share'));
      const p = String(url.searchParams.get('p') || '');
      // simple lookup: try to find item by name under shared or any
      const item = await db.prepare(
        'SELECT share_url FROM items WHERE name = ? ORDER BY id DESC LIMIT 1'
      ).bind(shareName).first();
      if (item && item.share_url) {
        return redirect(item.share_url);
      }
      return html('<h1>Shared item not found</h1>', 404);
    }

    // ---------- Require login for the rest ----------
    if (!isLoggedIn) {
      return html(renderLogin());
    }

    // ---------- Delete comment ----------
    if (url.searchParams.has('del_comment')) {
      const cid = parseInt(url.searchParams.get('del_comment'), 10);
      if (cid > 0) {
        await db.prepare(
          'DELETE FROM comments WHERE comment_id = ? AND teacher_id = ?'
        ).bind(cid, teacher.teacher_id).run();
      }
      return redirect(buildQueryUrl({
        shared: url.searchParams.get('shared') === '1' ? '1' : null,
        path: url.searchParams.get('path') || null,
        view: url.searchParams.get('view') || null
      }));
    }

    // ---------- Delete item / folder ----------
    if (url.searchParams.has('del')) {
      const delName = safeName(url.searchParams.get('del'));
      const isSharedDrive = url.searchParams.get('shared') === '1';
      const currentPath = String(url.searchParams.get('path') || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      const ownerId = isSharedDrive ? 0 : teacher.teacher_id;
      const { folderId } = await resolveFolderPath(db, ownerId, isSharedDrive, currentPath);

      // delete folder (and cascade children manually for simplicity)
      const folder = await db.prepare(
        'SELECT id FROM folders WHERE parent_id = ? AND name = ? AND is_shared = ? LIMIT 1'
      ).bind(folderId, delName, isSharedDrive ? 1 : 0).first();
      if (folder) {
        // recursive delete would be nicer; for now delete direct items + folder
        await db.prepare('DELETE FROM items WHERE folder_id = ?').bind(folder.id).run();
        await db.prepare('DELETE FROM folders WHERE id = ?').bind(folder.id).run();
      }

      const item = await getItemByName(db, folderId, delName, isSharedDrive);
      if (item) {
        await db.prepare('DELETE FROM comments WHERE item_id = ?').bind(item.id).run();
        await db.prepare('DELETE FROM item_versions WHERE item_id = ?').bind(item.id).run();
        await db.prepare('DELETE FROM items WHERE id = ?').bind(item.id).run();
      }

      return redirect(buildQueryUrl({
        shared: isSharedDrive ? '1' : null,
        path: currentPath || null
      }));
    }

    // ---------- Admin users page ----------
    if (url.searchParams.get('admin') === '1') {
      if (teacher.username !== 'admin') {
        return redirect('?');
      }
      const userRows = await db.prepare(
        'SELECT teacher_id, username, password, firstname, lastname FROM teachers ORDER BY username COLLATE NOCASE'
      ).all();
      const teacherName = ((teacher.firstname || '') + ' ' + (teacher.lastname || '')).trim() || teacher.username;
      return html(renderAdminUsers({
        teacherName,
        teacherUsername: teacher.username,
        users: userRows.results || [],
        notice: url.searchParams.get('notice') || ''
      }));
    }

    // ---------- Version history page ----------
    if (url.searchParams.has('history')) {
      const historyName = safeName(url.searchParams.get('history'));
      const historyPath = String(url.searchParams.get('path') || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      const { folderId } = await resolveFolderPath(db, 0, true, historyPath);
      const item = await getItemByName(db, folderId, historyName, true);
      if (!item) {
        return html('<h1>Version history not found</h1>', 404);
      }
      const versions = await getVersionList(db, item.id);
      return html(renderHistory({
        historyName,
        historyVersions: versions,
        historyNotice: url.searchParams.get('notice') || '',
        historyPath,
        historyCurrentFileUrl: item.share_url,
        historyDownloadUrl: item.share_url
      }));
    }

    // ---------- Main drive view ----------
    const isSharedDrive = url.searchParams.get('shared') === '1';
    const currentPath = String(url.searchParams.get('path') || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const ownerId = isSharedDrive ? 0 : teacher.teacher_id;
    const { folderId, path: resolvedPath } = await resolveFolderPath(db, ownerId, isSharedDrive, currentPath);
    const items = await listFolderContents(db, folderId, isSharedDrive);

    // parent path for back link
    let parentPath = '';
    if (resolvedPath) {
      const last = resolvedPath.lastIndexOf('/');
      parentPath = last === -1 ? '' : resolvedPath.slice(0, last);
    }
    const backUrl = buildQueryUrl({ shared: isSharedDrive ? '1' : null, path: parentPath || null });
    const notice = url.searchParams.get('notice') || '';

    // Preview / comments view
    let previewData = null;
    let comments = [];
    const viewName = safeName(url.searchParams.get('view') || '');
    if (viewName) {
      const item = await getItemByName(db, folderId, viewName, isSharedDrive);
      if (item) {
        previewData = {
          name: item.name,
          share_url: item.share_url
        };
        comments = await getCommentsForItem(db, item.id, teacher.teacher_id);
      }
    }

    const teacherName = ((teacher.firstname || '') + ' ' + (teacher.lastname || '')).trim() || teacher.username;

    return html(renderDrive({
      teacherName,
      teacherUsername: teacher.username,
      isSharedDrive,
      currentPath: resolvedPath,
      items,
      notice,
      backUrl,
      sharedUrl: '?shared=1',
      teacherId: teacher.teacher_id,
      previewData,
      comments,
      isAdmin: teacher.username === 'admin'
    }));
  }
};
