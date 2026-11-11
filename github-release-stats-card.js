/*
 * GitHub Release Stats Card
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
 * Data comes straight from the public GitHub API in the browser. Answers are
 * cached per repository and revalidated with ETags, so a reload within the
 * refresh time costs no API quota (60 requests per hour without a token).
 */
const CARD_VERSION = "1.2.1";
const API = "https://api.github.com";
const CACHE_PREFIX = "grs-card:";
const HISTORY_KEY = "github-release-stats-card-history";
const HISTORY_DAYS = 31;

const DEFAULTS = {
  title: "GitHub Releases",
  repositories: [],
  releases: 5,
  refresh: 60,
  show_search: true,
  hide_empty: false,
  show_details: true,
  show_activity: true,
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
        { name: "hide_empty", selector: { boolean: {} } },
      ],
      computeLabel: (s) =>
        ({
          title: "Titel",
          repositories: "Repositories (owner/repo oder GitHub-Link)",
          releases: "Angezeigte Releases",
          refresh: "Aktualisieren alle",
          show_search: "Suche anzeigen",
          hide_empty: "Releases ohne Dateien ausblenden",
          show_details: "Sterne, Forks, Issues, Commits und letzten Push zeigen",
          show_activity: "Commits der letzten 12 Wochen zeigen",
        })[s.name],
      computeHelper: (s) =>
        ({
          repositories: "Diese Repositories bleiben dauerhaft auf der Karte.",
          refresh: "Zwischenspeicher pro Repository. GitHub erlaubt ohne Anmeldung 60 Abfragen pro Stunde.",
          hide_empty: "Nur Dateien in Releases (Assets) zählen Downloads.",
          show_details: "Kostet zwei weitere GitHub-Abfragen pro Repository und Aktualisierung (unverändert: keine).",
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
    };
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
    if (pagesOk && !force && Date.now() - cached.time < this._config.refresh * 60000) {
      const items = cached.pages.flat();
      items.fetched = cached.time; // when GitHub gave these numbers
      return items;
    }
    const pages = [];
    for (let page = 1; page <= maxPages; page++) {
      const headers = { Accept: "application/vnd.github+json" };
      const old = pagesOk ? cached.pages[page - 1] : null;
      const oldTag = pagesOk ? cached.etags[page - 1] : null;
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
      name: r.name,
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

  _loadAll(force = false) {
    const keys = [...this._config.repositories];
    if (this._search && this._search.repo) keys.push(`${this._search.owner}/${this._search.repo}`);
    [...new Set(keys)].forEach((key) => {
      this._loadRepo(key, force);
      this._loadDetails(key, force);
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
    } else {
      this._search = null;
      this._loadUserRepos(target.owner);
    }
  }

  // --- View ---

  _render() {
    this._rendered = true;
    this.shadowRoot.innerHTML = `
      <style>${STYLE}</style>
      <ha-card>
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
                  placeholder="owner/repo, GitHub-Link oder Benutzer" aria-label="Repository suchen">
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
    if (this._search) {
      const key = `${this._search.owner}/${this._search.repo}`;
      if (!this._config.repositories.some((r) => r.toLowerCase() === key.toLowerCase())) {
        html += this._repoHtml(key, true);
      }
    }
    html += this._config.repositories.map((key) => this._repoHtml(key, false)).join("");
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
    return `<section class="repo search-result">
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
      <div class="releases">${rows}</div>
      ${more}
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

  _releaseHtml(key, r, max, todayCount) {
    const id = `${key}@${r.tag}`;
    const open = this._expanded.has(id);
    const pct = max ? Math.max(r.downloads ? 3 : 0, Math.round((r.downloads / max) * 100)) : 0;
    const assets = open
      ? `<div class="assets">${
          r.assets.length
            ? r.assets
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
        }<a class="release-link" href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer">Release auf GitHub öffnen</a></div>`
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
    align-self: flex-start; margin: 4px 8px 0; padding: 0; border: none; background: none; cursor: pointer;
    font: inherit; font-size: 0.8rem; color: var(--grs-accent); text-decoration: underline;
  }
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
  @media (max-width: 420px) {
    ha-card { padding: 12px 10px 8px; }
    .go { padding: 0 12px; }
    .total-num { font-size: 1.35rem; }
    .release-row { grid-template-columns: 18px minmax(0, 1fr) auto auto; grid-template-areas: "chev tag pre dl" "chev date date date" "bar bar bar bar"; row-gap: 0; }
    .assets { margin-left: 8px; }
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
    name: "GitHub Release Stats",
    description: "Downloads der Release-Dateien eines oder mehrerer GitHub-Repositories, mit Suche.",
    preview: true,
    documentationURL: "https://github.com/nukleuz80/ha_github-release-stats-card",
  });
}
console.info(`%c GITHUB-RELEASE-STATS-CARD %c v${CARD_VERSION} `, "color:#fff;background:#8839ef;font-weight:700", "color:#8839ef;background:#1e1e2e");
