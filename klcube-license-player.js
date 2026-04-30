(function (global) {
  "use strict";

  const DEFAULT_STORAGE_PREFIX = "klcube_license_player";
  const DEVICE_FINGERPRINT_VERSION = "browser-stable-v2";
  const RESULT_CODES_REQUIRING_ACTIVATION = new Set([
    "TOKEN_MISSING",
    "TOKEN_EXPIRED",
    "TOKEN_NOT_FOUND",
    "DEVICE_INVALID",
    "DEVICE_MISMATCH"
  ]);

  class KlcubeLicenseError extends Error {
    constructor(message, result) {
      super(message);
      this.name = "KlcubeLicenseError";
      this.result = result || null;
      this.resultCode = result && result.resultCode ? result.resultCode : "UNKNOWN";
    }
  }

  class KlcubeLicensePlayer {
    constructor(options) {
      const config = options || {};

      if (!config.serverBaseUrl) {
        throw new Error("serverBaseUrl is required.");
      }

      if (!config.licenseKey) {
        throw new Error("licenseKey is required.");
      }

      this.serverBaseUrl = normalizeBaseUrl(config.serverBaseUrl);
      this.licenseKey = config.licenseKey;
      this.videoElement = resolveVideoElement(config.videoElement);
      this.storagePrefix = config.storagePrefix || DEFAULT_STORAGE_PREFIX;
      this.browserFamily = config.browserFamily || detectBrowserFamily();
      this.autoActivate = config.autoActivate !== false;
      this.preferHls = config.preferHls !== false;
      this.logger = typeof config.logger === "function" ? config.logger : null;
      this.fetchImpl = config.fetchImpl || global.fetch.bind(global);
      this.hlsFactory = config.hlsFactory || null;
      this.hlsInstance = null;
    }

    async activate() {
      const deviceFingerprint = await this.getDeviceFingerprint();
      const deviceSecret = this.getDeviceSecret();
      const result = await this.postJson("/api/licenses/activate", {
        licenseKey: this.licenseKey,
        hostName: global.location && global.location.hostname ? global.location.hostname : "web-client",
        deviceFingerprint,
        deviceSecret,
        machineGuid: null,
        macAddress: null,
        internalIpAddress: null
      });

      this.log("activate", result);

      if (result.success && result.data && result.data.token) {
        this.setSession("token", result.data.token);
        this.setSession("tokenId", result.data.tokenId || "");
        this.setSession("deviceFingerprint", deviceFingerprint);
        this.setSession("tokenExpiresAt", result.data.expiresAt || "");
        this.setDeviceSecret(result.data.deviceSecret || "");
      }

      return result;
    }

    async validate() {
      const token = this.getSession("token");
      const deviceFingerprint = this.getSession("deviceFingerprint") || await this.getDeviceFingerprint();
      const deviceSecret = this.getDeviceSecret();

      if (!token || !deviceFingerprint || !deviceSecret) {
        return createFailure("TOKEN_MISSING", "Stored activation token is missing.");
      }

      const result = await this.postJson("/api/licenses/validate", {
        token,
        deviceFingerprint,
        deviceSecret
      });

      this.log("validate", result);
      return result;
    }

    async issuePlaybackToken(videoId) {
      if (!videoId) {
        return createFailure("INVALID_REQUEST", "videoId is required.");
      }

      const token = this.getSession("token");
      const deviceFingerprint = this.getSession("deviceFingerprint") || await this.getDeviceFingerprint();
      const deviceSecret = this.getDeviceSecret();

      if (!token || !deviceFingerprint || !deviceSecret) {
        return createFailure("TOKEN_MISSING", "Stored activation token is missing.");
      }

      const result = await this.postJson("/api/videos/playback-token", {
        token,
        deviceFingerprint,
        deviceSecret,
        videoId
      });

      this.log("issuePlaybackToken", result);
      return result;
    }

    async ensureLicense() {
      let validateResult = await this.validate();

      if (validateResult.success && validateResult.data && validateResult.data.isAllowed === true) {
        return validateResult;
      }

      if (!this.autoActivate || !RESULT_CODES_REQUIRING_ACTIVATION.has(validateResult.resultCode)) {
        throw new KlcubeLicenseError(validateResult.message || "License validation failed.", validateResult);
      }

      const activateResult = await this.activate();
      if (!activateResult.success) {
        throw new KlcubeLicenseError(activateResult.message || "License activation failed.", activateResult);
      }

      validateResult = await this.validate();
      if (!validateResult.success || !validateResult.data || validateResult.data.isAllowed !== true) {
        throw new KlcubeLicenseError(validateResult.message || "License validation failed.", validateResult);
      }

      return validateResult;
    }

    async play(videoId, options) {
      const playOptions = options || {};
      const videoElement = resolveVideoElement(playOptions.videoElement || this.videoElement);

      if (!videoElement) {
        throw new Error("videoElement is required.");
      }

      await this.ensureLicense();

      const playbackResult = await this.issuePlaybackToken(videoId);
      if (!playbackResult.success || !playbackResult.data) {
        throw new KlcubeLicenseError(playbackResult.message || "Playback token issue failed.", playbackResult);
      }

      const source = this.selectSource(playbackResult.data);
      if (!source) {
        throw new KlcubeLicenseError("Playable stream URL was not returned.", playbackResult);
      }

      await this.loadSource(videoElement, source, playbackResult.data);

      if (playOptions.autoplay !== false) {
        await videoElement.play();
      }

      return {
        source,
        playback: playbackResult
      };
    }

    stop() {
      this.disposeHls();

      if (this.videoElement) {
        this.videoElement.removeAttribute("src");
        this.videoElement.load();
      }
    }

    clearSession() {
      removeStorage(sessionStorage, this.sessionKey("token"));
      removeStorage(sessionStorage, this.sessionKey("tokenId"));
      removeStorage(sessionStorage, this.sessionKey("deviceFingerprint"));
      removeStorage(sessionStorage, this.sessionKey("deviceFingerprintVersion"));
      removeStorage(sessionStorage, this.sessionKey("browserFamily"));
      removeStorage(sessionStorage, this.sessionKey("tokenExpiresAt"));
    }

    async getDeviceFingerprint() {
      const cached = this.getSession("deviceFingerprint");
      const cachedVersion = this.getSession("deviceFingerprintVersion");
      const cachedBrowserFamily = this.getSession("browserFamily");
      if (
        cached &&
        cachedVersion === DEVICE_FINGERPRINT_VERSION &&
        cachedBrowserFamily === this.browserFamily
      ) {
        return cached;
      }

      const raw = [
        DEVICE_FINGERPRINT_VERSION,
        this.browserFamily,
        navigator.userAgent || "",
        navigator.platform || "",
        navigator.language || "",
        screen.width || 0,
        screen.height || 0,
        Intl.DateTimeFormat().resolvedOptions().timeZone || ""
      ].join("|");

      const fingerprint = await sha256(raw);
      this.setSession("deviceFingerprint", fingerprint);
      this.setSession("deviceFingerprintVersion", DEVICE_FINGERPRINT_VERSION);
      this.setSession("browserFamily", this.browserFamily);
      return fingerprint;
    }

    selectSource(data) {
      if (this.preferHls && data.hlsUrl) {
        return {
          type: "hls",
          url: toAbsoluteUrl(this.serverBaseUrl, data.hlsUrl)
        };
      }

      if (data.streamUrl) {
        return {
          type: "file",
          url: toAbsoluteUrl(this.serverBaseUrl, data.streamUrl)
        };
      }

      return null;
    }

    async loadSource(videoElement, source, playbackData) {
      this.disposeHls();

      if (source.type === "hls") {
        if (videoElement.canPlayType("application/vnd.apple.mpegurl")) {
          videoElement.src = source.url;
          videoElement.load();
          return;
        }

        const HlsCtor = this.hlsFactory || global.Hls;
        if (HlsCtor && typeof HlsCtor.isSupported === "function" && HlsCtor.isSupported()) {
          this.hlsInstance = new HlsCtor();
          this.attachHlsFallback(videoElement, playbackData);
          this.hlsInstance.loadSource(source.url);
          this.hlsInstance.attachMedia(videoElement);
          return;
        }

        if (playbackData && playbackData.streamUrl) {
          videoElement.src = toAbsoluteUrl(this.serverBaseUrl, playbackData.streamUrl);
          videoElement.load();
          return;
        }

        throw new Error("HLS is not supported. Load hls.js or use a browser with native HLS support.");
      }

      videoElement.src = source.url;
      videoElement.load();
    }

    attachHlsFallback(videoElement, playbackData) {
      if (!this.hlsInstance || !playbackData || !playbackData.streamUrl) {
        return;
      }

      const HlsCtor = this.hlsFactory || global.Hls;
      if (!HlsCtor || !HlsCtor.Events || !HlsCtor.Events.ERROR) {
        return;
      }

      this.hlsInstance.on(HlsCtor.Events.ERROR, (_eventName, data) => {
        if (!data || data.fatal !== true) {
          return;
        }

        const fallbackUrl = toAbsoluteUrl(this.serverBaseUrl, playbackData.streamUrl);
        this.disposeHls();
        videoElement.src = fallbackUrl;
        videoElement.load();
        videoElement.play().catch(() => {
          // Autoplay may be blocked by the browser after a fallback source switch.
        });
      });
    }

    disposeHls() {
      if (this.hlsInstance && typeof this.hlsInstance.destroy === "function") {
        this.hlsInstance.destroy();
      }

      this.hlsInstance = null;
    }

    async postJson(path, payload) {
      const response = await this.fetchImpl(toAbsoluteUrl(this.serverBaseUrl, path), {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      return await response.json();
    }

    log(eventName, data) {
      if (this.logger) {
        this.logger(eventName, data);
      }
    }

    sessionKey(name) {
      return `${this.storagePrefix}_${name}`;
    }

    getSession(name) {
      return getStorage(sessionStorage, this.sessionKey(name));
    }

    setSession(name, value) {
      setStorage(sessionStorage, this.sessionKey(name), value);
    }

    localKey(name) {
      return `${this.storagePrefix}_${name}`;
    }

    getDeviceSecret() {
      return getStorage(localStorage, this.localKey("deviceSecret"));
    }

    setDeviceSecret(value) {
      if (value) {
        setStorage(localStorage, this.localKey("deviceSecret"), value);
      }
    }
  }

  function normalizeBaseUrl(value) {
    return String(value).replace(/\/+$/, "");
  }

  function toAbsoluteUrl(baseUrl, value) {
    if (/^https?:\/\//i.test(value)) {
      return value;
    }

    return `${baseUrl}${value.startsWith("/") ? "" : "/"}${value}`;
  }

  function resolveVideoElement(value) {
    if (!value) {
      return null;
    }

    if (typeof value === "string") {
      return document.querySelector(value);
    }

    return value;
  }

  function createFailure(resultCode, message) {
    return {
      success: false,
      statusCode: 0,
      resultCode,
      message,
      data: null
    };
  }

  function detectBrowserFamily() {
    const ua = navigator.userAgent || "";
    const brands = navigator.userAgentData && Array.isArray(navigator.userAgentData.brands)
      ? navigator.userAgentData.brands.map((brand) => brand.brand).join(" ")
      : "";
    const source = `${brands} ${ua}`;

    if (/Edg\//.test(source) || /Microsoft Edge/i.test(source)) {
      return "EDGE";
    }

    if (/Firefox\//i.test(source)) {
      return "FIREFOX";
    }

    if (/OPR\//.test(source) || /Opera/i.test(source)) {
      return "OPERA";
    }

    if (/SamsungBrowser\//i.test(source)) {
      return "SAMSUNG_INTERNET";
    }

    if (/Chrome\//.test(source) || /Chromium/i.test(source)) {
      return "CHROME";
    }

    if (/Safari\//.test(source) && /Version\//.test(source)) {
      return "SAFARI";
    }

    return "UNKNOWN_BROWSER";
  }

  function createUuid() {
    if (global.crypto && typeof global.crypto.randomUUID === "function") {
      return global.crypto.randomUUID();
    }

    return `browser-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  async function sha256(text) {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    if (!global.crypto || !global.crypto.subtle) {
      return sha256Fallback(data);
    }

    const hashBuffer = await global.crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((value) => value.toString(16).padStart(2, "0")).join("");
  }

  function sha256Fallback(data) {
    const words = [];
    const bitLength = data.length * 8;
    for (let i = 0; i < data.length; i += 1) {
      words[i >> 2] = (words[i >> 2] || 0) | (data[i] << (24 - (i % 4) * 8));
    }
    words[bitLength >> 5] = (words[bitLength >> 5] || 0) | (0x80 << (24 - bitLength % 32));
    words[((bitLength + 64 >> 9) << 4) + 15] = bitLength;

    const k = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];
    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    const w = new Array(64);

    for (let i = 0; i < words.length; i += 16) {
      for (let t = 0; t < 64; t += 1) {
        if (t < 16) {
          w[t] = words[i + t] || 0;
        } else {
          const s0 = rightRotate(w[t - 15], 7) ^ rightRotate(w[t - 15], 18) ^ (w[t - 15] >>> 3);
          const s1 = rightRotate(w[t - 2], 17) ^ rightRotate(w[t - 2], 19) ^ (w[t - 2] >>> 10);
          w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
        }
      }

      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let t = 0; t < 64; t += 1) {
        const s1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
        const ch = (e & f) ^ (~e & g);
        const temp1 = (h + s1 + ch + k[t] + w[t]) | 0;
        const s0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (s0 + maj) | 0;
        h = g; g = f; f = e; e = (d + temp1) | 0;
        d = c; c = b; b = a; a = (temp1 + temp2) | 0;
      }

      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
      h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
    }

    return [h0, h1, h2, h3, h4, h5, h6, h7]
      .map((value) => (value >>> 0).toString(16).padStart(8, "0"))
      .join("");
  }

  function rightRotate(value, shift) {
    return (value >>> shift) | (value << (32 - shift));
  }

  function getStorage(storage, key) {
    try {
      return storage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  function setStorage(storage, key, value) {
    try {
      storage.setItem(key, value);
    } catch (_) {
      // Storage can be disabled in some embedded browsers.
    }
  }

  function removeStorage(storage, key) {
    try {
      storage.removeItem(key);
    } catch (_) {
      // Storage can be disabled in some embedded browsers.
    }
  }

  global.KlcubeLicensePlayer = KlcubeLicensePlayer;
  global.KlcubeLicenseError = KlcubeLicenseError;
})(window);
