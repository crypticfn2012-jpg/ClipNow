const SUPABASE_URL = "https://fuffkzhzabnomohlemuz.supabase.co";
const SUPABASE_ANON_KEY = String.fromCharCode(101,121,74,104,98,71,99,105,79,105,74,73,85,122,73,49,78,105,73,115,73,110,82,53,99,67,73,54,73,107,112,88,86,67,74,57,46,101,121,74,112,99,51,77,105,79,105,74,122,100,88,66,104,89,109,70,122,90,83,73,115,73,110,74,108,90,105,73,54,73,109,90,49,90,109,90,114,101,109,104,54,89,87,74,117,98,50,49,118,97,71,120,108,98,88,86,54,73,105,119,105,99,109,57,115,90,83,73,54,73,109,70,117,98,50,52,105,76,67,74,112,89,88,81,105,79,106,69,51,79,68,107,119,78,106,85,50,78,68,107,115,73,109,86,52,99,67,73,54,77,106,69,119,78,68,89,48,77,84,89,48,79,88,48,46,115,65,84,88,121,84,110,104,115,84,110,70,74,114,122,50,82,70,51,115,102,103,119,122,76,107,49,53,114,77,101,97,105,71,83,73,55,45,97,81,76,79,107);
const CLIPPER_URL = "https://raw.githubusercontent.com/crypticfn2012-jpg/ron-violent-monkey-scripts/main/ron-cliptools.user.js";
const MAX_STORAGE = 5 * 1024 * 1024 * 1024;

const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storage: localStorage
  }
});
window.client = client;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
  return (n / 1073741824).toFixed(2) + " GB";
}

function sanitizeUsername(raw) {
  const cleaned = String(raw || "user")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 20);
  return cleaned.length >= 3 ? cleaned : "user" + Math.floor(Math.random() * 9999);
}

async function getCurrentUser() {
  try {
    const { data: { session } } = await client.auth.getSession();
    return session?.user || null;
  } catch (e) {
    console.error("getCurrentUser:", e);
    return null;
  }
}

async function requireLogin() {
  const user = await getCurrentUser();
  if (!user) {
    window.location.href = "login.html";
    return null;
  }
  return user;
}

async function logout() {
  try {
    await client.auth.signOut();
  } catch (e) {
    console.error("Logout error:", e);
  }
  window.location.href = "index.html";
}

async function uniqueUsername(base) {
  let name = sanitizeUsername(base);
  for (let i = 0; i < 30; i++) {
    const { data } = await client.from("profiles").select("id").eq("username", name).maybeSingle();
    if (!data) return name;
    name = sanitizeUsername(base).slice(0, 16) + (i + 2);
  }
  return sanitizeUsername(base) + Date.now().toString().slice(-4);
}

async function getProfile() {
  const user = await getCurrentUser();
  if (!user) return null;

  const { data, error } = await client.from("profiles").select("*").eq("id", user.id).maybeSingle();
  if (error) console.error("getProfile:", error);
  if (data) return data;

  const base = user.user_metadata?.username || (user.email ? user.email.split("@")[0] : "user");
  const username = await uniqueUsername(base);

  const { data: created, error: createErr } = await client
    .from("profiles")
    .upsert({
      id: user.id,
      username,
      display_name: username,
      bio: "Hey im new to ClipNow",
      avatar_url: null,
      storage_used: 0,
      is_dev: false
    })
    .select("*")
    .maybeSingle();

  if (createErr) {
    console.error("create profile:", createErr);
    return null;
  }
  return created;
}

async function getProfileById(id) {
  if (!id) return null;
  const { data } = await client
    .from("profiles")
    .select("id, username, display_name, avatar_url, is_dev")
    .eq("id", id)
    .maybeSingle();
  return data || null;
}

async function isDev() {
  const profile = await getProfile();
  return !!(profile && profile.is_dev === true);
}

async function getPublicClips({ limit = 50, order = "created_at" } = {}) {
  let query = client.from("clips").select("*").eq("visibility", "public").limit(limit);

  if (order === "views") {
    query = query.order("views", { ascending: false, nullsFirst: false });
  } else if (order === "likes") {
    query = query.order("likes_count", { ascending: false, nullsFirst: false });
  } else {
    query = query.order("created_at", { ascending: false, nullsFirst: false });
  }

  const { data, error } = await query;
  if (error) {
    console.error("getPublicClips:", error);
    return { data: [], error };
  }

  const clips = data || [];
  const userIds = [...new Set(clips.map(c => c.user_id).filter(Boolean))];

  if (userIds.length) {
    const { data: profiles } = await client
      .from("profiles")
      .select("id, username, display_name, avatar_url, is_dev")
      .in("id", userIds);

    const map = {};
    (profiles || []).forEach(p => (map[p.id] = p));
    clips.forEach(c => (c.profiles = map[c.user_id] || null));
  }

  return { data: clips, error: null };
}

async function getClipById(id) {
  if (!id || id === "undefined" || id === "null") {
    return { data: null, error: { message: "Missing clip id" } };
  }

  const { data, error } = await client.from("clips").select("*").eq("id", id).maybeSingle();
  if (error) return { data: null, error };
  if (!data) return { data: null, error: { message: "Clip not found or private" } };

  data.profiles = await getProfileById(data.user_id);
  return { data, error: null };
}

async function getClipPlaybackUrl(filePath) {
  if (!filePath) return "";

  const { data: signed, error } = await client.storage.from("clips").createSignedUrl(filePath, 21600);
  if (!error && signed?.signedUrl) return signed.signedUrl;

  const { data: pub } = client.storage.from("clips").getPublicUrl(filePath);
  return pub?.publicUrl || "";
}

function clipCardHtml(clip, username) {
  const name = username || clip.profiles?.username || "Unknown";
  const vis = clip.visibility && clip.visibility !== "public" ? ` • ${clip.visibility}` : "";

  return `
    <a href="clip.html?id=${encodeURIComponent(clip.id)}" class="clip-card">
      <div class="clip-thumb">
        <span class="play-icon">▶</span>
      </div>
      <div class="clip-info">
        <div class="clip-title">${escapeHtml(clip.title || "Untitled")}</div>
        <div class="clip-meta">
          ${escapeHtml(name)} • ${Number(clip.views) || 0} views${escapeHtml(vis)}
        </div>
      </div>
    </a>
  `;
}

function setupClipNowBranding() {
  // Use the new logo as the site favicon on every page that loads app.js.
  let favicon = document.querySelector('link[rel~="icon"]');
  if (!favicon) {
    favicon = document.createElement("link");
    favicon.rel = "icon";
    document.head.appendChild(favicon);
  }
  favicon.type = "image/svg+xml";
  favicon.href = "assets/clipnow-logo.svg";

  // Keep the navbar compact, but show the new wordmark in a clean white badge.
  document.querySelectorAll(".logo").forEach((logo) => {
    if (logo.dataset.clipnowBranded === "1") return;
    logo.dataset.clipnowBranded = "1";
    logo.innerHTML = '<span class="clipnow-logo-badge"><img src="assets/clipnow-wordmark.svg" alt="ClipNow"></span>';
    logo.style.setProperty("display", "inline-flex", "important");
    logo.style.setProperty("align-items", "center", "important");
    logo.style.setProperty("text-decoration", "none", "important");

    const badge = logo.querySelector(".clipnow-logo-badge");
    const img = logo.querySelector("img");
    if (badge) {
      badge.style.cssText = "display:inline-flex;align-items:center;justify-content:center;width:116px;height:40px;background:#fff;border-radius:6px;overflow:hidden;box-sizing:border-box;padding:2px 5px;";
    }
    if (img) {
      img.style.cssText = "display:block;width:108px;height:auto;max-height:37px;object-fit:contain;";
    }
  });
}

function ensureNavbar() {
  let navbar = document.querySelector("nav.navbar");

  if (!navbar && document.body) {
    navbar = document.createElement("nav");
    navbar.className = "navbar";
    navbar.innerHTML = `
      <a href="index.html" class="logo">Clip<span>Now</span></a>
      <div class="nav-center">
        <a href="index.html" id="nav-explore">Explore</a>
        <a href="upload.html" id="nav-upload">Upload</a>
        <a href="search.html" id="nav-search">Search</a>
        <a href="profile.html" id="nav-profile">Profile</a>
        <a href="download.html" id="nav-download">Download</a>
      </div>
      <div class="nav-right">
        <a href="login.html" id="nav-login" class="btn btn-primary">Sign in</a>
        <div id="nav-user">
          <a href="inbox.html" class="inbox-icon" title="Inbox" aria-label="Inbox">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 4h16v16H4z"></path>
              <path d="M4 9h5l2 3h2l2-3h5"></path>
            </svg>
          </a>
          <a href="profile.html" id="nav-username" class="nav-username"></a>
          <button type="button" onclick="logout()" class="btn btn-outline">Logout</button>
        </div>
      </div>
    `;
    document.body.insertBefore(navbar, document.body.firstChild);
  }

  if (!navbar) return null;

  navbar.style.setProperty("display", "flex", "important");
  navbar.style.setProperty("visibility", "visible", "important");
  navbar.style.setProperty("opacity", "1", "important");
  navbar.style.setProperty("position", "sticky", "important");
  navbar.style.setProperty("top", "0", "important");
  navbar.style.setProperty("width", "100%", "important");
  navbar.style.setProperty("height", "56px", "important");
  navbar.style.setProperty("min-height", "56px", "important");
  navbar.style.setProperty("z-index", "2147483647", "important");
  navbar.style.setProperty("background", "#0f0f0f", "important");
  navbar.style.setProperty("border-bottom", "1px solid #222", "important");
  navbar.style.setProperty("align-items", "center", "important");
  navbar.style.setProperty("justify-content", "space-between", "important");
  navbar.style.setProperty("padding", "0 24px", "important");
  navbar.style.setProperty("box-sizing", "border-box", "important");

  const logo = navbar.querySelector(".logo");
  if (logo) logo.style.setProperty("display", "inline-flex", "important");

  const right = navbar.querySelector(".nav-right");
  if (right) {
    right.style.setProperty("display", "flex", "important");
    right.style.setProperty("align-items", "center", "important");
    right.style.setProperty("justify-content", "flex-end", "important");
    right.style.setProperty("gap", "12px", "important");
  }

  return navbar;
}

function setActiveNav() {
  const path = (window.location.pathname.split("/").pop() || "index.html").toLowerCase();
  const map = {
    "index.html": "nav-explore",
    "": "nav-explore",
    "upload.html": "nav-upload",
    "search.html": "nav-search",
    "profile.html": "nav-profile",
    "download.html": "nav-download"
  };
  const id = map[path];
  if (!id) return;
  const el = document.getElementById(id);
  if (el) el.classList.add("active");
}

async function applyNavbarUser(user) {
  const loginBtn = document.getElementById("nav-login");
  const userArea = document.getElementById("nav-user");
  const usernameEl = document.getElementById("nav-username");

  if (!user) {
    if (loginBtn) loginBtn.style.setProperty("display", "inline-flex", "important");
    if (userArea) userArea.style.setProperty("display", "none", "important");
    return;
  }

  if (loginBtn) loginBtn.style.setProperty("display", "none", "important");
  if (userArea) userArea.style.setProperty("display", "flex", "important");

  if (usernameEl) {
    const profile = await getProfileById(user.id);
    if (profile?.is_dev) {
      usernameEl.innerHTML = "@" + escapeHtml(profile.username || "dev") + ' <span class="dev-badge">DEV</span>';
    } else {
      usernameEl.textContent = profile?.username ? "@" + profile.username : "@Account";
    }
  }
}

async function updateNavbar() {
  ensureNavbar();
  setupClipNowBranding();
  setActiveNav();

  try {
    const { data: { session } } = await client.auth.getSession();
    await applyNavbarUser(session?.user || null);
  } catch (error) {
    console.error("Navbar auth state:", error);
    await applyNavbarUser(null);
  }

  client.auth.onAuthStateChange((_event, session) => {
    applyNavbarUser(session?.user || null);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", updateNavbar, { once: true });
} else {
  updateNavbar();
}
