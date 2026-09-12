/* ClipNow moderation helpers.
   Text moderation is intentionally lenient for ordinary swearing in comments,
   while usernames/handles, bios, titles and descriptions use a stricter list.
   Media moderation calls the Supabase Edge Function named `moderate-media`.
*/

(function () {
  const mildAllowed = new Set([
    "damn", "hell", "crap", "shit", "ass"
  ]);

  // Strong profanity, explicit sexual terms, slurs and graphic-violence terms.
  // These are normalized at runtime so punctuation/spacing/leet substitutions
  // cannot trivially bypass the filter.
  const hardWords = [
    "fuck", "fucker", "fucking", "motherfucker", "motherfuck", "fck",
    "shithead", "bullshit", "bitch", "bastard", "cunt", "twat", "whore",
    "slut", "skank", "dickhead", "cockhead", "pussy", "jackass",
    "nigger", "nigga", "coon", "spic", "chink", "kike", "gook", "wetback",
    "retard", "retarded", "tranny", "dyke", "fag", "faggot",
    "porn", "porno", "pornography", "xxx", "hentai", "blowjob", "handjob",
    "cumshot", "cum", "semen", "dildo", "vibrator", "masturbate", "masturbation",
    "orgasm", "erection", "anal", "penetration", "sexslave", "prostitute",
    "rape", "rapist", "molest", "molester", "pedophile", "pedo", "childporn",
    "gore", "guro", "dismember", "dismembered", "beheading", "decapitation",
    "snuff", "murder", "killyourself", "kys"
  ];

  const normalizedHardWords = hardWords.map(normalizeWord);

  function normalizeWord(value) {
    return String(value || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[4@]/g, "a")
      .replace(/[3]/g, "e")
      .replace(/[1!|]/g, "i")
      .replace(/[0]/g, "o")
      .replace(/[5$]/g, "s")
      .replace(/[7]/g, "t")
      .replace(/[8]/g, "b");
  }

  function normalizedText(value) {
    return normalizeWord(value)
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function compactText(value) {
    return normalizedText(value).replace(/\s+/g, "");
  }

  function containsHardWord(value, { compact = false } = {}) {
    const normalized = normalizedText(value);
    const compacted = compactText(value);
    const tokens = new Set(normalized.split(" ").filter(Boolean));
    return normalizedHardWords.find((word) => {
      if (tokens.has(word)) return true;
      if (word.length >= 5 && compacted.includes(word)) return true;
      if (compact && compacted.includes(word)) return true;
      return false;
    }) || null;
  }

  function checkText(value, mode = "comment") {
    const raw = String(value || "").trim();
    if (!raw) return { allowed: true, word: null };

    const hit = containsHardWord(raw, { compact: mode === "username" });
    if (hit) {
      return {
        allowed: false,
        word: hit,
        message:
          mode === "comment"
            ? "That comment contains language that is not allowed."
            : mode === "username"
              ? "That username or handle is not allowed."
              : "That text contains language that is not allowed."
      };
    }

    // Usernames/handles are stricter: ordinary swear words are not accepted there.
    if (mode === "username") {
      const normalized = normalizedText(raw);
      const mildHit = [...mildAllowed].find((word) =>
        new RegExp(`(^|\\s)${word}(?=\\s|$)`, "i").test(normalized)
      );
      if (mildHit) {
        return { allowed: false, word: mildHit, message: "That username or handle is not allowed." };
      }
    }

    return { allowed: true, word: null };
  }

  function assertTextAllowed(value, mode = "comment") {
    const result = checkText(value, mode);
    if (!result.allowed) throw new Error(result.message);
    return true;
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Could not read media for moderation."));
      reader.onload = () => resolve(String(reader.result || ""));
      reader.readAsDataURL(file);
    });
  }

  function captureModerationFrames(file, count = 3) {
    return new Promise((resolve, reject) => {
      const video = document.createElement("video");
      const url = URL.createObjectURL(file);
      const canvas = document.createElement("canvas");
      const frames = [];
      let index = 0;
      let duration = 0;
      let done = false;

      const cleanup = () => {
        try { URL.revokeObjectURL(url); } catch (_) {}
        video.removeAttribute("src");
        video.load();
      };

      const fail = (message) => {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error(message || "Could not inspect video."));
      };

      const next = () => {
        if (index >= count) {
          done = true;
          cleanup();
          resolve(frames);
          return;
        }
        const ratio = count === 1 ? 0.5 : [0.12, 0.5, 0.88][index] ?? ((index + 1) / (count + 1));
        try {
          video.currentTime = Math.max(0, Math.min(Math.max(0, duration - 0.05), duration * ratio));
        } catch (e) {
          fail(e.message);
        }
      };

      video.muted = true;
      video.playsInline = true;
      video.preload = "metadata";
      video.onloadedmetadata = () => {
        duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1;
        next();
      };
      video.onseeked = () => {
        try {
          const vw = video.videoWidth || 640;
          const vh = video.videoHeight || 360;
          const maxW = 512;
          const scale = Math.min(1, maxW / vw);
          canvas.width = Math.max(1, Math.round(vw * scale));
          canvas.height = Math.max(1, Math.round(vh * scale));
          canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
          frames.push(canvas.toDataURL("image/jpeg", 0.72));
          index += 1;
          next();
        } catch (e) {
          fail(e.message);
        }
      };
      video.onerror = () => fail("Could not read this video for moderation.");
      video.src = url;
      video.load();
    });
  }

  async function moderateMediaFiles(videoFile, imageFile) {
    const images = [];
    if (imageFile) {
      if (!String(imageFile.type || "").startsWith("image/")) {
        throw new Error("The thumbnail must be an image.");
      }
      images.push(await fileToDataUrl(imageFile));
    }
    if (videoFile) {
      if (!String(videoFile.type || "").startsWith("video/")) {
        throw new Error("The clip must be a video.");
      }
      const frames = await captureModerationFrames(videoFile, 3);
      images.push(...frames);
    }

    if (!images.length) return { allowed: true };

    if (!window.client?.functions) {
      throw new Error("Media moderation is not available right now. Please try again later.");
    }

    const { data, error } = await window.client.functions.invoke("moderate-media", {
      body: { images }
    });
    if (error) {
      console.error("moderate-media:", error);
      throw new Error("Media moderation is unavailable right now. Please try again later.");
    }
    if (!data?.allowed) {
      throw new Error(data?.message || "This media is not allowed on ClipNow.");
    }
    return data;
  }

  window.ClipNowModeration = {
    checkText,
    assertTextAllowed,
    moderateMediaFiles,
    normalizeWord
  };
})();
