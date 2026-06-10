# 🎤 Pronunciation Tetris

Juego de pronunciacion para Linux. **Pegás un párrafo** y el juego lo divide en
**sub-jefes** (una oración por cada `.` o salto de línea). Vas derrotando oración
por oración, y el **jefe final** es leer **todo el párrafo** de corrido.

Para avanzar tenés que superar el umbral (94% por defecto) en **cada sonido**.
Cuando fallás, el juego cuenta **qué palabras** fallaste; con **`R`** practicás
las que más te cuestan — práctica **dirigida por datos**, no al azar.

A diferencia de copiar y pegar en Google Translate, acá Azure te dice
**exactamente que fonema fallaste** (`/dʒ/ 62%`, `/θ/ 71%`), no solo si zafaste.

## Por que Azure

El corazon del juego no es la UI, es el **scoring de pronunciacion**. Transcribir
con un ASR (Whisper, Vosk) y comparar strings NO mide pronunciacion: esos
motores estan entrenados para "corregirte" el acento, asi que te darian 100% con
una pronunciacion pesima. Azure **Pronunciation Assessment** trabaja a nivel
fonema (la tecnica GOP, _Goodness of Pronunciation_) y devuelve un score real de
calidad, ya calibrado.

## Setup

### 1. Dependencias del sistema (Ubuntu/Debian)

```bash
sudo apt install python3-tk libasound2 libssl-dev
```

- `python3-tk` → la interfaz grafica (tkinter).
- `libasound2` → captura de microfono (ALSA), que usa el SDK de Azure.
- `libssl-dev` → TLS para hablar con Azure.

> **Importante:** este proyecto usa el **Python del sistema** a proposito (ver
> `[tool.uv] python-preference = "only-system"` en `pyproject.toml`). El Python
> "standalone" que uv descarga por defecto linkea `libX11` estaticamente, lo que
> rompe `XInitThreads()` y hace crashear tkinter con threads (error de XCB
> "Unknown sequence number ... Aborting"). Por eso necesitas `python3-tk` del
> sistema y NO el Tk empaquetado.

### 2. Recurso de Azure Speech (una sola vez)

1. Entrá a https://portal.azure.com
2. **Create a resource** → buscá **Speech** → **Create**.
3. Elegí el free tier **F0** si esta disponible (5 horas de audio gratis/mes).
4. Creado el recurso → **Keys and Endpoint** → copiá **KEY 1** y la **Region**.

### 3. Instalar dependencias con uv

```bash
uv sync
```

Eso crea el entorno (`.venv/`) y instala todo desde `pyproject.toml` /
`uv.lock`. No hace falta activar el venv a mano. Para agregar una dependencia
mas adelante: `uv add <paquete>`.

### 4. Credenciales

```bash
cp .env.example .env
# Editá .env y pegá tu AZURE_SPEECH_KEY y AZURE_SPEECH_REGION
```

## Jugar

```bash
uv run app.py
```

`uv run` sincroniza las dependencias solo antes de arrancar, asi que ni siquiera
hace falta correr `uv sync` por separado.

### Teclas

| Tecla         | Accion                                              |
| ------------- | --------------------------------------------------- |
| `Shift+Enter` | Empezar (pegá el párrafo; Enter solo = salto de línea) |
| `Espacio`     | Grabar / reintentar / avanzar al siguiente objetivo |
| `F`           | Escuchá la correcta (voz de Azure)                  |
| `D`           | Escuchá tu voz (tu grabación)                       |
| `S`           | Reintentar el objetivo (aunque ya lo hayas pasado)  |
| `A`           | **Toggle** al jefe final: entrás y, apretando de nuevo, volvés |
| `X`           | Reiniciar la lista de palabras a practicar (del objetivo) |
| `Q` / `W`     | Navegar al sub-jefe anterior / siguiente            |
| `R`           | Practicar las palabras con más errores (modo datos) |
| `Ctrl+R`      | Reset: limpiar todo y volver al inicio              |
| `Ctrl+T`      | Probar el micrófono (en la pantalla inicial)        |
| `Esc`         | Salir                                               |

> Las teclas (`F`, `D`, `S`, `A`, `R`, `X`, `Q`, `W`) se configuran en el dict
> `KEYS` al principio de `app.py` — **una sola fuente de verdad**: cambiás la
> letra ahí y se actualiza en los atajos y en todas las pistas en pantalla.

**Sub-jefes y modo práctica:** cada oración del párrafo es un sub-jefe; el jefe
final es leer el párrafo entero. En cualquier oración (o en el jefe), el juego
cuenta los errores **por palabra** (un contador por objetivo). Apretá `R` para
drillear las palabras que más fallaste (de peor a mejor) y después volvés donde
estabas; `X` reinicia esa lista. Navegás entre objetivos con `Q`/`W`. **Hacé clic
en cualquier palabra del desglose para oírla** (recordatorio rápido, sin entrar al
drill). Arriba se ve un **progreso tipo Tetris**: **verde** = derrotado, **rojo** =
intentado sin derrotar, **gris** = no intentado. El actual se marca con ▶ y el jefe con ♛.

> El **jefe final** (párrafo entero) usa **reconocimiento continuo** de Azure en
> vez de `recognize_once` (que corta a los ~15 s): así podés leer todo de corrido,
> con pausas entre oraciones. Corta solo tras ~3,5 s de silencio prolongado.

En la **pantalla inicial** hay un desplegable para elegir el **micrófono** que
querés usar (por defecto, el del sistema) y un botón **🎧 Probar (Ctrl+T)**:
graba 3 segundos y te los reproduce, para confirmar que el mic anda antes de
jugar. La elección se fija al empezar.

> Nota técnica: los micrófonos `hw:` crudos de ALSA suelen no soportar 16 kHz.
> La app detecta la frecuencia que cada mic soporta y graba en esa (16 kHz si
> puede, si no la nativa). Si un mic no te graba, probá la opción `pulse` o
> `default` del desplegable.

> Para grabar y reproducir tu voz se usa `sounddevice` (necesita `libportaudio2`)
> y un reproductor de WAV (`aplay` de `alsa-utils`, o `paplay`/`ffplay`). Si algo
> de eso falta, el juego **igual puntúa** tu pronunciación; solo no vas a poder
> reproducir tu grabación con `S`.

## Coach con IA (DeepSeek) — opcional

Si configurás `DEEPSEEK_API_KEY` en `.env`, un LLM (DeepSeek) **te da consejos
personalizados** de cómo arreglar cada sonido flojo cuando practicás una palabra:
aparece en un recuadro destacado, después de la pista estática, sin frenar el
juego, y varía el enfoque si ya llevás varios intentos.

Si no ponés la key, todo funciona igual con las pistas estáticas. Conseguí tu key
en https://platform.deepseek.com.

## Ajustes

Todo se toca en `.env`:

- `PASS_THRESHOLD` → el umbral para "derrotar" (default 94). Hay que superarlo
  en **cada** sonido (no en el promedio).
- `NEAR_MISS_MARGIN` → 2da vía para pasar (default 5): si tu **promedio** quedó
  a ≤ N puntos del umbral **y** el reconocedor escuchó la palabra correcta,
  avanzás igual.
- `TARGET_LANGUAGE` → `en-US`, `en-GB`, etc.
- `TTS_VOICE` → voz para el "escuchá como se dice" (ej. `en-US-AvaNeural`,
  `en-GB-SoniaNeural`).
- `CEFR_LEVEL` → nivel del alumno (default `B2`). Los consejos del LLM se
  adaptan a este nivel.
- `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL` → coach con IA (opcional, ver arriba).

## Arquitectura

| Archivo      | Responsabilidad                                                  |
| ------------ | ---------------------------------------------------------------- |
| `config.py`  | Carga credenciales y parametros (.env / entorno).                |
| `scorer.py`  | **Unico** punto que habla con Azure: scoring + TTS.              |
| `coach.py`   | **Unico** punto que habla con DeepSeek: consejos (opcional).     |
| `app.py`     | UI tkinter + maquina de estados (sub-jefes) + threading.         |

El scoring corre en un **hilo aparte** (Azure bloquea mientras escucha); si no,
la ventana se congelaria. La UI recibe el resultado por una `queue`. Si algun
dia querés cambiar a un motor offline (wav2vec2 + GOP), **solo tocás `scorer.py`**.
