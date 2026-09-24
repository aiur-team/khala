# Brand asset sources

The original shell tokens and fonts were established by KHA-107. The public
splash additionally vendors the Aiur identity assets below from the Aiur-owned
Archon repository. No asset is hot-linked at runtime.

## Aiur logo and favicons

Copied byte-for-byte on 2026-09-24 from
[`aiur-team/archon`](https://github.com/aiur-team/archon) commit
[`1c3e8c01aa88e25aa9c12c7fb6e4756b159e94f7`](https://github.com/aiur-team/archon/commit/1c3e8c01aa88e25aa9c12c7fb6e4756b159e94f7).
The source blob and local SHA-256 make each copy independently verifiable.

| Asset | Source file (git blob SHA) | Vendored file | SHA-256 |
| --- | --- | --- | --- |
| Aiur logo | `site/assets/aiur-logo.png` (`b219fa42daa0e36378b9df8986ac82adc06c1890`) | `../landing/public/assets/aiur-logo.png` | `5f3b8f3dfa3c1376c775ede482bbb2048bbc4a9c51fd4535ba826f0ec7ac7482` |
| Multi-size favicon | `site/favicon.ico` (`6a05839e65709251ccbe2048357ef9f091a62768`) | `../landing/public/favicon.ico` | `7e2c794adfa502c40ec7a6a122bf4440d23117d18c579bf891defc5bc3727f01` |
| 16px favicon | `site/favicon-16x16.png` (`72bec0968bd36d792080a8ceaa6ab4c080f1268d`) | `../landing/public/favicon-16x16.png` | `f1dd7161e923cd8ef3e28f73564e3255add3932756b118eb36bc37a3274cf6d5` |
| 32px favicon | `site/favicon-32x32.png` (`1a0b37f57f4a2058614b28ea140ffbb6744dd197`) | `../landing/public/favicon-32x32.png` | `7eeb7e8034e0613e2984d97bb8b61bd18497e915542359767862e4b6214e5daa` |
| Apple touch icon | `site/apple-touch-icon.png` (`7bab655b70b02a321f0069142278130cd4ee4e6b`) | `../landing/public/apple-touch-icon.png` | `69803b1146c7f6ea7a242eb6aae14a9951d058ea4aaf7fcac6fbe0cd54c33ca9` |

## Aiur banner and footer

The announcement text (`Introducing Aiur: AI Unit Runtime for Executors`),
`Learn More` link, and `built with Aiur` footer treatment are copied from
`site/index.html` at the Archon commit above. Their styling is adapted to the
same vendored fonts and brand tokens already used by Khala's splash.

The hero flow-field keepouts and animated scroll cue are adapted from
`website/src/flowField.ts`, `website/src/styles.css`, `website/src/main.ts`, and
`website/index.html` in `aiur-team/aiur` commit
`0972f02977ecc77fbcce4ae30cae80aa2c879a18`. They are bundled into the landing
build and make no external requests.

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
