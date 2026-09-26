# Imported history

Renders the read-only transcript a carry-history conversion imported into an external channel.

- Input comes only from a verified archive (`openImportedArchive` in `@khala/messaging`), through `ImportedHistoryPort`. It never comes from the live timeline, and nothing here can reach an agent, a read receipt or a delivery path.
- Bodies are inert. They render as React text in `<p>` and `<pre><code>`. No HTML is parsed, and no link, image, frame, form or control is derived from a body.
- Author labels and times are display provenance recorded by the internal channel. They are never presented as messages sent in this channel.
- An archive that fails verification shows nothing from it.

The hosted channel page mounts `ImportedHistorySection` once the external channel's imported-history transport adapter lands. That adapter is not part of this feature.

```sh
pnpm --filter @khala/web exec vitest run --config ../../vitest.config.ts src/features/imported-history
pnpm --filter @khala/web exec node --import tsx --test src/features/imported-history/imported-history.browser.spec.ts
```
