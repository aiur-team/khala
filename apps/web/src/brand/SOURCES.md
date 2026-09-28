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

Khala imports Bungee, Space Grotesk, and JetBrains Mono from the pinned
[`@aiur/components` package](https://github.com/aiur-team/aiur/tree/ad7975717e3124421c915aff483b10b7d4efeaad/packages/components).
That package owns the font files, `@font-face` declarations, SIL Open Font
License notices, theme tokens, and shared control styles. `fonts.css` here is
only a compatibility import for existing Khala browser harnesses.
