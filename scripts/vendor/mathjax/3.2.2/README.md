# Bundled MathJax subset

This directory contains a pinned, unmodified subset of MathJax 3.2.2 from
the official `mathjax` npm package. It is sufficient for Node.js TeX-to-SVG
rendering with the TeX input jax, SVG output jax, and TeX path font.

Included upstream files:

- `es5/node-main.js`
- `es5/input/tex-full.js`
- `es5/output/svg.js`
- `es5/output/svg/fonts/tex.js`
- `LICENSE`

The four runtime files total about 1.8 MB. No network request, npm install,
browser, or local TeX distribution is needed at render time. The wrapper in
`scripts/render-formula.mjs` validates the expression before invoking this
code, rejects non-path glyphs, and emits a standalone SVG.

Upstream: https://github.com/mathjax/MathJax/tree/3.2.2

Integrity (SHA-256):

```text
a3e6f8f69fb7a786f4b4d08f0f17781381996ec2c278a0f406f9e812ffa809b2  es5/node-main.js
de76b151355304bde8217d8056264d9c2bec2f47acb7ffd4d142cbe14f5b0035  es5/input/tex-full.js
6fdee599b240851fd27b31017e1a18802d99743ac4fae8204998997176647609  es5/output/svg.js
6afb8e7f4f7f19255c4b111f4a00c06716b70ea9b977516127c054e7799d2da4  es5/output/svg/fonts/tex.js
```

MathJax is licensed under Apache License 2.0; see `LICENSE` in this directory.
