(() => {
  const $ = (id) => document.getElementById(id);
  const comboEl = $("combo");
  const modelEl = $("model");
  const menuEl = $("model-list");
  const textEl = $("text");
  const specialEl = $("special");
  const showIdsEl = $("show-ids");
  const statusEl = $("status");
  const loadBtn = $("load");
  const tokensEl = $("tokens");
  const tokensNote = $("tokens-note");
  const MAX_RENDER = 4000;
  const nf = new Intl.NumberFormat("en-US");
  const REPO_RE = /^[A-Za-z0-9][\w.\-]*\/[\w.\-]+$/;

  let seq = 0;
  let last = null;
  let current = "";      // last successfully loaded model
  let cached = [];       // models in the cache
  let options = [];      // rendered menu options
  let active = -1;
  let filtering = false; // true once the user types into the field
  let debounce;

  function normalize(raw) {
    let v = raw.trim().replace(/^(https?:\/\/)?(www\.)?(huggingface\.co|hf\.co)\//, "");
    v = v.split(/[?#]/)[0].replace(/^\/+|\/+$/g, "");
    return v.split("/").slice(0, 2).join("/");
  }

  // ================================================================ engines
  // Server engine: the local FastAPI backend (Python `tokenizers`, HF_TOKEN support).
  const serverEngine = {
    name: "server",
    note: "Running with the local server — tokenizer.json files are cached in the .cache folder.",
    async tokenize(model, text, special) {
      const res = await fetch("api/tokenize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, text, add_special_tokens: special }),
      });
      const data = await res.json().catch(() => ({ error: `Server error (${res.status})` }));
      if (!res.ok) {
        throw new Error(data.error || (data.detail && JSON.stringify(data.detail)) || res.statusText);
      }
      return data;
    },
    async list() {
      return (await (await fetch("api/cache")).json()).models;
    },
    async evict(model) {
      await fetch("api/cache/" + model, { method: "DELETE" });
    },
  };

  // Browser engine: used on static hosting (GitHub Pages). Fetches tokenizer.json
  // straight from Hugging Face and keeps it in the browser's Cache Storage.
  function makeBrowserEngine() {
    const LIB = "https://cdn.jsdelivr.net/npm/@huggingface/tokenizers@0.2.0/dist/tokenizers.min.mjs";
    const HF = "https://huggingface.co";
    const CACHE = "tokenmeter-v1";
    const FILE = "tokenizer.json";
    const memory = new Map();
    let libPromise;
    const lib = () => (libPromise ??= import(LIB));
    const fileUrl = (m) => `${HF}/${m}/resolve/main/${FILE}`;
    const openCache = async () => {
      try { return "caches" in self ? await caches.open(CACHE) : null; } catch { return null; }
    };

    async function explain(model, status) {
      try {
        const r = await fetch(`${HF}/api/models/${model}`);
        if (r.ok) {
          const info = await r.json();
          if (info.gated) {
            return `'${model}' is a gated model. Gated models need the local server with HF_TOKEN (see the README on GitHub).`;
          }
          return `'${model}' has no tokenizer.json (this model is not supported).`;
        }
      } catch {}
      if (status === 401 || status === 404) {
        return `'${model}' was not found. Check the name; private repos need the local server with HF_TOKEN.`;
      }
      return `Could not download tokenizer.json from Hugging Face (HTTP ${status}).`;
    }

    async function loadJson(model) {
      const cache = await openCache();
      const url = fileUrl(model);
      const hit = cache && (await cache.match(url));
      if (hit) return [await hit.json(), true];
      let res;
      try {
        res = await fetch(url);
      } catch (err) {
        throw new Error("Could not reach Hugging Face: " + err.message);
      }
      if (!res.ok) throw new Error(await explain(model, res.status));
      const body = await res.text();
      if (cache) {
        try {
          await cache.put(url, new Response(body, { headers: { "Content-Type": "application/json" } }));
        } catch {}
      }
      return [JSON.parse(body), false];
    }

    // Text for each token, for the token view. Byte-level tokens that split a
    // character are grouped so they show the whole character (like the server's offsets).
    function pieces(tok, enc, limit) {
      const out = [];
      const n = Math.min(enc.ids.length, limit);
      let group = [];
      for (let i = 0; i < n; i++) {
        group.push(i);
        let text = tok.decode(group.map((j) => enc.ids[j]), { skip_special_tokens: false });
        if (text.includes("�") && group.length < 4 && i < n - 1) continue;
        const raw = enc.tokens[group[0]] || "";
        if (/^[▁Ġ]/.test(raw) && !/^\s/.test(text)) text = " " + text;
        for (let k = 0; k < group.length; k++) out.push(text);
        group = [];
      }
      return out;
    }

    return {
      name: "browser",
      note: "Running in your browser — tokenizer.json files are fetched from Hugging Face and cached in this browser. Gated models need the local server.",
      async tokenize(rawModel, text, special) {
        const model = normalize(rawModel);
        if (!REPO_RE.test(model)) {
          throw new Error("Invalid model name. Use the 'owner/model' format, e.g. google/gemma-4-31B-it.");
        }
        let tok = memory.get(model);
        let fromCache = true;
        if (!tok) {
          const [{ Tokenizer }, [json, hit]] = await Promise.all([lib(), loadJson(model)]);
          try {
            tok = new Tokenizer(json, {});
          } catch (err) {
            throw new Error("Could not read tokenizer.json: " + err.message);
          }
          memory.set(model, tok);
          fromCache = hit;
        }
        const enc = tok.encode(text, { add_special_tokens: special });
        return {
          model,
          token_count: enc.ids.length,
          char_count: [...text].length,
          tokens: pieces(tok, enc, MAX_RENDER),
          ids: enc.ids,
          cached: fromCache,
        };
      },
      async list() {
        const models = new Set(memory.keys());
        const cache = await openCache();
        if (cache) {
          for (const req of await cache.keys()) {
            const m = new URL(req.url).pathname.match(/^\/(.+?\/.+?)\/resolve\/main\/tokenizer\.json$/);
            if (m) models.add(decodeURIComponent(m[1]));
          }
        }
        return [...models].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      },
      async evict(model) {
        memory.delete(model);
        const cache = await openCache();
        if (cache) await cache.delete(fileUrl(model));
      },
    };
  }

  async function detectEngine() {
    const forced = new URLSearchParams(location.search).get("mode");
    if (forced === "browser") return makeBrowserEngine();
    try {
      const r = await fetch("api/cache");
      if (r.ok && (r.headers.get("content-type") || "").includes("json")) return serverEngine;
    } catch {}
    return makeBrowserEngine();
  }

  const engineReady = detectEngine().then((engine) => {
    $("mode-note").textContent = engine.note;
    document.body.dataset.mode = engine.name;
    return engine;
  });

  // ---------------------------------------------------------------- status
  function setStatus(msg, kind = "") {
    statusEl.textContent = msg;
    statusEl.className = "status" + (kind ? " " + kind : "");
  }

  // ---------------------------------------------------------------- tokenize
  async function run({ announce = false } = {}) {
    const model = normalize(modelEl.value);
    $("char-count").textContent = nf.format([...textEl.value].length);
    if (!model) return;
    const id = ++seq;
    loadBtn.disabled = true;
    if (announce) {
      const isCached = cached.some((m) => m.toLowerCase() === model.toLowerCase());
      setStatus(isCached ? `Loading ${model}…` : `Downloading tokenizer.json for ${model}…`);
    }
    try {
      const engine = await engineReady;
      const data = await engine.tokenize(model, textEl.value, specialEl.checked);
      if (id !== seq) return; // a newer request is in flight
      last = data;
      current = data.model;
      modelEl.value = data.model;
      setStatus(
        `${data.model} · ${data.cached ? "from cache" : "downloaded from Hugging Face and cached"}`,
        "ok",
      );
      render();
      if (!data.cached) refreshCache();
      try { localStorage.setItem("tm:model", data.model); } catch {}
    } catch (err) {
      if (id !== seq) return;
      setStatus(err.message || String(err), "error");
      renderEmpty();
    } finally {
      if (id === seq) loadBtn.disabled = false;
    }
  }

  function renderEmpty() {
    last = null;
    $("token-count").textContent = "–";
    $("ratio").textContent = "–";
    tokensEl.replaceChildren();
    tokensNote.hidden = true;
  }

  function visible(piece) {
    const frag = document.createDocumentFragment();
    for (const part of piece.split(/(\n| |\t)/)) {
      if (!part) continue;
      if (part === "\n" || part === " " || part === "\t") {
        const s = document.createElement("span");
        s.className = "ws";
        s.textContent = part === "\n" ? "↵\n" : part === "\t" ? "→" : "·";
        frag.append(s);
      } else {
        frag.append(part);
      }
    }
    return frag;
  }

  function render() {
    if (!last) return;
    const { token_count, char_count, tokens, ids } = last;
    $("token-count").textContent = nf.format(token_count);
    $("char-count").textContent = nf.format(char_count);
    $("ratio").textContent = token_count ? (char_count / token_count).toFixed(2) : "–";

    const showIds = showIdsEl.checked;
    const frag = document.createDocumentFragment();
    const n = Math.min(tokens.length, MAX_RENDER);
    for (let i = 0; i < n; i++) {
      const span = document.createElement("span");
      span.className = "tok";
      span.title = `#${i} · id ${ids[i]}`;
      span.append(visible(tokens[i]));
      if (showIds) {
        const sub = document.createElement("sub");
        sub.textContent = ids[i];
        span.append(sub);
      }
      frag.append(span);
    }
    tokensEl.replaceChildren(frag);
    if (!token_count) {
      const m = document.createElement("span");
      m.className = "muted";
      m.textContent = "Text is empty.";
      tokensEl.append(m);
    }
    tokensNote.hidden = token_count <= MAX_RENDER;
    tokensNote.textContent = `Showing the first ${nf.format(MAX_RENDER)} tokens for performance; the count covers the full text.`;
  }

  // ------------------------------------------------------------ model menu
  async function refreshCache() {
    try {
      cached = await (await engineReady).list();
    } catch {
      cached = [];
    }
    if (!menuEl.hidden) buildMenu();
  }

  function highlight(name, q) {
    const frag = document.createDocumentFragment();
    const i = q ? name.toLowerCase().indexOf(q.toLowerCase()) : -1;
    if (i < 0) { frag.append(name); return frag; }
    const mark = document.createElement("mark");
    mark.textContent = name.slice(i, i + q.length);
    frag.append(name.slice(0, i), mark, name.slice(i + q.length));
    return frag;
  }

  function buildMenu() {
    const raw = modelEl.value.trim();
    const q = filtering ? raw : "";
    const norm = normalize(raw);
    const needle = (normalize(q) || q).toLowerCase();
    const matches = cached.filter((m) => !q || m.toLowerCase().includes(needle));
    const exact = cached.some((m) => m.toLowerCase() === norm.toLowerCase());

    options = [];
    menuEl.replaceChildren();

    // "New model" option
    const canLoadNew = filtering && norm.includes("/") && !exact;
    options.push({ type: "new", value: canLoadNew ? norm : "" });
    const li = document.createElement("li");
    li.className = "opt new";
    li.setAttribute("role", "option");
    const plus = document.createElement("span");
    plus.className = "plus";
    plus.textContent = "+";
    const label = document.createElement("span");
    label.className = "name";
    const hint = document.createElement("span");
    hint.className = "hint";
    if (canLoadNew) {
      label.append(`New: load “${norm}”`);
      hint.textContent = " from Hugging Face";
    } else {
      label.append("New model");
      hint.textContent = " — type or paste a name like owner/model";
    }
    label.append(hint);
    li.append(plus, label);
    menuEl.append(li);

    // Cached models
    const head = document.createElement("li");
    head.className = "menu-head";
    head.setAttribute("role", "presentation");
    head.textContent = `Cached models (${cached.length})`;
    menuEl.append(head);

    if (!matches.length) {
      const empty = document.createElement("li");
      empty.className = "menu-empty";
      empty.setAttribute("role", "presentation");
      empty.textContent = cached.length ? "No cached model matches your search." : "Nothing cached yet.";
      menuEl.append(empty);
    }

    for (const m of matches) {
      options.push({ type: "model", value: m });
      const item = document.createElement("li");
      item.className = "opt" + (m === current ? " current" : "");
      item.setAttribute("role", "option");
      const name = document.createElement("span");
      name.className = "name";
      name.append(highlight(m, q));
      item.append(name);
      if (m === current) {
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = "in use";
        item.append(tag);
      }
      const x = document.createElement("button");
      x.className = "x";
      x.type = "button";
      x.textContent = "×";
      x.title = "Remove from cache";
      x.setAttribute("aria-label", `Remove ${m} from cache`);
      x.addEventListener("mousedown", (e) => e.preventDefault());
      x.addEventListener("click", async (e) => {
        e.stopPropagation();
        await (await engineReady).evict(m);
        await refreshCache();
        modelEl.focus();
      });
      item.append(x);
      menuEl.append(item);
    }

    // Default highlight
    if (filtering) active = matches.length && !canLoadNew ? 1 : 0;
    else active = Math.max(0, options.findIndex((o) => o.value === current));
    paintActive();
  }

  function optionEls() {
    return [...menuEl.querySelectorAll(".opt")];
  }

  function paintActive() {
    optionEls().forEach((el, i) => {
      el.classList.toggle("active", i === active);
      el.setAttribute("aria-selected", i === active ? "true" : "false");
      el.onmouseenter = () => { active = i; paintActive(); };
      el.onmousedown = (e) => e.preventDefault();
      el.onclick = () => choose(i);
    });
    optionEls()[active]?.scrollIntoView({ block: "nearest" });
  }

  function openMenu() {
    if (!menuEl.hidden) return;
    menuEl.hidden = false;
    comboEl.classList.add("open");
    modelEl.setAttribute("aria-expanded", "true");
    buildMenu();
  }

  function closeMenu() {
    menuEl.hidden = true;
    comboEl.classList.remove("open");
    modelEl.setAttribute("aria-expanded", "false");
    filtering = false;
  }

  function choose(i) {
    const opt = options[i];
    if (!opt) return;
    if (opt.type === "new" && !opt.value) {
      // "New model" without a full owner/model name: clear the field (unless they
      // are mid-typing) so they can paste a name
      if (!filtering) modelEl.value = "";
      filtering = true;
      buildMenu();
      modelEl.focus();
      setStatus("Type or paste a Hugging Face model name, then press Enter.");
      return;
    }
    modelEl.value = opt.value;
    closeMenu();
    run({ announce: true });
  }

  modelEl.addEventListener("focus", openMenu);
  modelEl.addEventListener("click", openMenu);
  modelEl.addEventListener("input", () => {
    filtering = true;
    if (menuEl.hidden) openMenu();
    else buildMenu();
  });
  modelEl.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (menuEl.hidden) return openMenu();
      const n = options.length;
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
      paintActive();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!menuEl.hidden && active >= 0) choose(active);
      else { closeMenu(); run({ announce: true }); }
    } else if (e.key === "Escape") {
      if (!menuEl.hidden) {
        e.preventDefault();
        closeMenu();
        if (current) modelEl.value = current;
      }
    }
  });
  modelEl.addEventListener("blur", closeMenu);

  // ---------------------------------------------------------------- wiring
  const schedule = (ms = 250) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => run(), ms);
  };

  loadBtn.onclick = () => { closeMenu(); run({ announce: true }); };
  textEl.addEventListener("input", () => schedule());
  specialEl.addEventListener("change", () => run());
  showIdsEl.addEventListener("change", render);

  try { modelEl.value = localStorage.getItem("tm:model") || ""; } catch {}
  refreshCache();
  if (modelEl.value) run({ announce: true });
})();
