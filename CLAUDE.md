# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Qué es

**English Boss** (antes Pronunciation Tetris): juego web de pronunciación de inglés (Astro + React,
en `web/`). Pegas un párrafo (o lo extraes de una foto con OCR), el juego lo
parte en oraciones (sub-jefes) y el párrafo entero es el jefe final. Cada 4
oraciones se intercala un **reto** (`kind: "challenge"`): las palabras más
falladas acumuladas se leen como una línea y se juzgan igual que una oración;
sin palabras pendientes, el reto se salta solo (pase libre). Una palabra que
sale del rojo/naranja (>80, banda azul o mejor) abandona la lista de práctica
— en el reto, todas las listas. El
scoring real lo hace **Azure Pronunciation Assessment** (a nivel fonema,
directo desde el navegador con el SDK de JS); un ASR común NO sirve porque
"corrige" el acento. No hay backend: la key de Azure vive en el localStorage
del jugador.

**Regla de aprobado** (semáforo): WIN = promedio ≥ umbral **y** ninguna
palabra en rojo (≤ corte de rojo, default 50 y configurable en ajustes).
Bandas: rojo ≤ corte · naranja hasta 80 · azul 81–umbral ("me gustó, sigue
practicando") · ≥ umbral tinta normal. Naranja/azul no bloquean si el
promedio alcanza; las inserciones (palabras dichas de más, p. ej. un eco)
tampoco. El umbral mínimo permitido es 80 (`MIN_THRESHOLD`). Vive en
`web/src/lib/scoring.ts` (`scoreBand`, `judge`), puro y testeado.

## Comandos (desde `web/`)

```bash
pnpm dev      # http://localhost:4321
pnpm build    # dist/ estático
pnpm test     # unitarios (vitest, solo src/**/*.test.ts)
pnpm e2e      # Playwright contra el build (usa ?demo, sin mic ni key)
pnpm lint     # eslint
pnpm check    # astro check (type-check real)
```

`?demo` en la URL reemplaza el scorer por un stub determinista
(`src/lib/demo.ts`): primer intento falla, segundo pasa. Es la base del e2e y
del QA visual sin credenciales.

## Arquitectura (`web/src/`)

Puertos y adaptadores; la UI solo conoce los puertos:

| Módulo | Responsabilidad |
| --- | --- |
| `lib/constants.ts` | Perillas fijas del juego (cortes del semáforo, mínimos, voz TTS, presets Mid/Senior). Cero imports: cualquiera depende de él, nunca al revés. |
| `lib/ports.ts` | `ScorerPort` + `AssessOptions` (el contrato). |
| `lib/scorer.ts` | ÚNICO punto que habla con Azure (assessment once/continuo + TTS). |
| `lib/coach.ts` | ÚNICO punto que habla con DeepSeek (opcional; null = degradar a pistas estáticas). |
| `lib/scoring.ts` | Regla de aprobado (`judge`, `assessmentUnits`, `redCount`). |
| `lib/game.ts` | Targets, `splitSentences` (Intl.Segmenter + abreviaturas), `KEYS`, pistas IPA, `failHint`. |
| `lib/align.ts` | Alinea la oración original con las palabras de Azure (omisiones/inserciones/guiones). Invariante: ante desync, un token queda SIN resaltar, nunca corrido. |
| `lib/run.ts` | Persistencia de la corrida (localStorage, **posicional** sobre los targets — valida longitudes al cargar). |
| `lib/config.ts`, `lib/progress.ts` | Ajustes y XP/nivel en localStorage (las llaves conservan el prefijo legado `pronunciation-tetris.` — cambiarlas borraría los datos de todos). |
| `lib/ocr.ts`, `lib/audio.ts` | Tesseract (import dinámico) y mic test/playback. |
| `components/EnglishBoss.tsx` | Toda la UI + máquina de estados. No sabe de Azure/DeepSeek. |

### Patrones clave del componente

- **Estado en un ref mutable `G`** + `forceUpdate`: los handlers de teclado y
  las continuaciones async leen estado vivo sin closures viejas. Es deliberado
  — no migrar a reducer/store. ESLint tiene `react-hooks/refs` apagada por
  esto.
- **`G.gen`** invalida trabajo async viejo (un assessment/TTS/consejo que
  llega tras un reset se descarta). Además `assess()` recibe `AbortSignal`
  para soltar el micrófono al instante al abandonar un intento.
- **Restauración re-juzga**: `restoreRun` reconstruye la vista desde el
  assessment persistido con las reglas/umbral ACTUALES (un veredicto guardado
  con reglas viejas no sobrevive). Solo se persiste la fuente de verdad.
- El shell es de altura fija sin scroll global: scrollean internamente el
  carril, el stage y la hoja de inicio.

## Convenciones

- **Comentarios**: en inglés y mínimos — nada de narración; solo porqués no
  obvios. Nada de docblocks explicativos en código nuevo.
- **Copy de UI**: español mexicano (tuteo: "sigue", "saca", "por ti") — nunca
  voseo.
- CSS: un `global.css` con custom properties (tema claro) y prefijo `pt-`;
  colores del semáforo desde las mismas variables en inline y tabla
  (`scoreTone`/`tokClass` son la única fuente).

## Deploy y versión

- Push a `main` que toque `web/` → `.github/workflows/deploy.yml` publica a
  GitHub Pages (`https://iam-oov.github.io/english-full/`). El build de Pages
  usa `GITHUB_PAGES=true` (activa el `base`) — el dev/preview local sirve
  desde la raíz.
- PRs que tocan `web/` → `.github/workflows/test.yml` (lint + check + vitest
  + build + e2e).
- La versión del badge vive en **`web/version.ts`** (única fuente): para
  subirla, editar ese archivo. En dev el badge agrega el sufijo `-dev`.
