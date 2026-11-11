# GitHub Release Stats Card

[![Version](https://img.shields.io/badge/version-1.3.0-8839ef.svg)](https://github.com/nukleuz80/ha_github-release-stats-card/releases)
[![Validate](https://github.com/nukleuz80/ha_github-release-stats-card/actions/workflows/validate.yml/badge.svg)](https://github.com/nukleuz80/ha_github-release-stats-card/actions/workflows/validate.yml)

🇩🇪 [Deutsche Version](README_de.md)

A Lovelace card for Home Assistant that shows how often the files of your GitHub releases were downloaded, today and in total. Pin your own repositories to the card and look up any other one with the search bar.

<img src="images/screenshot.png" alt="GitHub Release Stats Card" width="480">

> The card's interface is in German.

## Features

- **Downloads** per repository and per release, with a bar per release. Tap a release to see its files with size and download count.
- **Downloads today** (`+3 heute`) per repository and per release. See [How "today" is counted](#how-today-is-counted).
- **Search** on top: `owner/repo`, a GitHub link, or a user name for a list of their repositories.
- **Repository details**: stars, forks, open issues, total commits and the last push.
- **Activity**: commits of the last 12 weeks as a bar chart.
- **No token, no backend**: it reads the public GitHub API straight from the browser. Answers are cached and revalidated with ETags, so reloading the dashboard costs no API quota (60 requests per hour without a token).
- Uses the theme colors of Home Assistant and [Catppuccin](https://github.com/catppuccin/home-assistant) when present, so it works in light and dark themes. Works on phones.
- Visual editor in the dashboard.

## Installation

1. Download [`github-release-stats-card.js`](https://raw.githubusercontent.com/nukleuz80/ha_github-release-stats-card/main/github-release-stats-card.js) and copy it to `/config/www/`.
2. Under **Settings → Dashboards → ⋮ → Resources**, add `/local/github-release-stats-card.js?v=1.3.0` as a **JavaScript module**. If your resources are managed in YAML, add it to `lovelace.yaml` and restart Home Assistant.
3. Reload the browser. When you update the file, raise `?v=` so browsers load the new version.

## Configuration

Add the card with **Add card → GitHub Release Stats Card**, or in YAML:

```yaml
type: custom:github-release-stats-card
title: GitHub Releases
layout: modern # or "classic" for the legacy layout
repositories:
  - nukleuz80/ha_brainstorm
  - https://github.com/hacs/integration
```

| Option | Default | Description |
| :--- | :--- | :--- |
| `title` | `GitHub Releases` | Card title |
| `layout` | `classic` | Layout style: `classic` (compact layout) or `modern` (Venus-inspired KPI grid & spline chart) |
| `repositories` | `[]` | Repositories that always stay on the card, as `owner/repo` or a GitHub link |
| `releases` | `5` | Releases shown per repository, the rest behind "Alle … anzeigen" |
| `refresh` | `60` | Minutes between updates (at least 5) |
| `show_search` | `true` | Search bar on top |
| `show_details` | `true` | Stars, forks, issues, commits and last push |
| `show_activity` | `true` | Commits of the last 12 weeks |
| `hide_empty` | `false` | Hide releases without files |

## How "today" is counted

GitHub only reports the total downloads of each file, not downloads per day. Each time the card loads, it notes the totals together with the time GitHub sent them. Per day it keeps the first and the last count, for 31 days, in the Home Assistant user data of the signed-in user. All your devices share it, and other users have their own.

**Today** is the current total minus the last count of yesterday. This needs the dashboard to have been open somewhere shortly before midnight:

- `+N heute`: the last count of yesterday was taken at most 2 hours before midnight.
- `+N heute*`: the last count is older, the tooltip says since when.
- `+N seit 14:05`: the first day, counted since the first load.

Only pinned repositories are counted, a search only shows the totals.

## What GitHub counts as a download

Only files attached to a release (assets) are counted. The source code archives that GitHub adds to every release are not. HACS downloads those archives for integrations unless the repository sets `zip_release` in its `hacs.json` and attaches a ZIP to every release. Without that, HACS installs do not show up here.

## Version history & changelog

| Version | Date | Highlights |
| :--- | :--- | :--- |
| 1.3.0 | 2026-11-11 | New optional modern Venus dashboard layout (`layout: modern`) with KPI metric cards, spline commit chart, pill badges, and capsule progress bars; fully backwards-compatible with `layout: classic` |
| 1.2.1 | 2026-11-11 | Own repository for manual installation. A count keeps the time GitHub sent it, so a cached answer no longer looks like new downloads |
| 1.2.0 | 2026-11-10 | Downloads today per repository and per release, history in the Home Assistant user data |
| 1.1.0 | 2026-11-10 | Stars, forks, issues, commits, last push, commit activity of 12 weeks |
| 1.0.0 | 2026-11-10 | First version: pinned repositories, search, downloads per release and file, ETag cache |

## Credits

Inspired by [GitHub Release Stats](https://somsubhra.github.io/github-release-stats/) by Somsubhra Bairi.

## License

[MIT](LICENSE)
