# 🎤 Pronunciation Tetris

Juego web de pronunciación de inglés. Pegas un párrafo (o subes una foto y el
OCR lo extrae), el juego lo divide en **sub-jefes** (una oración por cada `.`
o salto de línea) y el **jefe final** es leer todo el párrafo de corrido.
Derrotas una oración cuando tu **promedio supera el umbral** y **ninguna
palabra queda en rojo** (<50). El scoring lo hace Azure Pronunciation
Assessment a nivel fonema.

**Juega ya:** https://iam-oov.github.io/english-full/ — necesitas una key
gratuita de Azure Speech (tier F0), se configura en ⚙ Ajustes y vive solo en
tu navegador. Sin key puedes recorrerlo todo con el modo demo:
https://iam-oov.github.io/english-full/?demo

## Desarrollo

Todo el código vive en [`web/`](web/) (Astro + React):

```bash
cd web
pnpm install
pnpm dev        # http://localhost:4321
pnpm test       # unitarios (vitest)
pnpm e2e        # Playwright contra ?demo
```

Detalles de arquitectura en [`web/README.md`](web/README.md). Cada push a
`main` que toca `web/` despliega a GitHub Pages; los PRs corren lint,
type-check, unitarios, build y e2e.
