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
      const { error } = await client.from("follows").delete()
        .eq("follower_id", me.id).eq("following_id", userId);
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
  const { data: rows, error } = await client.from("follows")
    .select("follower_id, following_id")
    .eq(filterColumn, userId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  const ids = (rows || []).map(row => row[idColumn]).filter(Boolean);
  if (!ids.length) return [];
  const { data: profiles, error: profileError } = await client.from("profiles")
    .select("id, username, display_name, avatar_url, is_dev, rainbow_name")
    .in("id", ids);
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
          if (errorEl) {
            errorEl.textContent = err.message || "That profile text is not allowed.";
            errorEl.style.display = "block";
          }
          return;
        }
        return originalSaveProfile();
      };
    } catch (err) {
      console.error("Profile moderation setup:", err);
    }
  });
})();
