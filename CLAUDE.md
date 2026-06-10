# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Qué es

**Pronunciation Tetris**: juego de pronunciación de inglés para Linux. Pegás un
párrafo, el juego lo parte en oraciones (sub-jefes) y el párrafo entero es el
jefe final. Para avanzar tenés que superar el umbral en **cada sonido**, no en
el promedio. El scoring real lo hace **Azure Pronunciation Assessment** (a nivel
fonema, técnica GOP); transcribir con un ASR común NO sirve porque esos motores
"corrigen" el acento y te darían 100% con una pronunciación mala.

## Comandos

```bash
uv run app.py     # correr el juego (uv sincroniza deps solo antes de arrancar)
uv sync           # instalar/actualizar el .venv desde pyproject.toml + uv.lock
uv add <paquete>  # agregar una dependencia
```

Dependencias del sistema (Ubuntu/Debian): `sudo apt install python3-tk
libasound2 libssl-dev` (más `libportaudio2` para `sounddevice` y `alsa-utils`
para reproducir WAVs con `aplay`).

**No hay tests, ni linter, ni build configurados.** Es una aplicación, no una
librería: por eso `pyproject.toml` no tiene `[build-system]` y uv la trata como
proyecto "virtual" (instala deps en `.venv/`, no empaqueta el código).

## Arquitectura

Cuatro módulos con una frontera de **puertos y adaptadores** bien marcada:

| Archivo     | Responsabilidad |
| ----------- | --------------- |
| `config.py` | Carga `.env` (parser propio, sin deps) → dataclass `Config` inmutable. |
| `scorer.py` | **ÚNICO** punto que habla con Azure: captura de mic + scoring + TTS. |
| `coach.py`  | **ÚNICO** punto que habla con DeepSeek: consejos con IA (opcional). |
| `app.py`    | UI tkinter + máquina de estados + threading. No sabe de Azure/DeepSeek. |

Esa frontera es el invariante principal: `app.py` pide "evaluá esto" / "dame un
consejo" sin saber qué motor hay abajo. **Si algún día se cambia a un motor
offline (wav2vec2 + GOP), solo se toca `scorer.py`.** No metas llamadas a Azure
ni a la API de DeepSeek dentro de `app.py`.

`coach.py` (DeepSeek) es **opcional y sin regresión**: si no hay
`DEEPSEEK_API_KEY`, `Coach.available` es `False`, nunca se llama, y el juego cae
a la heurística de dificultad + pistas estáticas. La API de DeepSeek es
compatible con la de OpenAI (`/chat/completions`), por eso se habla por HTTP
plano con `requests`, sin SDK.

### Modelo de juego (`app.py`)

- `_split_sentences()` parte el párrafo por `.` **y** por salto de línea. Cada
  oración resultante es un `Target` de tipo `"sentence"` (sub-jefe).
- Si hay más de una oración, se agrega un `Target` `"boss"` = el párrafo entero.
- El tipo `"word"` solo aparece en el modo práctica (tecla R: drillear las
  palabras que más fallaste del objetivo actual).
- `Game` lleva la lista de `targets` y el `index`. `MULTIWORD = ("sentence",
  "boss")` distingue objetivos de varias palabras de la palabra suelta.

**Regla de aprobado (clave, no es obvia):** se "derrota" un objetivo solo si
**TODOS** los fonemas (palabra) o **TODAS** las palabras (jefe) superan
`PASS_THRESHOLD`, no el promedio. `NEAR_MISS_MARGIN` es una 2da vía: si el
promedio quedó a ≤ N puntos del umbral **y** el reconocedor escuchó el texto
correcto, pasa igual.

### Modelo de threading (clave)

Azure **bloquea** mientras escucha. Si eso corriera en el hilo de tkinter, la
ventana se congela. Patrón:

1. Las operaciones que bloquean (`scorer.assess`, `scorer.speak`,
   `record_test`) corren en un `threading.Thread(daemon=True)`.
2. El hilo publica el resultado en `self.results` (`queue.Queue`).
3. `_poll()` se reprograma con `root.after(80, ...)` y drena la cola en el hilo
   de la UI; ahí (y SOLO ahí) se toca tkinter.

**Regla de oro:** los callbacks del SDK de Azure (`on_status`, eventos de
sesión) corren en hilos internos del SDK → **solo pueden encolar mensajes,
nunca tocar widgets de tkinter directamente.**

- `self._gen` es un contador que **invalida trabajo async viejo**: cuando cambia
  el contexto (reset, nuevo objetivo, nueva grabación) se incrementa, y un
  consejo del coach que llega tarde con un `gen` distinto se descarta.
- Estados (`self.state`): `input | ready | recording | fail | pass | win`.
- `self._status` y `self._errors` se indexan por `id(Target)` (no por posición),
  para que la barra de progreso y la lista de errores no mientan al navegar Q/W.

### Teclas

El dict **`KEYS`** al principio de `app.py` es la **única fuente de verdad** de
las teclas de audio (F/D/S/A/R/X/Q/W). Cambiás la letra ahí y se actualiza en
los bindings y en todas las pistas en pantalla. No hardcodees teclas en otro
lado: usá `self._k(action)`.

## Gotchas de plataforma (te ahorran horas)

- **X11 + threads → crash de XCB.** `_init_x11_threads()` (ctypes
  `XInitThreads()`) DEBE ser lo primero en `main()`, antes de cualquier
  `tk.Tk()`. Y `pyproject.toml` fija `python-preference = "only-system"` +
  `requires-python = ">=3.12,<3.13"` **a propósito**: el Python "standalone" que
  uv descarga linkea `libX11` estáticamente, así que `XInitThreads()` le habla a
  otra libX11 y no surte efecto → `[xcb] Unknown sequence number ... Aborting`.
  No cambies eso ni uses 3.13.
- **Azure: dos clases de audio NO intercambiables.**
  `speechsdk.audio.AudioConfig` = ENTRADA (mic, para `assess`).
  `speechsdk.audio.AudioOutputConfig` = SALIDA (parlante, para `speak`/TTS).
- **`recognize_once` corta a ~15s.** Por eso el jefe final (párrafo entero) usa
  reconocimiento **continuo** (`_recognize_continuous`), que acumula frases
  hasta detectar silencio prolongado. El tope de 15s es del MODO, no del pricing
  tier: pagar (F0→S0) no lo cambia.
- **Mics `hw:` crudos de ALSA no soportan 16kHz.** `_pick_samplerate` prueba
  16k (lo ideal para Azure) y cae a la frecuencia nativa si el mic no la
  soporta. No fuerces 16k.
- **Captura propia para reproducir tu voz.** `assess` captura el audio con
  `sounddevice` (push stream) para poder reproducirlo después; si eso falla
  (sin portaudio, mic raro), cae al micrófono directo de Azure: el scoring sigue
  funcionando, solo se pierde la reproducción.

## Configuración (`.env`)

Credenciales obligatorias: `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`. Ajustes:
`PASS_THRESHOLD` (94), `NEAR_MISS_MARGIN` (5), `TARGET_LANGUAGE` (en-US),
`TTS_VOICE`/`TTS_PITCH`/`TTS_RATE` (vía SSML `<prosody>`), `CEFR_LEVEL` (B2,
calibra los consejos del LLM). Opcionales del coach: `DEEPSEEK_API_KEY`,
`DEEPSEEK_MODEL`, `DEEPSEEK_BASE_URL`.
