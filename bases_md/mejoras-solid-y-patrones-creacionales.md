# Reporte de mejoras — SOLID y patrones creacionales

**Proyecto:** Pronunciation Tetris
**Alcance:** análisis arquitectónico de `app.py`, `scorer.py`, `coach.py`, `config.py`
**Fecha:** 2026-06-10

---

## 0. Veredicto en una línea

El proyecto está **bien diseñado para lo que es**. La frontera de puertos y
adaptadores que documenta el `CLAUDE.md` existe de verdad: `config.py`,
`scorer.py` y `coach.py` son módulos cohesivos y de responsabilidad clara. El
**90% de la deuda SOLID vive en un solo archivo**: `app.py`, concretamente en la
clase `App`.

Por eso este reporte **no propone reescribir todo**. Propone una secuencia de
refactors quirúrgicos, ordenados por impacto/riesgo, que respetan los tres
invariantes intocables del proyecto (frontera hexagonal, modelo de threading,
regla de aprobado por sonido).

> **Advertencia anti-sobre-ingeniería (leer primero).**
> En un proyecto de 4 módulos, aplicar SOLID "en masa" o sembrar patrones
> creacionales por completitud es un error tan grave como no aplicarlos. Más
> abajo hay una sección explícita de **qué NO hacer**. Tratala con el mismo peso
> que las recomendaciones.

---

## 1. Lo que ya está bien (no romper esto)

Antes de criticar, hay que reconocer lo que sostiene el diseño. Estas cosas son
correctas y cualquier refactor debe preservarlas:

| Acierto | Dónde | Por qué importa |
| --- | --- | --- |
| Frontera Azure aislada | `scorer.py` | Cambiar a un motor offline (wav2vec2+GOP) toca solo este archivo. |
| Frontera DeepSeek aislada | `coach.py` | El coach es opcional y sin regresión (`available`). |
| Config inmutable + carga centralizada | `config.py` (`@dataclass(frozen=True)`, `Config.load`) | Estado de configuración predecible, sin globals mutables. |
| DTOs limpios de resultado | `Assessment`, `WordScore`, `PhonemeScore` | El dominio del juego habla en tipos propios, no en objetos del SDK de Azure. |
| `KEYS` como única fuente de verdad | `app.py` | Las teclas no están hardcodeadas en N lugares. |

Esto ya es **DIP aplicado a medias y bien**: el juego pide "evaluá esto" / "dame
un consejo" sin saber qué motor hay debajo. El problema, como verás en §2.2, es
que la **inversión está incompleta**: falta el contrato explícito (el puerto).

---

## 2. Hallazgos SOLID (ordenados por impacto)

### 2.1 SRP — `App` es una clase-Dios *(impacto: ALTO)*

`App` (≈1000 líneas) acumula al menos **seis responsabilidades** que cambian por
motivos distintos:

1. **Construcción de la UI** — `_build_ui`, `_list_microphones`.
2. **Máquina de estados del juego** — `self.state`, transiciones en cada handler.
3. **Orquestación de threading** — `_start_recording`, `_start_tts`, `_poll`, la cola.
4. **Reglas de negocio del scoring** — la lógica de aprobado vive embebida en `_on_assessment` (`app.py:978-1002`): regla estricta (todos los sonidos ≥ umbral) + regla near-miss.
5. **Renderizado de feedback** — `_render_units`, `_render_progress_blocks`, `_render_status_line`, `_score_color`.
6. **Modo práctica (drill)** — `_on_practice_worst`, `_cleanup_practice`, `_worst_words`.

**Por qué es un problema (el WHY técnico):** la responsabilidad #4 —la regla de
aprobado, que tu propio `CLAUDE.md` marca como "clave, no es obvia"— está
**enterrada dentro de un callback de UI**. No se puede testear sin levantar
tkinter ni sin un `Assessment` real. La regla más importante del juego es la
menos verificable. Eso es exactamente lo que SRP busca evitar: una razón de
cambio (afinar la regla de scoring) que te obliga a tocar el archivo de UI.

**Dirección de refactor (incremental, sin romper threading):**

Extraer la regla de aprobado a una función/clase pura, sin dependencia de tkinter:

```python
# scoring.py  (nuevo módulo — dominio puro, testeable sin Azure ni tkinter)
from dataclasses import dataclass

@dataclass(frozen=True)
class Verdict:
    passed: bool
    by_recognition: bool          # ganó por la 2da vía (near-miss)
    worst_label: str | None
    worst_score: float

def judge(
    units: list[tuple[str, float]],   # (fonema|palabra, score)
    accuracy: float,
    recognized_ok: bool,
    threshold: float,
    near_miss_margin: float,
) -> Verdict:
    if units:
        passed_strict = all(s >= threshold for s in (s for _, s in units))
        worst_label, worst_score = min(units, key=lambda u: u[1])
    else:
        passed_strict = accuracy >= threshold
        worst_label, worst_score = None, accuracy
    near = (threshold - near_miss_margin) <= accuracy < threshold
    passed = passed_strict or (near and recognized_ok)
    return Verdict(passed, passed and not passed_strict, worst_label, worst_score)
```

`App._on_assessment` pasa a **llamar** a `judge(...)` y solo se ocupa de pintar.
Ganás un módulo de dominio que podés testear con `pytest` sin micrófono. Esa es
la mayor victoria de todo el reporte.

> Nota: la máquina de estados (`self.state` como string con transiciones
> dispersas) es candidata al **patrón State** —pero ese es un patrón de
> *comportamiento*, no creacional, así que queda fuera del pedido. Lo dejo
> anotado porque es la segunda fuente de complejidad de `App`.

---

### 2.2 DIP — `App` depende de clases concretas, no de abstracciones *(impacto: ALTO)*

Hoy (`app.py:181-182`):

```python
self.scorer = Scorer(config)        # clase concreta
self.coach = Coach(config)          # clase concreta
```

Y `scorer.py:19` hace `import azure.cognitiveservices.speech as speechsdk` **a
nivel de módulo**. Consecuencia encadenada:

> No podés ni siquiera **importar** `app.py` en un test sin tener el SDK de
> Azure instalado y configurado.

Eso explica técnicamente por qué "no hay tests": la dependencia concreta sube
por la cadena de imports y contamina todo. La frontera hexagonal está dibujada
en la documentación pero **no existe como contrato en el código** — falta el
puerto (la interfaz).

**Dirección de refactor — definir los puertos con `typing.Protocol`:**

```python
# ports.py
from typing import TYPE_CHECKING, Protocol
if TYPE_CHECKING:
    from assessment import Assessment   # DTOs movidos fuera de scorer.py (sin Azure)

class PronunciationScorer(Protocol):
    def assess(self, reference_text: str, *, on_status=None, device=None,
               long_form: bool = False, continuous: bool = False) -> Assessment: ...
    def speak(self, text: str) -> str | None: ...

class PronunciationCoach(Protocol):
    @property
    def available(self) -> bool: ...
    def tip(self, word: str, phonemes, recognized: str,
            word_attempts: int, total_attempts: int, level: str) -> str | None: ...
```

```python
# app.py — inyección por constructor
class App:
    def __init__(self, root, config, scorer: PronunciationScorer,
                 coach: PronunciationCoach) -> None:
        self.scorer = scorer
        self.coach = coach
```

`main()` arma las dependencias (composition root) y se las pasa. En un test
inyectás un `FakeScorer` que devuelve un `Assessment` fijo, y por fin podés
verificar la regla de aprobado, el modo práctica y las transiciones de estado
**sin Azure**.

`Protocol` (tipado estructural) es la opción correcta acá: no obliga a `Scorer`
ni `Coach` a heredar de nada, solo a "cumplir la forma". Cero ceremonia.

> **Nota de implementación (lección del refactor real).** El esbozo de arriba
> tenía un error: `from scorer import Assessment` en `ports.py` habría vuelto a
> arrastrar el SDK de Azure por la cadena de imports. La solución real exigió
> mover los DTOs (`Assessment`, `WordScore`, `PhonemeScore`) a un módulo propio
> sin Azure (`assessment.py`) ANTES de definir los puertos, y dejar el wiring de
> los adaptadores concretos en imports locales dentro de `main()`. Lo vigila un
> test de arquitectura que importa `app` en un subproceso limpio y falla si el
> SDK de Azure aparece en `sys.modules`.

---

### 2.3 OCP — el tipo de objetivo es un *string mágico* con `switch` disperso *(impacto: MEDIO)*

`Target.kind` es un `str` libre (`"sentence" | "boss" | "word"`, `app.py:145`).
El despacho por ese string está **repetido en al menos 7 lugares**:

| Lugar | Qué decide según `kind` |
| --- | --- |
| `_render_target` (`app.py:518-525`) | tamaño de fuente y color |
| `_set_recording_status` (`863-867`) | el texto del semáforo |
| `_keys_line` (`418`) | qué teclas mostrar |
| `_render_status_line` (`546-548`) | etiqueta de "próxima" |
| `_refresh_hints` (`465`) | verbo de la instrucción |
| `_on_assessment` (`957`) | desglose por palabra vs por fonema |
| `assess` (`844-846`) | `long_form` / `continuous` |

**Por qué viola OCP:** agregar un nuevo tipo de objetivo (ej. "trabalenguas",
"diálogo") te obliga a cazar y editar todos esos `if kind == ...` / `.get(kind,
...)`. El sistema **no está cerrado a modificación**.

**Dos pasos, de menor a mayor:**

**(a) Enum en vez de string** — elimina los typos silenciosos y documenta el
dominio:

```python
from enum import Enum
class Kind(str, Enum):
    SENTENCE = "sentence"
    BOSS = "boss"
    WORD = "word"
```

**(b) Mover el comportamiento al propio `Target`** (polimorfismo) — cada tipo
sabe sus reglas, y los `switch` desaparecen:

```python
@dataclass(frozen=True)
class Target:
    label: str
    reference: str
    kind: Kind
    @property
    def is_multiword(self) -> bool: return self.kind in (Kind.SENTENCE, Kind.BOSS)
    @property
    def long_form(self) -> bool:    return self.is_multiword
    @property
    def continuous(self) -> bool:   return self.kind is Kind.BOSS
```

No hace falta una jerarquía de subclases con herencia: para 3 tipos, esto es
suficiente y más simple. **Resistí la tentación** de hacer `class SentenceTarget(Target)`,
`class BossTarget(Target)`, etc. — para 3 variantes pequeñas sería más código,
no menos.

---

### 2.4 ISP — `Scorer` mezcla scoring de Azure con I/O de audio local *(impacto: BAJO-MEDIO)*

`Scorer` expone cuatro operaciones que en realidad pertenecen a **dos
responsabilidades distintas**:

- **Azure / pronunciación:** `assess`, `speak`.
- **Audio local (sin Azure):** `record_test` (solo `sounddevice`), `play_recording` (lanza `aplay`/`paplay`/`ffplay` por `subprocess`).

Tu `CLAUDE.md` afirma que `scorer.py` es "el ÚNICO punto que habla con Azure" —
y es cierto para `assess`/`speak`, pero `record_test` y `play_recording` **no
tocan Azure para nada**. Están ahí por conveniencia, no por cohesión.

**Dirección (opcional, baja prioridad):** separar un puerto `AudioIO`
(grabar/reproducir local) del puerto `PronunciationScorer` (Azure). Quien solo
necesita reproducir el WAV no debería depender de la superficie de Azure. Es
ISP de manual, pero el costo/beneficio acá es modesto: hacelo si vas a meter más
features de audio local; si no, dejalo anotado.

---

### 2.5 LSP — sin hallazgos reales

No hay jerarquías de herencia con sustitución en el código, así que **no voy a
inventar una violación de LSP para llenar la sección**. Si en §2.3(b) llegaras a
crear subclases de `Target` (cosa que **desaconsejo**), ahí sí LSP pasaría a
importar: cada subtipo tendría que ser sustituible sin romper a quien use
`Target`. Hoy: no aplica.

---

## 3. Patrones creacionales — dónde SÍ y dónde NO

El pedido fue "donde aplique". La respuesta honesta: **uno aplica con claridad,
uno aplica condicionado al futuro, y dos serían sobre-ingeniería.**

### ✅ 3.1 Factory Method (named constructors) para `Target` — APLICA

Hoy los `Target` se construyen con el `kind` string crudo en dos lugares
(`Game.__init__` en `app.py:153-162` y `_on_practice_worst` en `app.py:777`).
Eso es construcción dispersa + acoplada al string mágico. Named constructors lo
centralizan y lo hacen legible:

```python
@dataclass(frozen=True)
class Target:
    label: str
    reference: str
    kind: Kind

    @classmethod
    def sentence(cls, text: str) -> "Target":
        return cls(label=text, reference=text, kind=Kind.SENTENCE)

    @classmethod
    def boss(cls, paragraph: str) -> "Target":
        return cls(label=paragraph, reference=paragraph, kind=Kind.BOSS)

    @classmethod
    def word(cls, w: str) -> "Target":
        return cls(label=w, reference=w, kind=Kind.WORD)
```

Uso: `Target.sentence(s)` en vez de `Target(label=s, reference=s, kind="sentence")`.
Más claro, imposible equivocar el `kind`, y un solo lugar para cambiar la
construcción. **Esta es la recomendación creacional principal.**

### 🟡 3.2 Factory simple para elegir el motor de scoring — APLICA *condicionado*

Una vez que existan los puertos de §2.2, tiene sentido una fábrica que decida
**qué adaptador** construir según la config (Azure hoy; wav2vec2+GOP el día de
mañana, como anticipa tu `CLAUDE.md`):

```python
# factory.py
def build_scorer(config: Config) -> PronunciationScorer:
    # único punto donde se decide el motor; mañana: if config.engine == "offline": ...
    return Scorer(config)
```

**Matiz honesto (YAGNI):** mientras exista UN solo motor, esta fábrica es casi
trivial. Su valor es real recién cuando aparece el segundo motor. **Lo que SÍ
vale desde ya** es el puerto (§2.2); la fábrica es la consecuencia natural
cuando llega el segundo adaptador. No la agregues "por las dudas" con un solo
motor: agregá el `Protocol` ahora, la fábrica cuando la necesites.

### ❌ 3.3 Builder — NO aplica

Tentaciones: `Config.load`, `_build_ssml`, `_speech_config`. Las tres construyen
objetos con varios parámetros. **Pero Builder resuelve un problema que acá no
existe:** construcción paso a paso, con orden variable y estados intermedios
válidos. `Config` se arma de una sola vez desde el entorno; `_build_ssml` es una
f-string. Meter un `ConfigBuilder` o un `SSMLBuilder` agregaría clases y
ceremonia sin resolver nada. `Config.load` ya **es** un Factory Method
(classmethod que encapsula la creación) y está perfecto así.

### ❌ 3.4 Singleton — NO aplica (y sería un retroceso)

`Config` se crea una vez en `main()` y se **inyecta** por parámetro a `App`,
`Scorer` y `Coach`. Eso es estrictamente mejor que un Singleton: testeable,
explícito, sin estado global. Convertir `Config` en Singleton **rompería** la
inyección que ya tenés bien hecha. No lo hagas.

---

## 4. Plan de refactor incremental (orden sugerido)

De menor riesgo/mayor retorno a mayor esfuerzo. Cada paso es independiente y
deja el juego funcionando:

| # | Estado | Cambio | SOLID / patrón | Riesgo | Retorno |
| --- | --- | --- | --- | --- | --- |
| 1 | ✅ hecho | `Kind` enum + named constructors de `Target` | OCP, Factory Method | Bajo | Alto |
| 2 | ✅ hecho | Extraer `scoring.py` (`judge`) — regla de aprobado pura | SRP | Bajo | **Alto** (testeable) |
| 3 | ✅ hecho | Definir `Protocol`s + inyectar `Scorer`/`Coach` en `App` | DIP | Medio | Alto |
| 4 | ⬜ pendiente | Mover `long_form`/`continuous`/`is_multiword` a `Target` | OCP | Bajo | Medio |
| 5 | ⬜ pendiente | (Opcional) separar puerto `AudioIO` de `Scorer` | ISP, SRP | Medio | Bajo |
| 6 | ⬜ pendiente | (Cuando haya 2º motor) `build_scorer` factory | Factory | Bajo | Diferido |

**Estado al 2026-06-10:** pasos #1, #2 y #3 implementados con tests (17 verdes).
Se agregó `assessment.py` (DTOs sin Azure), `scoring.py` (`judge`), `ports.py`
(puertos), y `tests/` con pytest. Quedan #4, #5, #6.

**Empezá por #2.** Es el de mejor relación retorno/riesgo: aísla la regla más
importante y menos verificable del juego en una función pura que podés cubrir
con tests hoy mismo, sin tocar UI ni threading.

---

## 5. Qué NO tocar (invariantes del proyecto)

Cualquier refactor debe respetar esto o rompe la app:

1. **`_init_x11_threads()` primero en `main()`** — antes de cualquier `tk.Tk()`.
   No lo muevas ni lo encapsules en algo que se inicialice tarde.
2. **Las dos clases de audio de Azure NO son intercambiables** — `AudioConfig`
   (entrada/mic) vs `AudioOutputConfig` (salida/parlante). Si extraés `AudioIO`,
   no las unifiques.
3. **La regla de aprobado por sonido** (todos los fonemas/palabras ≥ umbral, no
   el promedio) es intencional. Al extraerla a `scoring.py`, **preservá la
   lógica exacta**, incluido el rescate near-miss condicionado a
   `recognized_ok`.
4. **Regla de oro del threading** — los callbacks del SDK de Azure solo encolan
   (`self.results.put`), nunca tocan tkinter. Cualquier extracción debe mantener
   esto: tkinter se toca SOLO en `_poll` / hilo de UI.
5. **`self._gen`** invalida trabajo async viejo. Si reorganizás los handlers,
   no pierdas esta verificación de generación.

---

## 6. Cierre

No tenés un problema de arquitectura: tenés **una clase-Dios (`App`) dentro de
una arquitectura sana**. Atacá `app.py` por capas —regla de scoring, luego
puertos, luego el enum/factory de `Target`— y dejá `scorer.py`/`coach.py`/
`config.py` casi como están.

Y lo más importante: **el objetivo de extraer `scoring.py` y definir los puertos
no es "cumplir con SOLID". Es poder escribir el primer test del proyecto.** Esa
es la métrica real de si el refactor valió la pena.
