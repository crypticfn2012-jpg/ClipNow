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
    project: { name: "Untitled project", ratio: "16:9", items: [] },
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
    exportMode: null
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
    if (visual && visualAsset && visualAsset.type === "video") levels.set(visualAsset.id, volumeAtTime(visual, time));
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
    found.sort((a, b) => a.start - b.start);
    return found.length ? found[found.length - 1] : null;
  }
  function takeSnapshot() {
    return JSON.stringify({
      project: { name: state.project.name, ratio: state.project.ratio, items: state.project.items.map(item => Object.assign({}, item)) },
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
      id: uid(), kind: "visual", assetId: asset.id, name: asset.name,
      start: Math.max(0, start), in: 0, out: asset.duration, speed: 1,
      volume: 1, fit: "contain", brightness: 0, contrast: 1, saturate: 1,
      fadeIn: 0, fadeOut: 0, transition: "none", transitionDuration: 0.4
    };
  }
  function addAssetToTimeline(assetId, overlay) {
    const asset = state.assets.get(assetId);
    if (!asset) return;
    checkpoint();
    let item;
    if (asset.type === "audio") {
      item = { id: uid(), kind: "audio", assetId: asset.id, name: asset.name, start: state.time, in: 0, out: asset.duration, speed: 1, volume: 1, fadeIn: 0, fadeOut: 0 };
    } else if (overlay && asset.type === "image") {
      item = { id: uid(), kind: "imageOverlay", assetId: asset.id, name: asset.name, start: state.time, duration: 5, x: 50, y: 50, scale: 0.35, opacity: 1, rotation: 0 };
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
      value: value, start: state.time, duration: 5, x: 50, y: isCaption ? 84 : 50,
      scale: 1, fontSize: isCaption ? 36 : Number($("newTextSize").value) || 56,
      color: $("newTextColor").value || "#ffffff", background: false,
      rotation: 0, opacity: 1, align: "center", bold: true, outline: true
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
      id: uid(), kind: "sticker", name: "Sticker " + value, value: value,
      start: state.time, duration: 4, x: 50, y: 30, scale: 1,
      opacity: 1, rotation: 0
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
    let html = "";
    html += '<div class="ed-inspector-section"><div class="ed-inspector-title">Selected layer</div><div class="ed-form-field"><label>Media</label><div style="font-size:11px;color:#eee;overflow-wrap:anywhere">' + esc(item.name || (asset && asset.name) || item.kind) + '</div><div style="font-size:9px;color:#737373;margin-top:5px">' + esc(category) + ' · ' + fmtShort(itemDuration(item)) + '</div></div></div>';
    if (item.kind === "visual" || item.kind === "audio") {
      html += '<div class="ed-inspector-section"><div class="ed-inspector-title">Timing</div>';
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
        html += '<div class="ed-inspector-title" style="margin-top:15px">Transition out</div>';
        html += '<div class="ed-form-field"><label for="prop-transition">Effect</label><select id="prop-transition" data-prop="transition"><option value="none"' + ((item.transition || "none") === "none" ? " selected" : "") + '>None</option><option value="fade"' + (item.transition === "fade" ? " selected" : "") + '>Fade to black</option><option value="flash"' + (item.transition === "flash" ? " selected" : "") + '>Flash</option><option value="wipe"' + (item.transition === "wipe" ? " selected" : "") + '>Wipe</option></select></div>';
        html += field("Transition duration (s)", "transitionDuration", item.transitionDuration == null ? 0.4 : item.transitionDuration, { range: true, min: 0.1, max: 1.5, step: 0.1, unit: "s" });
        html += '</div>';
      }
    } else {
      html += '<div class="ed-inspector-section"><div class="ed-inspector-title">Timing</div>';
      html += pair(field("Start (s)", "start", item.start, { min: 0, max: 999999, step: 0.1 }), field("Duration (s)", "duration", item.duration, { min: 0.1, max: 999999, step: 0.1 }));
      html += '</div>';
      html += '<div class="ed-inspector-section"><div class="ed-inspector-title">Transform</div>';
      html += pair(field("X position (%)", "x", item.x, { min: 0, max: 100, step: 1 }), field("Y position (%)", "y", item.y, { min: 0, max: 100, step: 1 }));
      html += field("Scale", "scale", item.scale, { range: true, min: 0.1, max: item.kind === "imageOverlay" ? 1.5 : 3, step: 0.05, unit: "×" });
      html += pair(field("Rotation (°)", "rotation", item.rotation || 0, { min: -180, max: 180, step: 1 }), field("Opacity", "opacity", item.opacity == null ? 1 : item.opacity, { range: true, min: 0, max: 1, step: 0.05, unit: "" }));
      html += '</div>';
      if (item.kind === "text") {
        html += '<div class="ed-inspector-section"><div class="ed-inspector-title">Typography</div>';
        html += field("Caption text", "value", item.value, { textarea: true });
        html += pair(field("Font size", "fontSize", item.fontSize || 56, { min: 12, max: 180, step: 1 }), field("Text colour", "color", item.color || "#ffffff", { color: true }));
        html += field("Bold", "bold", item.bold !== false, { check: true });
        html += field("Text outline", "outline", item.outline !== false, { check: true });
        html += field("Text background", "background", !!item.background, { check: true });
        html += '</div>';
      }
    }
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
    else if (["fit", "color", "value", "transition"].includes(prop)) value = String(rawValue);
    else value = Number(rawValue);
    if (prop === "start") value = Math.max(0, value || 0);
    if (prop === "duration") value = Math.max(0.1, value || 0.1);
    if (prop === "in") value = clamp(value, 0, Math.max(0, Number(item.out) - 0.05));
    if (prop === "out") value = clamp(value, Number(item.in) + 0.05, asset ? asset.duration : Math.max(Number(item.in) + 0.05, value));
    if (prop === "speed") value = clamp(value, 0.25, 3);
    if (prop === "volume") value = clamp(value, 0, 2);
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
    Object.values(lanes).forEach(lane => {
      lane.querySelectorAll(".editor-timeline-clip").forEach(clip => clip.remove());
      lane.classList.remove("has-items");
    });
    state.project.items.forEach(item => {
      const lane = lanes[itemTrack(item)];
      if (!lane) return;
      lane.classList.add("has-items");
      const asset = assetFor(item);
      const clip = document.createElement("div");
      clip.className = "editor-timeline-clip kind-" + item.kind + (item.kind === "visual" && asset && asset.type === "image" ? " kind-image" : "") + (state.selectedId === item.id ? " selected" : "");
      clip.style.left = (TRACK_LABEL + Math.max(0, item.start) * pps) + "px";
      clip.style.width = Math.max(12, itemDuration(item) * pps) + "px";
      clip.dataset.itemId = item.id;
      clip.title = (item.name || item.value || item.kind) + " · " + fmtTime(item.start) + "–" + fmtTime(itemEnd(item));
      const name = document.createElement("span");
      name.className = "ed-clip-name";
      name.textContent = item.kind === "text" ? "T · " + (item.value || "Text") : item.kind === "sticker" ? (item.value || "Sticker") : (item.name || (asset && asset.name) || item.kind);
      const meta = document.createElement("span");
      meta.className = "ed-clip-meta";
      meta.textContent = fmtShort(itemDuration(item)) + (item.kind === "visual" || item.kind === "audio" ? " · " + (Number(item.speed) || 1).toFixed(2) + "×" : "");
      clip.append(name, meta);
      if (item.kind === "visual" || item.kind === "audio") {
        const left = document.createElement("span");
        left.className = "ed-trim-handle ed-trim-left";
        left.dataset.edge = "left";
        const right = document.createElement("span");
        right.className = "ed-trim-handle ed-trim-right";
        right.dataset.edge = "right";
        clip.append(left, right);
      } else {
        const left = document.createElement("span");
        left.className = "ed-trim-handle ed-trim-left";
        left.dataset.edge = "left";
        const right = document.createElement("span");
        right.className = "ed-trim-handle ed-trim-right";
        right.dataset.edge = "right";
        clip.append(left, right);
      }
      clip.addEventListener("pointerdown", event => startItemDrag(event, item, clip));
      clip.addEventListener("click", event => {
        event.stopPropagation();
        if (state.selectedId !== item.id) setSelected(item.id);
      });
      lane.appendChild(clip);
    });
    playhead.style.left = (TRACK_LABEL + state.time * pps) + "px";
    $("timelineDuration").textContent = state.project.items.length + " layer" + (state.project.items.length === 1 ? "" : "s") + " · " + fmtShort(duration);
    $("timelineStatus").textContent = state.playing ? "Playing" : "Ready";
    updateClock();
  }

  function snapStart(value, movingItem) {
    let best = Math.max(0, value);
    let distance = 0.12;
    const targets = [state.time];
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
    const original = { start: item.start, in: item.in, out: item.out, duration: item.duration };
    checkpoint();
    let changed = false;
    const move = ev => {
      const dx = (ev.clientX - startX) / pps;
      if (edge === "move") {
        item.start = snapStart(Math.max(0, original.start + dx), item);
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
      changed = true;
      const x = TRACK_LABEL + item.start * pps;
      element.style.left = x + "px";
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
      activeAssets.set(visibleAsset.id, volumeAtTime(visual, time));
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
    const visual = activeItem("visual", state.time);
    if (visual) {
      const asset = assetFor(visual);
      if (asset && asset.element && (asset.type === "image" || (asset.type === "video" && asset.element.readyState >= 2))) {
        const d = Math.max(0.001, itemDuration(visual));
        const elapsed = state.time - visual.start;
        let alpha = 1;
        if (visual.fadeIn > 0) alpha = Math.min(alpha, clamp(elapsed / visual.fadeIn, 0, 1));
        if (visual.fadeOut > 0) alpha = Math.min(alpha, clamp((d - elapsed) / visual.fadeOut, 0, 1));
        ctx.globalAlpha = alpha;
        ctx.filter = "brightness(" + (1 + (Number(visual.brightness) || 0)) + ") contrast(" + (Number(visual.contrast) || 1) + ") saturate(" + (Number(visual.saturate) || 1) + ")";
        drawFittedImage(asset.element, visual.fit || "contain", 0, 0, w, h);
        ctx.filter = "none";
      }
    }
    const overlays = state.project.items.filter(item => ["text", "sticker", "imageOverlay"].includes(item.kind) && state.time >= item.start && state.time < itemEnd(item));
    overlays.sort((a, b) => a.start - b.start);
    overlays.forEach(item => {
      ctx.save();
      ctx.globalAlpha = clamp(item.opacity == null ? 1 : item.opacity, 0, 1);
      const x = clamp(item.x == null ? 50 : item.x, 0, 100) / 100 * w;
      const y = clamp(item.y == null ? 50 : item.y, 0, 100) / 100 * h;
      ctx.translate(x, y);
      ctx.rotate((Number(item.rotation) || 0) * Math.PI / 180);
      const unit = w / 1280;
      const scale = Number(item.scale) || 1;
      if (item.kind === "text") {
        const fontSize = Math.max(12, (Number(item.fontSize) || 56) * unit * scale);
        ctx.font = (item.bold === false ? "500 " : "800 ") + fontSize + "px Arial, Helvetica, sans-serif";
        ctx.textAlign = item.align || "center";
        ctx.textBaseline = "middle";
        const lines = String(item.value || "").split("\n");
        const lineHeight = fontSize * 1.15;
        const totalHeight = lines.length * lineHeight;
        if (item.background) {
          const maxWidth = Math.max.apply(null, lines.map(line => ctx.measureText(line).width).concat([0]));
          ctx.fillStyle = "rgba(0,0,0,.68)";
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
      const remaining = itemEnd(visual) - state.time;
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
    state.project.items = state.project.items.filter(x => x.id !== item.id);
    state.selectedId = null;
    renderAll();
    syncMedia(state.time, false);
    notify("Layer deleted.");
  }

  function duplicateSelected() {
    const item = selectedItem();
    if (!item) return;
    checkpoint();
    const copy = Object.assign({}, item, { id: uid(), start: itemEnd(item) });
    copy.name = (item.name || item.kind) + " copy";
    state.project.items.push(copy);
    state.selectedId = copy.id;
    state.time = copy.start;
    renderAll();
    notify("Layer duplicated.");
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
        items: remappedItems
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
      if (stream) stream.getTracks().forEach(track => { try { track.stop(); } catch (_) {} });
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
      if (event.target.matches("[data-prop]")) delete event.target.dataset.historySaved;
    });
    $("inspectorBody").addEventListener("input", event => {
      const input = event.target;
      if (!input.matches("[data-prop]")) return;
      const item = selectedItem();
      if (!item) return;
      const prop = input.dataset.prop;
      const raw = input.type === "checkbox" ? input.checked : input.value;
      applyProperty(item, prop, raw);
      const output = input.parentElement.querySelector('output[data-for="' + prop + '"]');
      if (output) output.textContent = Number(item[prop]).toFixed(2) + (prop === "speed" || prop === "volume" ? "×" : "");
      if (prop === "start" || prop === "duration" || prop === "in" || prop === "out" || prop === "speed" || prop === "fadeIn" || prop === "fadeOut") renderTimeline();
      else {
        const block = timelineContent.querySelector('[data-item-id="' + item.id + '"] .ed-clip-name');
        if (block && (prop === "value" || prop === "name")) block.textContent = item.value || item.name || item.kind;
      }
      drawFrame();
      updateClock();
    });
    $("inspectorBody").addEventListener("click", event => {
      if (event.target.closest("#duplicateItemBtn")) duplicateSelected();
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
      if (typing || $("exportModal").hidden === false) {
        if (event.key === "Escape" && !$("exportModal").hidden) closeExportModal();
        return;
      }
      if (event.code === "Space") { event.preventDefault(); state.playing ? pause() : play(); }
      else if (event.key.toLowerCase() === "s") { event.preventDefault(); splitSelected(); }
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