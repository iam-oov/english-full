# English Boss — web

Juego de pronunciación de inglés (Astro + React). Pegas un párrafo, cada
oración es un sub-jefe y el párrafo entero es el jefe final. Derrotas un
objetivo cuando tu **promedio supera el umbral** (85% por defecto) y
**ninguna palabra queda en rojo** (<50): el ámbar no bloquea, el rojo siempre.

**Diseño**: el feedback por palabra va **inline en la oración** — las
palabras flojas se resaltan con su score en superíndice (semáforo: rojo <50,
ámbar 50–umbral), las omitidas con subrayado punteado, y las dichas de más se
anotan aparte; click en una palabra la reproduce. La ruta del párrafo vive en
un **carril a la derecha** (número por oración, ✓ + mejor score, click
navega; en pantallas angostas se abre como drawer). Las palabras falladas se
acumulan en una **tabla de práctica** (con IPA y veces fallada) y el modo
práctica las drillea una por una. La corrida se **persiste en el navegador**:
un refresh te devuelve exactamente donde estabas, re-juzgando con las reglas
vigentes.

## Correr

```bash
pnpm install
pnpm dev        # http://localhost:4321
pnpm build      # genera dist/ (sitio 100% estático)
pnpm test       # unitarios (vitest)
pnpm e2e        # Playwright contra el build, usando ?demo
pnpm lint       # eslint
pnpm check      # astro check
```

**Modo demo**: `http://localhost:4321/?demo` reemplaza el scorer por un stub
enlatado (`src/lib/demo.ts`): el primer intento con cada objetivo falla (con
omisión e inserción incluidas) y el segundo pasa. Sirve para recorrer todo el
juego —fail inline, práctica, pass, victoria— sin micrófono ni key de Azure,
y es la base del e2e.

## Credenciales

No hay backend: el SDK de Azure Speech para JavaScript habla directo desde el
navegador. Al abrir el juego, entra a **⚙ Ajustes** y pega tu
`AZURE_SPEECH_KEY` y región (el tier gratis F0 alcanza) — el botón "Probar
conexión" valida región y key al instante. Todo se guarda en `localStorage`;
la key nunca sale de tu navegador.

El coach con IA (DeepSeek) es opcional: sin key se usan las pistas estáticas.
Su "Probar conexión" distingue key inválida de bloqueo del navegador (CORS);
si la API no responde, el juego degrada solo a las pistas estáticas.

## Entrada desde imagen (OCR)

En la pantalla inicial puedes cargar una foto/captura de un texto en inglés:
con la card **Soltá una imagen**, pegándola con Ctrl+V sobre el cuadro de
texto, o arrastrándola. El flujo:

1. **OCR client-side** con Tesseract.js (WASM, import dinámico; la primera
   vez descarga el worker de un CDN, así que necesita red).
2. **Limpieza** (`src/lib/ocr.ts`): des-guionado de fin de línea, unión de
   líneas partidas en párrafos, descarte de basura sin letras.
3. **División en sub-jefes**: si hay key de DeepSeek, el coach corrige
   errores de OCR y separa oraciones con el LLM (`coach.smartSplit`); si no
   —o si falla—, `splitSentences` usa `Intl.Segmenter` con re-unión de
   abreviaturas ("Mr.", "p.m.", iniciales).

El resultado cae al textarea **una oración por línea**, editable antes de
empezar: el OCR a veces inventa, conviene revisar.

## Arquitectura

Puertos y adaptadores — la UI solo conoce los puertos:

| Módulo | Responsabilidad |
| --- | --- |
| `src/lib/ports.ts` | `ScorerPort` + `AssessOptions`: el contrato entre UI y motor. |
| `src/lib/scorer.ts` | **ÚNICO** punto que habla con Azure: assessment (once + continuo para el jefe) y TTS. |
| `src/lib/coach.ts` | **ÚNICO** punto que habla con DeepSeek (opcional, degrada a null). |
| `src/lib/scoring.ts` | Regla de aprobado (promedio + veto del rojo), dominio puro. |
| `src/lib/game.ts` | Targets, split de oraciones, teclas (`KEYS`), pistas de fonemas, `failHint`. |
| `src/lib/align.ts` | Alineación referencia ↔ palabras de Azure para el feedback inline (omisiones, inserciones, guiones; ante desync degrada a "sin resaltar", nunca a un resaltado corrido). |
| `src/lib/run.ts` | Persistencia de la corrida (posicional sobre los targets; valida longitudes al cargar). |
| `src/lib/progress.ts` | XP / nivel / accuracy de por vida, en localStorage. |
| `src/lib/config.ts` | Ajustes en localStorage. |
| `src/lib/audio.ts` | Mic test y reproducción local (getUserMedia / MediaRecorder). |
| `src/lib/demo.ts` | Scorer de mentira para el modo `?demo` (QA y e2e sin Azure). |
| `src/components/EnglishBoss.tsx` | Máquina de estados + render. No sabe de Azure/DeepSeek. |

Concurrencia: async/await + un contador `gen` que invalida trabajo asíncrono
viejo tras un reset o cambio de objetivo, y un `AbortSignal` que suelta el
micrófono al instante al abandonar un intento.

Notas de plataforma:

- `recognizeOnceAsync` corta a ~15s → el jefe usa reconocimiento **continuo**
  con corte por silencio prolongado (configurable en Ajustes).
- La captura propia para "Escuchar tu respuesta" corre en paralelo con
  MediaRecorder; si el navegador no deja, el scoring sigue y solo se pierde
  la reproducción.
- Ctrl+R es el reset del juego (`preventDefault` para no recargar la
  página); Esc también resetea.
