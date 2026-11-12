/*
 * GitHub Stats Card
 *
 * Shows how often the files of GitHub releases were downloaded, like
 * somsubhra.github.io/github-release-stats. Repositories set in the card
 * options stay on the card; the search bar on top looks up any other one
 * (owner/repo, a GitHub link or a user name for a list of their repos).
 *
 * Below the downloads, each repository can show stars, forks, open issues,
 * commits, the last push and a bar chart of the commits of the last 12 weeks.
 *
 * "Heute" compares the current totals with the last count taken before
 * midnight. GitHub only reports totals, so the card notes the totals each
 * time it loads and keeps one count per day for 31 days, stored per Home
 * Assistant user (frontend user data) so all devices share it.
 *
 * Optional traffic (views, clones, referrers, popular pages) comes from a
 * Home Assistant sensor with the attribute github_traffic: true, filled with
 * a GitHub token on the Home Assistant side, so the token never reaches the
 * browser. The wiki section lists the latest wiki edits from the public
 * events of the repository.
 *
 * Data comes straight from the public GitHub API in the browser. Answers are
 * cached per repository and revalidated with ETags, so a reload within the
 * refresh time costs no API quota (60 requests per hour without a token).
 */
const CARD_VERSION = "1.4.2";
const API = "https://api.github.com";
const CACHE_PREFIX = "grs-card:";
const HISTORY_KEY = "github-release-stats-card-history";
const HISTORY_DAYS = 31;

const DEFAULTS = {
  title: "GitHub Stats",
  repositories: [],
  releases: 5,
  refresh: 60,
  layout: "classic",
  show_search: true,
  hide_empty: false,
  show_details: true,
  show_activity: true,
  show_traffic: true,
  show_wiki: false,
  traffic_days: 30,
};

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const number = (value) => new Intl.NumberFormat("de-DE").format(value || 0);

const shortNumber = (value) => {
  if (value >= 1e6) return `${(value / 1e6).toFixed(1).replace(".", ",")} Mio.`;
  if (value >= 1e4) return `${Math.round(value / 1e3)} Tsd.`;
  return number(value);
};

const size = (bytes) => {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1).replace(".", ",")} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
};

/** Clean markdown release body into a concise plain text excerpt with linebreaks. */
export const cleanExcerpt = (text, maxLength = 320) => {
  if (!text) return "";
  let clean = String(text)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/^#+\s*(.*)$/gm, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (clean.length > maxLength) {
    const cut = clean.slice(0, maxLength);
    const lastSpace = cut.lastIndexOf(" ");
    clean = (lastSpace > maxLength * 0.7 ? cut.slice(0, lastSpace) : cut).trim().replace(/[,;:.!?•\s]+$/, "") + " …";
  }
  return clean;
};

/** "vor 3 Tagen" for an ISO date. */
export const ago = (iso, now = Date.now()) => {
  if (!iso) return "–";
  const sec = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  const steps = [
    [60, "gerade eben", null],
    [3600, "Min.", 60],
    [86400, "Std.", 3600],
    [86400 * 30, ["Tag", "Tagen"], 86400],
    [86400 * 365, ["Monat", "Monaten"], 86400 * 30],
    [Infinity, ["Jahr", "Jahren"], 86400 * 365],
  ];
  for (const [limit, unit, div] of steps) {
    if (sec < limit) {
      if (!div) return unit;
      const n = Math.floor(sec / div);
      const word = Array.isArray(unit) ? unit[n === 1 ? 0 : 1] : unit;
      return `vor ${n} ${word}`;
    }
  }
  return "–";
};

/** Total commits from the Link header of a per_page=1 commit list. */
export const commitCount = (link, pageLength) => {
  const match = /[?&]page=(\d+)[^>]*>;\s*rel="last"/.exec(link || "");
  return match ? Number(match[1]) : pageLength;
};

const date = (iso) => (iso ? new Date(iso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }) : "–");

/** Local calendar day as "YYYY-MM-DD". */
export const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const time = (ts) => new Date(ts).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });

/**
 * Smooth cubic bezier spline for activity charts.
 * Given values, returns linePath, areaPath and scaled points.
 */
export const computeSpline = (values, width = 320, height = 70, padding = 8) => {
  if (!values || !values.length) return { linePath: "", areaPath: "", points: [] };
  const max = Math.max(1, ...values);
  const n = values.length;
  const usableH = height - 2 * padding;
  const points = values.map((v, i) => {
    const x = Math.round(i * (width / Math.max(1, n - 1)));
    const y = Math.round(height - padding - (v / max) * usableH);
    return [x, y];
  });
  if (points.length === 1) {
    return {
      linePath: `M 0,${points[0][1]} L ${width},${points[0][1]}`,
      areaPath: `M 0,${points[0][1]} L ${width},${points[0][1]} L ${width},${height} L 0,${height} Z`,
      points,
    };
  }
  let line = `M ${points[0][0]},${points[0][1]}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i === 0 ? i : i - 1];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
    line += ` C ${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[0 + 1] ? p2[1].toFixed(1) : p2[1].toFixed(1)}`;
  }
  const lastX = points[points.length - 1][0];
  const firstX = points[0][0];
  const area = `${line} L ${lastX},${height} L ${firstX},${height} Z`;
  return { linePath: line, areaPath: area, points };
};

/**
 * Note a count in a repo's history: per day the first and the last count,
 * each as [timestamp, total, { tag: downloads }]. Returns a new object.
 */
export const recordCount = (history, summary, now = Date.now()) => {
  // `now` is when GitHub gave the numbers, a cached answer keeps its old time
  const day = dayKey(now);
  const point = [now, summary.total, Object.fromEntries(summary.releases.map((r) => [r.tag, r.downloads]))];
  const days = { ...(history || {}) };
  const old = days[day];
  days[day] = {
    first: old?.first && old.first[0] <= now ? old.first : point,
    last: old?.last && old.last[0] > now ? old.last : point,
  };
  const keep = Object.keys(days).sort().slice(-HISTORY_DAYS);
  return Object.fromEntries(keep.map((k) => [k, days[k]]));
};

/**
 * Downloads today: current totals minus the last count of an earlier day,
 * or the first count today when there is none. `since` is when that base
 * count was taken; `exact` means it was taken late enough yesterday.
 */
export const countToday = (history, summary, now = Date.now()) => {
  if (!history) return null;
  const today = dayKey(now);
  const earlier = Object.keys(history).filter((k) => k < today).sort();
  const base = earlier.length ? history[earlier[earlier.length - 1]].last : history[today]?.first;
  if (!base) return null;
  const [since, total, tags] = base;
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  const releases = {};
  for (const r of summary.releases) {
    const diff = r.downloads - (tags[r.tag] ?? 0);
    if (diff > 0) releases[r.tag] = diff;
  }
  return {
    total: Math.max(0, summary.total - total),
    releases,
    since,
    exact: since <= midnight && midnight - since <= 2 * 3600000,
    fromToday: since >= midnight,
  };
};

/**
 * A readable name for a popular page. GitHub sends titles like
 * "/wiki/Listenkarte" or "Overview" (older answers: "Home · owner/repo Wiki
 * · GitHub"), so the name mostly comes from the path.
 */
const PAGE_NAMES = { releases: "Releases", issues: "Issues", pulls: "Pull Requests", pulse: "Pulse", branches: "Branches", tags: "Tags", commits: "Commits", actions: "Actions", discussions: "Diskussionen", "graphs/traffic": "Traffic", stargazers: "Sterne", forks: "Forks" };
export const pageTitle = (title, path) => {
  const rel = String(path || "").split("/").filter(Boolean).slice(2).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch (err) {
      return p;
    }
  });
  const t = String(title || "").trim();
  if (!rel.length) return "Repository-Startseite";
  if (rel[0] === "wiki") return rel.length === 1 ? "Wiki-Startseite" : rel.slice(1).join("/").replace(/-/g, " ");
  if (t && !t.startsWith("/") && t !== "Overview") return t.split(" · ")[0].trim() || t;
  if ((rel[0] === "blob" || rel[0] === "tree") && rel.length > 2) return rel.slice(2).join("/");
  const joined = rel.join("/");
  return PAGE_NAMES[joined] || PAGE_NAMES[rel[0]] || joined;
};

/**
 * Wiki edits from slim repository events ({ t, actor, pages }): the pages
 * newest first with their last change, the time of the last edit and the
 * number of page edits in the last 30 days.
 */
export const wikiSummary = (events, now = Date.now()) => {
  const edits = [];
  for (const e of events || []) {
    if (!e || !Array.isArray(e.pages)) continue;
    for (const p of e.pages) edits.push({ t: e.t, actor: e.actor, title: p.title, action: p.action, url: p.url });
  }
  edits.sort((a, b) => new Date(b.t) - new Date(a.t));
  const seen = new Map();
  for (const e of edits) if (!seen.has(e.title)) seen.set(e.title, e);
  return {
    pages: [...seen.values()],
    last: edits[0]?.t || null,
    edits30: edits.filter((e) => now - new Date(e.t).getTime() <= 30 * 86400000).length,
    created: [...seen.values()].filter((e) => e.action === "created").length,
  };
};

/** UTC calendar day as "YYYY-MM-DD", like the days GitHub reports traffic for. */
const utcDay = (ts) => new Date(ts).toISOString().slice(0, 10);

/**
 * The last `days` days of a traffic history ({ day: [views, visitors,
 * clones, unique clones] }), missing days as zero, plus their sums and the
 * first day recorded.
 */
export const trafficSeries = (history, days = 30, now = Date.now()) => {
  const h = history && typeof history === "object" ? history : {};
  const list = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = utcDay(now - i * 86400000);
    const v = Array.isArray(h[day]) ? h[day] : [0, 0, 0, 0];
    list.push({ day, views: v[0] || 0, visitors: v[1] || 0, clones: v[2] || 0, uniqueClones: v[3] || 0 });
  }
  const sum = (k) => list.reduce((a, d) => a + d[k], 0);
  const keys = Object.keys(h).sort();
  return { days: list, views: sum("views"), clones: sum("clones"), first: keys[0] || null };
};

/** Turn "owner/repo", a GitHub link or "owner" into its parts. */
export const parseTarget = (input) => {
  let text = String(input || "").trim();
  text = text.replace(/^https?:\/\/(www\.)?github\.com\//i, "").replace(/^github\.com\//i, "");
  text = text.replace(/\.git$/i, "").replace(/[?#].*$/, "").replace(/\/+$/, "");
  const parts = text.split("/").filter(Boolean);
  const valid = (part) => /^[A-Za-z0-9_.-]{1,100}$/.test(part);
  if (parts.length >= 2 && valid(parts[0]) && valid(parts[1])) return { owner: parts[0], repo: parts[1] };
  if (parts.length === 1 && valid(parts[0])) return { owner: parts[0], repo: null };
  return null;
};

/** Sum up the downloads of a list of releases. */
export const summarize = (releases) => {
  const list = releases
    .filter((r) => !r.draft)
    .map((r) => {
      const assets = (r.assets || []).map((a) => ({ name: a.name, size: a.size, downloads: a.download_count || 0, url: a.browser_download_url }));
      return {
        tag: r.tag_name,
        name: r.name || r.tag_name,
        body: r.body || "",
        url: r.html_url,
        published: r.published_at || r.created_at,
        prerelease: Boolean(r.prerelease),
        assets,
        downloads: assets.reduce((sum, a) => sum + a.downloads, 0),
      };
    });
  const total = list.reduce((sum, r) => sum + r.downloads, 0);
  return {
    releases: list,
    total,
    withAssets: list.filter((r) => r.assets.length).length,
    hasZip: list.some((r) => r.assets.some((a) => /\.zip$/i.test(a.name))),
    max: Math.max(0, ...list.map((r) => r.downloads)),
  };
};

class GithubReleaseStatsCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = { ...DEFAULTS };
    this._data = new Map(); // "owner/repo" -> { state, summary, error, fetched }
    this._details = new Map(); // "owner/repo" -> { info, commits, weeks }
    this._expanded = new Set(); // "owner/repo@tag"
    this._showAll = new Set(); // "owner/repo"
    this._search = null; // { owner, repo } shown above the pinned repos
    this._userRepos = null; // { owner, repos, state, error }
    this._timer = null;
    this._rendered = false;
    this._history = null; // { "owner/repo": { day: { first, last } } }
    this._historyLoad = null;
    this._wiki = new Map(); // "owner/repo" -> { state, summary, error }
    this._trafficIds = new Map(); // "owner/repo" (lower case) -> entity_id or null
    this._trafficLookup = new Map(); // "owner/repo" (lower case) -> last lookup time
    this._trafficSig = "";
  }

  static getStubConfig() {
    return { repositories: ["home-assistant/frontend"], releases: 5 };
  }

  static getConfigForm() {
    return {
      schema: [
        { name: "title", selector: { text: {} } },
        { name: "repositories", selector: { text: { multiple: true } } },
        {
          name: "layout",
          selector: {
            select: {
              mode: "dropdown",
              options: [
                { value: "classic", label: "Klassisch (Bisheriges Design)" },
                { value: "modern", label: "Modern (Venus / Kachel-Design)" },
              ],
            },
          },
        },
        {
          type: "grid",
          name: "",
          schema: [
            { name: "releases", selector: { number: { min: 1, max: 50, mode: "box" } } },
            { name: "refresh", selector: { number: { min: 5, max: 1440, mode: "box", unit_of_measurement: "min" } } },
          ],
        },
        { name: "show_search", selector: { boolean: {} } },
        { name: "show_details", selector: { boolean: {} } },
        { name: "show_activity", selector: { boolean: {} } },
        { name: "show_traffic", selector: { boolean: {} } },
        { name: "traffic_days", selector: { number: { min: 7, max: 90, mode: "box", unit_of_measurement: "Tage" } } },
        { name: "show_wiki", selector: { boolean: {} } },
        { name: "hide_empty", selector: { boolean: {} } },
      ],
      computeLabel: (s) =>
        ({
          title: "Titel",
          repositories: "Repositories (owner/repo oder GitHub-Link)",
          layout: "Karten-Design / Layout",
          releases: "Angezeigte Releases",
          refresh: "Aktualisieren alle",
          show_search: "Suche anzeigen",
          hide_empty: "Releases ohne Dateien ausblenden",
          show_details: "Sterne, Forks, Issues, Commits und letzten Push zeigen",
          show_activity: "Commits der letzten 12 Wochen zeigen",
          show_traffic: "Aufrufe, Clones, Herkunft und beliebte Seiten zeigen",
          traffic_days: "Tage im Traffic-Diagramm",
          show_wiki: "Wiki-Änderungen zeigen",
        })[s.name],
      computeHelper: (s) =>
        ({
          repositories: "Diese Repositories bleiben dauerhaft auf der Karte.",
          layout: "Wähle zwischen dem klassischen Look und dem modernen Venus-Kacheldesign.",
          refresh: "Zwischenspeicher pro Repository. GitHub erlaubt ohne Anmeldung 60 Abfragen pro Stunde.",
          hide_empty: "Nur Dateien in Releases (Assets) zählen Downloads.",
          show_details: "Kostet zwei weitere GitHub-Abfragen pro Repository und Aktualisierung (unverändert: keine).",
          show_traffic: "Braucht einen Sensor in Home Assistant mit Token (siehe README). Ohne Sensor bleibt der Bereich ausgeblendet.",
          show_wiki: "Aus den öffentlichen Ereignissen des Repositories (letzte 90 Tage), eine Abfrage pro Aktualisierung.",
        })[s.name],
    };
  }

  setConfig(config) {
    if (!config || typeof config !== "object") throw new Error("Ungültige Konfiguration");
    const repos = Array.isArray(config.repositories)
      ? config.repositories
      : config.repositories
        ? [config.repositories]
        : config.repository
          ? [config.repository]
          : [];
    const parsed = repos.map(parseTarget);
    const bad = repos.filter((_, i) => !parsed[i] || !parsed[i].repo);
    if (bad.length) throw new Error(`Kein gültiges Repository: ${bad.join(", ")} (erwartet owner/repo)`);
    this._config = {
      ...DEFAULTS,
      ...config,
      repositories: parsed.map((p) => `${p.owner}/${p.repo}`),
      releases: Math.max(1, Number(config.releases) || DEFAULTS.releases),
      refresh: Math.max(5, Number(config.refresh) || DEFAULTS.refresh),
      layout: config.layout === "modern" ? "modern" : "classic",
      traffic_days: Math.min(90, Math.max(7, Number(config.traffic_days) || DEFAULTS.traffic_days)),
    };
    this._trafficIds.clear();
    this._trafficSig = "";
    if (this.isConnected) {
      this._render();
      this._loadAll();
    }
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._rendered) {
      this._render();
      this._loadAll();
      return;
    }
    // Redraw when a traffic sensor got new numbers
    const sig = this._trafficSignature();
    if (sig !== this._trafficSig) {
      this._trafficSig = sig;
      this._renderBody();
    }
  }

  connectedCallback() {
    if (this._rendered) this._loadAll();
    clearInterval(this._timer);
    this._timer = setInterval(() => this._loadAll(), this._config.refresh * 60000);
  }

  disconnectedCallback() {
    clearInterval(this._timer);
    this._timer = null;
  }

  getCardSize() {
    return 2 + this._config.repositories.length * 4;
  }

  getGridOptions() {
    return { columns: 12, min_columns: 6, rows: "auto" };
  }

  // --- Data ---

  _readCache(key) {
    try {
      return JSON.parse(localStorage.getItem(CACHE_PREFIX + key) || "null");
    } catch (err) {
      return null;
    }
  }

  _writeCache(key, value) {
    try {
      localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(value));
    } catch (err) {
      // Storage full or blocked: the card still works, it only asks GitHub more often
    }
  }

  /**
   * GET a JSON list from GitHub, following pages. Each page is cached with its
   * ETag; an unchanged page answers 304, which costs no API quota.
   */
  async _fetchList(path, maxPages = 10, force = false, slim = (items) => items) {
    const cached = this._readCache(path);
    const pagesOk = cached && Array.isArray(cached.pages);
    // Releases cached before v1.3.1 lack the body; other lists have none
    const hasBodyField = !pagesOk || !path.includes("/releases") || cached.pages.every((p) => p.every((r) => r.body !== undefined));
    if (pagesOk && !force && hasBodyField && Date.now() - cached.time < this._config.refresh * 60000) {
      const items = cached.pages.flat();
      items.fetched = cached.time; // when GitHub gave these numbers
      return items;
    }
    const pages = [];
    for (let page = 1; page <= maxPages; page++) {
      const headers = { Accept: "application/vnd.github+json" };
      const old = pagesOk && hasBodyField ? cached.pages[page - 1] : null;
      const oldTag = pagesOk && hasBodyField ? cached.etags[page - 1] : null;
      if (old && oldTag) headers["If-None-Match"] = oldTag;
      const sep = path.includes("?") ? "&" : "?";
      const res = await fetch(`${API}${path}${sep}per_page=100&page=${page}`, { headers });
      let items;
      let etag;
      if (res.status === 304 && old) {
        items = old;
        etag = oldTag;
      } else if (res.ok) {
        items = slim(await res.json());
        etag = res.headers.get("ETag") || "";
      } else {
        throw await this._apiError(res);
      }
      pages.push({ items, etag });
      if (items.length < 100) break;
    }
    const time = Date.now();
    this._writeCache(path, { time, etags: pages.map((p) => p.etag), pages: pages.map((p) => p.items) });
    const items = pages.flatMap((p) => p.items);
    items.fetched = time;
    return items;
  }

  /**
   * GET one JSON answer with ETag revalidation. `read` turns the response into
   * what is cached. A 202 (GitHub still computing statistics) gives null.
   */
  async _fetchJson(path, read, force = false) {
    const cached = this._readCache(path);
    if (cached && "data" in cached && !force && Date.now() - cached.time < this._config.refresh * 60000) return cached.data;
    const headers = { Accept: "application/vnd.github+json" };
    if (cached && cached.etag) headers["If-None-Match"] = cached.etag;
    const res = await fetch(`${API}${path}`, { headers });
    if (res.status === 304 && cached) {
      this._writeCache(path, { ...cached, time: Date.now() });
      return cached.data;
    }
    if (res.status === 202) return null;
    if (!res.ok) throw await this._apiError(res);
    const data = await read(await res.json(), res);
    this._writeCache(path, { time: Date.now(), etag: res.headers.get("ETag") || "", data });
    return data;
  }

  async _apiError(res) {
    if ((res.status === 403 || res.status === 429) && res.headers.get("X-RateLimit-Remaining") === "0") {
      const reset = Number(res.headers.get("X-RateLimit-Reset")) * 1000;
      const time = reset ? new Date(reset).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) : "später";
      return new Error(`GitHub-Abfragelimit erreicht, wieder ab ${time} Uhr`);
    }
    if (res.status === 404) return new Error("Nicht gefunden oder privat");
    return new Error(`GitHub antwortet mit ${res.status}`);
  }

  /** The count history, from the Home Assistant user data or else localStorage. */
  _loadHistory() {
    if (!this._historyLoad) {
      this._historyLoad = (async () => {
        let value = null;
        if (this._hass?.connection) {
          try {
            value = (await this._hass.callWS({ type: "frontend/get_user_data", key: HISTORY_KEY }))?.value;
          } catch (err) {
            value = null;
          }
        }
        this._history = value || this._readCache(HISTORY_KEY) || {};
      })();
    }
    return this._historyLoad;
  }

  async _noteCount(key, summary, fetched = Date.now()) {
    await this._loadHistory();
    this._history = { ...this._history, [key]: recordCount(this._history[key], summary, fetched) };
    this._writeCache(HISTORY_KEY, this._history);
    if (this._hass?.connection) {
      this._hass.callWS({ type: "frontend/set_user_data", key: HISTORY_KEY, value: this._history }).catch(() => {
        // Kept in localStorage; the next load tries again
      });
    }
  }

  /** Only the releases a card needs: trim what is kept in localStorage. */
  _slimReleases(list) {
    return list.map((r) => ({
      tag_name: r.tag_name,
      name: r.name || "",
      body: cleanExcerpt(r.body, 320),
      html_url: r.html_url,
      published_at: r.published_at,
      created_at: r.created_at,
      draft: r.draft,
      prerelease: r.prerelease,
      assets: (r.assets || []).map((a) => ({ name: a.name, size: a.size, download_count: a.download_count, browser_download_url: a.browser_download_url })),
    }));
  }

  async _loadRepo(key, force = false) {
    const entry = this._data.get(key) || {};
    if (entry.state === "loading") return;
    this._data.set(key, { ...entry, state: "loading" });
    this._renderBody();
    try {
      const releases = await this._fetchList(`/repos/${key}/releases`, 10, force, (list) => this._slimReleases(list));
      const summary = summarize(releases);
      this._data.set(key, { state: "ok", summary, fetched: Date.now() });
      // Only pinned repos get a history, a search shows the totals
      if (this._config.repositories.includes(key)) await this._noteCount(key, summary, releases.fetched);
    } catch (err) {
      this._data.set(key, { ...entry, state: "error", error: err.message || String(err) });
    }
    this._renderBody();
  }

  /** Stars, forks, commits and activity; failures only leave them out. */
  async _loadDetails(key, force = false, attempt = 0) {
    const want = this._config.show_details || this._config.show_activity;
    if (!want) return;
    const current = this._details.get(key) || {};
    if (current.loading && !attempt) return;
    this._details.set(key, { ...current, loading: true });
    const jobs = [];
    if (this._config.show_details) {
      jobs.push(
        this._fetchJson(`/repos/${key}`, (r) => ({
          stars: r.stargazers_count,
          forks: r.forks_count,
          issues: r.open_issues_count,
          watchers: r.subscribers_count,
          pushed: r.pushed_at,
          archived: r.archived,
          description: r.description,
        }), force).then((info) => ({ info }), () => ({})),
        this._fetchJson(`/repos/${key}/commits?per_page=1`, (list, res) => commitCount(res.headers.get("Link"), list.length), force).then(
          (commits) => ({ commits }),
          () => ({})
        )
      );
    }
    if (this._config.show_activity) {
      jobs.push(
        this._fetchJson(`/repos/${key}/stats/participation`, (p) => (Array.isArray(p.all) ? p.all : null), force).then(
          (weeks) => ({ weeks, pending: weeks === null }),
          () => ({})
        )
      );
    }
    const parts = await Promise.all(jobs);
    const merged = Object.assign({}, current, ...parts, { loading: false });
    this._details.set(key, merged);
    this._renderBody();
    // GitHub computes the weekly numbers on first request; ask again shortly
    if (merged.pending && attempt < 3) {
      setTimeout(() => this._loadDetails(key, true, attempt + 1), 4000 * (attempt + 1));
    }
  }

  // --- Traffic (Home Assistant sensor) and wiki ---

  /** The Home Assistant sensor holding the traffic of a repository, if any. */
  _trafficEntity(key) {
    if (!this._config.show_traffic || !this._hass?.states) return null;
    const k = key.toLowerCase();
    const id = this._trafficIds.get(k);
    if (id && this._hass.states[id]) return this._hass.states[id];
    const now = Date.now();
    if (id === null && now - (this._trafficLookup.get(k) || 0) < 60000) return null;
    const found = Object.values(this._hass.states).find(
      (s) => s.attributes?.github_traffic === true && String(s.attributes.repository || "").toLowerCase() === k
    );
    this._trafficIds.set(k, found ? found.entity_id : null);
    this._trafficLookup.set(k, now);
    return found || null;
  }

  _trafficSignature() {
    if (!this._config.show_traffic) return "";
    const keys = [...this._config.repositories];
    if (this._search?.repo) keys.push(`${this._search.owner}/${this._search.repo}`);
    return keys.map((k) => this._trafficEntity(k)?.last_updated || "").join("|");
  }

  async _loadWiki(key, force = false) {
    if (!this._config.show_wiki) return;
    const entry = this._wiki.get(key) || {};
    if (entry.state === "loading") return;
    this._wiki.set(key, { ...entry, state: "loading" });
    try {
      // Up to 300 events (about 90 days); other events stay as placeholders so paging works
      const events = await this._fetchList(`/repos/${key}/events`, 3, force, (list) =>
        list.map((e) =>
          e.type === "GollumEvent"
            ? {
                t: e.created_at,
                actor: e.actor?.login || "",
                pages: (e.payload?.pages || []).map((p) => ({ title: p.title, action: p.action, url: p.html_url })),
              }
            : 0
        )
      );
      this._wiki.set(key, { state: "ok", summary: wikiSummary(events) });
    } catch (err) {
      this._wiki.set(key, { ...entry, state: "error", error: err.message || String(err) });
    }
    this._renderBody();
  }

  _loadAll(force = false) {
    const keys = [...this._config.repositories];
    if (this._search && this._search.repo) keys.push(`${this._search.owner}/${this._search.repo}`);
    [...new Set(keys)].forEach((key) => {
      this._loadRepo(key, force);
      this._loadDetails(key, force);
      this._loadWiki(key, force);
    });
  }

  async _loadUserRepos(owner) {
    this._userRepos = { owner, state: "loading", repos: [] };
    this._renderBody();
    try {
      const repos = await this._fetchList(`/users/${owner}/repos?sort=pushed&type=owner`, 3, false, (list) =>
        list.map((r) => ({ name: r.name, stargazers_count: r.stargazers_count, archived: r.archived, fork: r.fork }))
      );
      this._userRepos = {
        owner,
        state: "ok",
        repos: repos.filter((r) => !r.fork).map((r) => ({ name: r.name, stars: r.stargazers_count, archived: r.archived })),
      };
    } catch (err) {
      this._userRepos = { owner, state: "error", error: err.message || String(err), repos: [] };
    }
    this._renderBody();
  }

  _runSearch(text) {
    const target = parseTarget(text);
    if (!target) {
      this._searchError = "Bitte owner/repo, einen GitHub-Link oder einen Benutzernamen eingeben";
      this._renderBody();
      return;
    }
    this._searchError = null;
    if (target.repo) {
      this._search = target;
      this._userRepos = null;
      this._loadRepo(`${target.owner}/${target.repo}`);
      this._loadDetails(`${target.owner}/${target.repo}`);
      this._loadWiki(`${target.owner}/${target.repo}`);
    } else {
      this._search = null;
      this._loadUserRepos(target.owner);
    }
  }

  // --- View ---

  _render() {
    this._rendered = true;
    const isModern = this._config.layout === "modern";
    this.shadowRoot.innerHTML = `
      <style>${STYLE}</style>
      <ha-card class="${isModern ? "layout-modern" : "layout-classic"}">
        <div class="head">
          <ha-icon icon="mdi:github"></ha-icon>
          <span class="title">${escapeHtml(this._config.title)}</span>
          <button class="icon-btn" id="refresh" title="Neu laden" aria-label="Neu laden"><ha-icon icon="mdi:refresh"></ha-icon></button>
        </div>
        ${
          this._config.show_search
            ? `<form class="search" id="search" role="search">
                <ha-icon icon="mdi:magnify"></ha-icon>
                <input id="query" type="search" autocomplete="off" spellcheck="false" enterkeyhint="search"
                  placeholder="${isModern ? "owner/repo, GitHub-Link oder Benutzer suchen …" : "owner/repo, GitHub-Link oder Benutzer"}" aria-label="Repository suchen">
                <button type="submit" class="go">Suchen</button>
              </form>`
            : ""
        }
        <div class="body" id="body"></div>
      </ha-card>`;
    const root = this.shadowRoot;
    root.getElementById("refresh").addEventListener("click", () => this._loadAll(true));
    const form = root.getElementById("search");
    if (form) {
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        this._runSearch(root.getElementById("query").value);
      });
    }
    root.getElementById("body").addEventListener("click", (e) => this._onClick(e));
    this._renderBody();
  }

  _onClick(e) {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const { action, key, tag, owner, repo } = el.dataset;
    if (action === "toggle-release") {
      const id = `${key}@${tag}`;
      if (this._expanded.has(id)) this._expanded.delete(id);
      else this._expanded.add(id);
    } else if (action === "show-all") {
      if (this._showAll.has(key)) this._showAll.delete(key);
      else this._showAll.add(key);
    } else if (action === "close-search") {
      this._search = null;
    } else if (action === "close-user") {
      this._userRepos = null;
    } else if (action === "pick") {
      this._search = { owner, repo };
      const input = this.shadowRoot.getElementById("query");
      if (input) input.value = `${owner}/${repo}`;
      this._loadRepo(`${owner}/${repo}`);
      this._loadDetails(`${owner}/${repo}`);
      this._loadWiki(`${owner}/${repo}`);
      return;
    } else if (action === "retry") {
      this._loadRepo(key, true);
      return;
    } else {
      return;
    }
    this._renderBody();
  }

  _renderBody() {
    const body = this.shadowRoot.getElementById("body");
    if (!body) return;
    let html = "";
    if (this._searchError) html += `<div class="note error">${escapeHtml(this._searchError)}</div>`;
    if (this._userRepos) html += this._userReposHtml();
    const isModern = this._config.layout === "modern";
    if (this._search) {
      const key = `${this._search.owner}/${this._search.repo}`;
      if (!this._config.repositories.some((r) => r.toLowerCase() === key.toLowerCase())) {
        html += isModern ? this._repoHtmlModern(key, true) : this._repoHtml(key, true);
      }
    }
    html += this._config.repositories.map((key) => (isModern ? this._repoHtmlModern(key, false) : this._repoHtml(key, false))).join("");
    if (!html) {
      html = `<div class="empty">
        <ha-icon icon="mdi:source-repository"></ha-icon>
        <span>Noch kein Repository. Oben suchen oder in den Karteneinstellungen dauerhaft hinzufügen.</span>
      </div>`;
    }
    body.innerHTML = html;
  }

  _userReposHtml() {
    const u = this._userRepos;
    const isModern = this._config.layout === "modern";
    let inner;
    if (u.state === "loading") inner = `<div class="note">Lade Repositories von ${escapeHtml(u.owner)} …</div>`;
    else if (u.state === "error") inner = `<div class="note error">${escapeHtml(u.error)}</div>`;
    else if (!u.repos.length) inner = `<div class="note">Keine eigenen öffentlichen Repositories.</div>`;
    else
      inner = `<div class="chips">${u.repos
        .map(
          (r) =>
            `<button class="chip${r.archived ? " muted" : ""}" data-action="pick" data-owner="${escapeHtml(u.owner)}" data-repo="${escapeHtml(r.name)}">${escapeHtml(r.name)}${r.stars ? ` <span class="star">★ ${number(r.stars)}</span>` : ""}</button>`
        )
        .join("")}</div>`;
    return `<section class="repo${isModern ? " modern-repo" : ""} search-result">
      <div class="repo-head">
        <span class="badge">Suche</span>
        <span class="repo-name">${escapeHtml(u.owner)}</span>
        <button class="icon-btn small" data-action="close-user" title="Schließen" aria-label="Schließen"><ha-icon icon="mdi:close"></ha-icon></button>
      </div>
      ${inner}
    </section>`;
  }

  _repoHtml(key, isSearch) {
    const entry = this._data.get(key) || { state: "loading" };
    const link = `https://github.com/${key}`;
    const close = isSearch
      ? `<button class="icon-btn small" data-action="close-search" title="Schließen" aria-label="Schließen"><ha-icon icon="mdi:close"></ha-icon></button>`
      : "";
    const head = (right) => `
      <div class="repo-head">
        ${isSearch ? '<span class="badge">Suche</span>' : '<ha-icon class="repo-icon" icon="mdi:source-repository"></ha-icon>'}
        <a class="repo-name" href="${link}" target="_blank" rel="noopener noreferrer">${escapeHtml(key)}</a>
        ${right}
        ${close}
      </div>`;
    if (!entry.summary) {
      const msg =
        entry.state === "error"
          ? `<div class="note error">${escapeHtml(entry.error)} <button class="link" data-action="retry" data-key="${escapeHtml(key)}">Erneut versuchen</button></div>`
          : `<div class="note"><span class="spinner"></span> Lade Releases …</div>`;
      return `<section class="repo${isSearch ? " search-result" : ""}">${head("")}${msg}</section>`;
    }
    const s = entry.summary;
    const latest = s.releases.find((r) => !r.prerelease) || s.releases[0];
    const list = this._config.hide_empty ? s.releases.filter((r) => r.assets.length) : s.releases;
    const all = this._showAll.has(key);
    const shown = all ? list : list.slice(0, this._config.releases);

    const today = this._history ? countToday(this._history[key], s) : null;
    let todayHtml = "";
    if (today) {
      const title = today.exact
        ? "Downloads seit Mitternacht"
        : today.fromToday
          ? `Gezählt seit ${time(today.since)} Uhr, als die Karte heute zum ersten Mal geladen hat`
          : `Gezählt seit ${date(new Date(today.since).toISOString())}, ${time(today.since)} Uhr, als die Karte zuletzt geladen hat`;
      const label = today.exact ? "heute" : today.fromToday ? `seit ${time(today.since)}` : "heute*";
      todayHtml = `<span class="today${today.total ? " up" : ""}" title="${escapeHtml(title)}">+${number(today.total)} ${label}</span>`;
    }
    const total = `<div class="total" title="${number(s.total)} Downloads"><span class="total-num">${shortNumber(s.total)}</span><span class="total-label">Downloads</span>${todayHtml}</div>`;
    const stats = `
      <div class="stats">
        <span class="stat"><ha-icon icon="mdi:tag-multiple-outline"></ha-icon>${number(s.releases.length)} Releases</span>
        ${latest ? `<span class="stat" title="${date(latest.published)}"><ha-icon icon="mdi:tag-outline"></ha-icon>${escapeHtml(latest.tag)} · ${ago(latest.published)}</span>` : ""}
        <span class="stat"><ha-icon icon="mdi:paperclip"></ha-icon>${number(s.withAssets)} mit Dateien</span>
      </div>`;
    const rows = shown.length
      ? shown.map((r) => this._releaseHtml(key, r, s.max, today?.releases[r.tag])).join("")
      : `<div class="note">Keine Releases${this._config.hide_empty && s.releases.length ? " mit Dateien" : ""}.</div>`;
    const more =
      list.length > this._config.releases
        ? `<button class="more" data-action="show-all" data-key="${escapeHtml(key)}">${all ? "Weniger anzeigen" : `Alle ${number(list.length)} Releases anzeigen`}</button>`
        : "";
    const hint =
      s.releases.length && !s.hasZip
        ? `<div class="hint"><ha-icon icon="mdi:information-outline"></ha-icon>Gezählt werden nur Dateien in Releases. Installationen über HACS laden den Quellcode und erscheinen hier nicht.</div>`
        : "";
    return `<section class="repo${isSearch ? " search-result" : ""}">
      ${head(total)}
      ${stats}
      ${this._detailsHtml(key)}
      ${this._trafficHtml(key)}
      <div class="releases">${rows}</div>
      ${more}
      ${this._wikiHtml(key)}
      ${hint}
    </section>`;
  }

  _detailsHtml(key) {
    const d = this._details.get(key);
    if (!d) return "";
    let html = "";
    if (this._config.show_details && (d.info || d.commits != null)) {
      const i = d.info || {};
      const chip = (icon, text, title) => `<span class="meta" title="${escapeHtml(title)}"><ha-icon icon="${icon}"></ha-icon>${text}</span>`;
      html += `<div class="metas">
        ${d.info ? chip("mdi:star-outline", number(i.stars), "Sterne") : ""}
        ${d.info ? chip("mdi:source-fork", number(i.forks), "Forks") : ""}
        ${d.info ? chip("mdi:alert-circle-outline", number(i.issues), "Offene Issues und Pull Requests") : ""}
        ${d.commits != null ? chip("mdi:source-commit", `${number(d.commits)} Commits`, "Commits im Hauptzweig") : ""}
        ${d.info ? chip("mdi:upload-outline", `Push ${ago(i.pushed)}`, `Letzter Push: ${date(i.pushed)}`) : ""}
        ${i.archived ? '<span class="meta archived">Archiviert</span>' : ""}
      </div>`;
    }
    if (this._config.show_activity) {
      if (Array.isArray(d.weeks)) {
        const weeks = d.weeks.slice(-12);
        const sum = weeks.reduce((a, b) => a + b, 0);
        const max = Math.max(1, ...weeks);
        const bars = weeks
          .map((n, idx) => {
            const h = n ? Math.max(2, Math.round((n / max) * 22)) : 1;
            const x = idx * 9;
            return `<rect x="${x}" y="${24 - h}" width="6" height="${h}" rx="1.5"${n ? "" : ' class="zero"'}><title>${n} Commits, vor ${11 - idx} Wochen</title></rect>`;
          })
          .join("");
        html += `<div class="activity">
          <span class="activity-label"><ha-icon icon="mdi:chart-bar"></ha-icon>${number(sum)} Commits in 12 Wochen</span>
          <svg class="spark" viewBox="0 0 105 24" preserveAspectRatio="none" role="img" aria-label="${number(sum)} Commits in den letzten 12 Wochen">${bars}</svg>
        </div>`;
      } else if (d.pending) {
        html += `<div class="activity"><span class="activity-label"><ha-icon icon="mdi:chart-bar"></ha-icon>GitHub berechnet die Commit-Statistik …</span></div>`;
      }
    }
    return html;
  }

  /** Views, clones, referrers and popular pages from the Home Assistant sensor. */
  _trafficHtml(key) {
    const ent = this._trafficEntity(key);
    if (!ent) return "";
    const a = ent.attributes || {};
    const errors = Array.isArray(a.errors) ? a.errors : [];
    const hasData = Object.keys(a.history || {}).length > 0 || a.views_14d || a.clones_14d;
    const updated = a.updated ? `aktualisiert ${ago(a.updated)}` : "";
    const head = (sub) => `<div class="tr-head">
        <ha-icon icon="mdi:eye-outline"></ha-icon>
        <div class="tr-titles"><span class="tr-title">Besucher &amp; Clones</span><span class="tr-sub">${sub}</span></div>
      </div>`;
    if (!hasData && errors.length) {
      const auth = errors.some((e) => /HTTP (401|403)/.test(e));
      return `<div class="tr-box">${head(escapeHtml(updated))}
        <div class="note error small"><ha-icon icon="mdi:key-alert-outline"></ha-icon> ${
          auth ? "Token fehlt, ist abgelaufen oder hat keine Berechtigung „Administration: Read-only“." : escapeHtml(errors.join(", "))
        }</div></div>`;
    }
    const firstDay = Object.keys(a.history || {}).sort()[0];
    const recorded = firstDay ? Math.round((Date.now() - new Date(`${firstDay}T00:00:00Z`).getTime()) / 86400000) + 1 : 0;
    const span = Math.max(7, Math.min(this._config.traffic_days, recorded || this._config.traffic_days));
    const series = trafficSeries(a.history, span);
    const spanLabel = `${span} Tage`;
    const kpi = (icon, value, label, title, cls = "") =>
      `<div class="tr-kpi ${cls}" title="${escapeHtml(title)}"><ha-icon icon="${icon}"></ha-icon><span class="tr-num">${shortNumber(value)}</span><span class="tr-lbl">${label}</span></div>`;
    const kpis = `<div class="tr-kpis">
        ${kpi("mdi:eye-outline", a.views_14d, "Aufrufe 14 T", `${number(a.views_14d)} Aufrufe in 14 Tagen`)}
        ${kpi("mdi:account-outline", a.view_uniques_14d, "Besucher 14 T", `${number(a.view_uniques_14d)} einzelne Besucher in 14 Tagen`)}
        ${kpi("mdi:source-branch", a.clones_14d, "Clones 14 T", `${number(a.clones_14d)} Clones in 14 Tagen`, "green")}
        ${kpi("mdi:account-multiple-outline", a.clone_uniques_14d, "Einzeln 14 T", `${number(a.clone_uniques_14d)} einzelne Clones in 14 Tagen`, "green")}
      </div>`;

    // Grouped bars per day: views (accent) and clones (green)
    const w = 300;
    const h = 48;
    const slot = w / series.days.length;
    const bw = Math.max(1, slot * 0.4);
    // Each series on its own scale: clones (bots, HACS checks) dwarf views
    const maxV = Math.max(1, ...series.days.map((d) => d.views));
    const maxC = Math.max(1, ...series.days.map((d) => d.clones));
    const bar = (x, v, cls, title) => {
      const max = cls === "v" ? maxV : maxC;
      const bh = v ? Math.max(2, Math.round((v / max) * (h - 2))) : 1;
      return `<rect x="${x.toFixed(1)}" y="${h - bh}" width="${bw.toFixed(1)}" height="${bh}" rx="1" class="${v ? cls : "zero"}"><title>${title}</title></rect>`;
    };
    const bars = series.days
      .map((d, i) => {
        const label = date(`${d.day}T12:00:00Z`);
        const x = i * slot + slot * 0.1;
        return (
          bar(x, d.views, "v", `${label}: ${number(d.views)} Aufrufe, ${number(d.visitors)} Besucher`) +
          bar(x + bw, d.clones, "c", `${label}: ${number(d.clones)} Clones, ${number(d.uniqueClones)} einzeln`)
        );
      })
      .join("");
    const chart = `<div class="tr-chart">
        <div class="tr-chart-head">
          <span><i class="dot v"></i>${number(series.views)} Aufrufe</span>
          <span><i class="dot c"></i>${number(series.clones)} Clones</span>
          <span class="tr-span" title="Aufrufe und Clones haben je eine eigene Skala">${spanLabel}</span>
        </div>
        <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${number(series.views)} Aufrufe und ${number(series.clones)} Clones in ${spanLabel}">${bars}</svg>
      </div>`;

    const rows = (list, render) => {
      const max2 = Math.max(1, ...list.map((r) => r.count || 0));
      return list
        .slice(0, 5)
        .map((r) => {
          const [icon, label, href] = render(r);
          const inner = `<ha-icon icon="${icon}"></ha-icon><span class="tr-row-name">${escapeHtml(label)}</span>
            <span class="tr-row-num" title="${number(r.uniques)} einzelne">${number(r.count)}</span>
            <span class="tr-row-bar" aria-hidden="true"><span style="width:${Math.max(3, Math.round(((r.count || 0) / max2) * 100))}%"></span></span>`;
          return href
            ? `<a class="tr-row" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
            : `<div class="tr-row">${inner}</div>`;
        })
        .join("");
    };
    const referrers = Array.isArray(a.referrers) ? a.referrers : [];
    const paths = Array.isArray(a.paths) ? a.paths : [];
    const refHtml = referrers.length
      ? `<div class="tr-list"><div class="tr-list-title">Herkunft</div>${rows(referrers, (r) => [
          /google|bing|duckduckgo/i.test(r.referrer) ? "mdi:magnify" : /github/i.test(r.referrer) ? "mdi:github" : "mdi:web",
          r.referrer,
          null,
        ])}</div>`
      : "";
    const pathHtml = paths.length
      ? `<div class="tr-list"><div class="tr-list-title">Beliebte Seiten</div>${rows(paths, (r) => [
          /\/wiki(\/|$)/.test(r.path) ? "mdi:book-open-page-variant-outline" : "mdi:file-document-outline",
          pageTitle(r.title, r.path),
          `https://github.com${r.path}`,
        ])}</div>`
      : "";
    const warn = errors.length
      ? `<div class="note small tr-warn" title="${escapeHtml(errors.join(", "))}"><ha-icon icon="mdi:alert-outline"></ha-icon> Letzter Abruf unvollständig, Werte von früher</div>`
      : "";
    return `<div class="tr-box">
      ${head(`GitHub zählt 14 Tage · ${escapeHtml(updated)}`)}
      ${kpis}
      ${chart}
      ${refHtml || pathHtml ? `<div class="tr-lists">${refHtml}${pathHtml}</div>` : ""}
      ${warn}
    </div>`;
  }

  /** Latest wiki edits, and the most read wiki pages when traffic is there. */
  _wikiHtml(key) {
    if (!this._config.show_wiki) return "";
    const w = this._wiki.get(key);
    const link = `https://github.com/${key}/wiki`;
    const head = (sub) => `<div class="tr-head">
        <ha-icon icon="mdi:book-open-page-variant-outline"></ha-icon>
        <div class="tr-titles"><span class="tr-title">Wiki</span><span class="tr-sub">${sub}</span></div>
        <a class="icon-btn small" href="${link}" target="_blank" rel="noopener noreferrer" title="Wiki öffnen" aria-label="Wiki öffnen"><ha-icon icon="mdi:open-in-new"></ha-icon></a>
      </div>`;
    if (!w || (!w.summary && w.state === "loading")) return `<div class="tr-box">${head("Lade …")}</div>`;
    if (!w.summary) return `<div class="tr-box">${head("")}<div class="note error small">${escapeHtml(w.error)}</div></div>`;
    const s = w.summary;
    if (!s.pages.length) return `<div class="tr-box">${head("Keine Änderungen in den letzten 90 Tagen")}</div>`;
    const sub = `Zuletzt geändert ${ago(s.last)} · ${number(s.edits30)} Änderungen in 30 Tagen`;
    const actions = { created: "neu", edited: "bearbeitet", deleted: "gelöscht" };
    const recent = s.pages
      .slice(0, 5)
      .map(
        (p) => `<a class="tr-row wiki" href="${escapeHtml(p.url || link)}" target="_blank" rel="noopener noreferrer">
          <ha-icon icon="${p.action === "created" ? "mdi:file-plus-outline" : "mdi:file-edit-outline"}"></ha-icon>
          <span class="tr-row-name">${escapeHtml(p.title)}</span>
          <span class="tr-row-meta" title="${date(p.t)}${p.actor ? ` · ${escapeHtml(p.actor)}` : ""}">${actions[p.action] || escapeHtml(p.action)} · ${ago(p.t)}</span>
        </a>`
      )
      .join("");
    // Wiki pages among GitHub's popular pages (needs the traffic sensor)
    const ent = this._trafficEntity(key);
    const wikiPaths = (Array.isArray(ent?.attributes?.paths) ? ent.attributes.paths : []).filter((r) => /\/wiki(\/|$)/.test(r.path));
    const read = wikiPaths.length
      ? `<div class="tr-list"><div class="tr-list-title">Meistgelesen (14 Tage)</div>${wikiPaths
          .slice(0, 5)
          .map(
            (r) => `<a class="tr-row wiki" href="https://github.com${escapeHtml(r.path)}" target="_blank" rel="noopener noreferrer">
              <ha-icon icon="mdi:eye-outline"></ha-icon>
              <span class="tr-row-name">${escapeHtml(pageTitle(r.title, r.path))}</span>
              <span class="tr-row-num" title="${number(r.uniques)} einzelne Besucher">${number(r.count)}</span>
            </a>`
          )
          .join("")}</div>`
      : "";
    return `<div class="tr-box">
      ${head(sub)}
      <div class="tr-lists">
        <div class="tr-list"><div class="tr-list-title">${number(s.pages.length)} Seiten geändert (90 Tage)</div>${recent}</div>
        ${read}
      </div>
    </div>`;
  }

  _releaseHtml(key, r, max, todayCount) {
    const id = `${key}@${r.tag}`;
    const open = this._expanded.has(id);
    const pct = max ? Math.max(r.downloads ? 3 : 0, Math.round((r.downloads / max) * 100)) : 0;
    const hasDistinctName = r.name && r.name.trim().toLowerCase() !== r.tag.trim().toLowerCase();
    const releaseName = hasDistinctName ? r.name : (r.name || r.tag);
    const titleHtml = releaseName ? `<div class="rel-title"><ha-icon icon="mdi:tag-outline"></ha-icon><span>${escapeHtml(releaseName)}</span></div>` : "";
    const bodyHtml = r.body ? `<div class="rel-desc">${escapeHtml(r.body)}</div>` : "";
    const assets = open
      ? `<div class="assets">
          ${titleHtml}
          ${bodyHtml}
          ${
            r.assets.length
              ? `<div class="rel-files-header"><ha-icon icon="mdi:package-variant-closed"></ha-icon><span>Dateien (${number(r.assets.length)}):</span></div>` +
                r.assets
                  .map(
                    (a) => `<a class="asset" href="${escapeHtml(a.url)}" target="_blank" rel="noopener noreferrer">
                      <ha-icon icon="mdi:file-download-outline"></ha-icon>
                      <span class="asset-name">${escapeHtml(a.name)}</span>
                      <span class="asset-size">${size(a.size)}</span>
                      <span class="asset-dl">${number(a.downloads)}</span>
                    </a>`
                  )
                  .join("")
              : '<div class="note small">Dieses Release hat keine Dateien.</div>'
          }
          <a class="release-link" href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer">Release auf GitHub öffnen <ha-icon icon="mdi:open-in-new"></ha-icon></a>
        </div>`
      : "";
    return `<div class="release${r.assets.length ? "" : " empty-release"}${open ? " open" : ""}">
      <button class="release-row" data-action="toggle-release" data-key="${escapeHtml(key)}" data-tag="${escapeHtml(r.tag)}" aria-expanded="${open}">
        <ha-icon class="chev" icon="mdi:chevron-right"></ha-icon>
        <span class="tag">${escapeHtml(r.tag)}</span>
        ${r.prerelease ? '<span class="pre">Pre</span>' : ""}
        <span class="date">${date(r.published)}</span>
        ${todayCount ? `<span class="dl-today" title="Heute">+${number(todayCount)}</span>` : ""}
        <span class="dl">${number(r.downloads)}</span>
        <span class="bar" aria-hidden="true"><span style="width:${pct}%"></span></span>
      </button>
      ${assets}
    </div>`;
  }

  _repoHtmlModern(key, isSearch) {
    const entry = this._data.get(key) || { state: "loading" };
    const link = `https://github.com/${key}`;
    const [owner, repoName] = key.split("/");
    const close = isSearch
      ? `<button class="icon-btn small" data-action="close-search" title="Schließen" aria-label="Schließen"><ha-icon icon="mdi:close"></ha-icon></button>`
      : "";

    if (!entry.summary) {
      const msg =
        entry.state === "error"
          ? `<div class="note error">${escapeHtml(entry.error)} <button class="link" data-action="retry" data-key="${escapeHtml(key)}">Erneut versuchen</button></div>`
          : `<div class="note"><span class="spinner"></span> Lade Releases …</div>`;
      return `<section class="repo modern-repo${isSearch ? " search-result" : ""}">
        <div class="m-repo-header">
          <div class="m-repo-avatar"><ha-icon icon="mdi:github"></ha-icon></div>
          <div class="m-repo-titles">
            <span class="m-repo-owner">${escapeHtml(owner)}</span>
            <a class="m-repo-name" href="${link}" target="_blank" rel="noopener noreferrer">${escapeHtml(repoName || key)}</a>
          </div>
          ${isSearch ? '<span class="badge">Suche</span>' : ""}
          ${close}
        </div>
        ${msg}
      </section>`;
    }

    const s = entry.summary;
    const latest = s.releases.find((r) => !r.prerelease) || s.releases[0];
    const list = this._config.hide_empty ? s.releases.filter((r) => r.assets.length) : s.releases;
    const all = this._showAll.has(key);
    const shown = all ? list : list.slice(0, this._config.releases);

    const today = this._history ? countToday(this._history[key], s) : null;
    const d = this._details.get(key);
    const i = d?.info || {};

    const head = `
      <div class="m-repo-header">
        <div class="m-repo-avatar"><ha-icon icon="mdi:github"></ha-icon></div>
        <div class="m-repo-titles">
          <span class="m-repo-owner">${escapeHtml(owner)}</span>
          <a class="m-repo-name" href="${link}" target="_blank" rel="noopener noreferrer">${escapeHtml(repoName || key)}</a>
        </div>
        ${isSearch ? '<span class="badge">Suche</span>' : ""}
        ${i.archived ? '<span class="meta archived">Archiviert</span>' : ""}
        ${close}
      </div>`;

    let todayTitle = "";
    let todayPill = "";
    if (today) {
      todayTitle = today.exact
        ? "Downloads seit Mitternacht"
        : today.fromToday
          ? `Gezählt seit ${time(today.since)} Uhr`
          : `Gezählt seit ${date(new Date(today.since).toISOString())}, ${time(today.since)} Uhr`;
      const label = today.exact ? "heute" : today.fromToday ? `seit ${time(today.since)}` : "heute*";
      todayPill = `<span class="m-kpi-pill" title="${escapeHtml(todayTitle)}">+${number(today.total)} ${label}</span>`;
    }

    const kpiDownloads = `
      <div class="m-kpi-card m-kpi-hero">
        <div class="m-kpi-top">
          <div class="m-kpi-icon-wrap hero-icon"><ha-icon icon="mdi:cloud-download"></ha-icon></div>
          ${todayPill}
        </div>
        <div class="m-kpi-num">${shortNumber(s.total)}</div>
        <div class="m-kpi-lbl">${number(s.total)} Downloads</div>
      </div>`;

    const kpiReleases = `
      <div class="m-kpi-card">
        <div class="m-kpi-top">
          <div class="m-kpi-icon-wrap" style="color: var(--grs-accent); background: rgba(var(--grs-accent-rgb), 0.12)"><ha-icon icon="mdi:tag-multiple-outline"></ha-icon></div>
          <span class="m-kpi-subtag">${number(s.releases.length)} Releases</span>
        </div>
        <div class="m-kpi-num m-kpi-text" title="${latest ? escapeHtml(latest.tag) : "–"}">${latest ? escapeHtml(latest.tag) : "–"}</div>
        <div class="m-kpi-lbl">${latest ? ago(latest.published) : "Keine Releases"}</div>
      </div>`;

    const kpiCommunity = this._config.show_details
      ? `<div class="m-kpi-card">
          <div class="m-kpi-top">
            <div class="m-kpi-icon-wrap" style="color: var(--grs-yellow); background: rgba(223, 142, 29, 0.14)"><ha-icon icon="mdi:star"></ha-icon></div>
            <span class="m-kpi-subtag">${d?.info ? `${number(i.forks)} Forks` : "GitHub"}</span>
          </div>
          <div class="m-kpi-num">${d?.info ? number(i.stars) : "–"}</div>
          <div class="m-kpi-lbl">${d?.info ? `${number(i.issues)} offene Issues` : "Sterne"}</div>
        </div>`
      : "";

    const weeksList = Array.isArray(d?.weeks) ? d.weeks.slice(-12) : null;
    const commitSum = weeksList ? weeksList.reduce((a, b) => a + b, 0) : null;
    const kpiCommits = (this._config.show_details || this._config.show_activity)
      ? `<div class="m-kpi-card">
          <div class="m-kpi-top">
            <div class="m-kpi-icon-wrap" style="color: var(--grs-green); background: rgba(64, 160, 43, 0.14)"><ha-icon icon="mdi:source-commit"></ha-icon></div>
            <span class="m-kpi-subtag">${i.pushed ? ago(i.pushed) : "Aktivität"}</span>
          </div>
          <div class="m-kpi-num">${d?.commits != null ? shortNumber(d.commits) : (commitSum != null ? number(commitSum) : "–")}</div>
          <div class="m-kpi-lbl">Commits Hauptzweig</div>
        </div>`
      : "";

    const kpiGrid = `<div class="m-kpi-grid">${kpiDownloads}${kpiReleases}${kpiCommunity}${kpiCommits}</div>`;

    let chartHtml = "";
    if (this._config.show_activity) {
      if (weeksList) {
        const spline = computeSpline(weeksList, 320, 70, 8);
        const gradId = `grad-${key.replace(/[^a-zA-Z0-9]/g, "-")}`;
        const dots = spline.points
          .map(
            (p, idx) =>
              `<circle cx="${p[0]}" cy="${p[1]}" r="${idx === spline.points.length - 1 ? 4 : 2.5}" fill="var(--grs-accent)" class="m-chart-dot"><title>${weeksList[idx]} Commits vor ${11 - idx} Wochen</title></circle>`
          )
          .join("");
        chartHtml = `
          <div class="m-chart-card">
            <div class="m-chart-header">
              <div class="m-chart-header-left">
                <ha-icon icon="mdi:chart-timeline-variant"></ha-icon>
                <div>
                  <span class="m-chart-title">Commit-Aktivität</span>
                  <span class="m-chart-sub">Letzte 12 Wochen</span>
                </div>
              </div>
              <div class="m-chart-badge">${number(commitSum)} Commits</div>
            </div>
            <div class="m-chart-svg-wrap">
              <svg class="m-spline-svg" viewBox="0 0 320 70" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="var(--grs-accent)" stop-opacity="0.38"/>
                    <stop offset="100%" stop-color="var(--grs-accent)" stop-opacity="0.0"/>
                  </linearGradient>
                </defs>
                <path d="${spline.areaPath}" fill="url(#${gradId})"/>
                <path d="${spline.linePath}" fill="none" stroke="var(--grs-accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
                ${dots}
              </svg>
            </div>
          </div>`;
      } else if (d?.pending) {
        chartHtml = `<div class="m-chart-card"><div class="m-chart-loading"><span class="spinner"></span> GitHub berechnet die Commit-Statistik …</div></div>`;
      }
    }

    const rows = shown.length
      ? shown.map((r) => this._releaseHtmlModern(key, r, s.max, today?.releases[r.tag])).join("")
      : `<div class="note">Keine Releases${this._config.hide_empty && s.releases.length ? " mit Dateien" : ""}.</div>`;
    const more =
      list.length > this._config.releases
        ? `<button class="m-btn-pill" data-action="show-all" data-key="${escapeHtml(key)}">${all ? "Weniger anzeigen" : `Alle ${number(list.length)} Releases anzeigen`}</button>`
        : "";
    const hint =
      s.releases.length && !s.hasZip
        ? `<div class="hint"><ha-icon icon="mdi:information-outline"></ha-icon>Gezählt werden nur Dateien in Releases. Installationen über HACS laden den Quellcode und erscheinen hier nicht.</div>`
        : "";

    return `<section class="repo modern-repo${isSearch ? " search-result" : ""}">
      ${head}
      ${kpiGrid}
      ${chartHtml}
      ${this._trafficHtml(key)}
      <div class="m-releases">${rows}</div>
      ${more}
      ${this._wikiHtml(key)}
      ${hint}
    </section>`;
  }

  _releaseHtmlModern(key, r, max, todayCount) {
    const id = `${key}@${r.tag}`;
    const open = this._expanded.has(id);
    const pct = max ? Math.max(r.downloads ? 4 : 0, Math.round((r.downloads / max) * 100)) : 0;
    const hasDistinctName = r.name && r.name.trim().toLowerCase() !== r.tag.trim().toLowerCase();
    const releaseName = hasDistinctName ? r.name : (r.name || r.tag);
    const titleHtml = releaseName ? `<div class="m-rel-title"><ha-icon icon="mdi:tag-outline"></ha-icon><span>${escapeHtml(releaseName)}</span></div>` : "";
    const bodyHtml = r.body ? `<div class="m-rel-desc">${escapeHtml(r.body)}</div>` : "";
    const assets = open
      ? `<div class="m-assets">
          ${titleHtml}
          ${bodyHtml}
          ${
            r.assets.length
              ? `<div class="m-rel-files-header"><ha-icon icon="mdi:package-variant-closed"></ha-icon><span>Dateien (${number(r.assets.length)}):</span></div>` +
                r.assets
                  .map(
                    (a) => `<a class="asset" href="${escapeHtml(a.url)}" target="_blank" rel="noopener noreferrer">
                      <ha-icon icon="mdi:file-download-outline"></ha-icon>
                      <span class="asset-name">${escapeHtml(a.name)}</span>
                      <span class="asset-size">${size(a.size)}</span>
                      <span class="asset-dl">${number(a.downloads)}</span>
                    </a>`
                  )
                  .join("")
              : '<div class="note small">Dieses Release hat keine Dateien.</div>'
          }
          <a class="m-rel-link" href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer">
            <span>Release auf GitHub öffnen</span>
            <ha-icon icon="mdi:open-in-new"></ha-icon>
          </a>
        </div>`
      : "";
    return `<div class="m-release${r.assets.length ? "" : " empty-release"}${open ? " open" : ""}">
      <button class="m-release-row" data-action="toggle-release" data-key="${escapeHtml(key)}" data-tag="${escapeHtml(r.tag)}" aria-expanded="${open}">
        <ha-icon class="chev" icon="mdi:chevron-right"></ha-icon>
        <span class="m-rel-tag">${escapeHtml(r.tag)}</span>
        ${r.prerelease ? '<span class="pre">Pre</span>' : ""}
        <span class="date">${date(r.published)}</span>
        <div class="m-rel-right">
          ${todayCount ? `<span class="m-pill-today">+${number(todayCount)} heute</span>` : ""}
          <span class="dl">${number(r.downloads)}</span>
        </div>
        <div class="m-progress-capsule" aria-hidden="true"><span style="width:${pct}%"></span></div>
      </button>
      ${assets}
    </div>`;
  }
}

const STYLE = `
  :host {
    --grs-accent: var(--catppuccin-mauve, var(--primary-color, #8839ef));
    --grs-accent-rgb: var(--catppuccin-mauve-rgb, var(--rgb-primary-color, 136, 57, 239));
    --grs-surface: var(--catppuccin-surface0, var(--secondary-background-color, rgba(127, 127, 127, 0.12)));
    --grs-muted: var(--catppuccin-overlay1, var(--secondary-text-color, #8c8fa1));
    --grs-green: var(--catppuccin-green, var(--success-color, #40a02b));
    --grs-red: var(--catppuccin-red, var(--error-color, #d20f39));
    --grs-yellow: var(--catppuccin-yellow, var(--warning-color, #df8e1d));
  }
  ha-card { padding: 14px 14px 10px; overflow: hidden; }
  .head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
  .head > ha-icon { color: var(--grs-accent); --mdc-icon-size: 24px; }
  .title { flex: 1; font-size: 1.15rem; font-weight: 600; color: var(--primary-text-color); }
  .icon-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 40px; height: 40px; border-radius: 50%; border: none; cursor: pointer;
    background: transparent; color: var(--grs-muted);
  }
  .icon-btn:hover, .icon-btn:focus-visible { background: rgba(var(--grs-accent-rgb), 0.14); color: var(--grs-accent); outline: none; }
  .icon-btn.small { width: 32px; height: 32px; --mdc-icon-size: 18px; margin-left: 2px; }
  .search {
    display: flex; align-items: center; gap: 8px;
    padding: 4px 4px 4px 12px; margin-bottom: 12px;
    border-radius: 999px; background: var(--grs-surface);
    border: 1px solid transparent;
  }
  .search:focus-within { border-color: var(--grs-accent); }
  .search > ha-icon { color: var(--grs-muted); --mdc-icon-size: 20px; flex: none; }
  .search input {
    flex: 1; min-width: 0; height: 36px; border: none; outline: none; background: transparent;
    color: var(--primary-text-color); font: inherit; font-size: 0.95rem;
  }
  .search input::placeholder { color: var(--grs-muted); }
  .go {
    flex: none; height: 36px; padding: 0 16px; border: none; border-radius: 999px; cursor: pointer;
    background: var(--grs-accent); color: var(--text-primary-color, #fff); font: inherit; font-weight: 600; font-size: 0.85rem;
  }
  .go:hover { filter: brightness(1.08); }
  .body { display: flex; flex-direction: column; gap: 10px; }
  .repo {
    border-radius: var(--ha-card-border-radius, 12px);
    background: rgba(var(--grs-accent-rgb), 0.05);
    border: 1px solid rgba(var(--grs-accent-rgb), 0.16);
    padding: 12px;
  }
  .repo.search-result { border-style: dashed; }
  .repo-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .repo-icon { color: var(--grs-accent); --mdc-icon-size: 20px; flex: none; }
  .repo-name {
    flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-weight: 600; color: var(--primary-text-color); text-decoration: none;
  }
  a.repo-name:hover { color: var(--grs-accent); text-decoration: underline; }
  .badge {
    flex: none; font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
    padding: 2px 8px; border-radius: 999px; background: rgba(var(--grs-accent-rgb), 0.18); color: var(--grs-accent);
  }
  .total { flex: none; display: flex; flex-direction: column; align-items: flex-end; line-height: 1.05; }
  .total-num { font-size: 1.6rem; font-weight: 700; color: var(--grs-accent); font-variant-numeric: tabular-nums; }
  .total-label { font-size: 0.7rem; color: var(--grs-muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .today { margin-top: 3px; font-size: 0.75rem; font-weight: 600; color: var(--grs-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .today.up { color: var(--grs-green); }
  .dl-today { flex: none; font-size: 0.72rem; font-weight: 600; color: var(--grs-green); font-variant-numeric: tabular-nums; }
  .stats { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 8px 0 10px; }
  .stat { display: inline-flex; align-items: center; gap: 4px; font-size: 0.8rem; color: var(--secondary-text-color); }
  .stat ha-icon { --mdc-icon-size: 15px; color: var(--grs-muted); }
  .metas { display: flex; flex-wrap: wrap; gap: 6px; margin: -2px 0 10px; }
  .meta {
    display: inline-flex; align-items: center; gap: 4px; min-height: 26px; padding: 0 9px;
    border-radius: 999px; background: var(--grs-surface); font-size: 0.78rem; color: var(--primary-text-color);
    font-variant-numeric: tabular-nums;
  }
  .meta ha-icon { --mdc-icon-size: 14px; color: var(--grs-accent); }
  .meta.archived { background: rgba(223, 142, 29, 0.18); color: var(--grs-yellow); }
  .activity { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 0 0 10px; }
  .activity-label { display: inline-flex; align-items: center; gap: 4px; font-size: 0.8rem; color: var(--secondary-text-color); }
  .activity-label ha-icon { --mdc-icon-size: 15px; color: var(--grs-muted); }
  .spark { flex: none; width: 110px; height: 26px; }
  .spark rect { fill: var(--grs-green); }
  .spark rect.zero { fill: var(--grs-surface); }
  .releases { display: flex; flex-direction: column; gap: 2px; }
  .release-row {
    width: 100%; min-height: 40px; display: grid; align-items: center; column-gap: 8px;
    grid-template-columns: 18px minmax(0, auto) auto 1fr auto;
    grid-template-areas: "chev tag pre date dl" "bar bar bar bar bar";
    padding: 6px 8px; border: none; border-radius: 8px; background: transparent; cursor: pointer;
    color: var(--primary-text-color); font: inherit; text-align: left;
  }
  .release-row:hover, .release-row:focus-visible { background: var(--grs-surface); outline: none; }
  .chev { grid-area: chev; --mdc-icon-size: 18px; color: var(--grs-muted); transition: transform 0.15s ease; }
  .release.open .chev { transform: rotate(90deg); }
  .tag { grid-area: tag; font-weight: 600; font-size: 0.9rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pre { grid-area: pre; font-size: 0.65rem; font-weight: 700; padding: 1px 6px; border-radius: 6px; background: rgba(223, 142, 29, 0.18); color: var(--grs-yellow); }
  .date { grid-area: date; font-size: 0.78rem; color: var(--grs-muted); white-space: nowrap; }
  .dl { grid-area: dl; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--primary-text-color); }
  .bar { grid-area: bar; height: 4px; margin-top: 5px; border-radius: 2px; background: var(--grs-surface); overflow: hidden; }
  .bar > span { display: block; height: 100%; border-radius: 2px; background: var(--grs-accent); }
  .empty-release .tag, .empty-release .dl { color: var(--grs-muted); font-weight: 500; }
  .assets { margin: 2px 0 8px 26px; display: flex; flex-direction: column; gap: 2px; }
  .rel-title {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 0.88rem; font-weight: 700; color: var(--primary-text-color);
    margin: 4px 0 2px;
  }
  .rel-title ha-icon { --mdc-icon-size: 15px; color: var(--grs-accent); }
  .rel-desc {
    font-size: 0.78rem; line-height: 1.45; color: var(--secondary-text-color);
    white-space: pre-line; margin: 3px 0 6px; padding: 6px 10px;
    background: var(--grs-surface); border-radius: 8px; border-left: 3px solid var(--grs-accent);
  }
  .rel-files-header {
    display: flex; align-items: center; gap: 5px;
    font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--grs-muted); margin: 6px 0 2px;
  }
  .rel-files-header ha-icon { --mdc-icon-size: 14px; color: var(--grs-accent); }
  .asset {
    display: grid; grid-template-columns: 18px minmax(0, 1fr) auto auto; align-items: center; gap: 8px;
    min-height: 36px; padding: 4px 8px; border-radius: 8px; text-decoration: none; color: var(--primary-text-color); font-size: 0.85rem;
  }
  .asset:hover { background: var(--grs-surface); }
  .asset ha-icon { --mdc-icon-size: 16px; color: var(--grs-muted); }
  .asset-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .asset-size { font-size: 0.75rem; color: var(--grs-muted); white-space: nowrap; }
  .asset-dl { font-weight: 700; font-variant-numeric: tabular-nums; min-width: 2.5ch; text-align: right; }
  .release-link, .link {
    display: inline-flex; align-items: center; gap: 4px;
    align-self: flex-start; margin: 4px 8px 0; padding: 0; border: none; background: none; cursor: pointer;
    font: inherit; font-size: 0.8rem; color: var(--grs-accent); text-decoration: underline;
  }
  .release-link ha-icon { --mdc-icon-size: 13px; }
  .more {
    width: 100%; min-height: 40px; margin-top: 6px; border: none; border-radius: 8px; cursor: pointer;
    background: var(--grs-surface); color: var(--grs-accent); font: inherit; font-weight: 600; font-size: 0.85rem;
  }
  .more:hover { filter: brightness(1.05); }
  .hint { display: flex; gap: 6px; align-items: flex-start; margin-top: 10px; font-size: 0.75rem; line-height: 1.35; color: var(--grs-muted); }
  .hint ha-icon { --mdc-icon-size: 15px; flex: none; margin-top: 1px; }
  .note { margin-top: 8px; font-size: 0.85rem; color: var(--secondary-text-color); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .note.small { margin: 4px 8px; font-size: 0.8rem; }
  .note.error { color: var(--grs-red); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .chip {
    min-height: 36px; padding: 0 12px; border-radius: 999px; cursor: pointer; font: inherit; font-size: 0.85rem;
    border: 1px solid rgba(var(--grs-accent-rgb), 0.3); background: transparent; color: var(--primary-text-color);
  }
  .chip:hover { background: rgba(var(--grs-accent-rgb), 0.14); border-color: var(--grs-accent); }
  .chip.muted { opacity: 0.6; }
  .star { color: var(--grs-yellow); font-size: 0.75rem; }
  .empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 18px 8px; text-align: center; color: var(--grs-muted); font-size: 0.9rem; }
  .empty ha-icon { --mdc-icon-size: 32px; color: var(--grs-accent); opacity: 0.7; }
  .spinner {
    width: 14px; height: 14px; border-radius: 50%;
    border: 2px solid rgba(var(--grs-accent-rgb), 0.25); border-top-color: var(--grs-accent);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ================= MODERN / VENUS LAYOUT STYLES ================= */
  ha-card.layout-modern {
    padding: 16px 16px 12px;
  }
  .layout-modern .head {
    margin-bottom: 14px;
  }
  .layout-modern .title {
    font-size: 1.22rem;
    font-weight: 700;
  }
  .layout-modern .search {
    background: var(--grs-surface);
    border: 1px solid rgba(var(--grs-accent-rgb), 0.16);
    box-shadow: 0 2px 8px -2px rgba(0, 0, 0, 0.05);
    margin-bottom: 14px;
    padding: 4px 6px 4px 14px;
  }
  .layout-modern .search:focus-within {
    border-color: var(--grs-accent);
    box-shadow: 0 0 0 3px rgba(var(--grs-accent-rgb), 0.18);
  }
  .layout-modern .go {
    background: var(--grs-accent);
    border-radius: 999px;
    font-weight: 700;
    padding: 0 18px;
    box-shadow: 0 2px 8px 0 rgba(var(--grs-accent-rgb), 0.3);
  }

  .modern-repo {
    border-radius: var(--ha-card-border-radius, 14px);
    background: var(--ha-card-background, var(--card-background-color, rgba(var(--grs-accent-rgb), 0.04)));
    border: 1px solid rgba(var(--grs-accent-rgb), 0.14);
    box-shadow: 0 4px 18px -4px rgba(0, 0, 0, 0.05);
    padding: 14px;
  }

  .m-repo-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 12px;
  }
  .m-repo-avatar {
    width: 38px;
    height: 38px;
    border-radius: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(var(--grs-accent-rgb), 0.12);
    color: var(--grs-accent);
    flex: none;
  }
  .m-repo-avatar ha-icon {
    --mdc-icon-size: 22px;
  }
  .m-repo-titles {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }
  .m-repo-owner {
    font-size: 0.72rem;
    font-weight: 500;
    color: var(--grs-muted);
    line-height: 1.1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .m-repo-name {
    font-size: 1.05rem;
    font-weight: 700;
    color: var(--primary-text-color);
    text-decoration: none;
    line-height: 1.3;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  a.m-repo-name:hover {
    color: var(--grs-accent);
    text-decoration: underline;
  }

  /* Modern KPI Grid */
  .m-kpi-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    gap: 8px;
    margin-bottom: 12px;
  }
  .m-kpi-card {
    background: var(--grs-surface);
    border: 1px solid rgba(var(--grs-accent-rgb), 0.1);
    border-radius: 12px;
    padding: 10px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    min-height: 84px;
    box-sizing: border-box;
  }
  .m-kpi-hero {
    background: linear-gradient(135deg, var(--grs-accent) 0%, #4f46e5 100%);
    border-color: transparent;
    color: #ffffff;
    box-shadow: 0 4px 14px 0 rgba(var(--grs-accent-rgb), 0.32);
  }
  .m-kpi-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
    margin-bottom: 6px;
  }
  .m-kpi-icon-wrap {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
  }
  .m-kpi-icon-wrap ha-icon {
    --mdc-icon-size: 16px;
  }
  .hero-icon {
    background: rgba(255, 255, 255, 0.22);
    color: #ffffff;
  }
  .m-kpi-pill {
    font-size: 0.68rem;
    font-weight: 700;
    padding: 2px 7px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.24);
    color: #ffffff;
    white-space: nowrap;
    backdrop-filter: blur(4px);
  }
  .m-kpi-subtag {
    font-size: 0.68rem;
    font-weight: 600;
    color: var(--grs-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .m-kpi-num {
    font-size: 1.35rem;
    font-weight: 700;
    line-height: 1.1;
    font-variant-numeric: tabular-nums;
    color: var(--primary-text-color);
  }
  .m-kpi-text {
    font-size: 1.05rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .m-kpi-hero .m-kpi-num {
    color: #ffffff;
  }
  .m-kpi-lbl {
    font-size: 0.68rem;
    font-weight: 500;
    color: var(--grs-muted);
    margin-top: 3px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .m-kpi-hero .m-kpi-lbl {
    color: rgba(255, 255, 255, 0.85);
  }

  /* Modern Spline Chart Card */
  .m-chart-card {
    background: var(--grs-surface);
    border: 1px solid rgba(var(--grs-accent-rgb), 0.1);
    border-radius: 12px;
    padding: 10px 12px 8px;
    margin-bottom: 12px;
  }
  .m-chart-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }
  .m-chart-header-left {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .m-chart-header-left ha-icon {
    --mdc-icon-size: 18px;
    color: var(--grs-accent);
  }
  .m-chart-title {
    font-size: 0.8rem;
    font-weight: 700;
    color: var(--primary-text-color);
    display: block;
    line-height: 1.15;
  }
  .m-chart-sub {
    font-size: 0.68rem;
    color: var(--grs-muted);
    display: block;
  }
  .m-chart-badge {
    font-size: 0.72rem;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 999px;
    background: rgba(var(--grs-accent-rgb), 0.12);
    color: var(--grs-accent);
  }
  .m-chart-svg-wrap {
    width: 100%;
    height: 65px;
    overflow: hidden;
  }
  .m-spline-svg {
    width: 100%;
    height: 100%;
    overflow: visible;
  }
  .m-chart-dot {
    transition: r 0.15s ease;
    cursor: pointer;
  }
  .m-chart-dot:hover {
    r: 5px;
  }
  .m-chart-loading {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.78rem;
    color: var(--grs-muted);
    padding: 14px 0;
    justify-content: center;
  }

  /* Modern Releases Section */
  .m-releases {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .m-release {
    border-radius: 10px;
    background: var(--grs-surface);
    border: 1px solid transparent;
    transition: border-color 0.15s ease;
    overflow: hidden;
  }
  .m-release:hover {
    border-color: rgba(var(--grs-accent-rgb), 0.22);
  }
  .m-release-row {
    width: 100%;
    min-height: 40px;
    display: grid;
    align-items: center;
    column-gap: 8px;
    grid-template-columns: 18px minmax(0, auto) auto 1fr auto;
    grid-template-areas: "chev tag pre date dl" "bar bar bar bar bar";
    padding: 7px 10px;
    border: none;
    background: transparent;
    cursor: pointer;
    color: var(--primary-text-color);
    font: inherit;
    text-align: left;
  }
  .m-release-row:focus-visible {
    outline: 2px solid var(--grs-accent);
  }
  .m-release.open .chev {
    transform: rotate(90deg);
  }
  .m-rel-tag {
    grid-area: tag;
    font-weight: 700;
    font-size: 0.88rem;
    color: var(--primary-text-color);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .m-rel-right {
    grid-area: dl;
    display: flex;
    align-items: center;
    justify-content: flex-end;
  }
  .m-pill-today {
    font-size: 0.68rem;
    font-weight: 700;
    padding: 1px 7px;
    border-radius: 999px;
    background: rgba(64, 160, 43, 0.15);
    color: var(--grs-green);
    margin-right: 6px;
    white-space: nowrap;
  }
  .m-progress-capsule {
    grid-area: bar;
    height: 5px;
    border-radius: 999px;
    background: rgba(var(--grs-accent-rgb), 0.1);
    margin-top: 5px;
    overflow: hidden;
  }
  .m-progress-capsule > span {
    display: block;
    height: 100%;
    border-radius: 999px;
    background: linear-gradient(90deg, var(--grs-accent), #38bdf8);
    transition: width 0.3s ease;
  }
  .m-btn-pill {
    width: 100%;
    min-height: 38px;
    margin-top: 8px;
    border: none;
    border-radius: 999px;
    cursor: pointer;
    background: rgba(var(--grs-accent-rgb), 0.12);
    color: var(--grs-accent);
    font: inherit;
    font-weight: 700;
    font-size: 0.84rem;
    transition: all 0.2s ease;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .m-btn-pill:hover {
    background: var(--grs-accent);
    color: #ffffff;
    box-shadow: 0 4px 12px 0 rgba(var(--grs-accent-rgb), 0.3);
  }

  .m-assets {
    margin: 4px 6px 10px 24px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px 10px 6px;
    border-radius: 10px;
    background: rgba(var(--grs-accent-rgb), 0.04);
    border: 1px dashed rgba(var(--grs-accent-rgb), 0.18);
  }
  .m-rel-title {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 0.9rem;
    font-weight: 700;
    color: var(--primary-text-color);
    margin: 2px 0 3px;
  }
  .m-rel-title ha-icon {
    --mdc-icon-size: 16px;
    color: var(--grs-accent);
  }
  .m-rel-desc {
    font-size: 0.78rem;
    line-height: 1.45;
    color: var(--secondary-text-color);
    white-space: pre-line;
    padding: 7px 10px;
    background: var(--grs-surface);
    border-left: 3px solid var(--grs-accent);
    border-radius: 0 8px 8px 0;
    margin: 2px 0 6px;
  }
  .m-rel-files-header {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--grs-muted);
    margin: 4px 0 2px;
  }
  .m-rel-files-header ha-icon {
    --mdc-icon-size: 14px;
    color: var(--grs-accent);
  }
  .m-rel-link {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    align-self: flex-start;
    margin-top: 4px;
    padding: 2px 6px;
    border-radius: 6px;
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--grs-accent);
    text-decoration: none;
    transition: background 0.15s ease;
  }
  .m-rel-link:hover {
    background: rgba(var(--grs-accent-rgb), 0.12);
    text-decoration: underline;
  }
  .m-rel-link ha-icon {
    --mdc-icon-size: 13px;
  }

  .tr-box {
    margin: 0 0 10px; padding: 10px 12px; border-radius: 10px;
    background: var(--grs-surface); display: flex; flex-direction: column; gap: 8px;
  }
  .repo .more + .tr-box, .repo .m-btn-pill + .tr-box, .releases + .tr-box, .m-releases + .tr-box { margin-top: 10px; }
  .tr-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .tr-head > ha-icon { --mdc-icon-size: 20px; color: var(--grs-accent); flex: none; }
  .tr-titles { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.2; }
  .tr-title { font-weight: 600; font-size: 0.9rem; color: var(--primary-text-color); }
  .tr-sub { font-size: 0.72rem; color: var(--grs-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tr-head a.icon-btn { text-decoration: none; }
  .tr-kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
  .tr-kpi {
    display: grid; grid-template-columns: auto 1fr; grid-template-areas: "icon num" "lbl lbl";
    align-items: center; column-gap: 5px; padding: 6px 8px; border-radius: 8px;
    background: var(--card-background-color, var(--ha-card-background, transparent));
  }
  .tr-kpi ha-icon { grid-area: icon; --mdc-icon-size: 15px; color: var(--grs-accent); }
  .tr-kpi.green ha-icon { color: var(--grs-green); }
  .tr-num { grid-area: num; font-weight: 700; font-size: 1.05rem; color: var(--primary-text-color); font-variant-numeric: tabular-nums; }
  .tr-lbl { grid-area: lbl; font-size: 0.68rem; color: var(--grs-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tr-chart-head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; font-size: 0.74rem; color: var(--secondary-text-color); margin-bottom: 4px; }
  .tr-chart-head span { display: inline-flex; align-items: center; gap: 5px; font-variant-numeric: tabular-nums; }
  .tr-span { margin-left: auto; color: var(--grs-muted); }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 2px; }
  .dot.v { background: var(--grs-accent); }
  .dot.c { background: var(--grs-green); }
  .tr-chart svg { display: block; width: 100%; height: 48px; }
  .tr-chart rect.v { fill: var(--grs-accent); }
  .tr-chart rect.c { fill: var(--grs-green); }
  .tr-chart rect.zero { fill: rgba(127, 127, 127, 0.25); }
  .tr-lists { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px 14px; }
  .tr-list { display: flex; flex-direction: column; min-width: 0; }
  .tr-list-title { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--grs-muted); margin: 2px 0 2px; }
  .tr-row {
    display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; grid-template-areas: "icon name num" "bar bar bar";
    align-items: center; column-gap: 6px; min-height: 32px; padding: 3px 4px; border-radius: 6px;
    color: var(--primary-text-color); text-decoration: none; font-size: 0.8rem;
  }
  a.tr-row:hover, a.tr-row:focus-visible { background: rgba(var(--grs-accent-rgb), 0.1); outline: none; }
  .tr-row ha-icon { grid-area: icon; --mdc-icon-size: 16px; color: var(--grs-muted); }
  .tr-row-name { grid-area: name; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tr-row-num { grid-area: num; font-weight: 700; font-variant-numeric: tabular-nums; }
  .tr-row-meta { grid-area: num; font-size: 0.72rem; color: var(--grs-muted); white-space: nowrap; }
  .tr-row-bar { grid-area: bar; height: 3px; margin-top: 3px; border-radius: 2px; background: rgba(127, 127, 127, 0.18); overflow: hidden; }
  .tr-row-bar > span { display: block; height: 100%; background: var(--grs-accent); border-radius: 2px; }
  .tr-row.wiki { grid-template-areas: "icon name num"; }
  .tr-box .note { margin: 0; display: flex; align-items: center; gap: 6px; }
  .tr-box .note ha-icon { --mdc-icon-size: 16px; flex: none; }
  .tr-warn { color: var(--grs-yellow); }

  @media (max-width: 440px) {
    .tr-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .m-kpi-grid {
      grid-template-columns: repeat(2, 1fr);
    }
    .m-kpi-num {
      font-size: 1.18rem;
    }
  }

  @media (max-width: 420px) {
    ha-card { padding: 12px 10px 8px; }
    .go { padding: 0 12px; }
    .total-num { font-size: 1.35rem; }
    .release-row { grid-template-columns: 18px minmax(0, 1fr) auto auto; grid-template-areas: "chev tag pre dl" "chev date date date" "bar bar bar bar"; row-gap: 0; }
    .assets, .m-assets { margin-left: 8px; }
    .asset { grid-template-columns: 18px minmax(0, 1fr) auto; }
    .asset-size { display: none; }
  }
`;

if (!customElements.get("github-release-stats-card")) {
  customElements.define("github-release-stats-card", GithubReleaseStatsCard);
}
window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "github-release-stats-card")) {
  window.customCards.push({
    type: "github-release-stats-card",
    name: "GitHub Stats",
    description: "Downloads der Release-Dateien eines oder mehrerer GitHub-Repositories, mit Suche, Traffic und Wiki.",
    preview: true,
    documentationURL: "https://github.com/nukleuz80/ha_github-release-stats-card",
  });
}
console.info(`%c GITHUB-STATS-CARD %c v${CARD_VERSION} `, "color:#fff;background:#8839ef;font-weight:700", "color:#8839ef;background:#1e1e2e");
