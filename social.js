/* ClipNow social features: public follows, follower/following counts, follow buttons. */

async function getFollowCounts(userId) {
  if (!userId) return { followers: 0, following: 0 };
  const [{ count: followers }, { count: following }] = await Promise.all([
    client.from("follows").select("follower_id", { count: "exact", head: true }).eq("following_id", userId),
    client.from("follows").select("following_id", { count: "exact", head: true }).eq("follower_id", userId)
  ]);
  return { followers: followers || 0, following: following || 0 };
}

async function isFollowing(userId) {
  const me = await getCurrentUser();
  if (!me || !userId || me.id === userId) return false;
  const { data } = await client.from("follows").select("follower_id")
    .eq("follower_id", me.id).eq("following_id", userId).maybeSingle();
  return !!data;
}

async function toggleFollow(userId, button) {
  const me = await requireLogin();
  if (!me || !userId || me.id === userId) return;
  if (button) { button.disabled = true; button.textContent = "..."; }
  try {
    const following = await isFollowing(userId);
    if (following) {
      const { error } = await client.from("follows").delete().eq("follower_id", me.id).eq("following_id", userId);
      if (error) throw error;
    } else {
      const { error } = await client.from("follows").insert({ follower_id: me.id, following_id: userId });
      if (error) throw error;
    }
    if (typeof refreshSocialUI === "function") await refreshSocialUI();
    await refreshSearchFollowButtons();
  } catch (err) {
    console.error("toggleFollow:", err);
    alert(err.message || "Could not update follow");
  } finally {
    if (button) button.disabled = false;
  }
}

async function refreshSearchFollowButtons() {
  const buttons = [...document.querySelectorAll("[data-follow-user]")];
  await Promise.all(buttons.map(async button => {
    const id = button.getAttribute("data-follow-user");
    if (!id) return;
    const following = await isFollowing(id);
    button.className = `btn ${following ? "btn-outline" : "btn-green"} follow-btn`;
    button.textContent = following ? "Following" : "Follow";
  }));
}

async function loadFollowersList(userId, type) {
  const filterColumn = type === "following" ? "follower_id" : "following_id";
  const idColumn = type === "following" ? "following_id" : "follower_id";
  const { data: rows, error } = await client.from("follows").select("follower_id, following_id").eq(filterColumn, userId).order("created_at", { ascending: false });
  if (error) throw error;
  const ids = (rows || []).map(row => row[idColumn]).filter(Boolean);
  if (!ids.length) return [];
  const { data: profiles, error: profileError } = await client.from("profiles").select("id, username, display_name, avatar_url, is_dev, rainbow_name").in("id", ids);
  if (profileError) throw profileError;
  const map = Object.fromEntries((profiles || []).map(p => [p.id, p]));
  return ids.map(id => map[id]).filter(Boolean);
}

async function showFollowersList(userId, type) {
  try {
    const title = type === "following" ? "Following" : "Followers";
    const list = await loadFollowersList(userId, type);
    const box = document.getElementById("social-list");
    const heading = document.getElementById("social-list-title");
    if (!box || !heading) return;
    heading.textContent = title;
    box.innerHTML = list.length ? list.map(p => {
      const name = p.rainbow_name ? `<span class="rainbow-name">${escapeHtml(p.display_name || p.username)}</span>` : escapeHtml(p.display_name || p.username);
      const avatar = p.avatar_url ? `<img class="avatar-sm" src="${escapeHtml(p.avatar_url)}" alt="">` : `<div class="avatar-sm">${escapeHtml((p.username || "?").charAt(0).toUpperCase())}</div>`;
      return `<a class="user-card" href="profile.html?user=${encodeURIComponent(p.username)}">${avatar}<div><div style="font-weight:500">${name}${p.is_dev ? ' <span class="dev-badge">DEV</span>' : ""}</div><div style="font-size:13px;color:#888">@${escapeHtml(p.username)}</div></div></a>`;
    }).join("") : `<p class="empty">No ${type === "following" ? "following" : "followers"} yet.</p>`;
    box.classList.remove("hidden");
  } catch (err) {
    console.error("showFollowersList:", err);
  }
}

/* Profile moderation is attached here so the existing public profile UI stays unchanged. */
(function setupProfileModeration() {
  if (!/profile\.html$/i.test(location.pathname)) return;
  function loadModerationScript() {
    return new Promise((resolve, reject) => {
      if (window.ClipNowModeration) return resolve();
      const script = document.createElement("script");
      script.src = "moderation.js";
      script.onload = resolve;
      script.onerror = () => reject(new Error("Could not load moderation.js"));
      document.head.appendChild(script);
    });
  }
  window.addEventListener("load", async () => {
    try {
      await loadModerationScript();
      if (typeof window.saveProfile !== "function") return;
      const originalSaveProfile = window.saveProfile;
      window.saveProfile = async function () {
        const errorEl = document.getElementById("edit-error");
        try {
          ClipNowModeration.assertTextAllowed(document.getElementById("edit-username")?.value || "", "username");
          ClipNowModeration.assertTextAllowed(document.getElementById("edit-display-name")?.value || "", "username");
          ClipNowModeration.assertTextAllowed(document.getElementById("edit-bio")?.value || "", "profile");
        } catch (err) {
          if (errorEl) { errorEl.textContent = err.message || "That profile text is not allowed."; errorEl.style.display = "block"; }
          return;
        }
        return originalSaveProfile();
      };
    } catch (err) { console.error("Profile moderation setup:", err); }
  });
})();

/* Creator verification: display-only. The verified flag is controlled in Supabase, not by users. */
(function setupCreatorVerification() {
  if (!/profile\.html$/i.test(location.pathname)) return;
  function addStyles() {
    if (document.getElementById("clipnow-verification-styles")) return;
    const style = document.createElement("style");
    style.id = "clipnow-verification-styles";
    style.textContent = `.clipnow-verified{display:inline-flex;align-items:center;justify-content:center;width:19px;height:19px;margin-left:7px;border-radius:50%;background:#1d9bf0;color:#fff;font-size:13px;font-family:Arial,sans-serif;font-weight:900;line-height:19px;vertical-align:middle;box-shadow:0 1px 5px rgba(29,155,240,.28)}`;
    document.head.appendChild(style);
  }
  window.addEventListener("load", async () => {
    setTimeout(async () => {
      try {
        const username = new URLSearchParams(location.search).get("user");
        let profile = null;
        if (username) {
          const result = await client.from("profiles").select("verified").eq("username", username.toLowerCase()).maybeSingle();
          profile = result.data;
        } else {
          const me = await getCurrentUser();
          if (me) {
            const result = await client.from("profiles").select("verified").eq("id", me.id).maybeSingle();
            profile = result.data;
          }
        }
        if (!profile?.verified) return;
        const name = document.getElementById("display-name");
        if (!name || name.querySelector(".clipnow-verified")) return;
        addStyles();
        const badge = document.createElement("span");
        badge.className = "clipnow-verified";
        badge.title = "Verified creator";
        badge.setAttribute("aria-label", "Verified creator");
        badge.textContent = "✓";
        name.appendChild(badge);
      } catch (err) {
        console.warn("Creator verification unavailable:", err);
      }
    }, 300);
  });
})();

/* Profile banners: isolated from the existing profile renderer so the current profile UI stays intact. */
(function setupProfileBanners() {
  if (!/profile\.html$/i.test(location.pathname)) return;

  const MAX_BANNER_SIZE = 5 * 1024 * 1024;

  function addStyles() {
    if (document.getElementById("clipnow-banner-styles")) return;
    const style = document.createElement("style");
    style.id = "clipnow-banner-styles";
    style.textContent = `
      .clipnow-profile-banner{position:relative;width:100%;height:190px;margin:0 0 22px;border-radius:16px;overflow:hidden}
      .clipnow-profile-banner img{width:100%;height:100%;display:block;object-fit:cover;border-radius:16px}
      .clipnow-profile-banner::after{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(180deg,rgba(0,0,0,.02) 35%,rgba(0,0,0,.42) 100%);border-radius:16px}
      .clipnow-banner-settings{margin-bottom:16px}
      .clipnow-banner-preview{width:100%;height:120px;margin-top:10px;border-radius:10px;overflow:hidden;border:1px solid #2b2b2b;background:#111;display:none}
      .clipnow-banner-preview img{width:100%;height:100%;object-fit:cover;display:block}
      .clipnow-banner-help{display:block;margin-top:7px;color:#777;font-size:12px;line-height:1.4}
      .clipnow-banner-remove{margin-top:9px}
      @media(max-width:600px){.clipnow-profile-banner{height:140px;border-radius:12px}.clipnow-profile-banner img,.clipnow-profile-banner::after{border-radius:12px}}
    `;
    document.head.appendChild(style);
  }

  function getOrCreateBanner() {
    let banner = document.getElementById("clipnow-profile-banner");
    if (banner) return banner;
    const header = document.getElementById("profile-header");
    if (!header) return null;
    banner = document.createElement("div");
    banner.id = "clipnow-profile-banner";
    banner.className = "clipnow-profile-banner";
    header.parentNode.insertBefore(banner, header);
    return banner;
  }

  function renderBanner(url) {
    const banner = document.getElementById("clipnow-profile-banner");
    if (!url) {
      if (banner) banner.remove();
      return;
    }
    const target = banner || getOrCreateBanner();
    if (!target) return;
    target.innerHTML = `<img src="${escapeHtml(url)}" alt="Profile banner">`;
    const img = target.querySelector("img");
    img.onerror = () => target.remove();
  }

  function addEditorControls() {
    const editMode = document.getElementById("edit-mode");
    if (!editMode || document.getElementById("clipnow-banner-settings")) return;
    const section = document.createElement("div");
    section.id = "clipnow-banner-settings";
    section.className = "form-group clipnow-banner-settings";
    section.innerHTML = `
      <label for="profile-banner-input">Profile Banner</label>
      <input type="file" id="profile-banner-input" accept="image/*">
      <span class="clipnow-banner-help">Add a banner image to the top of your profile. Maximum 5 MB.</span>
      <div id="clipnow-banner-preview" class="clipnow-banner-preview"><img alt="Banner preview"></div>
      <button type="button" id="remove-profile-banner" class="btn btn-outline clipnow-banner-remove">Remove banner</button>
    `;
    const bioGroup = document.getElementById("edit-bio")?.closest(".form-group");
    const anchor = bioGroup || editMode.querySelector(".row");
    if (anchor) editMode.insertBefore(section, anchor);
    else editMode.appendChild(section);

    const input = document.getElementById("profile-banner-input");
    const preview = document.getElementById("clipnow-banner-preview");
    const previewImg = preview?.querySelector("img");
    input?.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file || !preview || !previewImg) return;
      if (file.size > MAX_BANNER_SIZE) {
        input.value = "";
        const errorEl = document.getElementById("edit-error");
        if (errorEl) { errorEl.textContent = "Banner image must be 5 MB or smaller."; errorEl.style.display = "block"; }
        return;
      }
      input.dataset.remove = "false";
      const reader = new FileReader();
      reader.onload = () => { previewImg.src = reader.result; preview.style.display = "block"; };
      reader.readAsDataURL(file);
    });

    document.getElementById("remove-profile-banner")?.addEventListener("click", () => {
      input.value = "";
      input.dataset.remove = "true";
      if (preview) preview.style.display = "none";
      const errorEl = document.getElementById("edit-error");
      if (errorEl) errorEl.style.display = "none";
    });
  }

  async function uploadBanner(user, file) {
    const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
    const path = `${user.id}/banner.${ext || "jpg"}`;
    const { error } = await client.storage.from("clips").upload(path, file, {
      upsert: true,
      contentType: file.type || "image/jpeg"
    });
    if (error) throw error;
    const { data } = client.storage.from("clips").getPublicUrl(path);
    return `${data.publicUrl}?t=${Date.now()}`;
  }

  async function removeOldBannerFiles(userId) {
    const { data } = await client.storage.from("clips").list(userId, { search: "banner", limit: 20 });
    const paths = (data || []).filter(item => /^banner\.[a-z0-9]+$/i.test(item.name)).map(item => `${userId}/${item.name}`);
    if (paths.length) await client.storage.from("clips").remove(paths);
  }

  function wrapSaveProfile() {
    if (window.__clipNowBannerSaveWrapped || typeof window.saveProfile !== "function") return;
    window.__clipNowBannerSaveWrapped = true;
    const originalSaveProfile = window.saveProfile;
    window.saveProfile = async function () {
      const input = document.getElementById("profile-banner-input");
      const file = input?.files?.[0];
      const remove = input?.dataset.remove === "true";
      const errorEl = document.getElementById("edit-error");
      const user = await getCurrentUser();
      if (!user) return;
      if (file && file.size > MAX_BANNER_SIZE) {
        if (errorEl) { errorEl.textContent = "Banner image must be 5 MB or smaller."; errorEl.style.display = "block"; }
        return;
      }
      try {
        let bannerUrl = currentProfile?.banner_url || null;
        if (file) {
          bannerUrl = await uploadBanner(user, file);
          await client.from("profiles").update({ banner_url: bannerUrl }).eq("id", user.id);
        } else if (remove) {
          await removeOldBannerFiles(user.id);
          bannerUrl = null;
          await client.from("profiles").update({ banner_url: null }).eq("id", user.id);
        }
        const result = await originalSaveProfile();
        if (result !== undefined && result === null) return result;
        if (currentProfile) currentProfile.banner_url = bannerUrl;
        renderBanner(bannerUrl);
        return result;
      } catch (err) {
        if (errorEl) { errorEl.textContent = err.message || "Failed to save profile banner"; errorEl.style.display = "block"; }
        console.error("Profile banner save:", err);
      }
    };
  }

  async function boot() {
    addStyles();
    addEditorControls();
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      addEditorControls();
      if (typeof currentProfile !== "undefined" && currentProfile) {
        clearInterval(timer);
        renderBanner(currentProfile.banner_url || null);
        if (viewingOwnProfile) wrapSaveProfile();
      } else if (tries >= 100) {
        clearInterval(timer);
        wrapSaveProfile();
      }
    }, 100);
  }

  window.addEventListener("load", boot);
})();