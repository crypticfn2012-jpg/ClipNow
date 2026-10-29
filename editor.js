(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const TRACK_LABEL = 78;
  const HISTORY_LIMIT = 80;
  const ASPECTS = {
    "16:9": [1280, 720],
    "9:16": [720, 1280],
    "1:1": [1080, 1080],
    "4:5": [864, 1080]
  };
  const state = {
    project: { name: "Untitled project", ratio: "16:9", items: [], markers: [], trackCounts: { visual: 1, overlay: 1, audio: 1 } },
    assets: new Map(),
    selectedId: null,
    time: 0,
    zoom: 80,
    playing: false,
    playbackEpoch: 0,
    playbackWall: 0,
    raf: 0,
    currentVisualAsset: null,
    currentVisualItemId: null,
    history: [],
    future: [],
    audioContext: null,
    audioMix: null,
    recorder: null,
    exportMode: null,
    clipboard: null,
    snapEnabled: true,
    transcriberPromise: null,
    speechModelLoaded: false
  };

  const canvas = $("previewCanvas");
  const ctx = canvas.getContext("2d", { alpha: false });
  const timelineScroll = $("timelineScroll");
  const timelineContent = $("timelineContent");
  const timelineRuler = $("timelineRuler");
  const playhead = $("timelinePlayhead");
  let toastHandle = 0;

  function uid() {
    return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : "cn-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }
  function clamp(n, min, max) { return Math.min(max, Math.max(min, Number(n) || 0)); }
  function fmtTime(s, frames) {
    const v = Math.max(0, Number(s) || 0);
    const m = Math.floor(v / 60);
    const sec = Math.floor(v % 60);
    const centi = Math.floor((v - Math.floor(v)) * 100);
    return String(m).padStart(2, "0") + ":" + String(sec).padStart(2, "0") + (frames === false ? "" : "." + String(centi).padStart(2, "0"));
  }
  function fmtShort(s) {
    const v = Math.max(0, Number(s) || 0);
    return Math.floor(v / 60) + ":" + String(Math.floor(v % 60)).padStart(2, "0");
  }
  function fmtBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return "Media";
    if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }
  function notify(message) {
    const el = $("editorToast");
    el.textContent = message;
    el.classList.add("visible");
    clearTimeout(toastHandle);
    toastHandle = setTimeout(() => el.classList.remove("visible"), 3000);
  }
  function showExportError(message) {
    $("exportError").textContent = message;
    $("exportError").hidden = false;
  }
  function clearExportError() {
    const el = $("exportError");
    el.textContent = "";
    el.hidden = true;
    el.style.background = "";
    el.style.borderColor = "";
    el.style.color = "";
  }
  function itemDuration(item) {
    if (item.kind === "visual" || item.kind === "audio") {
      return Math.max(0, (Number(item.out) - Number(item.in)) / Math.max(0.05, Number(item.speed) || 1));
    }
    return Math.max(0, Number(item.duration) || 0);
  }
  function itemEnd(item) { return (Number(item.start) || 0) + itemDuration(item); }
  function volumeAtTime(item, time) {
    let volume = clamp(item.volume == null ? 1 : item.volume, 0, 2);
    const elapsed = time - item.start;
    const remaining = itemEnd(item) - time;
    if (Number(item.fadeIn) > 0) volume *= clamp(elapsed / Number(item.fadeIn), 0, 1);
    if (Number(item.fadeOut) > 0) volume *= clamp(remaining / Number(item.fadeOut), 0, 1);
    return volume;
  }
  function applyAudioLevels(time) {
    const levels = new Map();
    const visual = activeItem("visual", time);
    const visualAsset = visual ? assetFor(visual) : null;
    if (visual && visualAsset && visualAsset.type === "video") levels.set(visualAsset.id, visual.sourceMuted ? 0 : volumeAtTime(visual, time));
    state.project.items.forEach(item => {
      if (item.kind !== "audio" || time < item.start || time >= itemEnd(item)) return;
      const asset = assetFor(item);
      if (!asset || asset.type !== "audio") return;
      levels.set(asset.id, Math.max(levels.get(asset.id) || 0, volumeAtTime(item, time)));
    });
    state.assets.forEach(asset => {
      if (!asset.element || !["video", "audio"].includes(asset.type)) return;
      const level = levels.has(asset.id) ? clamp(levels.get(asset.id), 0, 2) : 0;
      if (asset.gainNode && state.audioContext) {
        try { asset.gainNode.gain.setTargetAtTime(level, state.audioContext.currentTime, 0.025); }
        catch (_) { asset.gainNode.gain.value = level; }
      } else {
        asset.element.volume = clamp(level, 0, 1);
      }
    });
  }
  function projectDuration() {
    let end = 0;
    state.project.items.forEach(item => { end = Math.max(end, itemEnd(item)); });
    return end;
  }
  function visualTrackEnd() {
    let end = 0;
    state.project.items.forEach(item => { if (item.kind === "visual") end = Math.max(end, itemEnd(item)); });
    return end;
  }
  function itemTrack(item) {
    if (item.kind === "visual") return "visual";
    if (item.kind === "audio") return "audio";
    return "overlay";
  }
  function assetFor(item) { return item && item.assetId ? state.assets.get(item.assetId) : null; }
  function selectedItem() { return state.project.items.find(item => item.id === state.selectedId) || null; }
  function activeItem(kind, time) {
    const t = Number.isFinite(time) ? time : state.time;
    const found = state.project.items.filter(item => item.kind === kind && t >= item.start && t < itemEnd(item));
    found.sort((a, b) => (Number(a.track) || 0) - (Number(b.track) || 0) || a.start - b.start || state.project.items.indexOf(a) - state.project.items.indexOf(b));
    return found.length ? found[found.length - 1] : null;
  }
  function takeSnapshot() {
    return JSON.stringify({
      project: { name: state.project.name, ratio: state.project.ratio, items: state.project.items.map(item => Object.assign({}, item)), markers: (state.project.markers || []).map(marker => Object.assign({}, marker)), trackCounts: Object.assign({ visual: 1, overlay: 1, audio: 1 }, state.project.trackCounts || {}) },
      selectedId: state.selectedId,
      time: state.time
    });
  }
  function checkpoint() {
    state.history.push(takeSnapshot());
    if (state.history.length > HISTORY_LIMIT) state.history.shift();
    state.future = [];
    updateHistoryButtons();
  }
  function restoreSnapshot(raw) {
    const snapshot = JSON.parse(raw);
    state.project = snapshot.project;
    state.project.markers = state.project.markers || [];
    state.project.trackCounts = Object.assign({ visual: 1, overlay: 1, audio: 1 }, state.project.trackCounts || {});
    state.selectedId = snapshot.selectedId;
    state.time = snapshot.time || 0;
    $("projectName").value = state.project.name || "Untitled project";
    $("aspectRatio").value = state.project.ratio || "16:9";
    updateCanvasSize();
    renderAll();
    syncMedia(state.time, false);
  }
  function updateHistoryButtons() {
    $("undoBtn").disabled = state.history.length === 0;
    $("redoBtn").disabled = state.future.length === 0;
  }
  function undo() {
    if (!state.history.length) return;
    state.future.push(takeSnapshot());
    restoreSnapshot(state.history.pop());
    updateHistoryButtons();
    notify("Undo");
  }
  function redo() {
    if (!state.future.length) return;
    state.history.push(takeSnapshot());
    restoreSnapshot(state.future.pop());
    updateHistoryButtons();
    notify("Redo");
  }

  function updateCanvasSize(width, height) {
    const dimensions = width && height ? [width, height] : (ASPECTS[state.project.ratio] || ASPECTS["16:9"]);
    canvas.width = dimensions[0];
    canvas.height = dimensions[1];
    $("stage").style.aspectRatio = dimensions[0] + " / " + dimensions[1];
    $("previewResolution").textContent = dimensions[0] + " × " + dimensions[1];
    drawFrame();
  }

  function audioGraphFor(asset) {
    if (!state.audioContext || !asset || !asset.element || !["video", "audio"].includes(asset.type)) return;
    if (asset.gainNode) return;
    try {
      const source = state.audioContext.createMediaElementSource(asset.element);
      const gain = state.audioContext.createGain();
      source.connect(gain);
      gain.connect(state.audioContext.destination);
      if (state.audioMix) gain.connect(state.audioMix);
      asset.sourceNode = source;
      asset.gainNode = gain;
      asset.element.volume = 1;
    } catch (error) {
      asset.audioUnavailable = true;
      console.warn("ClipNow editor: audio graph unavailable for", asset.name, error);
    }
  }
  async function ensureAudioGraph() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return false;
    try {
      if (!state.audioContext) {
        state.audioContext = new AudioContextClass();
        state.audioMix = state.audioContext.createMediaStreamDestination();
      }
      for (const asset of state.assets.values()) audioGraphFor(asset);
      if (state.audioContext.state === "suspended") await state.audioContext.resume();
      return !!state.audioMix;
    } catch (error) {
      console.warn("ClipNow editor audio setup failed", error);
      return false;
    }
  }

  function waitMedia(el, eventName, failEvent, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (eventName === "loadedmetadata" && el.readyState >= 1 && Number.isFinite(el.duration)) { resolve(); return; }
      if (eventName === "load" && el.complete && el.naturalWidth) { resolve(); return; }
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        el.removeEventListener(eventName, ok);
        el.removeEventListener(failEvent, bad);
        if (error) reject(error); else resolve();
      };
      const ok = () => finish();
      const bad = () => finish(new Error("The media file could not be opened."));
      const timer = setTimeout(() => finish(new Error("Timed out while loading media.")), timeoutMs || 20000);
      el.addEventListener(eventName, ok, { once: true });
      el.addEventListener(failEvent, bad, { once: true });
    });
  }
  async function buildAssetFromFile(file) {
    const type = String(file.type || "").split("/")[0];
    if (!["video", "image", "audio"].includes(type)) throw new Error(file.name + " is not a supported media type.");
    const asset = {
      id: uid(), name: file.name || "Untitled media", type: type, size: file.size || 0,
      file: file, url: URL.createObjectURL(file), duration: type === "image" ? 5 : 0,
      element: null, width: 0, height: 0, gainNode: null, sourceNode: null
    };
    if (type === "image") {
      const img = new Image();
      img.decoding = "async";
      img.src = asset.url;
      await waitMedia(img, "load", "error", 20000);
      asset.element = img;
      asset.width = img.naturalWidth;
      asset.height = img.naturalHeight;
    } else {
      const el = document.createElement(type);
      el.preload = "auto";
      el.crossOrigin = "anonymous";
      if (type === "video") {
        el.playsInline = true;
        el.controls = false;
      }
      el.src = asset.url;
      el.load();
      await waitMedia(el, "loadedmetadata", "error", 25000);
      asset.element = el;
      asset.duration = Number.isFinite(el.duration) ? el.duration : 0;
      asset.width = el.videoWidth || 0;
      asset.height = el.videoHeight || 0;
      if (!asset.duration || !Number.isFinite(asset.duration)) throw new Error(file.name + " has no readable duration.");
      el.addEventListener("seeked", () => { if (!state.playing && asset.id === state.currentVisualAsset) drawFrame(); });
    }
    if (state.audioContext) audioGraphFor(asset);
    return asset;
  }
  async function buildCloudVideo(url, name, size) {
    const el = document.createElement("video");
    el.preload = "auto";
    el.crossOrigin = "anonymous";
    el.playsInline = true;
    el.src = url;
    el.load();
    await waitMedia(el, "loadedmetadata", "error", 30000);
    if (!Number.isFinite(el.duration) || el.duration <= 0) throw new Error("The selected ClipNow clip has no readable duration.");
    const asset = {
      id: uid(), name: name || "ClipNow video", type: "video", size: Number(size) || 0,
      file: null, url: url, duration: el.duration, element: el,
      width: el.videoWidth || 0, height: el.videoHeight || 0,
      gainNode: null, sourceNode: null, cloud: true
    };
    el.addEventListener("seeked", () => { if (!state.playing && asset.id === state.currentVisualAsset) drawFrame(); });
    if (state.audioContext) audioGraphFor(asset);
    return asset;
  }

  async function importFiles(files, autoTab, addImportedToTimeline) {
    const incoming = Array.from(files || []);
    if (!incoming.length) return [];
    let success = 0;
    const imported = [];
    for (const file of incoming) {
      try {
        const asset = await buildAssetFromFile(file);
        state.assets.set(asset.id, asset);
        imported.push(asset);
        success++;
      } catch (error) {
        notify((file.name || "File") + ": " + (error.message || "Could not import."));
      }
    }
    if (addImportedToTimeline && imported.length) {
      checkpoint();
      imported.forEach(asset => {
        let item;
        if (asset.type === "audio") {
          item = { id: uid(), kind: "audio", assetId: asset.id, name: asset.name, start: 0, in: 0, out: asset.duration, speed: 1, volume: 1, fadeIn: 0, fadeOut: 0 };
        } else {
          item = makeVisualItem(asset, visualTrackEnd());
          state.time = item.start;
        }
        state.project.items.push(item);
        state.selectedId = item.id;
      });
    }
    renderMediaList();
    if (autoTab) activatePanel(autoTab);
    if (success) {
      $("saveStatus").textContent = "Media imported";
      notify(success + " file" + (success === 1 ? "" : "s") + (addImportedToTimeline ? " added to the timeline." : " added to the media library."));
      if (addImportedToTimeline) renderAll();
    }
    return imported;
  }

  function iconForAsset(asset) {
    if (asset.type === "video") return "▶";
    if (asset.type === "image") return "▧";
    return "♫";
  }
  function renderMediaList() {
    const list = $("mediaList");
    const search = $("mediaSearch").value.trim().toLowerCase();
    const filter = $("mediaFilter").value;
    const assets = Array.from(state.assets.values()).filter(asset =>
      (filter === "all" || asset.type === filter) && (!search || asset.name.toLowerCase().includes(search))
    );
    list.replaceChildren();
    if (!assets.length) {
      const empty = document.createElement("div");
      empty.className = "editor-empty";
      const mark = document.createElement("span");
      mark.textContent = "▧";
      const title = document.createElement("strong");
      title.textContent = state.assets.size ? "No media matches this filter" : "Your media library is empty";
      const desc = document.createElement("p");
      desc.textContent = state.assets.size ? "Try another search or media filter." : "Import a video, screenshot, or music track to get started.";
      empty.append(mark, title, desc);
      list.appendChild(empty);
      return;
    }
    assets.forEach(asset => {
      const card = document.createElement("article");
      card.className = "editor-media-item";
      const thumb = document.createElement("div");
      thumb.className = "editor-media-thumb";
      if (asset.type === "image" && asset.url) {
        const img = document.createElement("img");
        img.src = asset.url;
        img.alt = "";
        thumb.appendChild(img);
      } else {
        thumb.textContent = iconForAsset(asset);
      }
      const meta = document.createElement("div");
      meta.className = "editor-media-meta";
      const name = document.createElement("div");
      name.className = "editor-media-name";
      name.title = asset.name;
      name.textContent = asset.name;
      const sub = document.createElement("div");
      sub.className = "editor-media-sub";
      sub.textContent = (asset.type === "image" ? "Image · 5s default" : asset.type === "audio" ? "Audio · " + fmtShort(asset.duration) : "Video · " + fmtShort(asset.duration)) + " · " + fmtBytes(asset.size);
      meta.append(name, sub);
      const buttons = document.createElement("div");
      buttons.className = "editor-media-buttons";
      const add = document.createElement("button");
      add.type = "button";
      add.textContent = asset.type === "audio" ? "Add audio track" : "Add to timeline";
      add.dataset.addAsset = asset.id;
      const second = document.createElement("button");
      second.type = "button";
      second.textContent = asset.type === "image" ? "Add as overlay" : "Preview";
      if (asset.type === "image") second.dataset.addOverlay = asset.id;
      else second.dataset.previewAsset = asset.id;
      buttons.append(add, second);
      card.append(thumb, meta, buttons);
      list.appendChild(card);
    });
  }

  function makeVisualItem(asset, start) {
    return {
      id: uid(), kind: "visual", assetId: asset.id, name: asset.name, track: 0,
      start: Math.max(0, start), in: 0, out: asset.duration, speed: 1,
      volume: 1, fit: "contain", brightness: 0, contrast: 1, saturate: 1,
      hue: 0, temperature: 0, vignette: 0, blur: 0, look: "clean",
      x: 50, y: 50, scale: 1, rotation: 0, opacity: 1, keyframes: [],
      fadeIn: 0, fadeOut: 0, transition: "none", transitionDuration: 0.4
    };
  }
  function addAssetToTimeline(assetId, overlay) {
    const asset = state.assets.get(assetId);
    if (!asset) return;
    checkpoint();
    let item;
    if (asset.type === "audio") {
      item = { id: uid(), kind: "audio", assetId: asset.id, name: asset.name, track: 0, start: state.time, in: 0, out: asset.duration, speed: 1, volume: 1, fadeIn: 0, fadeOut: 0, keyframes: [] };
    } else if (overlay && asset.type === "image") {
      item = { id: uid(), kind: "imageOverlay", assetId: asset.id, name: asset.name, track: 0, start: state.time, duration: 5, x: 50, y: 50, scale: 0.35, opacity: 1, rotation: 0, keyframes: [] };
    } else {
      const start = visualTrackEnd();
      item = makeVisualItem(asset, start);
    }
    state.project.items.push(item);
    state.selectedId = item.id;
    if (item.kind === "visual") state.time = item.start;
    if (item.kind === "audio" || item.kind === "imageOverlay") state.time = item.start;
    $("stageEmpty").hidden = true;
    renderAll();
    syncMedia(state.time, false);
    if (item.kind === "visual") {
      const assetNow = assetFor(item);
      if (assetNow && assetNow.type === "video") seekMediaForItem(item, state.time, false);
    }
    notify("Added " + asset.name + " to the timeline.");
  }

  function addText(text, preset) {
    const value = String(text || "Text").trim();
    if (!value) { notify("Enter some text first."); return; }
    checkpoint();
    const isCaption = preset === "caption";
    const item = {
      id: uid(), kind: "text", name: isCaption ? "Caption" : "Text",
      value: value, start: state.time, duration: 5, x: 50, y: isCaption ? 84 : 50, track: 0,
      scale: 1, fontSize: isCaption ? 36 : Number($("newTextSize").value) || 56,
      color: $("newTextColor").value || "#ffffff", background: isCaption,
      rotation: 0, opacity: 1, align: "center", bold: true, outline: true, keyframes: []
    };
    if (preset === "title") { item.fontSize = 84; item.y = 45; item.scale = 1; }
    state.project.items.push(item);
    state.selectedId = item.id;
    renderAll();
    notify("Text layer added. Select it to edit its style and timing.");
  }

  function addSticker(value) {
    checkpoint();
    const item = {
      id: uid(), kind: "sticker", name: "Sticker " + value, value: value, track: 0,
      start: state.time, duration: 4, x: 50, y: 30, scale: 1,
      opacity: 1, rotation: 0, keyframes: []
    };
    state.project.items.push(item);
    state.selectedId = item.id;
    renderAll();
  }

  function activatePanel(panelId) {
    document.querySelectorAll(".editor-tool-tab").forEach(tab => {
      const active = tab.dataset.panel === panelId;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    });
    document.querySelectorAll(".editor-tool-panel").forEach(panel => {
      const active = panel.id === panelId;
      panel.classList.toggle("active", active);
      panel.hidden = !active;
    });
  }

  function setSelected(id) {
    state.selectedId = id;
    renderInspector();
    renderTimeline();
    drawFrame();
  }

  function renderInspector() {
    const body = $("inspectorBody");
    const item = selectedItem();
    const header = $("inspectorSub");
    body.replaceChildren();
    if (!item) {
      header.textContent = "Project settings";
      const empty = document.createElement("div");
      empty.className = "editor-inspector-empty";
      empty.innerHTML = '<span>⌖</span><strong>Select a clip or layer</strong><p>Timing, transform, speed, colour and audio controls will appear here.</p>';
      body.appendChild(empty);
      return;
    }
    const asset = assetFor(item);
    const category = item.kind === "visual" ? (asset && asset.type === "image" ? "Image clip" : "Video clip") :
      item.kind === "audio" ? "Audio track" :
      item.kind === "caption" ? "Caption layer" :
      item.kind === "text" ? "Text layer" :
      item.kind === "sticker" ? "Sticker layer" : "Image overlay";
    header.textContent = category;
    const addSection = (title, html) => {
      const section = document.createElement("section");
      section.className = "ed-inspector-section";
      const heading = document.createElement("div");
      heading.className = "ed-inspector-title";
      heading.textContent = title;
      section.appendChild(heading);
      const content = document.createElement("div");
      content.innerHTML = html;
      section.appendChild(content);
      body.appendChild(section);
    };
    const field = (label, prop, value, options) => {
      const opts = options || {};
      const id = "prop-" + prop;
      const unit = opts.unit || "";
      let control = "";
      if (opts.select) {
        control = '<select id="' + id + '" data-prop="' + prop + '">';
        opts.select.forEach(option => { control += '<option value="' + esc(option.value) + '"' + (String(value) === String(option.value) ? " selected" : "") + '>' + esc(option.label) + '</option>'; });
        control += "</select>";
      } else if (opts.color) {
        control = '<input id="' + id + '" type="color" data-prop="' + prop + '" value="' + esc(value || "#ffffff") + '">';
      } else if (opts.check) {
        control = '<input id="' + id + '" type="checkbox" data-prop="' + prop + '"' + (value ? " checked" : "") + '>';
      } else if (opts.range) {
        control = '<input id="' + id + '" type="range" data-prop="' + prop + '" min="' + opts.min + '" max="' + opts.max + '" step="' + (opts.step || 0.05) + '" value="' + esc(value) + '">';
      } else if (opts.textarea) {
        control = '<textarea id="' + id + '" data-prop="' + prop + '" rows="3" maxlength="300">' + esc(value) + '</textarea>';
      } else {
        control = '<input id="' + id + '" type="number" data-prop="' + prop + '" min="' + (opts.min == null ? 0 : opts.min) + '" max="' + (opts.max == null ? 999999 : opts.max) + '" step="' + (opts.step || 0.1) + '" value="' + esc(value) + '">';
      }
      return '<div class="ed-form-field"><label for="' + id + '">' + label + (unit ? ' <output data-for="' + prop + '">' + esc(value) + unit + '</output>' : "") + '</label>' + control + '</div>';
    };
    const pair = (a, b) => '<div class="ed-form-grid">' + a + b + '</div>';
    const trackOptions = kind => {
      const key = kind === "visual" ? "visual" : kind === "audio" ? "audio" : "overlay";
      const count = Math.max(1, Number(state.project.trackCounts && state.project.trackCounts[key]) || 1);
      return Array.from({ length: count }, (_, i) => ({ value: i, label: key === "visual" ? "Video " + (i + 1) : key === "audio" ? "Audio " + (i + 1) : "Overlay " + (i + 1) }));
    };
    let html = "";
    html += '<div class="ed-inspector-section"><div class="ed-inspector-title">Selected layer</div><div class="ed-form-field"><label>Media</label><div style="font-size:11px;color:#eee;overflow-wrap:anywhere">' + esc(item.name || (asset && asset.name) || item.kind) + '</div><div style="font-size:9px;color:#737373;margin-top:5px">' + esc(category) + ' · ' + fmtShort(itemDuration(item)) + '</div></div></div>';
    if (item.kind === "visual" || item.kind === "audio") {
      html += '<div class="ed-inspector-section"><div class="ed-inspector-title">Timing</div>';
      html += field("Track", "track", Number(item.track) || 0, { select: trackOptions(item.kind) });
      html += field("Timeline start (s)", "start", item.start, { min: 0, max: 999999, step: 0.1 });
      html += pair(field("Source in (s)", "in", item.in, { min: 0, max: asset ? asset.duration : 999999, step: 0.05 }), field("Source out (s)", "out", item.out, { min: 0.05, max: asset ? asset.duration : 999999, step: 0.05 }));
      html += field("Speed", "speed", item.speed, { range: true, min: 0.25, max: 3, step: 0.05, unit: "×" });
      html += '</div>';
      html += '<div class="ed-inspector-section"><div class="ed-inspector-title">Audio</div>';
      html += field("Volume", "volume", item.volume, { range: true, min: 0, max: 2, step: 0.05, unit: "×" });
      html += pair(field("Fade in (s)", "fadeIn", item.fadeIn || 0, { min: 0, max: 10, step: 0.1 }), field("Fade out (s)", "fadeOut", item.fadeOut || 0, { min: 0, max: 10, step: 0.1 }));
      html += '</div>';
      if (item.kind === "visual") {
        html += '<div class="ed-inspector-section"><div class="ed-inspector-title">Image & colour</div>';
        html += '<div class="ed-form-field"><label for="prop-fit">Fit</label><select id="prop-fit" data-prop="fit"><option value="contain"' + (item.fit === "contain" ? " selected" : "") + '>Fit inside</option><option value="cover"' + (item.fit === "cover" ? " selected" : "") + '>Fill frame</option></select></div>';
        html += field("Brightness", "brightness", item.brightness || 0, { range: true, min: -0.5, max: 0.5, step: 0.05, unit: "" });
        html += field("Contrast", "contrast", item.contrast == null ? 1 : item.contrast, { range: true, min: 0.5, max: 1.8, step: 0.05, unit: "×" });
        html += field("Saturation", "saturate", item.saturate == null ? 1 : item.saturate, { range: true, min: 0, max: 2, step: 0.05, unit: "×" });
        html += '<div class="ed-form-field"><label for="prop-look">Colour preset</label><select id="prop-look" data-prop="look"><option value="clean"' + ((item.look || "clean") === "clean" ? " selected" : "") + '>Clean</option><option value="cinematic"' + (item.look === "cinematic" ? " selected" : "") + '>Cinematic</option><option value="warm"' + (item.look === "warm" ? " selected" : "") + '>Warm</option><option value="cold"' + (item.look === "cold" ? " selected" : "") + '>Cold</option><option value="vivid"' + (item.look === "vivid" ? " selected" : "") + '>Vivid</option><option value="mono"' + (item.look === "mono" ? " selected" : "") + '>Black & white</option><option value="fade"' + (item.look === "fade" ? " selected" : "") + '>Faded film</option></select></div>';
        html += field("Hue", "hue", item.hue || 0, { range: true, min: -180, max: 180, step: 5, unit: "°" });
        html += field("Warmth", "temperature", item.temperature || 0, { range: true, min: -1, max: 1, step: 0.05 });
        html += field("Vignette", "vignette", item.vignette || 0, { range: true, min: 0, max: 1, step: 0.05 });
        html += field("Soft focus", "blur", item.blur || 0, { range: true, min: 0, max: 8, step: 0.5, unit: "px" });
        html += '<div class="ed-inspector-title" style="margin-top:15px">Transform & motion</div>';
        html += pair(field("X (%)", "x", item.x == null ? 50 : item.x, { min: 0, max: 100, step: 1 }), field("Y (%)", "y", item.y == null ? 50 : item.y, { min: 0, max: 100, step: 1 }));
        html += field("Scale", "scale", item.scale == null ? 1 : item.scale, { range: true, min: 0.2, max: 3, step: 0.05, unit: "×" });
        html += pair(field("Rotation (°)", "rotation", item.rotation || 0, { min: -180, max: 180, step: 1 }), field("Opacity", "opacity", item.opacity == null ? 1 : item.opacity, { range: true, min: 0, max: 1, step: 0.05 }));
        html += '<div class="ed-inspector-title" style="margin-top:12px">Transition out</div>';
        html += '<div class="ed-form-field"><label for="prop-transition">Effect</label><select id="prop-transition" data-prop="transition"><option value="none"' + ((item.transition || "none") === "none" ? " selected" : "") + '>None</option><option value="fade"' + (item.transition === "fade" ? " selected" : "") + '>Fade to black</option><option value="flash"' + (item.transition === "flash" ? " selected" : "") + '>Flash</option><option value="wipe"' + (item.transition === "wipe" ? " selected" : "") + '>Wipe</option></select></div>';
        html += field("Transition duration (s)", "transitionDuration", item.transitionDuration == null ? 0.4 : item.transitionDuration, { range: true, min: 0.1, max: 1.5, step: 0.1, unit: "s" });
        html += '</div>';
      }
    } else {
      html += '<div class="ed-inspector-section"><div class="ed-inspector-title">Timing</div>';
      html += field("Track", "track", Number(item.track) || 0, { select: trackOptions(item.kind) });
      html += pair(field("Start (s)", "start", item.start, { min: 0, max: 999999, step: 0.1 }), field("Duration (s)", "duration", item.duration, { min: 0.1, max: 999999, step: 0.1 }));
      html += '</div>';
      html += '<div class="ed-inspector-section"><div class="ed-inspector-title">Transform</div>';
      html += pair(field("X position (%)", "x", item.x, { min: 0, max: 100, step: 1 }), field("Y position (%)", "y", item.y, { min: 0, max: 100, step: 1 }));
      html += field("Scale", "scale", item.scale, { range: true, min: 0.1, max: item.kind === "imageOverlay" ? 1.5 : 3, step: 0.05, unit: "×" });
      html += pair(field("Rotation (°)", "rotation", item.rotation || 0, { min: -180, max: 180, step: 1 }), field("Opacity", "opacity", item.opacity == null ? 1 : item.opacity, { range: true, min: 0, max: 1, step: 0.05, unit: "" }));
      html += '</div>';
      if (item.kind === "text" || item.kind === "caption") {
        html += '<div class="ed-inspector-section"><div class="ed-inspector-title">Typography</div>';
        html += field("Caption text", "value", item.value, { textarea: true });
        html += pair(field("Font size", "fontSize", item.fontSize || 56, { min: 12, max: 180, step: 1 }), field("Text colour", "color", item.color || "#ffffff", { color: true }));
        html += field("Bold", "bold", item.bold !== false, { check: true });
        html += field("Text outline", "outline", item.outline !== false, { check: true });
        html += field("Text background", "background", !!item.background, { check: true });
        html += '</div>';
      }
    }
    if (item.kind === "visual") {
      html += '<button type="button" class="ed-wide-button ed-secondary-button" id="detachAudioBtn">' + (item.linkGroup ? "Select linked audio" : "Detach audio") + '</button>';
    }
    if (item.kind !== "audio") html += '<button type="button" class="ed-wide-button" id="inspectorKeyframeBtn">◇ Set keyframe at playhead</button>';
    if (item.keyframes && item.keyframes.length) html += '<div class="ed-caption-progress">' + item.keyframes.length + ' keyframe(s) · animated properties interpolate between them.</div>';
    html += '<button type="button" class="ed-wide-button ed-secondary-button" id="duplicateItemBtn">Duplicate selected layer</button>';
    body.innerHTML = html;
    body.querySelectorAll("[data-prop]").forEach(input => {
      if (input.dataset.prop === "value") input.style.resize = "vertical";
    });
  }

  function applyProperty(item, prop, rawValue) {
    let value = rawValue;
    const asset = assetFor(item);
    const boolProps = ["bold", "outline", "background"];
    if (boolProps.includes(prop)) value = Boolean(rawValue);
    else if (["fit", "color", "value", "transition", "look"].includes(prop)) value = String(rawValue);
    else value = Number(rawValue);
    if (prop === "start") value = Math.max(0, value || 0);
    if (prop === "duration") value = Math.max(0.1, value || 0.1);
    if (prop === "in") value = clamp(value, 0, Math.max(0, Number(item.out) - 0.05));
    if (prop === "out") value = clamp(value, Number(item.in) + 0.05, asset ? asset.duration : Math.max(Number(item.in) + 0.05, value));
    if (prop === "track") {
      const key = itemTrack(item);
      const count = Math.max(1, Number(state.project.trackCounts && state.project.trackCounts[key]) || 1);
      value = clamp(Math.floor(value), 0, count - 1);
    }
    if (prop === "speed") value = clamp(value, 0.25, 3);
    if (prop === "volume") value = clamp(value, 0, 2);
    if (prop === "hue") value = clamp(value, -180, 180);
    if (prop === "temperature") value = clamp(value, -1, 1);
    if (prop === "vignette") value = clamp(value, 0, 1);
    if (prop === "blur") value = clamp(value, 0, 8);
    if (prop === "transitionDuration") value = clamp(value, 0.1, 1.5);
    if (prop === "fadeIn" || prop === "fadeOut") value = clamp(value, 0, Math.max(0, itemDuration(item)));
    if (prop === "brightness") value = clamp(value, -0.5, 0.5);
    if (prop === "contrast") value = clamp(value, 0.5, 1.8);
    if (prop === "saturate") value = clamp(value, 0, 2);
    if (prop === "x" || prop === "y") value = clamp(value, 0, 100);
    if (prop === "scale") value = clamp(value, 0.1, item.kind === "imageOverlay" ? 1.5 : 3);
    if (prop === "opacity") value = clamp(value, 0, 1);
    if (prop === "rotation") value = clamp(value, -180, 180);
    if (prop === "fontSize") value = clamp(value, 12, 180);
    if (prop === "value") value = String(value).slice(0, 300);
    if (prop === "color" && !/^#[0-9a-f]{6}$/i.test(value)) value = "#ffffff";
    item[prop] = value;
  }

  function getTimelinePixelsPerSecond() { return Number(state.zoom) || 80; }
  function renderTimeline() {
    const duration = projectDuration();
    const pps = getTimelinePixelsPerSecond();
    const width = Math.max(1100, TRACK_LABEL + Math.max(15, duration + 1) * pps);
    timelineContent.style.width = width + "px";
    timelineContent.style.minWidth = width + "px";
    timelineRuler.querySelectorAll(".editor-ruler-tick").forEach(node => node.remove());
    const interval = pps >= 90 ? 1 : pps >= 55 ? 2 : 5;
    for (let t = 0; t <= Math.max(15, duration) + 0.001; t += interval) {
      const tick = document.createElement("div");
      tick.className = "editor-ruler-tick major";
      tick.style.left = (TRACK_LABEL + t * pps) + "px";
      tick.textContent = fmtShort(t);
      timelineRuler.appendChild(tick);
    }

    const lanes = {
      visual: timelineContent.querySelector('[data-track="visual"]'),
      overlay: timelineContent.querySelector('[data-track="overlay"]'),
      audio: timelineContent.querySelector('[data-track="audio"]')
    };
    const trackNames = { visual: "Video", overlay: "Overlay", audio: "Audio" };
    let totalHeight = 29;
    Object.keys(lanes).forEach(key => {
      const lane = lanes[key];
      const count = Math.max(1, Math.floor(Number(state.project.trackCounts && state.project.trackCounts[key]) || 1));
      lane.style.height = (count * 48 + 12) + "px";
      lane.style.setProperty("--track-count", count);
      lane.style.backgroundImage = "repeating-linear-gradient(to bottom, transparent 0, transparent 47px, #242424 47px, #242424 48px)";
      const label = lane.querySelector(".editor-track-label");
      if (label) label.innerHTML = "<span>" + (key === "visual" ? "▣" : key === "audio" ? "♫" : "T") + "</span>" + trackNames[key] + (count > 1 ? " ×" + count : "");
      lane.querySelectorAll(".editor-timeline-clip").forEach(clip => clip.remove());
      lane.classList.remove("has-items");
      totalHeight += count * 48 + 12;
    });
    timelineContent.style.minHeight = (totalHeight + 8) + "px";

    state.project.items.forEach(item => {
      const laneKey = itemTrack(item);
      const lane = lanes[laneKey];
      if (!lane) return;
      lane.classList.add("has-items");
      const count = Math.max(1, Math.floor(Number(state.project.trackCounts && state.project.trackCounts[laneKey]) || 1));
      item.track = clamp(Math.floor(Number(item.track) || 0), 0, count - 1);
      const asset = assetFor(item);
      const linked = !!item.linkGroup;
      const hasKeys = Array.isArray(item.keyframes) && item.keyframes.length > 0;
      const clip = document.createElement("div");
      clip.className = "editor-timeline-clip kind-" + item.kind +
        (item.kind === "visual" && asset && asset.type === "image" ? " kind-image" : "") +
        (state.selectedId === item.id ? " selected" : "") +
        (linked ? " is-linked" : "") + (hasKeys ? " has-keyframes" : "");
      clip.style.left = (TRACK_LABEL + Math.max(0, item.start) * pps) + "px";
      clip.style.top = (6 + item.track * 48) + "px";
      clip.style.height = "36px";
      clip.style.width = Math.max(12, itemDuration(item) * pps) + "px";
      clip.dataset.itemId = item.id;
      clip.title = (item.name || item.value || item.kind) + " · Track " + (item.track + 1) + " · " + fmtTime(item.start) + "–" + fmtTime(itemEnd(item));
      const name = document.createElement("span");
      name.className = "ed-clip-name";
      name.textContent = item.kind === "text" || item.kind === "caption" ? "T · " + (item.value || "Text") : item.kind === "sticker" ? (item.value || "Sticker") : (item.name || (asset && asset.name) || item.kind);
      const meta = document.createElement("span");
      meta.className = "ed-clip-meta";
      meta.textContent = fmtShort(itemDuration(item)) + (item.kind === "visual" || item.kind === "audio" ? " · " + (Number(item.speed) || 1).toFixed(2) + "×" : "");
      clip.append(name, meta);
      const left = document.createElement("span");
      left.className = "ed-trim-handle ed-trim-left";
      left.dataset.edge = "left";
      const right = document.createElement("span");
      right.className = "ed-trim-handle ed-trim-right";
      right.dataset.edge = "right";
      clip.append(left, right);
      clip.addEventListener("pointerdown", event => startItemDrag(event, item, clip));
      clip.addEventListener("click", event => {
        event.stopPropagation();
        if (state.selectedId !== item.id) setSelected(item.id);
      });
      lane.appendChild(clip);
    });

    const markerLayer = $("markerLayer");
    if (markerLayer) {
      markerLayer.replaceChildren();
      (state.project.markers || []).forEach(marker => {
        const el = document.createElement("div");
        el.className = "editor-timeline-marker";
        el.style.left = (TRACK_LABEL + Math.max(0, marker.time) * pps) + "px";
        el.title = (marker.label || "Marker") + " · " + fmtTime(marker.time);
        el.dataset.markerId = marker.id;
        const text = document.createElement("span");
        text.textContent = marker.label || "Marker";
        el.appendChild(text);
        el.addEventListener("click", event => {
          event.stopPropagation();
          seekTo(marker.time);
        });
        el.addEventListener("dblclick", event => {
          event.stopPropagation();
          const next = prompt("Rename marker", marker.label || "Marker");
          if (next === null) return;
          checkpoint();
          marker.label = next.trim().slice(0, 48) || "Marker";
          renderTimeline();
        });
        el.addEventListener("contextmenu", event => {
          event.preventDefault();
          event.stopPropagation();
          if (!confirm("Delete this marker?")) return;
          checkpoint();
          state.project.markers = state.project.markers.filter(m => m.id !== marker.id);
          renderTimeline();
        });
        markerLayer.appendChild(el);
      });
    }
    playhead.style.left = (TRACK_LABEL + state.time * pps) + "px";
    $("timelineDuration").textContent = state.project.items.length + " layer" + (state.project.items.length === 1 ? "" : "s") + " · " + fmtShort(duration);
    $("timelineStatus").textContent = state.playing ? "Playing" : "Ready";
    $("snapBtn").classList.toggle("is-on", state.snapEnabled);
    $("snapBtn").textContent = state.snapEnabled ? "Snap on" : "Snap off";
    $("snapBtn").setAttribute("aria-pressed", state.snapEnabled ? "true" : "false");
    $("pasteBtn").disabled = !state.clipboard;
    updateClock();
  }

  function snapStart(value, movingItem) {
    let best = Math.max(0, value);
    if (!state.snapEnabled) return best;
    let distance = 0.12;
    const targets = [state.time, ...(state.project.markers || []).map(marker => marker.time)];
    state.project.items.forEach(item => {
      if (item.id === movingItem.id) return;
      targets.push(item.start, itemEnd(item));
    });
    targets.forEach(target => {
      const d = Math.abs(target - best);
      if (d < distance) { distance = d; best = target; }
    });
    return Math.max(0, best);
  }

  function startItemDrag(event, item, element) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (state.selectedId !== item.id) {
      state.selectedId = item.id;
      renderInspector();
    }
    state.project.items.forEach(other => {
      const block = timelineContent.querySelector('[data-item-id="' + other.id + '"]');
      if (block) block.classList.toggle("selected", other.id === item.id);
    });
    const edge = event.target && event.target.dataset ? event.target.dataset.edge || "move" : "move";
    const pps = getTimelinePixelsPerSecond();
    const startX = event.clientX;
    const startY = event.clientY;
    const original = { start: item.start, in: item.in, out: item.out, duration: item.duration, track: Number(item.track) || 0 };
    checkpoint();
    let changed = false;
    const move = ev => {
      const dx = (ev.clientX - startX) / pps;
      if (edge === "move") {
        item.start = snapStart(Math.max(0, original.start + dx), item);
        const trackKey = itemTrack(item);
        const count = Math.max(1, Number(state.project.trackCounts && state.project.trackCounts[trackKey]) || 1);
        item.track = clamp(original.track + Math.round((ev.clientY - startY) / 48), 0, count - 1);
      } else if (item.kind === "visual" || item.kind === "audio") {
        const speed = Math.max(0.25, Number(item.speed) || 1);
        const asset = assetFor(item);
        if (edge === "left") {
          const maxIn = Math.max(0, original.out - 0.05);
          const newIn = clamp(original.in + dx * speed, 0, maxIn);
          item.in = newIn;
          item.start = Math.max(0, original.start + (newIn - original.in) / speed);
        } else {
          const maxOut = asset ? asset.duration : original.out + 600;
          item.out = clamp(original.out + dx * speed, original.in + 0.05, maxOut);
        }
      } else {
        if (edge === "left") {
          const delta = clamp(dx, -original.start, original.duration - 0.1);
          item.start = original.start + delta;
          item.duration = Math.max(0.1, original.duration - delta);
        } else {
          item.duration = Math.max(0.1, original.duration + dx);
        }
      }
      syncLinkedDuringDrag(item);
      changed = true;
      const x = TRACK_LABEL + item.start * pps;
      element.style.left = x + "px";
      element.style.top = (6 + (Number(item.track) || 0) * 48) + "px";
      element.style.width = Math.max(12, itemDuration(item) * pps) + "px";
      const newWidth = Math.max(1100, TRACK_LABEL + Math.max(15, projectDuration() + 1) * pps);
      timelineContent.style.width = newWidth + "px";
      timelineContent.style.minWidth = newWidth + "px";
      playhead.style.left = (TRACK_LABEL + state.time * pps) + "px";
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (changed) {
        renderAll();
        syncMedia(state.time, false);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  function handleTimelinePointer(event) {
    const ruler = event.target.closest("#timelineRuler");
    const block = event.target.closest(".editor-timeline-clip");
    const label = event.target.closest(".editor-track-label");
    const track = event.target.closest(".editor-track");
    if (block || label || (!ruler && !track && event.target !== timelineContent)) return;
    const rect = timelineContent.getBoundingClientRect();
    const timeAtPointer = pointerEvent => {
      const rect = timelineContent.getBoundingClientRect();
      return Math.max(0, (pointerEvent.clientX - rect.left - TRACK_LABEL) / getTimelinePixelsPerSecond());
    };
    seekTo(Math.max(0, (event.clientX - rect.left - TRACK_LABEL) / getTimelinePixelsPerSecond()));
    if (ruler && event.button === 0) {
      event.preventDefault();
      const move = moveEvent => seekTo(timeAtPointer(moveEvent));
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    }
  }

  function renderAll() {
    renderMediaList();
    renderTimeline();
    renderInspector();
    updateHistoryButtons();
    updateClock();
    $("stageEmpty").hidden = state.project.items.some(item => item.kind !== "audio");
    drawFrame();
    $("saveStatus").textContent = "Unsaved changes";
  }

  function updateClock() {
    $("currentTime").textContent = fmtTime(state.time);
    $("totalTime").textContent = fmtTime(projectDuration());
    $("playIcon").textContent = state.playing ? "Ⅱ" : "▶";
    $("timelineStatus").textContent = state.playing ? "Playing" : "Ready";
    playhead.style.left = (TRACK_LABEL + state.time * getTimelinePixelsPerSecond()) + "px";
  }

  function seekMediaForItem(item, time, shouldPlay) {
    if (!item || item.kind !== "visual") return;
    const asset = assetFor(item);
    if (!asset || asset.type !== "video" || !asset.element) return;
    const el = asset.element;
    const local = clamp(item.in + (time - item.start) * Math.max(0.25, Number(item.speed) || 1), item.in, Math.max(item.in, item.out - 0.02));
    if (Math.abs((el.currentTime || 0) - local) > (shouldPlay ? 0.65 : 0.025)) {
      try { el.currentTime = local; } catch (_) {}
    }
    el.playbackRate = clamp(item.speed || 1, 0.25, 3);
    if (shouldPlay) {
      const p = el.play();
      if (p && p.catch) p.catch(() => {});
    }
  }

  async function syncMedia(time, shouldPlay) {
    const visual = activeItem("visual", time);
    const visibleAsset = visual ? assetFor(visual) : null;
    const visibleVideoId = visibleAsset && visibleAsset.type === "video" ? visibleAsset.id : null;
    const visibleVideoItemId = visibleVideoId && visual ? visual.id : null;
    if (state.currentVisualAsset && state.currentVisualAsset !== visibleVideoId) {
      const prior = state.assets.get(state.currentVisualAsset);
      if (prior && prior.element && prior.type === "video") prior.element.pause();
    }
    state.currentVisualAsset = visibleVideoId;
    state.currentVisualItemId = visibleVideoItemId;
    const activeAudioIds = new Set();
    const activeAssets = new Map();
    if (visual && visibleAsset && visibleAsset.type === "video") {
      activeAssets.set(visibleAsset.id, visual.sourceMuted ? 0 : volumeAtTime(visual, time));
      seekMediaForItem(visual, time, shouldPlay);
    } else if (visibleAsset && visibleAsset.type === "image") {
      // Image clips render directly from their decoded image.
    }
    state.project.items.forEach(item => {
      if (item.kind !== "audio" || time < item.start || time >= itemEnd(item)) return;
      const asset = assetFor(item);
      if (!asset || asset.type !== "audio" || !asset.element) return;
      activeAudioIds.add(asset.id);
      activeAssets.set(asset.id, Math.max(activeAssets.get(asset.id) || 0, volumeAtTime(item, time)));
      const el = asset.element;
      const local = clamp(item.in + (time - item.start) * Math.max(0.25, Number(item.speed) || 1), item.in, Math.max(item.in, item.out - 0.02));
      el.playbackRate = clamp(item.speed || 1, 0.25, 3);
      if (Math.abs((el.currentTime || 0) - local) > (shouldPlay ? 0.9 : 0.03)) {
        try { el.currentTime = local; } catch (_) {}
      }
      if (shouldPlay) {
        const p = el.play();
        if (p && p.catch) p.catch(() => {});
      } else el.pause();
    });
    for (const asset of state.assets.values()) {
      if (asset.type === "audio" && asset.element && !activeAudioIds.has(asset.id)) asset.element.pause();
      if (asset.type === "video" && asset.element && asset.id !== visibleVideoId) asset.element.pause();
      if (asset.gainNode) {
        const active = activeAssets.get(asset.id);
        const target = active == null ? 0 : clamp(active, 0, 2);
        try { asset.gainNode.gain.setTargetAtTime(target, state.audioContext.currentTime, 0.015); } catch (_) { asset.gainNode.gain.value = target; }
      } else if (asset.element && ["audio", "video"].includes(asset.type)) {
        const active = activeAssets.get(asset.id);
        asset.element.volume = active == null ? 0 : clamp(active, 0, 1);
      }
    }
    drawFrame();
    updateClock();
  }

  function seekTo(time) {
    const max = projectDuration();
    state.time = max > 0 ? clamp(time, 0, max) : 0;
    if (state.playing) {
      state.playbackEpoch = state.time;
      state.playbackWall = performance.now();
    }
    syncMedia(state.time, state.playing);
    renderTimeline();
    drawFrame();
  }

  function play() {
    if (projectDuration() <= 0) {
      notify("Add media to the timeline before playing.");
      return;
    }
    if (state.time >= projectDuration() - 0.02) state.time = 0;
    state.playing = true;
    state.playbackEpoch = state.time;
    state.playbackWall = performance.now();
    ensureAudioGraph().then(() => syncMedia(state.time, true));
    syncMedia(state.time, true);
    updateClock();
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = requestAnimationFrame(playbackTick);
  }
  function pause() {
    state.playing = false;
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = 0;
    for (const asset of state.assets.values()) {
      if (asset.element && ["video", "audio"].includes(asset.type)) asset.element.pause();
    }
    updateClock();
    renderTimeline();
    drawFrame();
  }
  function playbackTick(now) {
    if (!state.playing) return;
    const duration = projectDuration();
    const elapsed = Math.max(0, (now - state.playbackWall) / 1000);
    const rawTime = state.playbackEpoch + elapsed;
    const reachedEnd = rawTime >= duration;
    // Keep the final visible frame inside the last clip's half-open time range.
    state.time = reachedEnd ? Math.max(0, duration - 1 / 60) : Math.min(duration, rawTime);

    const visual = activeItem("visual", state.time);
    const asset = visual ? assetFor(visual) : null;
    applyAudioLevels(state.time);
    if ((asset && asset.type === "video" ? asset.id : null) !== state.currentVisualAsset ||
        (asset && asset.type === "video" ? visual.id : null) !== state.currentVisualItemId) {
      syncMedia(state.time, true);
    } else {
      drawFrame();
      updateClock();
    }

    // Start audio precisely at its timeline in-point, including tracks that begin
    // later than the video. Keep normal playback uninterrupted unless it drifts.
    state.project.items.forEach(item => {
      if (item.kind !== "audio") return;
      const audio = assetFor(item);
      if (!audio || audio.type !== "audio" || !audio.element) return;
      const active = state.time >= item.start && state.time < itemEnd(item);
      if (!active) {
        if (!audio.element.paused) audio.element.pause();
        return;
      }
      const speed = Math.max(0.25, Number(item.speed) || 1);
      const target = clamp(item.in + (state.time - item.start) * speed, item.in, Math.max(item.in, item.out - 0.02));
      const drift = Math.abs((audio.element.currentTime || 0) - target);
      if (audio.element.paused || drift > 0.8) {
        try { audio.element.currentTime = target; } catch (_) {}
        if (audio.element.paused) {
          const p = audio.element.play();
          if (p && p.catch) p.catch(() => {});
        }
      }
    });

    if (reachedEnd || state.time >= duration - 0.005) {
      state.time = Math.max(0, duration - 1 / 60);
      pause();
      // Show the project end in the clock while leaving the final rendered frame visible.
      state.time = duration;
      updateClock();
      renderTimeline();
      return;
    }
    state.raf = requestAnimationFrame(playbackTick);
  }

    function drawFittedImage(element, fit, x, y, targetW, targetH) {
    const sourceW = element.videoWidth || element.naturalWidth || element.width || 1;
    const sourceH = element.videoHeight || element.naturalHeight || element.height || 1;
    if (!sourceW || !sourceH) return;
    const sourceAspect = sourceW / sourceH;
    const targetAspect = targetW / targetH;
    if (fit === "cover") {
      let sx = 0, sy = 0, sw = sourceW, sh = sourceH;
      if (sourceAspect > targetAspect) {
        sw = sourceH * targetAspect;
        sx = (sourceW - sw) / 2;
      } else {
        sh = sourceW / targetAspect;
        sy = (sourceH - sh) / 2;
      }
      ctx.drawImage(element, sx, sy, sw, sh, x, y, targetW, targetH);
    } else {
      const scale = Math.min(targetW / sourceW, targetH / sourceH);
      const w = sourceW * scale, h = sourceH * scale;
      ctx.drawImage(element, x + (targetW - w) / 2, y + (targetH - h) / 2, w, h);
    }
  }

  function drawFrame() {
    if (!ctx || !canvas.width || !canvas.height) return;
    const w = canvas.width, h = canvas.height;
    ctx.save();
    ctx.filter = "none";
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);

    const rawVisual = activeItem("visual", state.time);
    const visual = rawVisual ? animatedProperties(rawVisual, state.time) : null;
    if (visual) {
      const asset = assetFor(visual);
      if (asset && asset.element && (asset.type === "image" || (asset.type === "video" && asset.element.readyState >= 2))) {
        const d = Math.max(0.001, itemDuration(rawVisual));
        const elapsed = state.time - rawVisual.start;
        let alpha = clamp(visual.opacity == null ? 1 : visual.opacity, 0, 1);
        if (rawVisual.fadeIn > 0) alpha = Math.min(alpha, clamp(elapsed / rawVisual.fadeIn, 0, 1));
        if (rawVisual.fadeOut > 0) alpha = Math.min(alpha, clamp((d - elapsed) / rawVisual.fadeOut, 0, 1));
        const look = LOOK_PRESETS[visual.look || "clean"] || LOOK_PRESETS.clean;
        const brightness = clamp((Number(visual.brightness) || 0) + (look.brightness - 1), -0.8, 1.5) + 1;
        const contrast = clamp((Number(visual.contrast) || 1) * look.contrast, 0.2, 2.5);
        const saturate = clamp((Number(visual.saturate) == null ? 1 : Number(visual.saturate)) * look.saturate, 0, 3);
        const hue = (Number(visual.hue) || 0) + look.hue;
        const sepia = clamp(look.sepia * 100, 0, 100);
        const grey = clamp(look.grayscale * 100, 0, 100);
        const blur = clamp(Number(visual.blur) || 0, 0, 8);
        const scale = clamp(Number(visual.scale) || 1, 0.1, 3);
        const x = clamp(visual.x == null ? 50 : visual.x, 0, 100) / 100 * w;
        const y = clamp(visual.y == null ? 50 : visual.y, 0, 100) / 100 * h;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(x, y);
        ctx.rotate((Number(visual.rotation) || 0) * Math.PI / 180);
        ctx.filter = "brightness(" + brightness + ") contrast(" + contrast + ") saturate(" + saturate + ") hue-rotate(" + hue + "deg) sepia(" + sepia + "%) grayscale(" + grey + "%) blur(" + blur + "px)";
        drawFittedImage(asset.element, visual.fit || "contain", -w * scale / 2, -h * scale / 2, w * scale, h * scale);
        ctx.filter = "none";
        const temperature = clamp((Number(visual.temperature) || 0) + look.temperature, -1, 1);
        if (temperature > 0.01) {
          ctx.fillStyle = "rgba(255,151,77," + (temperature * 0.22) + ")";
          ctx.fillRect(-w * scale / 2, -h * scale / 2, w * scale, h * scale);
        } else if (temperature < -0.01) {
          ctx.fillStyle = "rgba(72,145,255," + (-temperature * 0.2) + ")";
          ctx.fillRect(-w * scale / 2, -h * scale / 2, w * scale, h * scale);
        }
        const vignette = clamp(Number(visual.vignette) || 0, 0, 1);
        if (vignette > 0.01) {
          const radius = Math.max(w, h) * 0.72 * scale;
          const gradient = ctx.createRadialGradient(0, 0, Math.min(w, h) * 0.15 * scale, 0, 0, radius);
          gradient.addColorStop(0, "rgba(0,0,0,0)");
          gradient.addColorStop(0.55, "rgba(0,0,0," + (vignette * 0.12) + ")");
          gradient.addColorStop(1, "rgba(0,0,0," + (vignette * 0.88) + ")");
          ctx.fillStyle = gradient;
          ctx.fillRect(-w * scale / 2, -h * scale / 2, w * scale, h * scale);
        }
        ctx.restore();
      }
    }

    const overlays = state.project.items.filter(item =>
      ["text", "caption", "sticker", "imageOverlay"].includes(item.kind) &&
      state.time >= item.start && state.time < itemEnd(item)
    );
    overlays.sort((a, b) => (Number(a.track) || 0) - (Number(b.track) || 0) || a.start - b.start);
    overlays.forEach(raw => {
      const item = animatedProperties(raw, state.time);
      ctx.save();
      ctx.globalAlpha = clamp(item.opacity == null ? 1 : item.opacity, 0, 1);
      const x = clamp(item.x == null ? 50 : item.x, 0, 100) / 100 * w;
      const y = clamp(item.y == null ? 50 : item.y, 0, 100) / 100 * h;
      ctx.translate(x, y);
      ctx.rotate((Number(item.rotation) || 0) * Math.PI / 180);
      const unit = w / 1280;
      const scale = Number(item.scale) || 1;
      if (item.kind === "text" || item.kind === "caption") {
        const fontSize = Math.max(12, (Number(item.fontSize) || 56) * unit * scale);
        ctx.font = (item.bold === false ? "500 " : "800 ") + fontSize + "px Arial, Helvetica, sans-serif";
        ctx.textAlign = item.align || "center";
        ctx.textBaseline = "middle";
        const lines = String(item.value || "").split("\n");
        const lineHeight = fontSize * 1.15;
        const totalHeight = lines.length * lineHeight;
        if (item.background) {
          const maxWidth = Math.max.apply(null, lines.map(line => ctx.measureText(line).width).concat([0]));
          ctx.fillStyle = item.kind === "caption" ? "rgba(0,0,0,.76)" : "rgba(0,0,0,.68)";
          roundedRect(ctx, -maxWidth / 2 - fontSize * 0.22, -totalHeight / 2 - fontSize * 0.12, maxWidth + fontSize * 0.44, totalHeight + fontSize * 0.24, fontSize * 0.12);
          ctx.fill();
        }
        lines.forEach((line, i) => {
          const ly = (i - (lines.length - 1) / 2) * lineHeight;
          if (item.outline !== false) {
            ctx.lineJoin = "round";
            ctx.strokeStyle = "rgba(0,0,0,.92)";
            ctx.lineWidth = Math.max(2, fontSize * 0.075);
            ctx.strokeText(line, 0, ly, w * 0.92);
          }
          ctx.fillStyle = item.color || "#fff";
          ctx.fillText(line, 0, ly, w * 0.92);
        });
      } else if (item.kind === "sticker") {
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = Math.round(76 * unit * scale) + "px system-ui, Apple Color Emoji, Segoe UI Emoji, sans-serif";
        ctx.fillText(item.value || "⭐", 0, 0);
      } else if (item.kind === "imageOverlay") {
        const asset = assetFor(item);
        if (asset && asset.type === "image" && asset.element) {
          const sw = asset.width || asset.element.naturalWidth || 1;
          const sh = asset.height || asset.element.naturalHeight || 1;
          const targetW = w * clamp(item.scale || 0.35, 0.05, 1.5);
          const targetH = targetW * sh / sw;
          drawFittedImage(asset.element, "contain", -targetW / 2, -targetH / 2, targetW, targetH);
        }
      }
      ctx.restore();
    });

    if (visual && visual.transition && visual.transition !== "none") {
      const remaining = itemEnd(rawVisual) - state.time;
      const transitionDuration = clamp(visual.transitionDuration == null ? 0.4 : visual.transitionDuration, 0.1, 1.5);
      if (remaining >= 0 && remaining < transitionDuration) {
        const phase = clamp(1 - remaining / transitionDuration, 0, 1);
        ctx.save();
        ctx.globalAlpha = 1;
        if (visual.transition === "fade") {
          ctx.fillStyle = "rgba(0,0,0," + phase + ")";
          ctx.fillRect(0, 0, w, h);
        } else if (visual.transition === "flash") {
          ctx.fillStyle = "rgba(255,255,255," + (Math.sin(phase * Math.PI) * 0.9) + ")";
          ctx.fillRect(0, 0, w, h);
        } else if (visual.transition === "wipe") {
          ctx.fillStyle = "#000";
          ctx.fillRect(0, 0, w * phase, h);
        }
        ctx.restore();
      }
    }
    ctx.restore();
  }

  function animatedProperties(item, time) {
    const base = Object.assign({}, item);
    const frames = Array.isArray(item.keyframes) ? item.keyframes.slice().sort((a, b) => a.time - b.time) : [];
    if (!frames.length) return base;
    const props = ["x", "y", "scale", "rotation", "opacity"];
    if (time <= frames[0].time) {
      props.forEach(key => { if (Number.isFinite(frames[0][key])) base[key] = frames[0][key]; });
      return base;
    }
    if (time >= frames[frames.length - 1].time) {
      props.forEach(key => { if (Number.isFinite(frames[frames.length - 1][key])) base[key] = frames[frames.length - 1][key]; });
      return base;
    }
    let left = frames[0], right = frames[1];
    for (let i = 0; i < frames.length - 1; i++) {
      if (time >= frames[i].time && time <= frames[i + 1].time) { left = frames[i]; right = frames[i + 1]; break; }
    }
    const amount = clamp((time - left.time) / Math.max(0.0001, right.time - left.time), 0, 1);
    const ease = amount * amount * (3 - 2 * amount);
    props.forEach(key => {
      const a = Number.isFinite(left[key]) ? left[key] : (Number.isFinite(base[key]) ? base[key] : (key === "opacity" || key === "scale" ? 1 : 0));
      const b = Number.isFinite(right[key]) ? right[key] : a;
      base[key] = a + (b - a) * ease;
    });
    return base;
  }

  const LOOK_PRESETS = {
    clean: { brightness: 1, contrast: 1, saturate: 1, hue: 0, sepia: 0, grayscale: 0, temperature: 0 },
    cinematic: { brightness: 0.96, contrast: 1.18, saturate: 0.88, hue: -3, sepia: 0.08, grayscale: 0, temperature: 0.18 },
    warm: { brightness: 1.02, contrast: 1.04, saturate: 1.12, hue: -5, sepia: 0.13, grayscale: 0, temperature: 0.45 },
    cold: { brightness: 1, contrast: 1.1, saturate: 0.92, hue: 12, sepia: 0, grayscale: 0, temperature: -0.42 },
    vivid: { brightness: 1.02, contrast: 1.12, saturate: 1.42, hue: 0, sepia: 0, grayscale: 0, temperature: 0 },
    mono: { brightness: 1.02, contrast: 1.1, saturate: 0, hue: 0, sepia: 0, grayscale: 1, temperature: 0 },
    fade: { brightness: 1.08, contrast: 0.82, saturate: 0.8, hue: 0, sepia: 0.12, grayscale: 0, temperature: 0.12 }
  };

  function roundedRect(c, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + width, y, x + width, y + height, r);
    c.arcTo(x + width, y + height, x, y + height, r);
    c.arcTo(x, y + height, x, y, r);
    c.arcTo(x, y, x + width, y, r);
    c.closePath();
  }

  function splitSelected() {
    const item = selectedItem();
    if (!item) { notify("Select a clip or layer to split."); return; }
    if (state.time <= item.start + 0.04 || state.time >= itemEnd(item) - 0.04) {
      notify("Move the playhead inside the selected clip before splitting.");
      return;
    }
    checkpoint();
    if (item.kind === "visual" || item.kind === "audio") {
      const local = item.in + (state.time - item.start) * (Number(item.speed) || 1);
      const oldOut = item.out;
      const clone = Object.assign({}, item, { id: uid(), name: (item.name || "Clip") + " (split)", in: local, out: oldOut, start: state.time });
      item.out = local;
      state.project.items.push(clone);
      state.selectedId = clone.id;
    } else {
      const oldEnd = itemEnd(item);
      const clone = Object.assign({}, item, { id: uid(), name: (item.name || "Layer") + " (split)", start: state.time, duration: oldEnd - state.time });
      item.duration = state.time - item.start;
      state.project.items.push(clone);
      state.selectedId = clone.id;
    }
    renderAll();
    notify("Clip split at " + fmtTime(state.time) + ".");
  }

  function deleteSelected() {
    const item = selectedItem();
    if (!item) { notify("Select a clip or layer to delete."); return; }
    checkpoint();
    const ids = new Set([item.id]);
    if (item.linkGroup) state.project.items.filter(x => x.linkGroup === item.linkGroup).forEach(x => ids.add(x.id));
    state.project.items = state.project.items.filter(x => !ids.has(x.id));
    state.selectedId = null;
    renderAll();
    syncMedia(state.time, false);
    notify(ids.size > 1 ? "Linked video and audio deleted." : "Layer deleted.");
  }

  function duplicateSelected() {
    if (!selectedItem()) return;
    copySelected();
    pasteCopied();
  }

  function addTrack(kind) {
    const key = kind === "visual" ? "visual" : kind === "audio" ? "audio" : "overlay";
    checkpoint();
    state.project.trackCounts = Object.assign({ visual: 1, overlay: 1, audio: 1 }, state.project.trackCounts || {});
    state.project.trackCounts[key] = Math.min(12, (Number(state.project.trackCounts[key]) || 1) + 1);
    renderTimeline();
    renderInspector();
    notify((key === "visual" ? "Video" : key === "audio" ? "Audio" : "Overlay") + " track " + state.project.trackCounts[key] + " added.");
  }

  function addTimelineMarker() {
    const label = prompt("Marker name", "Marker " + ((state.project.markers || []).length + 1));
    if (label === null) return;
    checkpoint();
    state.project.markers = state.project.markers || [];
    state.project.markers.push({ id: uid(), time: Math.max(0, state.time), label: label.trim().slice(0, 48) || "Marker" });
    state.project.markers.sort((a, b) => a.time - b.time);
    renderTimeline();
    notify("Marker added at " + fmtTime(state.time) + ".");
  }

  function addKeyframeForSelected() {
    let item = selectedItem();
    if ($("motionTarget").value === "visual") item = activeItem("visual", state.time);
    if (!item) { notify("Select a video, caption, sticker or image layer first."); return; }
    if (item.kind === "audio") { notify("Audio keyframes aren't supported yet. Use volume and fade controls instead."); return; }
    const values = animatedProperties(item, state.time);
    const frame = {
      time: Number(state.time.toFixed(3)),
      x: Number(values.x == null ? 50 : values.x),
      y: Number(values.y == null ? 50 : values.y),
      scale: Number(values.scale == null ? 1 : values.scale),
      rotation: Number(values.rotation) || 0,
      opacity: Number(values.opacity == null ? 1 : values.opacity)
    };
    checkpoint();
    item.keyframes = Array.isArray(item.keyframes) ? item.keyframes : [];
    const existing = item.keyframes.findIndex(k => Math.abs(k.time - frame.time) < 0.04);
    if (existing >= 0) item.keyframes[existing] = frame;
    else item.keyframes.push(frame);
    item.keyframes.sort((a, b) => a.time - b.time);
    state.selectedId = item.id;
    renderAll();
    notify("Keyframe set at " + fmtTime(state.time) + ".");
  }

  function applyMotionPreset(preset) {
    let item = selectedItem();
    if ($("motionTarget").value === "visual") item = activeItem("visual", state.time);
    if (!item) { notify("Select the layer you want to animate first."); return; }
    if (item.kind === "audio") { notify("Choose a visual or overlay layer for motion presets."); return; }
    const start = item.start;
    const end = itemEnd(item);
    const span = Math.max(0.3, end - start);
    const base = {
      x: Number(item.x == null ? 50 : item.x),
      y: Number(item.y == null ? (item.kind === "caption" ? 84 : 50) : item.y),
      scale: Number(item.scale == null ? 1 : item.scale),
      rotation: Number(item.rotation) || 0,
      opacity: Number(item.opacity == null ? 1 : item.opacity)
    };
    const point = (time, vals) => Object.assign({ time: Number(time.toFixed(3)) }, base, vals || {});
    let frames;
    if (preset === "punch") {
      frames = [point(start), point(start + span * 0.34, { scale: base.scale * 1.22 }), point(start + span * 0.52, { scale: base.scale * 1.04 }), point(end, { scale: base.scale })];
    } else if (preset === "slowzoom") {
      frames = [point(start, { scale: base.scale * 0.98 }), point(end, { scale: base.scale * 1.2 })];
    } else if (preset === "shake") {
      const p = Math.min(0.24, span * 0.22);
      frames = [point(start), point(start + p * 0.5, { x: base.x - 1.3, rotation: base.rotation - 3.5, scale: base.scale * 1.06 }), point(start + p, { x: base.x + 1.4, rotation: base.rotation + 3.1, scale: base.scale * 1.08 }), point(start + p * 1.5, { x: base.x - 0.9, rotation: base.rotation - 1.9, scale: base.scale * 1.03 }), point(Math.min(end, start + p * 2), base), point(end, base)];
    } else if (preset === "fade") {
      frames = [point(start, { opacity: 0 }), point(Math.min(end, start + Math.min(0.45, span * 0.2)), { opacity: base.opacity }), point(end, { opacity: base.opacity })];
    } else {
      notify("Unknown motion preset.");
      return;
    }
    checkpoint();
    item.keyframes = frames.filter((frame, index) => index === 0 || frame.time > frames[index - 1].time + 0.001);
    state.selectedId = item.id;
    renderAll();
    activatePanel("motionPanel");
    notify("Motion preset applied. Adjust its keyframes or position for your edit.");
  }

  function copySelected() {
    const item = selectedItem();
    if (!item) { notify("Select a clip or layer to copy."); return; }
    const group = item.linkGroup ? state.project.items.filter(x => x.linkGroup === item.linkGroup) : [item];
    const base = item.start;
    state.clipboard = group.map(source => Object.assign({}, JSON.parse(JSON.stringify(source)), { relativeStart: source.start - base }));
    $("pasteBtn").disabled = false;
    notify(group.length > 1 ? "Linked video and audio copied." : "Layer copied.");
  }

  function pasteCopied() {
    if (!state.clipboard || !state.clipboard.length) return;
    checkpoint();
    const base = selectedItem() ? itemEnd(selectedItem()) : state.time;
    const delta = base - Math.min(...state.clipboard.map(item => item.relativeStart || 0));
    const newLinkGroup = state.clipboard.length > 1 ? uid() : null;
    const clones = state.clipboard.map(source => {
      const copy = Object.assign({}, JSON.parse(JSON.stringify(source)));
      delete copy.relativeStart;
      copy.id = uid();
      copy.start = Math.max(0, base + (source.relativeStart || 0));
      copy.name = (copy.name || copy.kind) + " copy";
      if (newLinkGroup) copy.linkGroup = newLinkGroup;
      else delete copy.linkGroup;
      if (Array.isArray(copy.keyframes)) copy.keyframes = copy.keyframes.map(k => Object.assign({}, k, { time: k.time + delta }));
      return copy;
    });
    state.project.items.push(...clones);
    state.selectedId = clones[0].id;
    state.time = clones[0].start;
    renderAll();
    syncMedia(state.time, false);
    notify(clones.length > 1 ? "Linked layers pasted." : "Layer pasted.");
  }

  function rippleDeleteSelected() {
    const item = selectedItem();
    if (!item) { notify("Select a clip or layer for ripple delete."); return; }
    const group = item.linkGroup ? state.project.items.filter(x => x.linkGroup === item.linkGroup) : [item];
    const start = Math.min(...group.map(x => x.start));
    const end = Math.max(...group.map(itemEnd));
    const gap = Math.max(0, end - start);
    if (gap <= 0) { deleteSelected(); return; }
    const ids = new Set(group.map(x => x.id));
    checkpoint();
    state.project.items = state.project.items.filter(x => !ids.has(x.id));
    state.project.items.forEach(other => {
      if (other.start >= end - 0.001) {
        other.start = Math.max(0, other.start - gap);
        if (Array.isArray(other.keyframes)) other.keyframes = other.keyframes.map(k => Object.assign({}, k, { time: Math.max(other.start, k.time - gap) }));
      }
    });
    (state.project.markers || []).forEach(marker => { if (marker.time >= end) marker.time = Math.max(0, marker.time - gap); });
    state.selectedId = null;
    state.time = Math.max(0, Math.min(state.time, projectDuration()));
    renderAll();
    syncMedia(state.time, false);
    notify("Deleted layer and closed a " + gap.toFixed(2) + "s gap.");
  }

  function syncLinkedProperty(item, prop) {
    if (!item || !item.linkGroup) return;
    const partner = state.project.items.find(other => other.id !== item.id && other.linkGroup === item.linkGroup);
    if (!partner) return;
    if (["start", "in", "out", "speed"].includes(prop)) {
      if (prop === "start") partner.start = item.start;
      else {
        partner.in = clamp(item.in, 0, Math.max(0, partner.out - 0.05));
        partner.out = clamp(item.out, partner.in + 0.05, assetFor(partner) ? assetFor(partner).duration : item.out);
        partner.speed = item.speed;
      }
    }
  }

  function syncLinkedDuringDrag(item) {
    if (!item || !item.linkGroup) return;
    const partner = state.project.items.find(other => other.id !== item.id && other.linkGroup === item.linkGroup);
    if (!partner) return;
    partner.start = item.start;
    partner.in = item.in;
    partner.out = item.out;
    partner.speed = item.speed;
  }

  async function detachAudioFromSelected() {
    const item = selectedItem();
    if (!item || item.kind !== "visual") { notify("Select a video clip first."); return; }
    if (item.linkGroup) {
      const partner = state.project.items.find(other => other.id !== item.id && other.linkGroup === item.linkGroup);
      if (partner) { setSelected(partner.id); notify("Selected the linked audio track."); }
      return;
    }
    const source = assetFor(item);
    if (!source || source.type !== "video" || (!source.url && !source.file)) {
      notify("This clip doesn't have a detachable audio source.");
      return;
    }
    const audio = document.createElement("audio");
    audio.preload = "auto";
    audio.crossOrigin = "anonymous";
    audio.src = source.url;
    audio.load();
    try {
      await waitMedia(audio, "loadedmetadata", "error", 20000);
      if (!Number.isFinite(audio.duration) || audio.duration <= 0) throw new Error("The browser could not read audio from this video.");
      checkpoint();
      const audioAsset = {
        id: uid(), name: (source.name || "Video") + " — detached audio", type: "audio",
        size: source.size || 0, file: source.file || null, url: source.url, duration: audio.duration,
        element: audio, width: 0, height: 0, gainNode: null, sourceNode: null,
        cloud: !!source.cloud, derivedFrom: source.id
      };
      state.assets.set(audioAsset.id, audioAsset);
      if (state.audioContext) audioGraphFor(audioAsset);
      const linkGroup = uid();
      item.linkGroup = linkGroup;
      item.sourceMuted = true;
      const linkedAudio = {
        id: uid(), kind: "audio", assetId: audioAsset.id, name: audioAsset.name, track: 0,
        start: item.start, in: item.in, out: Math.min(item.out, audio.duration), speed: item.speed,
        volume: 1, fadeIn: 0, fadeOut: 0, linkGroup: linkGroup, keyframes: []
      };
      state.project.items.push(linkedAudio);
      state.project.trackCounts = Object.assign({ visual: 1, overlay: 1, audio: 1 }, state.project.trackCounts || {});
      state.project.trackCounts.audio = Math.max(1, state.project.trackCounts.audio);
      state.selectedId = linkedAudio.id;
      renderAll();
      syncMedia(state.time, false);
      notify("Audio detached. The video and audio remain linked when moved.");
    } catch (error) {
      audio.removeAttribute("src");
      audio.load();
      notify(error.message || "Could not detach audio from this file.");
    }
  }

  function activeCaptionStyle() {
    return {
      color: $("captionColor").value || "#ffffff",
      background: $("captionBackground").value === "box",
      outline: $("captionBackground").value !== "none",
      y: Number($("captionPosition").value) || 84
    };
  }

  function addCaption(text, start, end, style) {
    const value = String(text || "").trim();
    if (!value) return null;
    const chosen = style || activeCaptionStyle();
    const item = {
      id: uid(), kind: "caption", name: "Caption", value: value.slice(0, 300),
      start: Math.max(0, Number(start) || 0), duration: Math.max(0.15, (Number(end) || (Number(start) + 2.2)) - (Number(start) || 0)),
      x: 50, y: chosen.y, scale: 1, fontSize: 38, color: chosen.color,
      background: !!chosen.background, outline: !!chosen.outline, bold: true, opacity: 1,
      rotation: 0, align: "center", track: 0, keyframes: []
    };
    state.project.items.push(item);
    return item;
  }

  function addManualCaption() {
    const text = $("captionText").value.trim();
    if (!text) { notify("Type a caption first."); return; }
    checkpoint();
    const duration = Math.min(5, Math.max(1.5, text.length / 15));
    const item = addCaption(text, state.time, state.time + duration);
    state.selectedId = item && item.id;
    renderAll();
    notify("Caption added at the playhead.");
  }

  function parseCaptionTime(value) {
    const match = String(value).trim().replace(",", ".").match(/(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?/);
    if (!match) return NaN;
    const hours = Number(match[1] || 0);
    const minutes = Number(match[2] || 0);
    const seconds = Number(match[3] || 0);
    const milliseconds = Number(String(match[4] || "0").padEnd(3, "0"));
    return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
  }

  async function importCaptionFile(file) {
    if (!file) return;
    const raw = await file.text();
    const blocks = raw.replace(/^\uFEFF/, "").replace(/\r/g, "").trim();
    const entries = [];
    const timePattern = /((?:\d{1,2}:)?\d{1,2}:\d{2}[,.]\d{1,3})\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}[,.]\d{1,3})/;
    blocks.split(/\n\s*\n/).forEach(block => {
      const lines = block.split("\n");
      const index = lines.findIndex(line => timePattern.test(line));
      if (index >= 0) {
        const match = lines[index].match(timePattern);
        const text = lines.slice(index + 1).join(" ").replace(/<[^>]+>/g, "").trim();
        const start = parseCaptionTime(match[1]);
        const end = parseCaptionTime(match[2]);
        if (text && Number.isFinite(start) && Number.isFinite(end) && end > start) entries.push({ text, start, end });
      }
    });
    if (!entries.length && file.name.toLowerCase().endsWith(".txt")) {
      blocks.split(/\n+/).map(line => line.trim()).filter(Boolean).forEach((text, index) => entries.push({ text, start: index * 3, end: index * 3 + 3 }));
    }
    if (!entries.length) throw new Error("No subtitle cues were found. Use an SRT, WebVTT or plain text file.");
    checkpoint();
    const style = activeCaptionStyle();
    entries.forEach(entry => addCaption(entry.text, entry.start, entry.end, style));
    renderAll();
    $("captionStatus").textContent = entries.length + " caption cues imported.";
    notify("Imported " + entries.length + " subtitle cues.");
  }

  function formatSrtTime(time) {
    const ms = Math.max(0, Math.round((Number(time) || 0) * 1000));
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    const milli = ms % 1000;
    return String(hours).padStart(2, "0") + ":" + String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0") + "," + String(milli).padStart(3, "0");
  }
  function exportCaptionsSrt() {
    const captions = state.project.items.filter(item => item.kind === "caption").sort((a, b) => a.start - b.start);
    if (!captions.length) { notify("There are no caption layers to export."); return; }
    const content = captions.map((item, index) => (index + 1) + "\n" + formatSrtTime(item.start) + " --> " + formatSrtTime(itemEnd(item)) + "\n" + item.value).join("\n\n");
    downloadBlob(new Blob([content + "\n"], { type: "text/plain;charset=utf-8" }), "clipnow-captions.srt");
    notify("SRT subtitles exported.");
  }

  function loadTranscriber() {
    if (state.transcriberPromise) return state.transcriberPromise;
    state.transcriberPromise = (async () => {
      const url = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";
      const library = await import(url);
      const pipeline = library.pipeline;
      if (typeof pipeline !== "function") throw new Error("The speech model library did not load.");
      return pipeline("automatic-speech-recognition", "Xenova/whisper-tiny.en", {
        progress_callback: progress => {
          if (progress && progress.status === "progress" && Number.isFinite(progress.progress)) {
            $("captionStatus").textContent = "Downloading speech model… " + Math.round(progress.progress) + "%";
          } else if (progress && progress.status) {
            $("captionStatus").textContent = "Loading speech model… " + progress.status;
          }
        }
      });
    })().catch(error => {
      state.transcriberPromise = null;
      throw error;
    });
    return state.transcriberPromise;
  }

  function chooseCaptionSource() {
    let item = selectedItem();
    if (!item || !["visual", "audio"].includes(item.kind)) item = activeItem("visual", state.time);
    if (item && ["visual", "audio"].includes(item.kind)) {
      const asset = assetFor(item);
      if (asset && (asset.type === "video" || asset.type === "audio")) return { item, asset };
    }
    const visual = state.project.items.find(x => x.kind === "visual" && state.time >= x.start && state.time < itemEnd(x));
    if (visual) {
      const asset = assetFor(visual);
      if (asset && (asset.type === "video" || asset.type === "audio")) return { item: visual, asset };
    }
    return null;
  }

  async function audioTo16kMono(arrayBuffer) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("This browser does not support local audio processing.");
    const decodeContext = new AudioContextClass();
    try {
      const decoded = await decodeContext.decodeAudioData(arrayBuffer.slice(0));
      if (decoded.duration > 900) throw new Error("For browser performance, automatic captions are limited to clips shorter than 15 minutes. Try trimming the clip first.");
      const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i));
      const sourceRate = decoded.sampleRate;
      const outLength = Math.floor(decoded.length * 16000 / sourceRate);
      const mono = new Float32Array(outLength);
      for (let i = 0; i < outLength; i++) {
        const srcIndex = i * sourceRate / 16000;
        const left = Math.floor(srcIndex);
        const blend = srcIndex - left;
        let sample = 0;
        for (const channel of channels) {
          const a = channel[Math.min(decoded.length - 1, left)] || 0;
          const b = channel[Math.min(decoded.length - 1, left + 1)] || 0;
          sample += a + (b - a) * blend;
        }
        mono[i] = sample / Math.max(1, channels.length);
      }
      return { mono, sampleRate: 16000, duration: decoded.duration };
    } finally {
      try { await decodeContext.close(); } catch (_) {}
    }
  }

  async function generateAutoCaptions() {
    const selected = chooseCaptionSource();
    if (!selected) {
      $("captionStatus").textContent = "Import a video or audio file and select it on the timeline first.";
      notify("Select a video or audio clip to generate captions.");
      return;
    }
    const { item, asset } = selected;
    if (asset.size > 350 * 1024 * 1024) {
      $("captionStatus").textContent = "This file is too large for browser transcription. Trim or compress it first.";
      return;
    }
    const button = $("generateCaptionsBtn");
    button.disabled = true;
    $("captionStatus").textContent = "Preparing audio locally…";
    try {
      let bytes;
      if (asset.file && typeof asset.file.arrayBuffer === "function") bytes = await asset.file.arrayBuffer();
      else {
        $("captionStatus").textContent = "Fetching clip audio…";
        const response = await fetch(asset.url);
        if (!response.ok) throw new Error("Could not download the selected clip for local transcription.");
        bytes = await response.arrayBuffer();
      }
      const decoded = await audioTo16kMono(bytes);
      const speed = Math.max(0.25, Number(item.speed) || 1);
      const trimStart = Math.max(0, Number(item.in) || 0);
      const trimEnd = Math.min(decoded.duration, Number.isFinite(item.out) ? item.out : decoded.duration);
      if (trimEnd <= trimStart) throw new Error("The selected clip has no audio in its current trim range.");
      const crop = decoded.mono.slice(Math.floor(trimStart * decoded.sampleRate), Math.floor(trimEnd * decoded.sampleRate));
      $("captionStatus").textContent = "Loading speech model (first run may take a while)…";
      const transcriber = await loadTranscriber();
      $("captionStatus").textContent = "Transcribing speech in your browser…";
      const result = await transcriber(crop, { return_timestamps: "word", chunk_length_s: 30, stride_length_s: 5 });
      const words = Array.isArray(result.chunks) ? result.chunks : [];
      const chunks = [];
      let current = null;
      words.forEach(chunk => {
        const text = String(chunk.text || "").trim();
        const stamp = chunk.timestamp || [];
        const start = Number(stamp[0]);
        const end = Number(stamp[1]);
        if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
        if (!current || current.words >= 6 || end - current.start > 2.8 || /[.!?]$/.test(current.text)) {
          if (current) chunks.push(current);
          current = { text, start, end, words: 1 };
        } else {
          current.text += text.startsWith("'") || /^[,.;:!?]/.test(text) ? text : " " + text;
          current.end = end;
          current.words++;
        }
      });
      if (current) chunks.push(current);
      if (!chunks.length && String(result.text || "").trim()) {
        const wordsFallback = String(result.text).trim().split(/\s+/);
        const groups = [];
        for (let i = 0; i < wordsFallback.length; i += 6) groups.push(wordsFallback.slice(i, i + 6).join(" "));
        const approx = (trimEnd - trimStart) / Math.max(1, groups.length);
        groups.forEach((text, i) => chunks.push({ text, start: i * approx, end: (i + 1) * approx }));
      }
      if (!chunks.length) throw new Error("No speech was recognised. You can still import an SRT/VTT subtitle file or add captions manually.");
      checkpoint();
      const style = activeCaptionStyle();
      const created = [];
      chunks.forEach(chunk => {
        const start = item.start + Math.max(0, chunk.start) / speed;
        const end = item.start + Math.max(chunk.start + 0.15, chunk.end) / speed;
        const caption = addCaption(chunk.text, start, end, style);
        if (caption) created.push(caption);
      });
      state.selectedId = created.length ? created[0].id : state.selectedId;
      renderAll();
      $("captionStatus").textContent = "Created " + created.length + " subtitle cues. Check the wording and timings before export.";
      notify("Auto captions created. Review them for accuracy.");
      state.speechModelLoaded = true;
    } catch (error) {
      console.error("Auto captions:", error);
      $("captionStatus").textContent = error.message || "Could not generate captions.";
    } finally {
      button.disabled = false;
      button.textContent = "✦ Generate auto captions";
    }
  }

  function resetSelected() {
    const item = selectedItem();
    if (!item) return;
    checkpoint();
    if (item.kind === "visual") Object.assign(item, { speed: 1, volume: 1, fit: "contain", brightness: 0, contrast: 1, saturate: 1, fadeIn: 0, fadeOut: 0, transition: "none", transitionDuration: 0.4 });
    else if (item.kind === "audio") Object.assign(item, { speed: 1, volume: 1, fadeIn: 0, fadeOut: 0 });
    else Object.assign(item, { x: 50, y: item.kind === "sticker" ? 30 : 50, scale: item.kind === "imageOverlay" ? 0.35 : 1, opacity: 1, rotation: 0 });
    renderAll();
    notify("Selected layer properties reset.");
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function saveProjectFile() {
    const assetManifest = Array.from(state.assets.values()).map(asset => ({ id: asset.id, name: asset.name, type: asset.type, size: asset.size, duration: asset.duration }));
    const payload = {
      app: "ClipNow Editor", version: 1, project: state.project,
      assets: assetManifest,
      note: "This project file stores editing instructions, not the original media files. Re-import the referenced files before opening it on another session or device."
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const name = (state.project.name || "clipnow-project").replace(/[^a-z0-9-_]+/gi, "-").replace(/^-+|-+$/g, "") || "clipnow-project";
    downloadBlob(blob, name + ".clipnow.json");
    $("saveStatus").textContent = "Project file saved";
    notify("Project file downloaded. Keep the source media files with it.");
  }

  async function openProjectFile(file) {
    try {
      const payload = JSON.parse(await file.text());
      if (!payload || payload.app !== "ClipNow Editor" || !payload.project || !Array.isArray(payload.project.items)) throw new Error("That is not a valid ClipNow Editor project file.");
      const available = Array.from(state.assets.values());
      const assetMap = new Map();
      (payload.assets || []).forEach(saved => {
        let match = available.find(asset => asset.name === saved.name && asset.type === saved.type && asset.size === saved.size);
        if (!match) match = available.find(asset => asset.name === saved.name && asset.type === saved.type);
        if (match) assetMap.set(saved.id, match.id);
      });
      const missing = (payload.assets || []).filter(saved => !assetMap.has(saved.id));
      checkpoint();
      const remappedItems = [];
      payload.project.items.forEach(savedItem => {
        const copy = Object.assign({}, savedItem);
        if (copy.assetId) {
          if (!assetMap.has(copy.assetId)) return;
          copy.assetId = assetMap.get(copy.assetId);
        }
        remappedItems.push(copy);
      });
      state.project = {
        name: String(payload.project.name || "Imported project").slice(0, 80),
        ratio: ASPECTS[payload.project.ratio] ? payload.project.ratio : "16:9",
        items: remappedItems,
        markers: Array.isArray(payload.project.markers) ? payload.project.markers : [],
        trackCounts: Object.assign({ visual: 1, overlay: 1, audio: 1 }, payload.project.trackCounts || {})
      };
      state.selectedId = null;
      state.time = 0;
      $("projectName").value = state.project.name;
      $("aspectRatio").value = state.project.ratio;
      updateCanvasSize();
      renderAll();
      notify("Project opened." + (missing.length ? " " + missing.length + " media file(s) were missing and their clips were skipped. Re-import them and reopen the project." : ""));
    } catch (error) {
      notify(error.message || "Could not open project file.");
    }
  }

  function exportDimensions(resolution) {
    const ratio = state.project.ratio;
    if (resolution === "480") {
      if (ratio === "9:16") return [270, 480];
      if (ratio === "1:1") return [480, 480];
      if (ratio === "4:5") return [384, 480];
      return [854, 480];
    }
    if (resolution === "720") {
      if (ratio === "9:16") return [720, 1280];
      if (ratio === "1:1") return [720, 720];
      if (ratio === "4:5") return [576, 720];
      return [1280, 720];
    }
    if (ratio === "9:16") return [1080, 1920];
    if (ratio === "1:1") return [1080, 1080];
    if (ratio === "4:5") return [864, 1080];
    return [1920, 1080];
  }

  function supportedMime() {
    if (!window.MediaRecorder) return "";
    const choices = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
    return choices.find(type => {
      try { return MediaRecorder.isTypeSupported(type); } catch (_) { return false; }
    }) || "";
  }

  async function renderExport(mode) {
    const duration = projectDuration();
    if (!state.project.items.some(item => item.kind === "visual") || duration <= 0) {
      showExportError("Add at least one video or image clip to the timeline before exporting.");
      return;
    }
    if (mode === "upload") {
      if (typeof getCurrentUser !== "function" || !(await getCurrentUser())) {
        showExportError("Sign in to ClipNow before exporting an upload. You can download the finished video without signing in.");
        return;
      }
    }
    const mime = supportedMime();
    if (!mime || !canvas.captureStream) {
      showExportError("This browser cannot record a WebM export. Try the latest desktop version of Chrome or Edge.");
      return;
    }
    const resolution = $("exportResolution").value;
    const dims = exportDimensions(resolution);
    const quality = $("exportBitrate").value;
    const bitrate = quality === "compact" ? (resolution === "1080" ? 4500000 : 1800000) : quality === "standard" ? (resolution === "1080" ? 8000000 : 4000000) : (resolution === "1080" ? 14000000 : 6500000);
    const savedTime = state.time;
    const savedRatioSize = ASPECTS[state.project.ratio];
    const exportTitle = ($("exportTitle").value || state.project.name || "Edited Clip").trim().slice(0, 120) || "Edited Clip";
    const exportDescription = ($("exportDescription").value || "").trim().slice(0, 2000);
    clearExportError();
    state.exportMode = mode;
    $("downloadExport").disabled = true;
    $("uploadExport").disabled = true;
    $("closeExport").disabled = true;
    $("exportProgress").hidden = false;
    $("exportProgressFill").style.width = "0%";
    $("exportPercent").textContent = "0%";
    $("exportProgressLabel").textContent = "Preparing media…";
    pause();
    let stream = null;
    let canvasStream = null;
    let recorder = null;
    let chunks = [];
    try {
      await ensureAudioGraph();
      state.time = 0;
      updateCanvasSize(dims[0], dims[1]);
      await syncMedia(0, false);
      drawFrame();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      canvasStream = canvas.captureStream(30);
      const tracks = canvasStream.getVideoTracks().slice();
      if (state.audioMix && state.audioMix.stream && state.audioMix.stream.getAudioTracks().length) {
        tracks.push.apply(tracks, state.audioMix.stream.getAudioTracks());
      }
      stream = new MediaStream(tracks);
      recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
      state.recorder = recorder;
      const stopped = new Promise((resolve, reject) => {
        recorder.ondataavailable = event => { if (event.data && event.data.size) chunks.push(event.data); };
        recorder.onerror = event => reject((event.error && event.error.message) ? new Error(event.error.message) : new Error("The browser stopped recording unexpectedly."));
        recorder.onstop = resolve;
      });
      recorder.start(250);
      $("exportProgressLabel").textContent = "Rendering " + resolution + "p video…";
      play();
      const waitUntilDone = async () => {
        while (state.playing) {
          const pct = Math.min(99, Math.floor((state.time / Math.max(duration, 0.01)) * 100));
          $("exportProgressFill").style.width = pct + "%";
          $("exportPercent").textContent = pct + "%";
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      };
      await waitUntilDone();
      await new Promise(resolve => setTimeout(resolve, 200));
      if (recorder.state !== "inactive") recorder.stop();
      await stopped;
      if (!chunks.length) throw new Error("The browser produced an empty video. Try a different source file or export quality.");
      const blob = new Blob(chunks, { type: mime });
      if (!blob.size) throw new Error("The exported video was empty.");
      $("exportProgressFill").style.width = "100%";
      $("exportPercent").textContent = "100%";
      $("exportProgressLabel").textContent = "Finishing file…";
      if (mode === "upload") {
        await uploadExportedBlob(blob, exportTitle, exportDescription);
      } else {
        const filename = exportTitle.replace(/[^a-z0-9-_]+/gi, "-").replace(/^-+|-+$/g, "") || "edited-clip";
        downloadBlob(blob, filename + ".webm");
        notify("Export complete — your WebM download has started.");
        closeExportModal();
      }
    } catch (error) {
      console.error("ClipNow export failed:", error);
      showExportError(error.message || "Export failed. Try using a smaller resolution.");
    } finally {
      pause();
      state.recorder = null;
      // The audio-mix track belongs to the persistent AudioContext. Do not stop
      // it here or later exports would silently lose audio. Stop only the canvas track.
      if (canvasStream) canvasStream.getTracks().forEach(track => { try { track.stop(); } catch (_) {} });
      if (savedRatioSize) updateCanvasSize(savedRatioSize[0], savedRatioSize[1]);
      state.time = clamp(savedTime, 0, projectDuration());
      syncMedia(state.time, false);
      renderTimeline();
      $("downloadExport").disabled = false;
      $("uploadExport").disabled = false;
      $("closeExport").disabled = false;
      $("exportProgress").hidden = true;
      state.exportMode = null;
    }
  }

  async function uploadExportedBlob(blob, title, description) {
    if (typeof client === "undefined" || typeof getCurrentUser !== "function") {
      throw new Error("ClipNow sign-in is unavailable. Download the video instead.");
    }
    const user = await getCurrentUser();
    if (!user) throw new Error("Sign in to ClipNow to upload. You can still download the video without an account.");
    const profile = typeof getProfile === "function" ? await getProfile() : null;
    const used = Number(profile && profile.storage_used) || 0;
    if (typeof MAX_STORAGE !== "undefined" && used + blob.size > MAX_STORAGE) throw new Error("Your ClipNow 5 GB storage limit would be exceeded. Download the file instead.");
    const path = user.id + "/edited-" + Date.now() + ".webm";
    const upload = await client.storage.from("clips").upload(path, blob, { contentType: "video/webm", upsert: false });
    if (upload.error) throw upload.error;
    const row = await client.from("clips").insert({
      user_id: user.id,
      title: title,
      description: description || null,
      file_path: path,
      file_size: blob.size,
      visibility: "private",
      views: 0,
      likes_count: 0,
      comments_count: 0
    }).select("id").maybeSingle();
    if (row.error) {
      try { await client.storage.from("clips").remove([path]); } catch (_) {}
      throw row.error;
    }
    try { await client.from("profiles").update({ storage_used: used + blob.size }).eq("id", user.id); } catch (error) { console.warn("Storage count update failed", error); }
    if (!row.data || !row.data.id) throw new Error("The file uploaded, but ClipNow did not return a clip ID.");
    const link = document.createElement("a");
    link.href = "clip.html?id=" + encodeURIComponent(row.data.id);
    link.textContent = "Open your private clip";
    link.style.cssText = "display:inline-block;margin-top:14px;color:#d8f55d;font-size:12px";
    $("exportError").replaceChildren(document.createTextNode("Upload complete. "), link);
    $("exportError").style.background = "#142016";
    $("exportError").style.borderColor = "#315b37";
    $("exportError").style.color = "#d2f4d4";
    $("exportError").hidden = false;
    $("exportProgressLabel").textContent = "Uploaded to ClipNow";
    $("exportProgressFill").style.width = "100%";
    $("exportPercent").textContent = "100%";
    notify("Edited video uploaded privately to ClipNow.");
  }

  function openExportModal() {
    if (!state.project.items.length) {
      notify("Add media to the timeline before exporting.");
      return;
    }
    $("exportTitle").value = state.project.name && state.project.name !== "Untitled project" ? state.project.name : "Edited Clip";
    $("exportDuration").textContent = fmtTime(projectDuration(), false);
    $("exportModal").hidden = false;
    clearExportError();
    $("downloadExport").focus();
  }
  function closeExportModal() {
    if (state.recorder && state.recorder.state !== "inactive") {
      notify("Export is in progress. Let it finish before closing.");
      return;
    }
    $("exportModal").hidden = true;
    clearExportError();
  }

  function enableDragDrop() {
    const dropTargets = [$("mediaPanel"), $("stage"), timelineContent];
    dropTargets.forEach(target => {
      target.addEventListener("dragover", event => {
        event.preventDefault();
        target.classList.add("editor-drop-active");
      });
      target.addEventListener("dragleave", () => target.classList.remove("editor-drop-active"));
      target.addEventListener("drop", async event => {
        event.preventDefault();
        target.classList.remove("editor-drop-active");
        const files = Array.from(event.dataTransfer.files || []);
        if (files.length) {
          const intoTimeline = target === timelineContent || target === $("stage");
          await importFiles(files, null, intoTimeline);
          return;
        }
        const assetId = event.dataTransfer.getData("text/clipnow-asset");
        if (assetId && state.assets.has(assetId)) addAssetToTimeline(assetId);
      });
    });
  }

  async function importCloudClipFromQuery() {
    const id = new URLSearchParams(window.location.search).get("id");
    if (!id) return;
    if (typeof getClipById !== "function" || typeof getClipPlaybackUrl !== "function") {
      notify("ClipNow cloud import is not available on this page.");
      return;
    }
    try {
      $("saveStatus").textContent = "Loading ClipNow clip…";
      const result = await getClipById(id);
      if (!result || !result.data) throw new Error((result && result.error && result.error.message) || "Clip not found or access denied.");
      const url = await getClipPlaybackUrl(result.data.file_path);
      if (!url) throw new Error("ClipNow could not create a playback URL for this clip.");
      const asset = await buildCloudVideo(url, result.data.title || "ClipNow clip", result.data.file_size);
      state.assets.set(asset.id, asset);
      const item = makeVisualItem(asset, 0);
      state.project.items.push(item);
      state.selectedId = item.id;
      state.project.name = (result.data.title || "ClipNow edit").slice(0, 80) + " — Edit";
      $("projectName").value = state.project.name;
      $("exportTitle").value = state.project.name;
      $("saveStatus").textContent = "Clip imported from ClipNow";
      renderAll();
      await syncMedia(0, false);
      notify("Clip imported. Your original upload is unchanged.");
    } catch (error) {
      $("saveStatus").textContent = "Could not import clip";
      notify(error.message || "Could not import this ClipNow clip.");
    }
  }

  function bindEvents() {
    $("mediaInput").addEventListener("change", event => {
      importFiles(event.target.files);
      event.target.value = "";
    });
    $("audioInput").addEventListener("change", event => {
      importFiles(event.target.files, "mediaPanel");
      event.target.value = "";
    });
    $("mediaList").addEventListener("click", event => {
      const addButton = event.target.closest("[data-add-asset]");
      const overlayButton = event.target.closest("[data-add-overlay]");
      const previewButton = event.target.closest("[data-preview-asset]");
      if (addButton) addAssetToTimeline(addButton.dataset.addAsset, false);
      else if (overlayButton) addAssetToTimeline(overlayButton.dataset.addOverlay, true);
      else if (previewButton) {
        const asset = state.assets.get(previewButton.dataset.previewAsset);
        if (asset && asset.type === "video") {
          const existing = state.project.items.find(item => item.assetId === asset.id && item.kind === "visual");
          if (existing) seekTo(existing.start);
          else notify("Add this video to the timeline to preview it.");
        } else if (asset && asset.type === "audio") notify("Add the audio track to preview it in the timeline.");
      }
    });
    $("mediaSearch").addEventListener("input", renderMediaList);
    $("mediaFilter").addEventListener("change", renderMediaList);
    document.querySelectorAll(".editor-tool-tab").forEach(tab => tab.addEventListener("click", () => activatePanel(tab.dataset.panel)));
    $("jumpToMedia").addEventListener("click", () => activatePanel("mediaPanel"));
    $("addTextBtn").addEventListener("click", () => addText($("newText").value));
    $("addCaptionBtn").addEventListener("click", addManualCaption);
    $("generateCaptionsBtn").addEventListener("click", generateAutoCaptions);
    $("importCaptionsBtn").addEventListener("click", () => $("captionFileInput").click());
    $("captionFileInput").addEventListener("change", async event => {
      const file = event.target.files && event.target.files[0];
      if (file) {
        try { await importCaptionFile(file); }
        catch (error) { $("captionStatus").textContent = error.message || "Subtitle import failed."; }
      }
      event.target.value = "";
    });
    $("exportCaptionsBtn").addEventListener("click", exportCaptionsSrt);
    $("addKeyframeBtn").addEventListener("click", addKeyframeForSelected);
    $("clearKeyframesBtn").addEventListener("click", () => {
      const item = selectedItem();
      if (!item || !item.keyframes || !item.keyframes.length) { notify("The selected layer has no keyframes."); return; }
      checkpoint();
      item.keyframes = [];
      renderAll();
      notify("Keyframes cleared.");
    });
    $("jumpToCaptions").addEventListener("click", () => activatePanel("captionsPanel"));
    document.querySelectorAll("[data-motion]").forEach(button => button.addEventListener("click", () => applyMotionPreset(button.dataset.motion)));
    document.querySelectorAll("[data-text-preset]").forEach(button => {
      button.addEventListener("click", () => {
        const preset = button.dataset.textPreset;
        addText($("newText").value, preset);
        activatePanel("textPanel");
      });
    });
    $("stickerGrid").replaceChildren();
    ["🔥", "💯", "GG", "W", "EZ", "CLUTCH", "1HP", "LOL", "🎯", "👑", "⚡", "❤️", "😭", "💀", "✨", "🚀"].forEach(value => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = value;
      button.title = "Add " + value + " sticker";
      button.addEventListener("click", () => addSticker(value));
      $("stickerGrid").appendChild(button);
    });
    $("undoBtn").addEventListener("click", undo);
    $("redoBtn").addEventListener("click", redo);
    $("splitBtn").addEventListener("click", splitSelected);
    $("deleteBtn").addEventListener("click", deleteSelected);
    $("rippleDeleteBtn").addEventListener("click", rippleDeleteSelected);
    $("copyBtn").addEventListener("click", copySelected);
    $("pasteBtn").addEventListener("click", pasteCopied);
    $("addMarkerBtn").addEventListener("click", addTimelineMarker);
    $("snapBtn").addEventListener("click", () => {
      state.snapEnabled = !state.snapEnabled;
      renderTimeline();
      notify(state.snapEnabled ? "Magnetic snapping enabled." : "Magnetic snapping disabled.");
    });
    $("addVideoTrackBtn").addEventListener("click", () => addTrack("visual"));
    $("addAudioTrackBtn").addEventListener("click", () => addTrack("audio"));
    $("addOverlayTrackBtn").addEventListener("click", () => addTrack("overlay"));
    $("playPause").addEventListener("click", () => state.playing ? pause() : play());
    $("skipBack").addEventListener("click", () => seekTo(state.time - 1));
    $("skipForward").addEventListener("click", () => seekTo(state.time + 1));
    $("fitPreview").addEventListener("click", () => { $("stage").scrollIntoView({ block: "nearest", behavior: "smooth" }); });
    $("timelineZoom").addEventListener("input", event => {
      state.zoom = Number(event.target.value) || 80;
      renderTimeline();
    });
    $("zoomFit").addEventListener("click", () => {
      const visible = Math.max(100, timelineScroll.clientWidth - TRACK_LABEL - 30);
      state.zoom = clamp(visible / Math.max(15, projectDuration()), 35, 180);
      $("timelineZoom").value = state.zoom;
      renderTimeline();
    });
    timelineContent.addEventListener("pointerdown", handleTimelinePointer);
    $("aspectRatio").addEventListener("change", event => {
      checkpoint();
      state.project.ratio = event.target.value;
      updateCanvasSize();
      renderAll();
    });
    $("projectName").addEventListener("input", event => {
      state.project.name = event.target.value.slice(0, 80);
      $("saveStatus").textContent = "Unsaved changes";
    });
    $("saveProjectBtn").addEventListener("click", saveProjectFile);
    $("projectInput").addEventListener("change", async event => {
      const file = event.target.files && event.target.files[0];
      if (file) await openProjectFile(file);
      event.target.value = "";
    });
    $("resetProperties").addEventListener("click", resetSelected);
    $("inspectorBody").addEventListener("focusin", event => {
      if (!event.target.matches("[data-prop]")) return;
      if (!event.target.dataset.historySaved) {
        checkpoint();
        event.target.dataset.historySaved = "1";
      }
    });
    $("inspectorBody").addEventListener("pointerdown", event => {
      if (!event.target.matches("[data-prop]")) return;
      if (!event.target.dataset.historySaved) {
        checkpoint();
        event.target.dataset.historySaved = "1";
      }
    });
    $("inspectorBody").addEventListener("change", event => {
      if (!event.target.matches("[data-prop]")) return;
      delete event.target.dataset.historySaved;
      renderTimeline();
      renderInspector();
      syncMedia(state.time, false);
    });
    $("inspectorBody").addEventListener("input", event => {
      const input = event.target;
      if (!input.matches("[data-prop]")) return;
      const item = selectedItem();
      if (!item) return;
      const prop = input.dataset.prop;
      const raw = input.type === "checkbox" ? input.checked : input.value;
      applyProperty(item, prop, raw);
      syncLinkedProperty(item, prop);
      const output = input.parentElement.querySelector('output[data-for="' + prop + '"]');
      if (output) output.textContent = Number(item[prop]).toFixed(2) + (prop === "speed" || prop === "volume" ? "×" : "");
      if (["start", "duration", "in", "out", "speed", "fadeIn", "fadeOut", "track", "keyframes", "transition", "transitionDuration"].includes(prop)) renderTimeline();
      else {
        const block = timelineContent.querySelector('[data-item-id="' + item.id + '"] .ed-clip-name');
        if (block && (prop === "value" || prop === "name")) block.textContent = item.value || item.name || item.kind;
      }
      drawFrame();
      updateClock();
    });
    $("inspectorBody").addEventListener("click", event => {
      if (event.target.closest("#duplicateItemBtn")) duplicateSelected();
      if (event.target.closest("#inspectorKeyframeBtn")) addKeyframeForSelected();
      if (event.target.closest("#detachAudioBtn")) detachAudioFromSelected();
    });
    $("openExport").addEventListener("click", openExportModal);
    $("closeExport").addEventListener("click", closeExportModal);
    $("exportModal").addEventListener("click", event => {
      if (event.target === $("exportModal")) closeExportModal();
    });
    $("downloadExport").addEventListener("click", () => renderExport("download"));
    $("uploadExport").addEventListener("click", () => renderExport("upload"));
    document.addEventListener("keydown", event => {
      const target = event.target;
      const typing = target && (target.matches("input,textarea,select") || target.isContentEditable);
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") { event.preventDefault(); redo(); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && !typing) { event.preventDefault(); copySelected(); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v" && !typing) { event.preventDefault(); pasteCopied(); return; }
      if (typing || $("exportModal").hidden === false) {
        if (event.key === "Escape" && !$("exportModal").hidden) closeExportModal();
        return;
      }
      if (event.code === "Space") { event.preventDefault(); state.playing ? pause() : play(); }
      else if (event.key.toLowerCase() === "s") { event.preventDefault(); splitSelected(); }
      else if (event.key.toLowerCase() === "m") { event.preventDefault(); addTimelineMarker(); }
      else if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); deleteSelected(); }
      else if (event.key === "ArrowLeft") { event.preventDefault(); seekTo(state.time - 1 / 30); }
      else if (event.key === "ArrowRight") { event.preventDefault(); seekTo(state.time + 1 / 30); }
      else if (event.key === "Escape" && state.playing) pause();
    });
    enableDragDrop();
  }

  function boot() {
    updateCanvasSize();
    $("aspectRatio").value = state.project.ratio;
    $("timelineZoom").value = state.zoom;
    bindEvents();
    renderAll();
    updateHistoryButtons();
    importCloudClipFromQuery();
  }

  boot();
})();