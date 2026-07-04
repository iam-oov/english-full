# Pronunciation Tetris — web

Port web (Astro + React) del juego de escritorio que vive en la raíz del repo.
Misma mecánica: pegás un párrafo, cada oración es un sub-jefe y el párrafo
entero es el jefe final. Solo avanzás si **cada sonido** supera el umbral
(94% por defecto), no el promedio; el near-miss es la segunda vía.

**Diseño** (variante "3b — carril lateral", tema claro): el feedback por
palabra va **inline en la oración** — las palabras bajo el umbral se resaltan
con su score en superíndice, las omitidas con subrayado punteado, y las dichas
de más se anotan aparte; clic en una palabra la reproduce. La ruta del párrafo
vive en un **carril a la derecha** (✓ + mejor score por oración, clic navega;
en pantallas angostas se abre como drawer). Las acciones son botones con su
atajo de teclado como hint — el teclado (Espacio/F/D/S/A/R/X/Q/W/P/L) sigue
mandando. La pantalla inicial (variante "1d") ofrece párrafo o imagen como
entrada en dos cards lado a lado, con el micrófono, la prueba (chip "mic OK")
y el botón Empezar en una misma barra.

## Correr

```bash
pnpm install
pnpm dev        # http://localhost:4321
pnpm build      # genera dist/ (sitio 100% estático)
pnpm preview
```

**Modo demo**: `http://localhost:4321/?demo` reemplaza el scorer por un stub
enlatado (`src/lib/demo.ts`): el primer intento con cada objetivo falla (con
omisión e inserción incluidas) y el segundo pasa. Sirve para recorrer todo el
juego —fail inline, práctica, pass, victoria— sin micrófono ni key de Azure.

## Credenciales

No hay backend: el SDK de Azure Speech para JavaScript habla directo desde el
navegador. Al abrir el juego, entrá a **⚙ Ajustes** y pegá tu
`AZURE_SPEECH_KEY` y región (el tier gratis F0 alcanza). Todo se guarda en
`localStorage`; la key nunca sale de tu navegador.

El coach con IA (DeepSeek) es opcional, igual que en el escritorio: sin key se
usan las pistas estáticas. Ojo: la API de DeepSeek puede rechazar pedidos
hechos desde un navegador (CORS); si pasa, el juego degrada solo a las pistas
estáticas, sin romper nada.

## Entrada desde imagen (OCR)

En la pantalla inicial podés cargar una foto/captura de un texto en inglés:
con el botón **🖼 Leer de una imagen**, pegando la imagen con Ctrl+V sobre el
cuadro de texto, o arrastrándola encima. El flujo:

1. **OCR client-side** con Tesseract.js (WASM; la primera vez descarga el
   worker y los datos de idioma de un CDN, así que necesita red).
2. **Limpieza** (`src/lib/ocr.ts`): des-guionado de fin de línea, unión de
   líneas partidas en párrafos, descarte de basura sin letras (números de
   página, símbolos sueltos).
3. **División en sub-jefes**: si hay key de DeepSeek, el coach corrige errores
   de OCR y separa oraciones con el LLM (`coach.smartSplit`, JSON mode); si
   no —o si falla—, `splitSentences` usa `Intl.Segmenter` con re-unión de
   abreviaturas ("Mr.", "p.m.", iniciales), que es bastante más listo que
   partir por ".".

El resultado cae al textarea **una oración por línea** (cada línea = un
sub-jefe; el párrafo completo = jefe final), editable antes de empezar: el OCR
a veces inventa, conviene revisar.

## Arquitectura

Se conserva la frontera de puertos y adaptadores del original:

| Módulo | Espejo de | Responsabilidad |
| --- | --- | --- |
| `src/lib/scorer.ts` | `scorer.py` | **ÚNICO** punto que habla con Azure: assessment (once + continuo para el jefe) y TTS. |
| `src/lib/coach.ts` | `coach.py` | **ÚNICO** punto que habla con DeepSeek (opcional, degrada a null). |
| `src/lib/scoring.ts` | `scoring.py` | Regla de aprobado (estricta + near-miss), dominio puro. |
| `src/lib/game.ts` | modelo de `app.py` | Targets, split de oraciones, teclas (`KEYS`), pistas de fonemas. |
| `src/lib/progress.ts` | `progress.py` | XP / nivel / accuracy de por vida, en localStorage. |
| `src/lib/config.ts` | `config.py` | Ajustes (en localStorage en lugar de `.env`). |
| `src/lib/audio.ts` | `audio.py` | Mic test y reproducción local (getUserMedia / MediaRecorder). |
| `src/lib/align.ts` | — | Alineación referencia ↔ palabras de Azure para el feedback inline (maneja omisiones, inserciones y puntuación; ante desync degrada a "sin resaltar", nunca a un resaltado corrido). |
| `src/lib/demo.ts` | — | Scorer de mentira para el modo `?demo` (QA sin Azure). |
| `src/components/PronunciationTetris.tsx` | UI de `app.py` | Máquina de estados + render. No sabe de Azure/DeepSeek. |

Donde el escritorio usaba hilos + `queue` + `_poll`, acá alcanza con
async/await (el SDK de JS no bloquea). Se conserva el contador `gen` que
invalida trabajo asíncrono viejo tras un reset o cambio de objetivo.

Notas de plataforma que se trasladan del original:

- `recognizeOnceAsync` corta a ~15s → el jefe usa reconocimiento **continuo**
  con corte por silencio prolongado (~3.5s), igual que `_recognize_continuous`.
- La captura propia para "escuchá tu voz" (D) corre en paralelo con
  MediaRecorder; si el navegador no deja, el scoring sigue y solo se pierde la
  reproducción (mismo fallback que sounddevice → mic directo).
- Ctrl+R es el reset del juego (se hace `preventDefault` para que no recargue
  la página); Esc también resetea (acá no hay ventana que cerrar).
