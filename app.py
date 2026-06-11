"""Pronunciation Tetris — juego de pronunciacion manejado por teclado.

Flujo:
  1. Escribís una oracion y Enter.
  2. El juego te "lanza" las palabras de MAS dificil a mas facil (como bloques).
  3. Cada palabra es un enemigo: solo avanzás si tu pronunciacion supera el
     umbral (94% por defecto). Si no, te muestro QUE fonema fallaste y reintentás.
  4. El JEFE FINAL es la oracion completa.

Teclas:
  ESPACIO  -> grabar / reintentar / avanzar (segun el momento)
  <correct>-> escuchá la correcta (TTS de Azure)   } definidas en el dict KEYS
  <mine>   -> escuchá tu voz (tu ultima grabacion) } (unica fuente de verdad)
  ESC      -> salir   ·   Ctrl+R -> reset   ·   Ctrl+T -> probar mic

El scoring corre en un hilo aparte porque Azure bloquea mientras escucha; si lo
corrieramos en el hilo de tkinter, la ventana se congelaria. La UI se entera del
resultado por una cola (queue) que poleamos con root.after.
"""

from __future__ import annotations

import ctypes
import queue
import sys
import threading
import tkinter as tk
from dataclasses import dataclass
from enum import Enum

from assessment import Assessment
from config import Config
from ports import AudioIO, PronunciationCoach, PronunciationScorer
from progress import LifetimeStats, ProgressStore, XP_PER_DEFEAT
from scoring import judge


def _split_sentences(text: str) -> list[str]:
    """Divide un parrafo en oraciones por '.' o por salto de linea.

    Cada oracion (trim, no vacia) es un sub-jefe. El jefe final es el parrafo
    entero. Ej: el parrafo de 7 oraciones -> 7 sub-jefes + 1 jefe final.
    """
    unified = text.replace("\n", ".")
    return [s.strip() for s in unified.split(".") if s.strip()]


def _init_x11_threads() -> None:
    """Hace a Xlib thread-safe ANTES de que tkinter abra la conexion X.

    En Linux, Xlib no es thread-safe por defecto. El SDK de Azure levanta hilos
    nativos al importarse y nosotros tambien usamos hilos (grabacion / TTS). Sin
    esto, tkinter + esos hilos disparan el crash de XCB:
        [xcb] Unknown sequence number while appending request ... Aborting

    XInitThreads() debe ser de las primeras llamadas a Xlib del programa, asi que
    se invoca al inicio de main(), antes de cualquier tk.Tk(). Inofensivo si no
    hay X11 (Wayland puro, headless): simplemente no encuentra la lib y sigue.
    """
    if not sys.platform.startswith("linux"):
        return
    for name in ("libX11.so.6", "libX11.so"):
        try:
            ctypes.CDLL(name).XInitThreads()
            return
        except OSError:
            continue

# Paleta HashiCorp marketing (dark · monocroma + un acento azul).
BG         = "#000000"   # canvas: negro puro (token canvas/primary)
SURFACE1   = "#15181e"   # card lift (surface-1): target, entry, coach
SURFACE2   = "#1f232b"   # secondary control (surface-2): mic, boton, hint
HAIRLINE   = "#3b3d45"   # borde gris 1px (aprox. del hairline translucido)
FG         = "#ffffff"   # ink: titulos / texto enfatizado
INK_MUTED  = "#b2b6bd"   # ink-muted: body / instrucciones / ecos
DIM        = "#656a76"   # ink-subtle: eyebrows, labels, hints (solo sobre BG)
INK_SUBTLE = DIM         # alias del mismo token
ACCENT     = "#2b89ff"   # accent-blue: titulo, foco del entry, estado activo
GREEN      = "#00ca8e"   # semantic-success (Nomad): pass / derrotado
RED        = "#e62b1e"   # semantic-error  (Consul): fail
YELLOW     = "#ffcf25"   # semantic-warning (Vault): near-miss / procesando
UI         = "TkDefaultFont"  # fuente del sistema (compacta; sin zoom)
MONO       = "TkFixedFont"    # disponible pero SIN USO (HashiCorp: no mono)


def _bordered(w, thick=1):
    """Aplica el hairline gris 1px (aprox. del hairline translucido HashiCorp)."""
    w.config(highlightthickness=thick, highlightbackground=HAIRLINE, relief="flat")
    return w

# ÚNICA fuente de verdad de las teclas de audio. ¿Querés cambiar una? Editá ACÁ
# y listo: se actualiza en los bindings Y en todas las pistas en pantalla.
KEYS = {
    "correct": "f",  # escuchá la pronunciación CORRECTA (TTS de Azure)
    "mine": "d",  # escuchá TU voz (tu última grabación)
    "retry": "s",  # reintentar la palabra (incluso si ya la derrotaste)
    "boss": "a",  # saltar directo al jefe final (la oración completa)
    "practice": "r",  # practicar las palabras con más errores del objetivo
    "clear": "x",  # reiniciar la lista de palabras a practicar del objetivo
    "prev": "q",  # navegar al sub-jefe/jefe ANTERIOR
    "next": "w",  # navegar al sub-jefe/jefe SIGUIENTE
    # Teclas de UI (no audio): zoom de la fuente del texto a leer + el feedback.
    "font_up": "p",  # agrandar la fuente
    "font_down": "l",  # achicar la fuente
}

# Pistas para los sonidos del ingles que mas cuestan a un hispanohablante.
# Clave = fonema IPA que devuelve Azure; valor = "que sonido es" + ejemplo.
_PHONEME_HINTS: dict[str, str] = {
    "ð": "el 'th' SUAVE de THIS/THE (lengua entre los dientes, CON voz)",
    "θ": "el 'th' FUERTE de THINK/BATH (lengua entre los dientes, SIN voz)",
    "v": "la 'v' de VAN (labio sobre los dientes — NO es B)",
    "w": "la 'w' de WE/WATER (labios redondeados, como 'u')",
    "ɹ": "la 'r' inglesa de RED (la lengua NO vibra)",
    "r": "la 'r' inglesa de RED (la lengua NO vibra)",
    "ɪ": "la 'i' CORTA y relajada de SHIP/BIT (no es la de SHEEP)",
    "i": "la 'i' LARGA de SHEEP/SEE",
    "iː": "la 'i' LARGA de SHEEP/SEE",
    "æ": "la 'a' abierta de CAT/MAP (boca bien abierta)",
    "ə": "la 'schwa': vocal neutra y floja de THE/ABOUT",
    "ʌ": "la 'a' de CUP/LUCK",
    "ʃ": "el 'sh' de SHE/SHIP",
    "ʒ": "el sonido de viSIon/meaSure",
    "tʃ": "el 'ch' de CHEESE/CHAIR",
    "dʒ": "la 'j' de JOB/AGE",
    "ŋ": "el 'ng' nasal de SING/KING",
    "h": "la 'h' ASPIRADA de HELLO (sí suena, no es muda)",
    "ʊ": "la 'u' corta de BOOK/PUT",
    "u": "la 'u' larga de FOOD",
    "uː": "la 'u' larga de FOOD",
    "ɛ": "la 'e' de BED/HEAD",
    "ɔ": "la 'o' larga de THOUGHT/LAW",
    "ɔː": "la 'o' larga de THOUGHT/LAW",
    "ɑ": "la 'a' larga de FATHER/CAR",
    "ɑː": "la 'a' larga de FATHER/CAR",
    "eɪ": "el diptongo 'ei' de DAY/FACE",
    "oʊ": "el diptongo 'ou' de GO/HOME",
}


def _phoneme_hint(phoneme: str) -> str | None:
    """Pista para un fonema IPA; tolera marcas de longitud (ː) y variantes."""
    return _PHONEME_HINTS.get(phoneme) or _PHONEME_HINTS.get(phoneme.replace("ː", ""))


def _normalize_text(text: str) -> str:
    """Normaliza para comparar lo reconocido vs el objetivo: minusculas, sin
    puntuacion, espacios colapsados. 'Entered.' == 'entered'."""
    cleaned = "".join(c if (c.isalnum() or c.isspace()) else " " for c in text.lower())
    return " ".join(cleaned.split())


# Tipos de objetivo:
#   SENTENCE -> sub-jefe: una oracion del parrafo (se evalua por palabra)
#   BOSS     -> jefe final: el parrafo completo
#   WORD     -> palabra suelta (solo aparece en el modo practica con R)
class Kind(str, Enum):
    SENTENCE = "sentence"
    BOSS = "boss"
    WORD = "word"


@dataclass
class Target:
    label: str  # lo que se muestra grande
    reference: str  # el texto que Azure evalua
    kind: Kind

    # Named constructors: centralizan la creacion y evitan pasar el kind a mano
    # (un solo lugar que sabe que un sub-jefe es SENTENCE, el jefe BOSS, etc.).
    @classmethod
    def sentence(cls, text: str) -> "Target":
        return cls(label=text, reference=text, kind=Kind.SENTENCE)

    @classmethod
    def boss(cls, paragraph: str) -> "Target":
        return cls(label=paragraph, reference=paragraph, kind=Kind.BOSS)

    @classmethod
    def word(cls, w: str) -> "Target":
        return cls(label=w, reference=w, kind=Kind.WORD)

    # Comportamiento por tipo: el Target sabe como debe evaluarse y reconocerse,
    # asi app.py no lo deduce con dispatch disperso (`kind in (...)`, `== BOSS`).
    @property
    def is_multiword(self) -> bool:
        """Se evalua por palabra (oracion o jefe), no por fonema."""
        return self.kind in (Kind.SENTENCE, Kind.BOSS)

    @property
    def long_form(self) -> bool:
        """Tolera pausas largas entre palabras al reconocer (oracion/jefe)."""
        return self.is_multiword

    @property
    def continuous(self) -> bool:
        """Reconocimiento CONTINUO (sin tope de ~15s): el jefe = parrafo entero."""
        return self.kind is Kind.BOSS


class Game:
    """Estado del juego: sub-jefes (oraciones) + jefe final (parrafo)."""

    def __init__(self, sentences: list[str]) -> None:
        # Cada oracion es un sub-jefe, en orden de lectura.
        self.targets: list[Target] = [Target.sentence(s) for s in sentences]
        # El jefe final = leer el parrafo entero (solo si hay mas de una oracion).
        # Lo reconstruimos limpio desde las oraciones (sin lineas en blanco).
        if len(sentences) > 1:
            paragraph = ". ".join(sentences) + "."
            self.targets.append(Target.boss(paragraph))
        self.index = 0

    @property
    def current(self) -> Target:
        return self.targets[self.index]

    @property
    def finished(self) -> bool:
        return self.index >= len(self.targets)

    def advance(self) -> None:
        self.index += 1


class App:
    def __init__(
        self,
        root: tk.Tk,
        config: Config,
        scorer: PronunciationScorer,
        coach: PronunciationCoach,
        audio: AudioIO,
        store: ProgressStore | None = None,
    ) -> None:
        self.root = root
        self.config = config
        # Adaptadores inyectados: Azure/DeepSeek en produccion, dobles en tests.
        # App solo conoce los puertos (ports.py), nunca las clases concretas.
        self.scorer = scorer
        self.coach = coach  # DeepSeek (opcional): ranking + consejos
        self.audio = audio  # grabar prueba de mic + reproducir WAV (local, sin Azure)
        # Progresion persistida (XP/nivel/accuracy de por vida). Keyword opcional:
        # los tests inyectan un doble en memoria. ProgressStore() solo arma un Path,
        # no toca disco hasta save() (que solo corre en _win).
        self.store = store or ProgressStore()
        self.stats: LifetimeStats | None = None  # se carga lazy en _show_input
        self.results: "queue.Queue[tuple[str, object]]" = queue.Queue()

        self.game: Game | None = None
        self.state = "input"  # input | ready | recording | fail | pass | win
        self.busy = False  # hay un hilo (grabacion o TTS) corriendo
        self.last_audio: str | None = None  # .wav de tu ultima grabacion
        self.mic_device = None  # indice del mic elegido (None = predeterminado)
        # Contador para invalidar trabajo async viejo (ranking/consejo) cuando el
        # contexto cambia: reset, nuevo objetivo, nueva grabacion.
        self._gen = 0
        # Intentos para dar contexto al coach (y que el consejo no se repita).
        self._total_attempts = 0  # en toda la partida
        self._word_attempts = 0  # con el objetivo actual
        # Palabras a mejorar POR objetivo: id(Target) -> {palabra: cant_errores}.
        # Acumula cuantas veces fallaste cada palabra, PERO si la decis bien sale
        # de la lista (no practicas lo ya logrado). Cada oracion tiene la suya y
        # persiste al navegar (Q/W/A): en la oracion 3 no ves las de la 2.
        self._errors: dict[int, dict[str, int]] = {}
        # Estado de cada objetivo para los cuadritos de progreso: id(Target) ->
        # "defeated" | "failed" (ausente = no intentado todavia).
        self._status: dict[int, str] = {}
        # A (toggle al jefe): a que objetivo volver al salir del jefe.
        self._return_target: Target | None = None
        # Modo practica (R): oracion de origen y palabras insertadas, para volver
        # y limpiar al salir.
        self._practice_origin: Target | None = None
        self._practice_targets: list[Target] = []
        # Contadores RPG de UNA corrida (parrafo): efimeros, se resetean en
        # _begin_game. La progresion DE POR VIDA vive en self.stats (persistida).
        self._streak = 0  # objetivos derrotados al hilo sin un fallo en el medio
        self._combo = 0  # palabras perfectas seguidas (cruza intentos)
        self._run_xp = 0  # XP ganado en esta corrida (para el resumen al ganar)
        self._best_hp: dict[int, float] = {}  # id(Target) -> mejor accuracy lograda
        self._xp_gen = 0  # invalida un flash de XP viejo si llega otro antes de borrarse
        self._font_delta = 0  # zoom de fuente (P/L) del texto a leer + feedback

        self._build_ui()
        self._bind_keys()
        self.root.after(80, self._poll)

    # ------------------------------------------------------------------ UI
    def _build_ui(self) -> None:
        self.root.title("Pronunciation Tetris")
        self.root.configure(bg=BG)
        self.root.geometry("880x760")
        self.root.minsize(700, 560)

        # Barra de destello arriba: pulsa verde al ganar / rojo al fallar.
        self.flash_bar = tk.Frame(self.root, bg=BG, height=6)
        self.flash_bar.pack(side="top", fill="x")

        # Indicador de OBJETIVO (config, no feedback): arriba-izquierda, chico y
        # tenue. Te recuerda visualmente el umbral por sonido. Va con .place (capa
        # propia sobre root); como la columna `content` se crea despues y es alta,
        # la solaparia con su fondo negro -> al final de _build_ui la subimos con
        # .lift() para que quede ENCIMA y se lea entera.
        self.goal_label = tk.Label(
            self.root,
            text=f"🎯 objetivo: {self.config.pass_threshold:.0f}% por sonido",
            bg=BG, fg=DIM, font=(UI, 9),
        )
        self.goal_label.place(x=12, y=12)

        # Columna central de ancho fijo: agrupa el contenido y lo centra como un
        # bloque, para que en pantallas anchas (ultrawide) NO quede flotando en una
        # franja con enormes vacios negros a los costados. Reemplaza el layout que
        # colgaba cada widget directo de root. flash_bar (arriba) y los hints (abajo)
        # siguen en root; todo lo del medio vive en este contenedor.
        self.content = tk.Frame(self.root, bg=BG)
        self.content.pack(expand=True)

        self.progress = tk.Label(
            self.content, text="", bg=BG, fg=DIM, font=(UI, 10)
        )
        self.progress.pack(pady=(8, 0))

        # Eyebrow: etiqueta de categoria en mayusculas (la firma HashiCorp mas
        # portable). Marca toda la app como una "zona"; vive sobre la card target.
        self.eyebrow = tk.Label(
            self.content, text="PRONUNCIATION TRAINER", bg=BG, fg=DIM,
            font=(UI, 9, "bold"),
        )

        # Barra tipo Tetris: un bloque por objetivo (derrotado / actual / pendiente
        # / jefe). El progreso de un vistazo.
        self.progress_blocks = tk.Frame(self.content, bg=BG)
        self.progress_blocks.pack(pady=(8, 0))

        # Barra de "HP"/dominio del objetivo actual: se LLENA con tu mejor accuracy
        # (vacia = sin dominar, full verde = derrotado). Ancho fijo + pack_propagate
        # False para que el fill por `place` (relwidth) sea estable. Se packea/oculta
        # dinamicamente en _render_hp_bar (solo para oracion/jefe, no en input/win).
        self.hp_wrap = tk.Frame(
            self.content, bg=SURFACE2, width=300, height=10,
            highlightthickness=1, highlightbackground=HAIRLINE,
        )
        self.hp_wrap.pack_propagate(False)
        self.hp_fill = tk.Frame(self.hp_wrap, bg=GREEN)
        self.hp_fill.place(relx=0, rely=0, relwidth=0.0, relheight=1)

        # Status line: usa justify="left" para que la lista numerada "A practicar"
        # (multi-linea) se lea como lista; en los textos de una linea no cambia nada.
        self.incoming = tk.Label(
            self.content,
            text="",
            bg=BG,
            fg=INK_MUTED,
            font=(UI, 11),
            wraplength=540,
            justify="left",
        )
        self.incoming.pack(pady=(8, 0))

        # Eyebrow encima de la card target (pack apenas antes que el target).
        self.eyebrow.pack(pady=(8, 0))

        # Card de lectura: SURFACE1 con harto aire (ipady) y texto a la izquierda en
        # textos largos -> se lee como contenido, no como una alerta. El "peligro"
        # del jefe NO va con fill amarillo full (eso gritaba ERROR): va por la barra
        # de HP + un badge chico (Slice 3). Sin expand: la columna queda compacta y
        # centrada como bloque (lo centra `content`, no este widget).
        self.target = tk.Label(
            self.content,
            text="",
            bg=SURFACE1,
            fg=FG,
            font=(UI, 28, "bold"),
            wraplength=540,
        )
        # HashiCorp = surface-lift, NO shadow: el hairline gris 1px + el escalon
        # charcoal (BG -> SURFACE1) bastan para delimitar la card. Sin offset frame.
        _bordered(self.target, 1)
        # ipadx/ipady must go on pack(), not .config(), for tk.Label.
        # fill="x" -> la card abarca el ancho de la columna y se lee como tarjeta
        # (no como un bloque de texto flotando). El alto NO se expande (sin expand).
        self.target.pack(pady=(8, 0), ipadx=24, ipady=20, fill="x")

        # Header de jugador (solo pantalla inicial): "Level N · Accuracy X%" leido de
        # la progresion persistida. Se packea en _show_input (antes del paste box) y
        # se oculta al empezar, igual que entry/mic_row.
        self.start_stats = tk.Label(
            self.content, text="", bg=BG, fg=INK_MUTED, font=(UI, 12, "bold"),
        )

        # Cuadro multi-linea para PEGAR un parrafo (Enter = salto de linea;
        # Shift+Enter = empezar).
        self.entry = tk.Text(
            self.content, font=(UI, 11), width=60, height=5,
            bg=SURFACE1, fg=FG, insertbackground=FG, relief="flat",
            wrap="word", padx=10, pady=8,
        )
        # Focus ring fiel al de HashiCorp: el borde se pone ACCENT azul cuando el
        # campo tiene foco de teclado (highlightcolor) y vuelve al hairline gris al
        # perderlo (highlightbackground). Feature nativa de tk, sin binding extra.
        self.entry.config(
            relief="flat", highlightthickness=1,
            highlightcolor=ACCENT, highlightbackground=HAIRLINE,
        )
        self.entry.pack()

        # Selector de microfono (solo visible en la pantalla inicial).
        self.mic_row = tk.Frame(self.content, bg=BG)
        tk.Label(
            self.mic_row, text="🎙 Micrófono:", bg=BG, fg=DIM,
            font=(UI, 10),
        ).pack(side="left", padx=(0, 6))
        self._mic_options = self._list_microphones()
        self.mic_var = tk.StringVar(value=self._mic_options[0][0])
        self.mic_menu = tk.OptionMenu(
            self.mic_row, self.mic_var, *[label for label, _dev in self._mic_options]
        )
        # Control secundario (surface-2 + hairline): monocromo, sin fill de color.
        self.mic_menu.config(
            bg=SURFACE2, fg=FG, activebackground=SURFACE1, activeforeground=FG,
            relief="flat", font=(UI, 10, "bold"),
        )
        _bordered(self.mic_menu, 1)
        self.mic_menu["menu"].config(
            bg=SURFACE2, fg=FG, activebackground=SURFACE1, activeforeground=FG,
        )
        self.mic_menu.pack(side="left")
        # Boton secundario HashiCorp = surface-2 charcoal + hairline + ink (NO
        # fill amarillo): el unico color vivo se reserva para titulo/foco/activo.
        self.mic_test_btn = tk.Button(
            self.mic_row,
            text="🎧 Probar (Ctrl+T)",
            command=self._on_mic_test,
            bg=SURFACE2, fg=FG, activebackground=SURFACE1, activeforeground=FG,
            relief="flat", bd=0, padx=10, font=(UI, 10, "bold"), cursor="hand2",
        )
        _bordered(self.mic_test_btn, 1)
        # ipady is a geometry manager option, not a widget option
        self.mic_test_btn.pack(side="left", padx=(8, 0), ipady=2)

        # Badge de score: texto sin borde (idle) -> chip con fill semantico +
        # hairline al mostrar estado. Fuente UI (HashiCorp: no mono).
        self.score = tk.Label(
            self.content, text="", bg=BG, fg=DIM, font=(UI, 15, "bold"),
        )
        # ipadx/ipady are geometry manager options, not widget config options
        self.score.pack(pady=(8, 0), ipadx=10, ipady=4)

        # Chrome de la corrida: racha + combo, chiquito y tenue bajo el badge.
        self.run_chrome = tk.Label(self.content, text="", bg=BG, fg=DIM, font=(UI, 10))
        self.run_chrome.pack(pady=(4, 0))
        # Flash de XP: aparece breve (+40 XP) al derrotar un objetivo nuevo.
        self.xp_flash = tk.Label(
            self.content, text="", bg=BG, fg=GREEN, font=(UI, 11, "bold"),
        )
        self.xp_flash.pack(pady=(2, 0))

        # Desglose por fonema (palabra) o por palabra (jefe): cada unidad se
        # pinta segun su score. Aca el usuario VE donde estuvo el problema.
        # Vive en `content` (NO en root) para quedar dentro de la columna central.
        self.units = tk.Frame(self.content, bg=BG)
        self.units.pack(pady=(8, 0))

        # Body relajado: INK_MUTED por defecto (HashiCorp: body es el gris muteado,
        # los titulos/enfasis son blanco/acento). El color de estado lo lleva el badge.
        # wraplength = ancho de columna (540), igual que target/incoming.
        self.feedback = tk.Label(
            self.content,
            text="",
            bg=BG,
            fg=INK_MUTED,
            font=(UI, 11),
            wraplength=540,
        )
        self.feedback.pack(pady=(8, 0))

        # Consejo del LLM (DeepSeek): card surface-1 tranquila debajo de la pista
        # estatica. Idle = texto DIM sin recuadro; al mostrarse, surface-1 + hairline.
        self.coach_tip = tk.Label(
            self.content,
            text="",
            bg=BG,
            fg=DIM,
            font=(UI, 12, "bold"),
            wraplength=540,
            justify="center",
        )
        self.coach_tip.pack(pady=(8, 0), ipadx=12, ipady=8)

        # Barra inferior, TRES renglones. Se packea de abajo hacia arriba:
        # sistema (lo mas abajo), luego las teclas, luego ESPACIO arriba.
        # Renglon 3: comandos de sistema (siempre), bien tenue.
        self.hint_sys = tk.Label(
            self.root,
            text=f"{self._k('font_up')}/{self._k('font_down')}: fuente"
            "   ·   Ctrl+R: reset   ·   ESC: salir",
            bg=BG, fg=DIM, font=(UI, 9),
        )
        self.hint_sys.pack(side="bottom", pady=(0, 8))

        # Renglon 2: teclas de accion (X · A · S · D · F · R), tenue.
        self.hint_keys = tk.Label(
            self.root, text="", bg=BG, fg=DIM, font=(UI, 10),
            wraplength=850, justify="center",
        )
        self.hint_keys.pack(side="bottom", pady=(0, 4))

        # ACCION PRINCIPAL: el chip de ESPACIO deja de ser un renglon chiquito al
        # pie y pasa a ser un BOTON GIGANTE dentro de la columna central -> imposible
        # de ignorar (jerarquia nivel 3). fill="x" lo hace abarcar toda la columna;
        # ipady alto le da cuerpo de boton. Sigue monocromo (surface-2 + hairline):
        # HashiCorp reserva el acento azul para titulo/foco/activo, no para CTAs.
        # Click del mouse = misma accion que la tecla ESPACIO (aditivo; _on_space ya
        # ignora el click en estado 'input'/'busy').
        self.hint = tk.Label(
            self.content, text="", bg=SURFACE2, fg=FG, font=(UI, 14, "bold"),
            wraplength=520, justify="center", cursor="hand2",
        )
        _bordered(self.hint, 1)
        self.hint.bind("<Button-1>", self._on_space)
        # ipadx/ipady are geometry manager options, not widget config options
        self.hint.pack(pady=(16, 0), ipadx=24, ipady=12, fill="x")

        # La etiqueta de objetivo (.place sobre root) tiene que quedar ENCIMA de la
        # columna `content` (que se creo despues y la solapa). lift() la sube al tope.
        self.goal_label.lift()
        self._show_input()

    def _list_microphones(self) -> list[tuple[str, object]]:
        """(label, device) de cada mic de entrada. device None = predeterminado.

        Dedup por nombre para no llenar el menu con las mil entradas de ALSA.
        Si sounddevice/portaudio no esta, queda solo el predeterminado.
        """
        options: list[tuple[str, object]] = [("🎙 Predeterminado del sistema", None)]
        try:
            import sounddevice as sd

            seen: set[str] = set()
            for index, dev in enumerate(sd.query_devices()):
                if dev.get("max_input_channels", 0) > 0:
                    name = dev["name"]
                    if name not in seen:
                        seen.add(name)
                        options.append((name, index))
        except Exception:
            pass
        return options

    def _selected_mic(self):
        """Indice del mic elegido en el desplegable (o None = predeterminado)."""
        label = self.mic_var.get()
        for lbl, device in self._mic_options:
            if lbl == label:
                return device
        return None

    def _bind_keys(self) -> None:
        self.root.bind("<space>", self._on_space)
        # Teclas de audio/accion desde el dict KEYS (minuscula y mayuscula).
        self._bind_letter(KEYS["correct"], self._on_repeat)
        self._bind_letter(KEYS["mine"], self._on_play_mine)
        self._bind_letter(KEYS["retry"], self._on_retry)
        self._bind_letter(KEYS["boss"], self._on_skip_to_boss)
        self._bind_letter(KEYS["practice"], self._on_practice_worst)
        self._bind_letter(KEYS["clear"], self._on_clear_errors)
        self._bind_letter(KEYS["prev"], self._on_prev)
        self._bind_letter(KEYS["next"], self._on_next)
        # Zoom de fuente (UI, no audio): P agranda, L achica.
        self._bind_letter(KEYS["font_up"], self._on_font_bigger)
        self._bind_letter(KEYS["font_down"], self._on_font_smaller)
        self.root.bind("<Escape>", lambda _e: self.root.destroy())
        self.root.bind("<Control-r>", self._reset)
        self.root.bind("<Control-R>", self._reset)
        self.root.bind("<Control-t>", self._on_mic_test)
        self.root.bind("<Control-T>", self._on_mic_test)
        # Shift+Enter empieza; Enter solo (sin shift) inserta salto de linea.
        self.entry.bind("<Shift-Return>", self._on_start)

    def _bind_letter(self, key: str, handler) -> None:
        """Bindea una letra en minuscula y mayuscula al mismo handler."""
        self.root.bind(key.lower(), handler)
        self.root.bind(key.upper(), handler)

    def _k(self, action: str) -> str:
        """La tecla (en mayuscula, para mostrar) de una accion del dict KEYS."""
        return KEYS[action].upper()

    def _keys_line(self) -> str:
        """Renglon 2 de la barra: teclas de accion segun el estado/objetivo."""
        # Drilleando una palabra: solo audio + salir de practica + navegar.
        if self.game is not None and self.game.current.kind == Kind.WORD:
            items = [f"{self._k('retry')}: reintentar", f"{self._k('mine')}: tu voz",
                     f"{self._k('correct')}: la correcta"]
            if self._practice_origin is not None:
                items.append(f"{self._k('practice')}: salir de práctica")
            items.append(f"{self._k('prev')}/{self._k('next')}: ◀ ▶ navegar")
            return "   ·   ".join(items)

        has_errors = (
            self.game is not None
            and self.game.current.is_multiword
            and bool(self._cur_errors())
        )
        items = []
        # A es toggle: 'ir al jefe' desde una oracion, 'volver' desde el jefe.
        if self.game is not None and self._boss_index() is not None:
            if self.game.current.kind == Kind.BOSS:
                items.append(f"{self._k('boss')}: volver")
            else:
                items.append(f"{self._k('boss')}: ir al jefe")
        items.append(f"{self._k('retry')}: reintentar")
        items.append(f"{self._k('mine')}: tu voz")
        items.append(f"{self._k('correct')}: la correcta")
        if has_errors:
            items.append(f"{self._k('practice')}: practicar")
            items.append(f"{self._k('clear')}: limpiar práctica")
        items.append(f"{self._k('prev')}/{self._k('next')}: ◀ ▶ navegar")
        return "   ·   ".join(items)

    def _refresh_hints(self) -> None:
        """Dibuja la barra inferior: ESPACIO (verde, renglon 1) + teclas (renglon 2)."""
        # (Ctrl+R / ESC viven siempre en hint_sys, renglon de sistema.)
        if self.state == "input":
            self.hint.config(text="Shift+Enter: empezar")
            self.hint_keys.config(text="Ctrl+T: probar micrófono")
            return
        if self.state == "win":
            self.hint.config(text="ESPACIO: jugar otro párrafo")
            self.hint_keys.config(text="")
            return
        # En juego (ready / fail / pass): ESPACIO cambia segun el momento.
        kind = self.game.current.kind if self.game else Kind.WORD
        if self.state == "pass":
            space = "ESPACIO: siguiente"
        elif self.state == "fail":
            space = "ESPACIO: reintentar"
        else:  # ready
            verbo = {Kind.BOSS: "el párrafo", Kind.SENTENCE: "la oración"}.get(kind, "la palabra")
            space = f"ESPACIO: grabá {verbo}"
        self.hint.config(text=space)
        self.hint_keys.config(text=self._keys_line())

    # ----------------------------------------------------------- pantallas
    def _show_input(self) -> None:
        self.state = "input"
        # Carga unica de la progresion desde disco. Es un READ benigno: si el
        # archivo no existe devuelve stats frescas y NO lo crea (clave para que los
        # tests que construyen un App no escriban a disco).
        if self.stats is None:
            self.stats = self.store.load()
        self.progress.config(text="")
        self.incoming.config(text="")
        self._render_progress_blocks()  # game es None -> limpia los bloques
        self._render_hp_bar()  # game es None -> oculta la barra de HP
        self.run_chrome.config(text="")  # sin racha/combo en la pantalla inicial
        self.xp_flash.config(text="")
        self._render_start_stats()  # "Level N · Accuracy X%"
        # Titulo: centrado (hero), y reseteo del borde por si venimos de un jefe
        # (que deja el borde amarillo de 2px).
        self.target.config(
            text="Pronunciation Tetris", bg=SURFACE1, fg=ACCENT,
            font=(UI, 28, "bold"), justify="center", anchor="center",
        )
        _bordered(self.target, 1)
        self._score_badge("", BG, DIM)
        self._clear_units()
        self._coach_clear()
        self.feedback.config(
            text="Pegá un párrafo (oraciones separadas por “.” o saltos de línea) "
            "y apretá Shift+Enter.",
            fg=INK_MUTED,
        )
        self._refresh_hints()
        self.entry.delete("1.0", "end")
        self.entry.pack(before=self.score)  # mantiene su lugar tras un reset
        self.mic_row.pack(before=self.score, pady=(8, 0))  # elegir mic acá
        self.start_stats.pack(before=self.entry, pady=(0, 4))  # header arriba del paste
        self.entry.focus_set()

    def _reset(self, _event=None) -> None:
        """Botón/atajo de pánico: descarta el juego y vuelve a la pantalla inicial.

        Si hay un hilo de grabación o TTS en curso, no lo podemos matar (es
        daemon), pero su resultado se descarta: al volver al estado 'input', los
        handlers de la cola ignoran lo que llegue tarde. Asi un reset es de
        verdad y no te pisa la pantalla nueva con un score viejo.
        """
        self.game = None
        self.busy = False
        self.last_audio = None
        self._gen += 1  # invalida cualquier trabajo async en curso
        self._show_input()

    def _render_target(self) -> None:
        assert self.game is not None
        t = self.game.current
        n = len(self.game.targets)
        kind_label = {
            Kind.WORD: "Cola de práctica", Kind.SENTENCE: "Oración",
            Kind.BOSS: "👑 JEFE FINAL",
        }.get(t.kind, "Objetivo")
        self.progress.config(text=f"{kind_label}   ·   {self.game.index + 1} / {n}")
        self._render_progress_blocks()
        self._render_status_line()  # palabras a mejorar / proxima, bajo la barra
        self._render_hp_bar()  # barra de dominio del objetivo actual
        self._render_run_chrome()  # racha / combo

        # Tamaño segun largo: el parrafo (jefe) chico, oracion mediana, palabra
        # grande. El jefe ademas baja a 15 si es MUY largo (>220 chars).
        # Card de LECTURA: oracion/jefe a la izquierda (se lee como contenido, no
        # como banner centrado); palabra suelta centrada (es corta).
        # El "peligro" del jefe va por BORDE amarillo (2px), NO por fill amarillo
        # full: el fill gritaba ERROR/alerta. SENTENCE/WORD vuelven al hairline 1px.
        size = self._target_font_size(t)  # incluye el zoom P/L (self._font_delta)
        if t.kind == Kind.BOSS:
            self.target.config(
                text=t.label, bg=SURFACE1, fg=FG, font=(UI, size, "bold"),
                justify="left", anchor="w",
                highlightthickness=2, highlightbackground=YELLOW,
            )
        elif t.kind == Kind.SENTENCE:
            self.target.config(
                text=t.label, bg=SURFACE1, fg=FG, font=(UI, size, "bold"),
                justify="left", anchor="w",
            )
            _bordered(self.target, 1)
        else:  # word (practica): una sola palabra -> centrada
            self.target.config(
                text=t.label, bg=SURFACE1, fg=ACCENT, font=(UI, size, "bold"),
                justify="center", anchor="center",
            )
            _bordered(self.target, 1)

    def _render_status_line(self) -> None:
        """Renglon bajo la barra de progreso: las palabras A MEJORAR del objetivo
        actual (persisten tras calificar), o la próxima si no hay errores."""
        if self.game is None:
            self.incoming.config(text="")
            return
        worst = self._worst_words() if self.game.current.is_multiword else []
        if worst:
            # El jefe rotula "Puntos débiles" con un pipe list compacto (foco en QUE
            # mejorar). La oracion muestra una cola numerada "A practicar (R)" -> se
            # lee como lista de tareas, no como metricas sueltas.
            if self.game.current.kind == Kind.BOSS:
                resumen = "  |  ".join(f"{w}×{c}" for w, c in worst[:8])
                self.incoming.config(text=f"Puntos débiles:  {resumen}", fg=INK_MUTED)
            else:
                lines = "\n".join(
                    f"  {i}. {w}  ×{c}" for i, (w, c) in enumerate(worst[:6], 1)
                )
                self.incoming.config(
                    text=f"A practicar ({self._k('practice')}):\n{lines}", fg=INK_MUTED,
                )
            return
        upcoming = self.game.targets[self.game.index + 1 :]
        nxt = upcoming[0] if upcoming else None
        if nxt is None:
            self.incoming.config(text="¡Último objetivo!", fg=DIM)
        elif nxt.kind == Kind.BOSS:
            self.incoming.config(text="Próxima:  👑 EL JEFE (todo el párrafo)", fg=DIM)
        elif nxt.kind == Kind.WORD:
            self.incoming.config(text=f"Próxima:  {nxt.label}", fg=DIM)
        else:
            self.incoming.config(text="")  # próxima oración: sin label redundante

    def _render_progress_blocks(self) -> None:
        """Barra tipo Tetris: un bloque por objetivo. Color por ESTADO real:
        VERDE = derrotado, ROJO = intentado sin derrotar, GRIS = no intentado.
        El objetivo ACTUAL se marca con ▶ (el jefe siempre con ♛)."""
        for child in self.progress_blocks.winfo_children():
            child.destroy()
        if self.game is None:
            return
        for i, target in enumerate(self.game.targets):
            status = self._status.get(id(target))
            # Color is the FILL of the chip, not text fg. Pendiente = surface-2.
            bg_fill = {"defeated": GREEN, "failed": RED}.get(status, SURFACE2)
            fg_text = BG if status in ("defeated", "failed") else INK_MUTED
            if target.kind == Kind.BOSS:
                char = "♛"
            elif i == self.game.index:
                char = "▶"  # objetivo actual
            else:
                char = "■"
            lbl = tk.Label(
                self.progress_blocks, text=char, bg=bg_fill, fg=fg_text,
                font=(UI, 11, "bold"),
                highlightthickness=1, highlightbackground=HAIRLINE,
            )
            # ipadx/ipady are geometry manager options, not widget config options
            lbl.pack(side="left", padx=3, ipadx=6, ipady=2)

    def _flash(self, color: str) -> None:
        """Destello breve de la barra superior como feedback (pass/fail)."""
        self.flash_bar.config(bg=color)
        self.root.after(450, lambda: self.flash_bar.config(bg=BG))

    # --------------------------------------------------------------- RPG chrome
    def _render_hp_bar(self) -> None:
        """Barra de dominio del objetivo: se llena con tu mejor accuracy lograda.
        Solo para oracion/jefe (multiword); oculta en input/win y en palabras."""
        if self.game is None or not self.game.current.is_multiword:
            self.hp_wrap.pack_forget()
            return
        hp = self._best_hp.get(id(self.game.current), 0.0)
        ratio = max(0.0, min(1.0, hp / 100.0))
        self.hp_fill.config(bg=self._score_color(hp))
        self.hp_fill.place(relx=0, rely=0, relwidth=ratio, relheight=1)
        # after=progress_blocks -> queda entre la barra de bloques y el status line,
        # sin importar el orden de creacion de los widgets.
        self.hp_wrap.pack(after=self.progress_blocks, pady=(6, 0))

    def _render_run_chrome(self) -> None:
        """Racha + combo bajo el badge. Solo muestra lo que vale la pena (>= 2)."""
        parts = []
        if self._streak >= 2:
            parts.append(f"Racha {self._streak}")
        if self._combo >= 2:
            parts.append(f"Combo x{self._combo}")
        self.run_chrome.config(text="   ·   ".join(parts))

    def _xp_flash(self, amount: int) -> None:
        """Muestra '+N XP' un instante y lo borra (con guard de generacion)."""
        self._xp_gen += 1
        gen = self._xp_gen
        self.xp_flash.config(text=f"+{amount} XP")
        self.root.after(900, lambda: self._clear_xp_flash(gen))

    def _clear_xp_flash(self, gen: int) -> None:
        if self._xp_gen == gen:  # nadie disparo otro flash mientras tanto
            self.xp_flash.config(text="")

    def _render_start_stats(self) -> None:
        """Header de jugador en la pantalla inicial: 'Level N · Accuracy X%'."""
        if self.stats is None:
            self.start_stats.config(text="")
            return
        text = f"Level {self.stats.level}"
        if self.stats.accuracy_count > 0:  # accuracy real solo si ya jugaste
            text += f"   ·   Accuracy {self.stats.accuracy:.0f}%"
        self.start_stats.config(text=text)

    # ----------------------------------------------------------- zoom de fuente
    def _target_font_size(self, t: "Target") -> int:
        """Tamaño de la card de lectura segun tipo+largo, con el zoom P/L sumado.
        Unica fuente del calculo: la usan _render_target y _apply_font_scale."""
        if t.kind == Kind.BOSS:
            base, floor = (13 if len(t.label) > 220 else 15), 8
        elif t.kind == Kind.SENTENCE:
            base, floor = (12 if len(t.label) > 90 else 14), 8
        else:  # word (drill)
            base, floor = 20, 10
        return max(floor, base + self._font_delta)

    def _on_font_bigger(self, _event=None) -> None:
        self._bump_font(+2)

    def _on_font_smaller(self, _event=None) -> None:
        self._bump_font(-2)

    def _bump_font(self, step: int) -> None:
        """Zoom de la card de lectura + el feedback. No actua en la pantalla inicial:
        ahi no hay texto que leer y P/L son letras que podrias estar tipeando."""
        if self.game is None or self.state == "input":
            return
        self._font_delta = max(-6, min(16, self._font_delta + step))
        self._apply_font_scale()

    def _apply_font_scale(self) -> None:
        """Re-aplica el zoom: feedback siempre; la card solo si muestra texto a leer
        (no el titulo ni el trofeo de victoria)."""
        self.feedback.config(font=(UI, max(8, 11 + self._font_delta)))
        if self.game is not None and self.state in ("ready", "recording", "pass", "fail"):
            t = self.game.current
            self.target.config(font=(UI, self._target_font_size(t), "bold"))

    # ------------------------------------------------------------- acciones
    def _on_start(self, _event=None) -> str | None:
        if self.busy or self.state != "input":
            return "break"
        paragraph = self.entry.get("1.0", "end-1c").strip()
        if not paragraph:
            return "break"
        sentences = _split_sentences(paragraph)
        if not sentences:
            return "break"
        self.mic_device = self._selected_mic()  # fijamos el mic elegido
        self._begin_game(sentences)
        return "break"  # evita que Shift+Enter inserte un salto de linea

    def _begin_game(self, sentences: list[str]) -> None:
        """Arranca el juego: sub-jefes (oraciones) + jefe final (parrafo)."""
        self.busy = False
        self._total_attempts = 0  # arranca partida nueva
        self._errors = {}
        self._status = {}
        self._return_target = None
        self._practice_origin = None
        self._practice_targets = []
        # Cada parrafo es una corrida nueva: los contadores RPG arrancan de cero.
        self._streak = 0
        self._combo = 0
        self._run_xp = 0
        self._best_hp = {}
        self.game = Game(sentences)
        self.entry.pack_forget()
        self.mic_row.pack_forget()
        self.start_stats.pack_forget()  # el header de jugador es solo de la input screen
        self.root.focus_set()
        self._enter_ready()

    def _enter_ready(self) -> None:
        self.state = "ready"
        # Si salimos de las palabras de practica (volvimos a una oracion/jefe),
        # las quitamos de la lista para no ensuciar.
        if self._practice_targets and id(self.game.current) not in {
            id(t) for t in self._practice_targets
        }:
            self._cleanup_practice()
        self._gen += 1  # invalida consejos/ranking viejos
        self._word_attempts = 0  # arranca un objetivo nuevo
        self.last_audio = None  # grabacion del objetivo anterior ya no aplica
        self._render_target()
        self._score_badge("", BG, DIM)
        self._clear_units()
        self._coach_clear()
        self.feedback.config(text="", fg=INK_MUTED)
        self._refresh_hints()

    def _on_space(self, _event=None) -> None:
        if self.busy:
            return
        if self.state == "input":
            return  # que el Entry maneje el espacio
        if self.state == "win":
            self._show_input()
            return
        if self.state == "pass":
            self.game.advance()
            if self.game.finished:
                self._win()
            else:
                self._enter_ready()
            return
        # ready o fail -> grabar
        self._start_recording()

    def _on_repeat(self, _event=None) -> None:
        if self.busy or self.state in ("input", "win") or self.game is None:
            return
        self._start_tts(self.game.current.reference)

    def _on_word_click(self, word: str) -> None:
        # Click en una palabra del desglose -> la reproduce (recordatorio rapido).
        if self.busy or self.game is None:
            return
        self._start_tts(word)

    def _on_retry(self, _event=None) -> None:
        # Reintentar el objetivo actual, incluso si ya lo derrotaste (estado pass).
        if self.busy or self.game is None or self.state not in ("ready", "fail", "pass"):
            return
        self._start_recording()

    def _on_clear_errors(self, _event=None) -> None:
        # Reiniciar la lista de palabras a practicar del objetivo ACTUAL.
        # (Para avanzar ya no hace falta saltar: navegás con Q/W.)
        if self.busy or self.game is None or self.state not in ("ready", "fail", "pass"):
            return
        self._errors[id(self.game.current)] = {}
        self._render_status_line()  # refresca la lista de palabras a mejorar
        self._refresh_hints()  # R/X dejan de aparecer si ya no hay errores
        self.feedback.config(text="🧹 Lista de práctica reiniciada.", fg=DIM)

    def _on_skip_to_boss(self, _event=None) -> None:
        # A es un TOGGLE: si no estas en el jefe, vas al jefe (recordando de donde);
        # si ya estas en el jefe, volves a ese objetivo (o a la 1ra oracion).
        if self.busy or self.game is None or self.state not in ("ready", "fail", "pass"):
            return
        boss_idx = self._boss_index()
        if boss_idx is None:
            return  # parrafo de una sola oracion: no hay jefe separado
        if self.game.current.kind == Kind.BOSS:
            back = next(
                (i for i, t in enumerate(self.game.targets) if t is self._return_target),
                0,  # si no hay a donde volver, a la primera
            )
            self._return_target = None
            self.game.index = back
        else:
            self._return_target = self.game.current  # para volver con A
            self.game.index = boss_idx
        self._enter_ready()

    def _on_prev(self, _event=None) -> None:
        # Q: navegar al sub-jefe/jefe ANTERIOR (saltea las palabras de drill).
        self._navigate(forward=False)

    def _on_next(self, _event=None) -> None:
        # W: navegar al sub-jefe/jefe SIGUIENTE (saltea las palabras de drill).
        self._navigate(forward=True)

    def _navigate(self, forward: bool) -> None:
        if self.busy or self.game is None or self.state not in ("ready", "fail", "pass"):
            return
        multiword_idx = [
            i for i, t in enumerate(self.game.targets) if t.is_multiword
        ]
        if forward:
            candidates = [i for i in multiword_idx if i > self.game.index]
        else:
            candidates = [i for i in multiword_idx if i < self.game.index]
        if not candidates:
            return  # no hay a donde ir
        self.game.index = candidates[0] if forward else candidates[-1]
        self._enter_ready()

    def _boss_index(self) -> int | None:
        if self.game is None:
            return None
        return next(
            (i for i, t in enumerate(self.game.targets) if t.kind == Kind.BOSS), None
        )

    def _cur_errors(self) -> dict[str, int]:
        """Palabras a mejorar del objetivo ACTUAL: {palabra: cant_errores}."""
        if self.game is None:
            return {}
        return self._errors.setdefault(id(self.game.current), {})

    def _cleanup_practice(self) -> None:
        """Quita de la lista de objetivos las palabras de practica insertadas,
        conservando el objetivo actual (recalcula su indice)."""
        if self.game is None:
            self._practice_origin = None
            self._practice_targets = []
            return
        cur = self.game.current
        ids = {id(t) for t in self._practice_targets}
        self.game.targets = [t for t in self.game.targets if id(t) not in ids]
        self.game.index = next(
            (i for i, t in enumerate(self.game.targets) if t is cur), 0
        )
        self._practice_origin = None
        self._practice_targets = []

    def _worst_words(self) -> list[tuple[str, int]]:
        """Palabras a mejorar del objetivo actual, de MAS a menos fallada."""
        return sorted(self._cur_errors().items(), key=lambda kv: kv[1], reverse=True)

    def _on_practice_worst(self, _event=None) -> None:
        """R: entrar/salir del modo practica.

        Desde una oracion/parrafo con errores -> inserta esas palabras (de peor a
        mejor) ANTES del objetivo y las vas drilleando. Desde una palabra de drill
        -> SALE y vuelve a la oracion. Al salir se limpian las palabras insertadas.
        """
        if self.busy or self.game is None or self.state not in ("ready", "fail", "pass"):
            return
        # Si ya estoy drilleando (palabra) -> salir a la oracion de origen.
        if self.game.current.kind == Kind.WORD and self._practice_origin is not None:
            idx = next(
                (i for i, t in enumerate(self.game.targets) if t is self._practice_origin),
                None,
            )
            if idx is not None:
                self.game.index = idx
            self._enter_ready()  # al volver al origen, _enter_ready limpia
            return
        if not self.game.current.is_multiword:
            return
        worst = [w for w, _s in self._worst_words()]
        if not worst:
            self.feedback.config(
                text="No hay palabras para practicar acá. Leé la oración primero.",
                fg=DIM,
            )
            return
        # Insertamos las palabras a practicar JUSTO antes del objetivo actual; al
        # avanzar por ellas (o con R/W) volvés a la oracion y se limpian.
        practice = [Target.word(w) for w in worst]
        self._practice_origin = self.game.current
        self._practice_targets = practice
        i = self.game.index
        self.game.targets[i:i] = practice
        self._enter_ready()

    def _on_play_mine(self, _event=None) -> None:
        if self.busy or self.state in ("input", "win") or self.game is None:
            return
        if not self.last_audio:
            if self.state in ("fail", "pass"):
                # Grabó, pero la captura del mic no se pudo guardar.
                msg = "Grabaste, pero no pude guardar el audio de ese micrófono."
            else:
                msg = "Todavía no grabaste nada. Apretá ESPACIO y hablá."
            self.feedback.config(text=msg, fg=DIM)
            return
        self._start_play(self.last_audio)

    def _start_play(self, path: str) -> None:
        self.busy = True
        self.hint.config(text="🔊 Reproduciendo TU voz…")

        def work() -> None:
            err = self.audio.play_recording(path)
            self.results.put(("tts", err))  # mismo handler que el TTS

        threading.Thread(target=work, daemon=True).start()

    def _on_mic_test(self, _event=None) -> None:
        # Solo en la pantalla inicial (ahi se elige el mic y se prueba).
        if self.busy or self.state != "input":
            return
        self._start_mic_test()

    def _start_mic_test(self) -> None:
        self.busy = True
        device = self._selected_mic()
        self.feedback.config(text="🎙 Grabando 3 segundos… ¡decí algo!", fg=ACCENT)

        def work() -> None:
            path, err = self.audio.record_test(device, seconds=3.0)
            if err:
                self.results.put(("mictest", (None, err)))
                return
            self.results.put(("mictest_status", "playing"))
            play_err = self.audio.play_recording(path)
            self.results.put(("mictest", (path, play_err)))

        threading.Thread(target=work, daemon=True).start()

    def _start_recording(self) -> None:
        self.busy = True
        self.state = "recording"
        self._gen += 1  # nueva grabacion: invalida el consejo del intento anterior
        self._total_attempts += 1
        self._word_attempts += 1
        self._clear_units()
        self._coach_clear()
        # Semaforo en ROJO: el mic todavia se esta conectando, NO hables aun.
        self._score_badge("⏳  Preparando micrófono…", BG, DIM)
        self.feedback.config(text="Esperá la luz verde. Todavía NO hables.", fg=DIM)
        self.hint.config(text="")
        self.hint_keys.config(text="")  # durante la grabacion no hay teclas
        target = self.game.current.reference
        device = self.mic_device
        long_form = self.game.current.long_form  # tolera pausas largas (oracion/jefe)
        # El jefe (parrafo entero) usa reconocimiento CONTINUO (sin tope de ~15s).
        continuous = self.game.current.continuous

        def on_status(code: str) -> None:
            # Corre en hilos del SDK: solo encolar, nunca tocar tkinter aca.
            self.results.put(("status", code))

        def work() -> None:
            assessment = self.scorer.assess(
                target, on_status=on_status, device=device,
                long_form=long_form, continuous=continuous,
            )
            self.results.put(("assess", assessment))

        threading.Thread(target=work, daemon=True).start()

    def _set_recording_status(self, code: str) -> None:
        """Semaforo durante la grabacion, manejado por eventos del SDK."""
        kind = self.game.current.kind if self.game else Kind.WORD
        que = {
            Kind.BOSS: "Leé TODO el párrafo (podés pausar entre oraciones).",
            Kind.SENTENCE: "Leé la oración completa, fuerte y claro.",
        }.get(kind, "Decí la palabra UNA sola vez, fuerte y claro.")
        if code == "listening":
            # Estado ACTIVO -> fill ACCENT (azul = "estás en vivo"); texto blanco.
            # GREEN queda reservado SOLO para PASS, asi nunca significa dos cosas.
            self._score_badge("🟢  ¡HABLÁ AHORA!", ACCENT, FG)
            self.feedback.config(text=que, fg=INK_MUTED)
            self.hint.config(text="Cuando termines, quedate en silencio un toque.")
        elif code == "speech":
            self._score_badge("🎤  Te escucho…", ACCENT, FG)
            self.feedback.config(text="Seguí. Callate al terminar para cerrar.", fg=INK_MUTED)
        elif code == "processing":
            # Warning/working -> fill YELLOW con texto NEGRO (14:1).
            self._score_badge("⏳  Procesando…", YELLOW, BG)
            self.feedback.config(text="Listo, dejá que Azure analice.", fg=INK_MUTED)
            self.hint.config(text="")

    def _start_tts(self, text: str) -> None:
        self.busy = True
        self.hint.config(text="🔊 Reproduciendo…")

        def work() -> None:
            err = self.scorer.speak(text)
            self.results.put(("tts", err))

        threading.Thread(target=work, daemon=True).start()

    # ----------------------------------------------------- cola de hilos
    def _poll(self) -> None:
        try:
            while True:
                kind, payload = self.results.get_nowait()
                if kind == "assess":
                    self._on_assessment(payload)  # type: ignore[arg-type]
                elif kind == "status":
                    if self.state == "recording":
                        self._set_recording_status(payload)  # type: ignore[arg-type]
                elif kind == "tts":
                    self.busy = False
                    if self.state == "input":
                        continue  # se reseteo: no pisar la pantalla inicial
                    err = payload  # type: ignore[assignment]
                    if err:
                        self.feedback.config(text=str(err), fg=RED)
                    self._refresh_hints()  # restaura la barra tras reproducir
                elif kind == "mictest_status":
                    if payload == "playing" and self.state == "input":
                        self.feedback.config(
                            text="🔊 Reproduciendo lo que grabaste… ¿te escuchás?",
                            fg=ACCENT,
                        )
                elif kind == "mictest":
                    self.busy = False
                    if self.state != "input":
                        continue
                    _path, err = payload  # type: ignore[misc]
                    if err:
                        self.feedback.config(text=f"❌ {err}", fg=RED)
                    else:
                        self.feedback.config(
                            text="✅ ¿Te escuchaste? El micrófono ANDA. Escribí tu oración y Enter.",
                            fg=GREEN,
                        )
                elif kind == "tip":
                    gen, tip = payload  # type: ignore[misc]
                    if gen == self._gen and self.state == "fail":
                        # La pista estatica (feedback) se queda; el consejo del LLM
                        # va al recuadro destacado. Si fallo, sacamos 'pensando…'.
                        if tip:
                            self._coach_show(tip)
                        else:
                            self._coach_clear()
        except queue.Empty:
            pass
        self.root.after(80, self._poll)

    def _on_assessment(self, a: Assessment) -> None:
        self.busy = False
        if self.game is None or self.state == "input":
            return  # se reseteo mientras grababamos: descartar resultado viejo
        self.last_audio = a.audio_path  # tu grabacion, para reproducir con P

        if not a.ok:
            self.state = "fail"
            self._streak = 0  # un fallo corta la racha y el combo
            self._combo = 0
            self._status[id(self.game.current)] = "failed"  # intentado, no derrotado
            self._render_progress_blocks()
            self._score_badge("—", RED, BG)
            self._clear_units()
            self._coach_clear()
            self.feedback.config(text=a.error or "Algo salió mal.", fg=INK_MUTED)
            self._render_run_chrome()
            self._refresh_hints()
            return

        heard = f"escuché: “{a.recognized_text}”" if a.recognized_text else ""
        is_multiword = self.game.current.is_multiword  # oracion o parrafo
        threshold = self.config.pass_threshold

        # Desglose: por palabra (oracion/parrafo) o por fonema (palabra suelta).
        if is_multiword:
            units = [(w.word, w.accuracy) for w in a.words]
            # Contador de errores por palabra: +1 a las que no llegan al umbral;
            # las que SI llegan salen de la lista (ya las dominás). Base del modo R.
            errs = self._cur_errors()
            for label, score in units:
                if score < threshold:
                    errs[label] = errs.get(label, 0) + 1
                else:
                    errs.pop(label, None)
            self._render_status_line()  # las muestra bajo la barra de progreso
            # Combo: palabras PERFECTAS seguidas (>= max(umbral, 97)). Recorre en
            # orden; la primera que no llega lo corta. Si el intento termina fallando,
            # la rama de fail lo resetea igual (un fallo rompe el combo).
            perfect_bar = max(threshold, 97.0)
            for _label, score in units:
                self._combo = self._combo + 1 if score >= perfect_bar else 0
        else:
            phons = a.words[0].phonemes if a.words else []
            units = [(p.phoneme, p.accuracy) for p in phons]
        # El JEFE no muestra el muro de tiles de TODAS las palabras (eso era el caos
        # del feedback #5): muestra solo los PUNTOS DEBILES (las que no llegan al
        # umbral). Asi el grid no infla la columna ni desborda la ventana. La oracion
        # corta si muestra todas (son pocas y caben). `units` completo se conserva
        # arriba para el conteo de errores y el combo.
        display_units = units
        if self.game.current.kind == Kind.BOSS:
            display_units = [(w, s) for w, s in units if s < threshold]
        # Las PALABRAS (oracion/parrafo) son clickeables para oirlas; los fonemas no.
        self._render_units(display_units, clickable=is_multiword)
        # HP del objetivo = mejor accuracy lograda (la barra se llena al mejorar).
        tid = id(self.game.current)
        self._best_hp[tid] = max(self._best_hp.get(tid, 0.0), a.accuracy)
        self._render_hp_bar()

        # Regla de aprobado (dominio puro en scoring.py): regla estricta — TODOS
        # los sonidos >= umbral — mas el rescate near-miss. La justificacion
        # detallada de cada via vive en scoring.judge.
        reference = self.game.current.reference
        recognized_ok = (
            _normalize_text(a.recognized_text) == _normalize_text(reference)
        )
        verdict = judge(
            units,
            accuracy=a.accuracy,
            recognized_ok=recognized_ok,
            threshold=threshold,
            near_miss_margin=self.config.near_miss_margin,
        )
        passed = verdict.passed
        by_recognition = verdict.by_recognition
        worst_label, worst_score = verdict.worst_label, verdict.worst_score

        # Estado para los cuadritos: verde si lo derrotaste, rojo si no.
        # Capturamos el estado PREVIO antes de pisarlo: distingue una derrota nueva
        # (da XP) de re-pasar algo ya derrotado (no farmea).
        prev_status = self._status.get(id(self.game.current))
        self._status[id(self.game.current)] = "defeated" if passed else "failed"
        self._render_progress_blocks()

        if passed:
            self.state = "pass"
            self._streak += 1  # un objetivo mas al hilo (re-pase incluido)
            if self.stats is not None:
                self.stats.best_streak = max(self.stats.best_streak, self._streak)
            # XP solo la PRIMERA vez que se derrota este objetivo (re-pasar no suma).
            if prev_status != "defeated":
                self._run_xp += XP_PER_DEFEAT
                if self.stats is not None:
                    self.stats.record_defeat(a.accuracy, XP_PER_DEFEAT)
                self._xp_flash(XP_PER_DEFEAT)
            self._flash(GREEN)
            self._score_badge(f"✅  {a.accuracy:.0f}%  ¡DERROTADA!", GREEN, BG)
            if by_recognition:
                self.feedback.config(
                    text=f"Cerca (≥ {threshold - self.config.near_miss_margin:.0f}%) y te entendí perfecto. ✓  {heard}".strip(),
                    fg=INK_MUTED,
                )
            else:
                self.feedback.config(
                    text=f"Todos los sonidos ≥ {threshold:.0f}%.  {heard}".strip(), fg=INK_MUTED
                )
            self._coach_clear()
            self._refresh_hints()
        else:
            self.state = "fail"
            self._streak = 0  # un fallo corta la racha y el combo
            self._combo = 0
            self._flash(RED)
            if worst_label is not None:
                self._score_badge(
                    f"❌  [{worst_label}] {worst_score:.0f}%  ·  faltan sonidos", RED, BG
                )
            else:
                self._score_badge(f"❌  {a.accuracy:.0f}%", RED, BG)
            # Pista estatica: instantanea, discreta (vive en feedback). El umbral
            # vive arriba a la izquierda (goal_label), no acá: no es feedback.
            tip = self._fail_hint(a, is_multiword)
            self.feedback.config(
                text=f"{tip}" + (f"   ·   {heard}" if heard else ""), fg=INK_MUTED
            )
            self._refresh_hints()
            # Consejo de DeepSeek: SE SUMA (no reemplaza) en el recuadro destacado.
            # Solo en palabras sueltas (drill): el consejo es a nivel fonema.
            if self.coach.available and not is_multiword:
                self._coach_loading()
                self._request_tip(a)
            else:
                self._coach_clear()
        self._render_run_chrome()  # actualiza racha/combo tras pass o fail

    def _request_tip(self, a: Assessment) -> None:
        word = self.game.current.reference
        phonemes = [
            (p.phoneme, p.accuracy) for p in (a.words[0].phonemes if a.words else [])
        ]
        recognized = a.recognized_text
        word_attempts = self._word_attempts
        total_attempts = self._total_attempts
        gen = self._gen  # si cambia el contexto antes de que llegue, se descarta

        def work() -> None:
            tip = self.coach.tip(
                word, phonemes, recognized, word_attempts, total_attempts,
                self.config.cefr_level,
            )
            self.results.put(("tip", (gen, tip)))

        threading.Thread(target=work, daemon=True).start()

    # --------------------------------------------------- desglose visual
    def _score_badge(self, text: str, fill: str, fg: str) -> None:
        """Sets score badge as a filled chip (bordered) or idle text (no border)."""
        self.score.config(text=text, bg=fill, fg=fg)
        if fill != BG:
            self.score.config(highlightthickness=1, highlightbackground=HAIRLINE)
        else:
            self.score.config(highlightthickness=0)

    def _score_color(self, score: float) -> str:
        # Verde = pasa el umbral (la nueva regla: TODOS deben estar verdes para
        # derrotar). Amarillo = cerca pero no alcanza. Rojo = lejos.
        if score >= self.config.pass_threshold:
            return GREEN
        if score >= 75:
            return YELLOW
        return RED

    def _render_units(self, units: list[tuple[str, float]], clickable: bool = False) -> None:
        """Pinta cada unidad (fonema o palabra) con su score debajo.

        Se ENVUELVE en varias filas (grid) y achica la fuente cuando hay muchas
        unidades, para que el jefe (oracion larga) no desborde la ventana.
        clickable=True (palabras): hacer click en una la reproduce (recordatorio).
        """
        self._clear_units()
        n = len(units)
        if n == 0:
            return
        # Pocas (fonemas de una palabra) -> grandes, una fila. Muchas (palabras
        # del parrafo) -> chicas, mas columnas y varias filas, para que no
        # desborde la ventana aunque el texto sea largo.
        # ipad = aire INTERNO del tile (ipadx, ipady en el grid). Dos escalas:
        # - FONEMAS (palabra suelta, clickable=False): labels cortos (1-2 chars) ->
        #   van grandes, pocas columnas.
        # - PALABRAS (oracion/jefe, clickable=True): labels largos -> fuente menor y
        #   mas columnas, para que el grid NO supere el ancho de la columna central
        #   (~588px) y por ende no la infle.
        if not clickable:  # fonemas
            if n <= 7:
                font_size, sub, cols, pad, ipad = 16, 9, n, (5, 2), (6, 4)
            elif n <= 14:
                font_size, sub, cols, pad, ipad = 13, 8, 7, (4, 2), (4, 3)
            else:
                font_size, sub, cols, pad, ipad = 11, 7, 8, (3, 1), (3, 2)
        else:  # palabras
            if n <= 6:
                font_size, sub, cols, pad, ipad = 12, 8, n, (4, 2), (5, 3)
            elif n <= 12:
                font_size, sub, cols, pad, ipad = 11, 7, 6, (3, 2), (4, 2)
            elif n <= 24:
                font_size, sub, cols, pad, ipad = 10, 7, 8, (3, 1), (3, 2)
            else:
                font_size, sub, cols, pad, ipad = 9, 7, 9, (3, 1), (3, 1)
        for i, (text, score) in enumerate(units):
            # color is the FILL of the chip; BG (black) text on status fill.
            color = self._score_color(score)
            cell = tk.Frame(
                self.units, bg=color,
                highlightthickness=1, highlightbackground=HAIRLINE,
            )
            # ipadx/ipady are geometry manager options, not widget config options
            cell.grid(
                row=i // cols, column=i % cols,
                padx=pad[0], pady=pad[1], ipadx=ipad[0], ipady=ipad[1],
            )
            wlabel = tk.Label(
                cell, text=text, bg=color, fg=BG,
                font=(UI, font_size, "bold"),
            )
            wlabel.pack()
            slabel = tk.Label(
                cell, text=f"{score:.0f}%", bg=color, fg=BG,
                font=(UI, sub, "bold"),
            )
            slabel.pack()
            if clickable:
                # Click en la palabra -> la reproduce (recordatorio rapido).
                for widget in (cell, wlabel, slabel):
                    widget.config(cursor="hand2")
                    widget.bind("<Button-1>", lambda _e, w=text: self._on_word_click(w))

    def _clear_units(self) -> None:
        for child in self.units.winfo_children():
            child.destroy()

    # ---- recuadro del consejo de DeepSeek (la pista estatica vive en feedback) --
    def _coach_clear(self) -> None:
        self.coach_tip.config(text="", bg=BG, fg=DIM, highlightthickness=0)

    def _coach_loading(self) -> None:
        # Mientras DeepSeek piensa: texto tenue, sin recuadro.
        self.coach_tip.config(text="🧠 pensando un consejo…", bg=BG, fg=DIM, highlightthickness=0)

    def _coach_show(self, tip: str) -> None:
        # Consejo listo: SURFACE1 card + hairline + FG text (surface-1 elevation).
        self.coach_tip.config(
            text=f"🧠  {tip}", bg=SURFACE1, fg=FG,
            highlightthickness=1, highlightbackground=HAIRLINE,
        )

    def _fail_hint(self, a: Assessment, is_multiword: bool) -> str:
        """Texto accionable de 'que arreglar' (el desglose ya muestra los scores)."""
        if is_multiword:
            weak = a.weak_words(below=self.config.pass_threshold)
            if not weak:
                return f"Casi. Completaste {a.completeness:.0f}%, fluidez {a.fluency:.0f}%."
            partes = "  ".join(f"{w.word} {w.accuracy:.0f}%" for w in weak)
            return f"Palabras a mejorar:  {partes}   ·   🔊 clic en una para oírla"
        phons = a.words[0].phonemes if a.words else []
        if not phons:
            return "Casi. Afiná un poquito y de nuevo."
        worst = min(phons, key=lambda p: p.accuracy)
        base = f"Enfocate en [{worst.phoneme}] ({worst.accuracy:.0f}%)"
        tip = _phoneme_hint(worst.phoneme)
        return f"{base}: {tip}" if tip else base

    def _win(self) -> None:
        self.state = "win"
        # Unico punto de ESCRITURA a disco: al ganar persistimos la progresion.
        # Los tests nunca llegan aca (no escriben). best_streak se consolida ahora.
        if self.stats is not None:
            self.stats.best_streak = max(self.stats.best_streak, self._streak)
            self.store.save(self.stats)
        self._flash(GREEN)
        self.progress.config(text="")
        self.incoming.config(text="")
        self.hp_wrap.pack_forget()  # sin barra de HP en la pantalla de victoria
        self.run_chrome.config(text="")
        self.xp_flash.config(text="")
        for child in self.progress_blocks.winfo_children():
            child.destroy()
        # WIN: GREEN fill hero card with BG (black) text — the trophy block.
        # Centrado (no hereda el anchor="w" de la ultima oracion) y borde reseteado
        # al hairline (por si venimos del jefe con su borde amarillo de 2px).
        self.target.config(
            text="🏆  ¡GANASTE!", bg=GREEN, fg=BG, font=(UI, 30, "bold"),
            justify="center", anchor="center",
        )
        _bordered(self.target, 1)
        self._score_badge("", BG, DIM)
        self._clear_units()
        xp_line = f"   ·   +{self._run_xp} XP" if self._run_xp else ""
        self.feedback.config(
            text=f"Leíste todo el párrafo. ¡Crack!{xp_line}", fg=INK_MUTED
        )
        self._refresh_hints()


def main() -> None:
    _init_x11_threads()  # antes de cualquier tk.Tk(): ver docstring de la funcion
    try:
        config = Config.load()
    except RuntimeError as exc:
        # Mostramos el error en una ventanita en vez de reventar en consola.
        root = tk.Tk()
        root.title("Pronunciation Tetris — configuracion")
        root.configure(bg=BG)
        root.geometry("620x220")
        # Card SURFACE1 con borde RED (semantic-error): mismo lenguaje surface-lift
        # que la app, el error marcado por el hairline rojo en vez de fill de color.
        tk.Label(
            root,
            text=str(exc),
            bg=SURFACE1,
            fg=FG,
            font=(UI, 12),
            wraplength=560,
            justify="left",
            highlightthickness=1,
            highlightbackground=RED,
        ).pack(expand=True, padx=20, pady=20, ipadx=12, ipady=10)
        tk.Label(
            root, text="Cerrá, configurá .env y volvé a abrir.", bg=BG, fg=DIM
        ).pack(pady=(0, 16))
        root.mainloop()
        return

    # Composition root: el UNICO lugar que conoce los adaptadores concretos. Se
    # importan localmente a proposito -> asi importar `app` (p. ej. desde un
    # test) no arrastra el SDK de Azure ni HTTP, y App queda testeable con dobles.
    from audio import LocalAudio
    from coach import Coach
    from scorer import Scorer

    root = tk.Tk()
    App(root, config, Scorer(config), Coach(config), LocalAudio())
    root.mainloop()


if __name__ == "__main__":
    main()
