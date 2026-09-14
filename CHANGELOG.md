# Changelog

## 0.1.0

Initial release.

- Browser login with local Playwright session storage (no password in config)
- Source parsers for hosts, plain domains, CSV, and simple JSON
- Inspect / diff / additive sync against Freedom blocklists
- HTTP create, add-domain, and delete against Freedom’s filter-list API
- Sharding for large sources across numbered Freedom lists
- Dry-run mode, checkpoints, and conservative failure behavior
