# Findings

- The supplied Platform Kit Fluent package exports `FluentSelect` from `@platform-kit/fluent/vue` and its stylesheet from `@platform-kit/fluent/style.css`.
- Release `v0.6.1` publishes `platform-kit-fluent-0.2.1.tgz` for direct package installation.
- The legacy settings page renders markup dynamically, so the Kit Vue control is mounted into a dedicated host after each settings-page render.
