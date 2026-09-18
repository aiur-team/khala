# Brand asset sources

This ticket (KHA-107) is scoped to `apps/web/src/brand/` and `apps/web/src/shell/`.
The Aiur application source tree (`../aiur`) referenced by
`docs/evidence/ui-planning-grounding.md` and
`docs/evidence/client-reuse.md` is not checked out in this workspace, so no
Aiur-owned file was read or copied byte-for-byte. Numeric design tokens below
are transcribed from those two evidence documents (dashboard 960px breakpoint,
15rem nav, 2.6rem collapsed rail, 75rem content measure, 16/24px panel radii,
semantic ink/fill pairs) and from the already browser-tested fixture at
`experiments/client-reuse/sdk/src/style.css`, itself derived from the same
evidence. No Aiur/Archon process, configuration, route, or authentication was
touched to produce these values.

## Logo

No raster Aiur logo asset is vendored in this PR. The Aiur source repository
that holds the actual logo file is not accessible from this workspace, and
fabricating a replacement image would invent a product identity, which the
plan's assumptions explicitly rule out ("no new logo or invented product
identity"). The topbar instead renders the literal wordmark "AIUR" set in the
vendored Bungee typeface (the same face the plan's Aiur reference route
heading uses). A worker with access to `../aiur/website/public/images/` should
add the real asset plus its source commit and SHA-256 in a follow-up change to
this file; nothing here should be read as "the logo, adopted."

## Fonts

Vendored under the SIL Open Font License 1.1 from the
[`google/fonts`](https://github.com/google/fonts) repository at commit
[`a54f7446f84a1125ef6bf08baa46f3639e8905e0`](https://github.com/google/fonts/commit/a54f7446f84a1125ef6bf08baa46f3639e8905e0)
(fetched 2026-09-17). Only the weights this page uses are vendored, compressed
to WOFF2 with `woff2_compress`; the OFL text and copyright/reservedFontName
notices are carried alongside each family, unmodified, from the same commit.

| Family | Source file (git blob SHA) | Vendored file | SHA-256 (woff2) |
| --- | --- | --- | --- |
| Bungee Regular | [`ofl/bungee/Bungee-Regular.ttf`](https://github.com/google/fonts/blob/a54f7446f84a1125ef6bf08baa46f3639e8905e0/ofl/bungee/Bungee-Regular.ttf) (blob `59dfddc539f9ebbaf5134c7b272970d88aba0ba9`) | `fonts/Bungee-Regular.woff2` | `4513a7d68c82c053f363075a8aee249d60146f7c0bb7236cd27d721bffd16eeb` |
| Space Grotesk (variable, 300–700) | [`ofl/spacegrotesk/SpaceGrotesk[wght].ttf`](https://github.com/google/fonts/blob/a54f7446f84a1125ef6bf08baa46f3639e8905e0/ofl/spacegrotesk/SpaceGrotesk%5Bwght%5D.ttf) (blob `a1b2e6c26093066510a31147e7aec9abdc8d6c5e`) | `fonts/SpaceGrotesk-Variable.woff2` | `cb48953e20ccd61690a20f1d910d333aa3a352e62ac18d3ffc4e0264a3c4aaa4` |
| JetBrains Mono (variable, 100–800) | [`ofl/jetbrainsmono/JetBrainsMono[wght].ttf`](https://github.com/google/fonts/blob/a54f7446f84a1125ef6bf08baa46f3639e8905e0/ofl/jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf) (blob `aa310be8b717fe3774f9444dd89d5f4101cc6d10`) | `fonts/JetBrainsMono-Variable.woff2` | `11038e282dd7cb983dfc4e565017f37a91041c073c8929771fb6e64d27814396` |

License files, unmodified from the same commit:

| License | Vendored file | Source (git blob SHA) |
| --- | --- | --- |
| Bungee OFL | `fonts/Bungee-OFL.txt` | [`ofl/bungee/OFL.txt`](https://github.com/google/fonts/blob/a54f7446f84a1125ef6bf08baa46f3639e8905e0/ofl/bungee/OFL.txt) (blob `6f47072f01b8698301896b247b7087c023a4da2d`) |
| Space Grotesk OFL | `fonts/SpaceGrotesk-OFL.txt` | [`ofl/spacegrotesk/OFL.txt`](https://github.com/google/fonts/blob/a54f7446f84a1125ef6bf08baa46f3639e8905e0/ofl/spacegrotesk/OFL.txt) (blob `cb512b9af44ff61e75e1aad387b7424cdfab36a3`) |
| JetBrains Mono OFL | `fonts/JetBrainsMono-OFL.txt` | [`ofl/jetbrainsmono/OFL.txt`](https://github.com/google/fonts/blob/a54f7446f84a1125ef6bf08baa46f3639e8905e0/ofl/jetbrainsmono/OFL.txt) (blob `821a3dac22aff15a1f1c9689a1d79c45bb58ca39`) |

Pre-compression TTF SHA-256 (for reproducing the WOFF2 conversion):

- Bungee-Regular.ttf: `c4f5361ce120af3e6b9156d0bf379fa19cda2ea0cd18ac01fd99596c6bf66e3f`
- SpaceGrotesk[wght].ttf: `acad6de1fc93436f5c0f1f4137751ef04f1aea3063e7036535970ffcfbd79f72`
- JetBrainsMono[wght].ttf: `48715a42ec242c21e9f02692891e147d022299a52e48d5e413e1a942193ffeda`

Font-family names in `fonts.css` are prefixed `Khala ` so the vendored faces
never collide with a future embedding host's own use of the same open-source
family names.
