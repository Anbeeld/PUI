# Changelog

## v1.0.3

- Pinned every PUI-managed direct component, including Playwright MCP, to an exact release version.
- Added an installed PUI identity extension, exact Pi Web update bridge, and Pi Web-themed update card.
- Added a shared detached transaction worker with idle gating, explicit checkpoint routing, temporary status, automatic rollback, and recovery-required reporting.
- Made manual updates use the same transaction path and expanded read-only doctor and ownership-safe uninstall checks.
- Hardened reinstall and update safety across Windows, macOS, and Linux by failing closed when Pi Web activity cannot be verified and recognizing npm-launched standalone Pi processes.

## v1.0.2

- Adjusted browser and PWA title composition so the PUI label appears once in each context.
- Added content-hash versioning to PUI-modified client bundles.
- Marked all Unix lifecycle scripts as executable for direct launch on macOS and Linux.

## v1.0.1

- Refreshed PUI icon assets.
- Added versioning to icon references, including browser metadata, the PWA manifest, and the service-worker precache.
