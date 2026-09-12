/* ClipNow Discover enhancements. Keeps the existing Discover layout and controls. */
(function () {
  function scoreTrending(clip) {
    return (Number(clip.views) || 0) * 0.6 + (Number(clip.likes_count) || 0) * 3 + (Number(clip.comments_count) || 0) * 2;
  }

  function addStyles() {
    if (document.getElementById("clipnow-discover-feature-styles")) return;
    const style = document.createElement("style");
    style.id = "clipnow-discover-feature-styles";
    style.textContent = `
      .clipnow-discover-tags .tag-chip{height:30px;padding:0 10px;border:1px solid rgba(255,255,255,.09);border-radius:999px;background:rgba(255,255,255,.035);color:#aaa;cursor:pointer;font:inherit;font-size:12px}
      .clipnow-discover-tags .tag-chip:hover,.clipnow-discover-tags .tag-chip.active{border-color:rgba(34,197,94,.45);background:rgba(34,197,94,.08);color:#ddd}
      .verified-badge{display:inline-flex;align-items:center;margin-right:7px;padding:1px 6px;border:1px solid rgba(34,197,94,.35);border-radius:999px;color:#8ee8ad;font-size:10px;font-weight:700;vertical-align:middle}
    `;
    document.head.appendChild(style);
  }

  async function enhanceDiscover() {
    const sort = document.getElementById("sort");
    const search = document.getElementById("search");
    const grid = document.getElementById("discover-grid");
    const count = document.getElementById("count");
    if (!sort || !search || !grid || typeof client === "undefined") return;

    addStyles();

    if (!sort.querySelector('option[value="trending"]')) {
      const option = document.createElement("option");
      option.value = "trending";
      option.textContent = "Trending";
      sort.insertBefore(option, sort.firstChild);
    }

    let clips = [];
    try {
      const result = await client.from("clips").select("*").eq("visibility", "public").order("created_at", { ascending: false }).limit(100);
      if (result.error) throw result.error;
      clips = result.data || [];

      const ids = [...new Set(clips.map(c => c.user_id).filter(Boolean))];
      if (ids.length) {
        let profilesResult = await client.from("profiles").select("id,username,display_name,avatar_url,is_dev,rainbow_name,og_member,verified").in("id", ids);
        if (profilesResult.error) {
          profilesResult = await client.from("profiles").select("id,username,display_name,avatar_url,is_dev,rainbow_name,og_member").in("id", ids);
        }
        const profiles = profilesResult.data || [];
        const map = Object.fromEntries(profiles.map(p => [p.id, p]));
        clips.forEach(c => { c.profiles = map[c.user_id] || null; });
      }
    } catch (err) {
      console.error("Discover enhancement:", err);
      return;
    }

    let tagRow = document.querySelector(".clipnow-discover-tags");
    if (!tagRow) {
      tagRow = document.createElement("div");
      tagRow.className = "clipnow-discover-tags";
      tagRow.style.cssText = "display:flex;gap:7px;flex-wrap:wrap;margin:0 0 18px";
      grid.parentNode.insertBefore(tagRow, grid);
    }

    const tags = [...new Set(clips.flatMap(c => Array.isArray(c.tags) ? c.tags : []))].map(t => String(t).trim()).filter(Boolean).slice(0, 16);
    let activeTag = new URLSearchParams(location.search).get("tag") || "";

    function renderTags() {
      tagRow.innerHTML = "";
      if (!tags.length) return;
      const all = document.createElement("button");
      all.type = "button";
      all.className = "tag-chip" + (!activeTag ? " active" : "");
      all.textContent = "All";
      all.onclick = () => { activeTag = ""; renderTags(); render(); };
      tagRow.appendChild(all);
      tags.forEach(tag => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "tag-chip" + (activeTag === tag ? " active" : "");
        button.textContent = "#" + tag;
        button.onclick = () => { activeTag = tag; renderTags(); render(); };
        tagRow.appendChild(button);
      });
    }

    function render() {
      const query = search.value.trim().toLowerCase();
      let list = clips.filter(c => {
        if (activeTag && !(Array.isArray(c.tags) && c.tags.includes(activeTag))) return false;
        if (!query) return true;
        const title = String(c.title || "").toLowerCase();
        const profile = c.profiles || {};
        const username = String(profile.username || "").toLowerCase();
        const displayName = String(profile.display_name || "").toLowerCase();
        const clipTags = (Array.isArray(c.tags) ? c.tags : []).join(" ").toLowerCase();
        return title.includes(query) || username.includes(query) || displayName.includes(query) || clipTags.includes(query);
      });

      if (sort.value === "views") list.sort((a, b) => (Number(b.views) || 0) - (Number(a.views) || 0));
      else if (sort.value === "likes") list.sort((a, b) => (Number(b.likes_count) || 0) - (Number(a.likes_count) || 0));
      else if (sort.value === "trending") list.sort((a, b) => scoreTrending(b) - scoreTrending(a));
      else list.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

      if (count) count.textContent = `${list.length} clip${list.length === 1 ? "" : "s"}`;
      if (!list.length) {
        grid.innerHTML = '<div class="discover-empty"><h2>No clips found</h2><p>Try a different search, tag or sort option.</p></div>';
        return;
      }

      grid.innerHTML = list.map(c => clipCardHtml(c)).join("");
      [...grid.querySelectorAll(".clip-card")].forEach((card, index) => {
        const profile = list[index]?.profiles;
        if (!profile?.verified) return;
        const meta = card.querySelector(".clip-meta");
        if (!meta || meta.querySelector(".verified-badge")) return;
        const badge = document.createElement("span");
        badge.className = "verified-badge";
        badge.textContent = "✓ Verified";
        meta.insertBefore(badge, meta.firstChild);
      });
      if (typeof hydrateThumbnails === "function") hydrateThumbnails(grid);
    }

    renderTags();
    sort.addEventListener("change", render);
    search.addEventListener("input", render);
    render();
  }

  window.addEventListener("load", () => setTimeout(enhanceDiscover, 350));
})();
