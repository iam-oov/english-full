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

import customtkinter as ctk

# Tema oscuro global de CustomTkinter. Se setea al importar (no crea ningun root
# Tk ni toca X11, asi que es seguro antes de _init_x11_threads); los tests que
# importan `app` heredan el mismo modo.
ctk.set_appearance_mode("dark")

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

# Paleta del rediseño (CustomTkinter · dark azulado con acento azul y esquinas
# redondeadas). Reemplaza la paleta HashiCorp monocroma.
BG           = "#0f1117"  # canvas de la ventana: gris oscuro suave (no negro puro)
SURFACE1     = "#1a1d27"  # cards / textbox / superficies elevadas
SURFACE2     = "#232733"  # chips, pills, controles secundarios
BORDER       = "#2e3340"  # borde sutil de cards y controles
HAIRLINE     = BORDER     # alias retro-compat (el codigo viejo usaba HAIRLINE)
FG           = "#f2f4f8"  # ink: titulos / texto principal
INK_MUTED    = "#9aa1ac"  # body / instrucciones / ecos
DIM          = "#646b78"  # chrome tenue: counters, hints, labels
INK_SUBTLE   = DIM        # alias del mismo token
ACCENT       = "#3d7dff"  # azul: acento de card, segmentos hechos, foco, CTA
ACCENT_HOVER = "#5a90ff"  # hover del acento
GREEN        = "#22c55e"  # semantic pass / derrotado
GREEN_DIM    = "#16321f"  # fill oscuro del tile verde
RED          = "#ef4444"  # semantic fail
RED_DIM      = "#2c1719"  # fill oscuro del tile rojo
AMBER        = "#e8920c"  # warning / jefe (segmento naranja, banner near-miss)
AMBER_DIM    = "#241c10"  # fill oscuro del banner ambar
YELLOW       = AMBER      # alias retro-compat (el codigo viejo usaba YELLOW)
UI           = "TkDefaultFont"  # familia base; los widgets ctk aceptan tuplas (UI, n)
MONO         = "TkFixedFont"


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
        self.root.configure(fg_color=BG)
        self.root.geometry("900x780")
        self.root.minsize(720, 580)

        # Barra de destello arriba: pulsa verde al ganar / rojo al fallar.
        # corner_radius=0 -> rectangulo neto pegado al borde superior.
        self.flash_bar = ctk.CTkFrame(
            self.root, height=4, corner_radius=0, fg_color=BG
        )
        self.flash_bar.pack(side="top", fill="x")

        # Indicador de OBJETIVO (config, no feedback): arriba-izquierda, chico y
        # tenue. Te recuerda visualmente el umbral por sonido. Va con .place (capa
        # propia sobre root); como la columna `content` se crea despues y es alta,
        # la solaparia -> al final de _build_ui la subimos con .lift().
        self.goal_label = ctk.CTkLabel(
            self.root,
            text=f"🎯 objetivo: {self.config.pass_threshold:.0f}% por sonido",
            text_color=DIM, font=(UI, 11),
        )
        self.goal_label.place(x=16, y=12)

        # Fila de pills (hints) al pie: se reconstruye en _refresh_hints.
        self.hints_row = ctk.CTkFrame(self.root, fg_color="transparent")
        self.hints_row.pack(side="bottom", pady=(0, 14))

        # Columna central: agrupa el contenido y lo centra como un bloque, para que
        # en pantallas anchas NO quede flotando con enormes vacios a los costados.
        # flash_bar (arriba) y hints_row (abajo) viven en root; todo lo del medio
        # vive en este contenedor transparente.
        self.content = ctk.CTkFrame(self.root, fg_color="transparent")
        self.content.pack(expand=True)

        # Barra tipo Tetris: un segmento por objetivo (derrotado / actual /
        # pendiente / jefe). El progreso de un vistazo. Se reconstruye en
        # _render_progress_blocks.
        self.progress_blocks = ctk.CTkFrame(self.content, fg_color="transparent")
        self.progress_blocks.pack(pady=(4, 10))

        # Contador "Oración 3 de 8".
        self.progress = ctk.CTkLabel(
            self.content, text="", text_color=DIM, font=(UI, 12)
        )
        self.progress.pack(pady=(0, 8))

        # Card de lectura: SURFACE1 redondeada con borde sutil y una barra de acento
        # a la izquierda. El texto se lee como contenido, no como alerta.
        self.target_card = ctk.CTkFrame(
            self.content, fg_color=SURFACE1, corner_radius=14,
            border_width=1, border_color=BORDER, width=540,
        )
        self.target_card.pack(pady=(0, 10), fill="x")
        # Barra de acento vertical pegada al borde izquierdo de la card.
        self.target_accent = ctk.CTkFrame(
            self.target_card, width=4, corner_radius=2, fg_color=ACCENT
        )
        self.target_accent.place(relx=0.0, rely=0.5, anchor="w", x=14, relheight=0.62)
        self.target = ctk.CTkLabel(
            self.target_card, text="", text_color=FG, font=(UI, 16, "bold"),
            wraplength=470, justify="left", anchor="w",
        )
        self.target.pack(padx=(34, 24), pady=24, fill="x")

        # Barra de "HP"/dominio del objetivo actual: se LLENA con tu mejor accuracy.
        # Se packea/oculta dinamicamente en _render_hp_bar (solo oracion/jefe).
        self.hp_bar = ctk.CTkProgressBar(
            self.content, width=300, height=6, corner_radius=3,
            fg_color=SURFACE2, progress_color=GREEN,
        )
        self.hp_bar.set(0)

        # Status line: justify="left" para que la lista numerada "A practicar"
        # (multi-linea) se lea como lista; en textos de una linea no cambia nada.
        self.incoming = ctk.CTkLabel(
            self.content, text="", text_color=INK_MUTED, font=(UI, 12),
            wraplength=520, justify="left",
        )
        self.incoming.pack(pady=(0, 4))

        # Banner de resultado: card cuyo color/borde lo define _style_result segun
        # el veredicto (idle/pass/fail). Adentro: el score grande + el feedback.
        self.result_card = ctk.CTkFrame(
            self.content, fg_color="transparent", corner_radius=10
        )
        self.result_card.pack(pady=(0, 4), fill="x")
        self.score = ctk.CTkLabel(
            self.result_card, text="", font=(UI, 15, "bold"), text_color=FG
        )
        self.score.pack(pady=(8, 2), padx=14)
        self.feedback = ctk.CTkLabel(
            self.result_card, text="", text_color=INK_MUTED, font=(UI, 12),
            wraplength=500, justify="left",
        )
        self.feedback.pack(pady=(0, 8), padx=14)

        # Chrome de la corrida: racha + combo, chiquito y tenue.
        self.run_chrome = ctk.CTkLabel(
            self.content, text="", text_color=DIM, font=(UI, 11)
        )
        self.run_chrome.pack(pady=(2, 0))
        # Flash de XP: aparece breve (+40 XP) al derrotar un objetivo nuevo.
        self.xp_flash = ctk.CTkLabel(
            self.content, text="", text_color=GREEN, font=(UI, 12, "bold")
        )
        self.xp_flash.pack(pady=(0, 0))

        # Desglose por fonema (palabra) o por palabra (jefe): un tile por unidad.
        self.units = ctk.CTkFrame(self.content, fg_color="transparent")
        self.units.pack(pady=(8, 0))

        # Consejo del LLM (DeepSeek): debajo de la pista estatica. Idle = texto DIM;
        # al mostrarse, _coach_show lo eleva a card.
        self.coach_tip = ctk.CTkLabel(
            self.content, text="", text_color=DIM, font=(UI, 12, "bold"),
            wraplength=500, justify="center",
        )
        self.coach_tip.pack(pady=(8, 0))

        # CTA PRINCIPAL: boton redondeado (pill). Click = misma accion que ESPACIO
        # via _on_primary (que despacha _on_start / _on_space segun el estado).
        self.hint = ctk.CTkButton(
            self.content, text="", command=self._on_primary,
            font=(UI, 14, "bold"), height=46, corner_radius=23,
            fg_color="transparent", border_width=1, border_color=BORDER,
            hover_color=SURFACE2, text_color=FG,
        )
        self.hint.pack(pady=(14, 0))

        # --- widgets SOLO de la pantalla inicial (se crean aca, se packean en
        # _show_input y se ocultan en _begin_game) ---
        self.start_stats = ctk.CTkLabel(
            self.content, text="", text_color=INK_MUTED, font=(UI, 13, "bold")
        )
        # Cuadro multi-linea para PEGAR un parrafo (Enter = salto de linea;
        # Shift+Enter = empezar).
        self.entry = ctk.CTkTextbox(
            self.content, width=480, height=120, corner_radius=12,
            fg_color=SURFACE1, border_width=1, border_color=BORDER,
            font=(UI, 13), wrap="word",
        )
        # Selector de microfono (solo visible en la pantalla inicial).
        self.mic_row = ctk.CTkFrame(self.content, fg_color="transparent")
        ctk.CTkLabel(
            self.mic_row, text="🎙", text_color=DIM, font=(UI, 13)
        ).pack(side="left")
        self._mic_options = self._list_microphones()
        self.mic_var = tk.StringVar(value=self._mic_options[0][0])
        self.mic_menu = ctk.CTkOptionMenu(
            self.mic_row, variable=self.mic_var,
            values=[label for label, _dev in self._mic_options],
            font=(UI, 12), corner_radius=8,
            fg_color=SURFACE2, button_color=SURFACE2, button_hover_color=BORDER,
            text_color=FG, dropdown_fg_color=SURFACE1,
            dropdown_hover_color=SURFACE2, dropdown_text_color=FG, width=260,
        )
        self.mic_menu.pack(side="left", padx=(8, 0))
        self.mic_test_btn = ctk.CTkButton(
            self.mic_row, text="🎧 Probar", command=self._on_mic_test,
            font=(UI, 12, "bold"), corner_radius=8, width=90, height=28,
            fg_color="transparent", border_width=1, border_color=BORDER,
            hover_color=SURFACE2, text_color=FG,
        )
        self.mic_test_btn.pack(side="left", padx=(8, 0))

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

    def _on_primary(self, _event=None) -> None:
        """Despachador del CTA: en 'input' empieza el juego; si no, replica ESPACIO.

        El boton no puede llamar a _on_space y _on_start a la vez, asi que este
        wrapper decide segun el estado (igual que hacian el viejo click + ESPACIO).
        """
        if self.state == "input":
            self._on_start()
        else:
            self._on_space()

    def _keys_line(self) -> list[tuple[str, str]]:
        """Pills de accion segun el estado/objetivo: lista de (tecla, etiqueta)."""
        # Drilleando una palabra: solo audio + salir de practica + navegar.
        if self.game is not None and self.game.current.kind == Kind.WORD:
            items = [
                (self._k("retry"), "reintentar"),
                (self._k("mine"), "tu voz"),
                (self._k("correct"), "la correcta"),
            ]
            if self._practice_origin is not None:
                items.append((self._k("practice"), "salir de práctica"))
            items.append((f"{self._k('prev')}/{self._k('next')}", "◀ ▶ navegar"))
            return items

        has_errors = (
            self.game is not None
            and self.game.current.is_multiword
            and bool(self._cur_errors())
        )
        items: list[tuple[str, str]] = []
        # A es toggle: 'ir al jefe' desde una oracion, 'volver' desde el jefe.
        if self.game is not None and self._boss_index() is not None:
            if self.game.current.kind == Kind.BOSS:
                items.append((self._k("boss"), "volver"))
            else:
                items.append((self._k("boss"), "ir al jefe"))
        items.append((self._k("retry"), "reintentar"))
        items.append((self._k("mine"), "tu voz"))
        items.append((self._k("correct"), "la correcta"))
        if has_errors:
            items.append((self._k("practice"), "practicar"))
            items.append((self._k("clear"), "limpiar práctica"))
        items.append((f"{self._k('prev')}/{self._k('next')}", "◀ ▶ navegar"))
        return items

    def _clear_hints_row(self) -> None:
        for child in self.hints_row.winfo_children():
            child.destroy()

    def _refresh_hints(self) -> None:
        """Actualiza el CTA principal + redibuja las pills de la barra inferior."""
        # 1) Texto del CTA segun el estado.
        if self.state == "input":
            self.hint.configure(text="▷  Empezar")
        elif self.state == "win":
            self.hint.configure(text="↻  Otra vez")
        elif self.state == "recording":
            self.hint.configure(text="🎙 Escuchando…")
        elif self.state == "pass":
            self.hint.configure(text="➡  Siguiente")
        elif self.state == "fail":
            self.hint.configure(text="🎤  Reintentar")
        else:  # ready
            self.hint.configure(text="🎤  Hablar ahora")

        # 2) Pills: las de accion (segun estado/objetivo) + las de sistema (fijas).
        self._clear_hints_row()
        # Durante la grabacion no ofrecemos teclas de accion (no aplican).
        if self.state in ("input", "win", "recording"):
            action_pills: list[tuple[str, str]] = []
        else:
            action_pills = self._keys_line()
        system_pills = [
            (f"{self._k('font_up')}/{self._k('font_down')}", "fuente"),
            ("Ctrl+R", "reset"),
            ("Esc", "salir"),
        ]
        for key, label in action_pills + system_pills:
            pill = ctk.CTkFrame(self.hints_row, fg_color=SURFACE2, corner_radius=8)
            pill.pack(side="left", padx=4)
            ctk.CTkLabel(
                pill, text=key, text_color=FG, font=(UI, 10, "bold"),
                fg_color="transparent",
            ).pack(side="left", padx=(8, 4), pady=4)
            ctk.CTkLabel(
                pill, text=label, text_color=DIM, font=(UI, 10),
                fg_color="transparent",
            ).pack(side="left", padx=(0, 8))

    # ----------------------------------------------------------- pantallas
    def _show_input(self) -> None:
        self.state = "input"
        # Carga unica de la progresion desde disco. Es un READ benigno: si el
        # archivo no existe devuelve stats frescas y NO lo crea (clave para que los
        # tests que construyen un App no escriban a disco).
        if self.stats is None:
            self.stats = self.store.load()
        self.progress.configure(text="")
        self.incoming.configure(text="")
        self._render_progress_blocks()  # game es None -> limpia los bloques
        self._render_hp_bar()  # game es None -> oculta la barra de HP
        self.run_chrome.configure(text="")  # sin racha/combo en la pantalla inicial
        self.xp_flash.configure(text="")
        self._render_start_stats()  # "Level N · Accuracy X%"
        # Titulo: centrado (hero), card en su estado neutro (acento azul) por si
        # venimos de un jefe (que deja borde ambar de 2px).
        self.target_card.configure(
            fg_color=SURFACE1, border_color=BORDER, border_width=1
        )
        self.target_accent.configure(fg_color=ACCENT)
        self.target.configure(
            text="Pronunciation Tetris", text_color=ACCENT,
            font=(UI, 28, "bold"), justify="center", anchor="center",
        )
        self._score_badge("", DIM)
        self._style_result("idle")
        self._clear_units()
        self._coach_clear()
        self.feedback.configure(
            text="Pegá un párrafo (oraciones separadas por “.” o saltos de línea) "
            "y apretá Shift+Enter.",
            text_color=INK_MUTED,
        )
        self._refresh_hints()
        self.entry.delete("1.0", "end")
        # Orden de la pantalla inicial: card(titulo) -> start_stats -> entry ->
        # mic_row -> CTA. Los packeamos ANTES del CTA (self.hint).
        self.start_stats.pack(before=self.hint, pady=(0, 6))
        self.entry.pack(before=self.hint, pady=(0, 8))
        self.mic_row.pack(before=self.hint, pady=(0, 8))
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
        self.progress.configure(text=f"{kind_label}   ·   {self.game.index + 1} / {n}")
        self._render_progress_blocks()
        self._render_status_line()  # palabras a mejorar / proxima, bajo la barra
        self._render_hp_bar()  # barra de dominio del objetivo actual
        self._render_run_chrome()  # racha / combo

        # Tamaño segun largo: el parrafo (jefe) chico, oracion mediana, palabra
        # grande (ver _target_font_size). Card de LECTURA: oracion/jefe a la
        # izquierda (se lee como contenido), palabra suelta centrada (es corta).
        # El "peligro" del jefe va por BORDE ambar (2px) + acento ambar, NO por
        # fill ambar full (gritaba ERROR). SENTENCE/WORD vuelven al borde sutil.
        size = self._target_font_size(t)  # incluye el zoom P/L (self._font_delta)
        if t.kind == Kind.BOSS:
            self.target_card.configure(
                fg_color=SURFACE1, border_color=AMBER, border_width=2
            )
            self.target_accent.configure(fg_color=AMBER)
            self.target.configure(
                text=t.label, text_color=FG, font=(UI, size, "bold"),
                justify="left", anchor="w",
            )
        elif t.kind == Kind.SENTENCE:
            self.target_card.configure(
                fg_color=SURFACE1, border_color=BORDER, border_width=1
            )
            self.target_accent.configure(fg_color=ACCENT)
            self.target.configure(
                text=t.label, text_color=FG, font=(UI, size, "bold"),
                justify="left", anchor="w",
            )
        else:  # word (practica): una sola palabra -> centrada, en acento
            self.target_card.configure(
                fg_color=SURFACE1, border_color=BORDER, border_width=1
            )
            self.target_accent.configure(fg_color=ACCENT)
            self.target.configure(
                text=t.label, text_color=ACCENT, font=(UI, size, "bold"),
                justify="center", anchor="center",
            )

    def _render_status_line(self) -> None:
        """Renglon bajo la barra de progreso: las palabras A MEJORAR del objetivo
        actual (persisten tras calificar), o la próxima si no hay errores."""
        if self.game is None:
            self.incoming.configure(text="")
            return
        worst = self._worst_words() if self.game.current.is_multiword else []
        if worst:
            # El jefe rotula "Puntos débiles" con un pipe list compacto (foco en QUE
            # mejorar). La oracion muestra una cola numerada "A practicar (R)" -> se
            # lee como lista de tareas, no como metricas sueltas.
            if self.game.current.kind == Kind.BOSS:
                resumen = "  |  ".join(f"{w}×{c}" for w, c in worst[:8])
                self.incoming.configure(
                    text=f"Puntos débiles:  {resumen}", text_color=INK_MUTED
                )
            else:
                lines = "\n".join(
                    f"  {i}. {w}  ×{c}" for i, (w, c) in enumerate(worst[:6], 1)
                )
                self.incoming.configure(
                    text=f"A practicar ({self._k('practice')}):\n{lines}",
                    text_color=INK_MUTED,
                )
            return
        upcoming = self.game.targets[self.game.index + 1 :]
        nxt = upcoming[0] if upcoming else None
        if nxt is None:
            self.incoming.configure(text="¡Último objetivo!", text_color=DIM)
        elif nxt.kind == Kind.BOSS:
            self.incoming.configure(
                text="Próxima:  👑 EL JEFE (todo el párrafo)", text_color=DIM
            )
        elif nxt.kind == Kind.WORD:
            self.incoming.configure(text=f"Próxima:  {nxt.label}", text_color=DIM)
        else:
            self.incoming.configure(text="")  # próxima oración: sin label redundante

    def _render_progress_blocks(self) -> None:
        """Barra tipo Tetris: un segmento por objetivo. Color por ESTADO real:
        AZUL = derrotado, ROJO = intentado sin derrotar, GRIS = no intentado.
        El objetivo ACTUAL es mas alto (lee como "en progreso"); el jefe es ambar
        y lleva una coronita al lado."""
        for child in self.progress_blocks.winfo_children():
            child.destroy()
        if self.game is None:
            self.progress_blocks.pack_forget()  # vacio: no dejar el hueco de 200x200
            return
        self.progress_blocks.pack(before=self.progress, pady=(4, 10))
        n = len(self.game.targets)
        # Ancho por segmento: escala para que la fila entre en ~480px.
        seg_w = max(16, 480 // max(n, 1))
        for i, target in enumerate(self.game.targets):
            status = self._status.get(id(target))
            # defeated -> ACCENT (azul = hecho); failed -> RED; pendiente -> SURFACE2.
            color = {"defeated": ACCENT, "failed": RED}.get(status, SURFACE2)
            is_current = i == self.game.index
            # El objetivo actual aun no intentado se resalta con ACCENT_HOVER;
            # si ya tiene estado, conserva su color. Mas alto = "en progreso".
            if is_current and status is None:
                color = ACCENT_HOVER
            if target.kind == Kind.BOSS:
                # El jefe siempre se distingue en ambar (salvo ya derrotado/fallado).
                if status is None:
                    color = AMBER
            height = 8 if is_current else 6
            seg = ctk.CTkFrame(
                self.progress_blocks, width=seg_w, height=height,
                corner_radius=3, fg_color=color,
            )
            seg.pack(side="left", padx=3)
            if target.kind == Kind.BOSS:
                # Coronita junto al segmento del jefe.
                ctk.CTkLabel(
                    self.progress_blocks, text="👑", font=(UI, 11),
                    fg_color="transparent",
                ).pack(side="left", padx=(2, 0))

    def _flash(self, color: str) -> None:
        """Destello breve de la barra superior como feedback (pass/fail)."""
        self.flash_bar.configure(fg_color=color)
        self.root.after(450, lambda: self.flash_bar.configure(fg_color=BG))

    def _style_result(self, kind: str) -> None:
        """Estiliza el banner de resultado (result_card) segun el veredicto.

        idle      -> sin fill ni borde (transparente).
        pass       -> fill BG + borde verde.
        fail_amber -> fill ambar tenue + borde ambar (near miss / parcial).
        fail_red   -> fill rojo tenue + borde rojo (lejos / error).
        El color del texto (score/feedback) lo siguen poniendo sus propios setters.
        """
        styles = {
            "idle": dict(fg_color="transparent", border_width=0),
            "pass": dict(fg_color=BG, border_width=1, border_color=GREEN),
            "fail_amber": dict(fg_color=AMBER_DIM, border_width=1, border_color=AMBER),
            "fail_red": dict(fg_color=RED_DIM, border_width=1, border_color=RED),
        }
        self.result_card.configure(**styles.get(kind, styles["idle"]))

    # --------------------------------------------------------------- RPG chrome
    def _render_hp_bar(self) -> None:
        """Barra de dominio del objetivo: se llena con tu mejor accuracy lograda.
        Solo para oracion/jefe (multiword); oculta en input/win y en palabras."""
        if self.game is None or not self.game.current.is_multiword:
            self.hp_bar.pack_forget()
            return
        hp = self._best_hp.get(id(self.game.current), 0.0)
        self.hp_bar.configure(progress_color=self._score_color(hp))
        self.hp_bar.set(max(0.0, min(1.0, hp / 100.0)))
        # after=progress_blocks -> queda entre la barra de bloques y el status line,
        # sin importar el orden de creacion de los widgets.
        self.hp_bar.pack(after=self.progress_blocks, pady=(0, 6))

    def _render_run_chrome(self) -> None:
        """Racha + combo bajo el badge. Solo muestra lo que vale la pena (>= 2)."""
        parts = []
        if self._streak >= 2:
            parts.append(f"Racha {self._streak}")
        if self._combo >= 2:
            parts.append(f"Combo x{self._combo}")
        self.run_chrome.configure(text="   ·   ".join(parts))

    def _xp_flash(self, amount: int) -> None:
        """Muestra '+N XP' un instante y lo borra (con guard de generacion)."""
        self._xp_gen += 1
        gen = self._xp_gen
        self.xp_flash.configure(text=f"+{amount} XP")
        self.root.after(900, lambda: self._clear_xp_flash(gen))

    def _clear_xp_flash(self, gen: int) -> None:
        if self._xp_gen == gen:  # nadie disparo otro flash mientras tanto
            self.xp_flash.configure(text="")

    def _render_start_stats(self) -> None:
        """Header de jugador en la pantalla inicial: 'Level N · Accuracy X%'."""
        if self.stats is None:
            self.start_stats.configure(text="")
            return
        text = f"Level {self.stats.level}"
        if self.stats.accuracy_count > 0:  # accuracy real solo si ya jugaste
            text += f"   ·   Accuracy {self.stats.accuracy:.0f}%"
        self.start_stats.configure(text=text)

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
        self.feedback.configure(font=(UI, max(8, 12 + self._font_delta)))
        if self.game is not None and self.state in ("ready", "recording", "pass", "fail"):
            t = self.game.current
            self.target.configure(font=(UI, self._target_font_size(t), "bold"))

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
        # Los widgets de la pantalla inicial salen del layout durante el juego.
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
        self._score_badge("", DIM)
        self._style_result("idle")
        self._clear_units()
        self._coach_clear()
        self.feedback.configure(text="", text_color=INK_MUTED)
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
        self.feedback.configure(text="🧹 Lista de práctica reiniciada.", text_color=DIM)

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
            self.feedback.configure(
                text="No hay palabras para practicar acá. Leé la oración primero.",
                text_color=DIM,
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
            self.feedback.configure(text=msg, text_color=DIM)
            return
        self._start_play(self.last_audio)

    def _start_play(self, path: str) -> None:
        self.busy = True
        self.hint.configure(text="🔊 Reproduciendo TU voz…")

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
        self.feedback.configure(text="🎙 Grabando 3 segundos… ¡decí algo!", text_color=ACCENT)

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
        # Semaforo: el mic todavia se esta conectando, NO hables aun.
        self._score_badge("⏳  Preparando micrófono…", DIM)
        self._style_result("idle")
        self.feedback.configure(text="Esperá la luz verde. Todavía NO hables.", text_color=DIM)
        # Durante la grabacion el CTA muestra "escuchando" y no ofrece accion util.
        self.hint.configure(text="🎙 Escuchando…")
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
            # Estado ACTIVO -> texto ACCENT (azul = "estás en vivo").
            # GREEN queda reservado SOLO para PASS, asi nunca significa dos cosas.
            self._score_badge("🟢  ¡HABLÁ AHORA!", ACCENT)
            self.feedback.configure(text=que, text_color=INK_MUTED)
            self.hint.configure(text="🎙 Escuchando…")
        elif code == "speech":
            self._score_badge("🎤  Te escucho…", ACCENT)
            self.feedback.configure(
                text="Seguí. Callate al terminar para cerrar.", text_color=INK_MUTED
            )
        elif code == "processing":
            # Working -> texto ambar.
            self._score_badge("⏳  Procesando…", AMBER)
            self.feedback.configure(text="Listo, dejá que Azure analice.", text_color=INK_MUTED)
            self.hint.configure(text="🎙 Escuchando…")

    def _start_tts(self, text: str) -> None:
        self.busy = True
        self.hint.configure(text="🔊 Reproduciendo…")

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
                        self.feedback.configure(text=str(err), text_color=RED)
                    self._refresh_hints()  # restaura la barra tras reproducir
                elif kind == "mictest_status":
                    if payload == "playing" and self.state == "input":
                        self.feedback.configure(
                            text="🔊 Reproduciendo lo que grabaste… ¿te escuchás?",
                            text_color=ACCENT,
                        )
                elif kind == "mictest":
                    self.busy = False
                    if self.state != "input":
                        continue
                    _path, err = payload  # type: ignore[misc]
                    if err:
                        self.feedback.configure(text=f"❌ {err}", text_color=RED)
                    else:
                        self.feedback.configure(
                            text="✅ ¿Te escuchaste? El micrófono ANDA. Escribí tu oración y Enter.",
                            text_color=GREEN,
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
            self._score_badge("✕  —", RED)
            self._style_result("fail_red")
            self._clear_units()
            self._coach_clear()
            self.feedback.configure(text=a.error or "Algo salió mal.", text_color=INK_MUTED)
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
            self._score_badge(f"✅  {a.accuracy:.0f}%  ¡DERROTADA!", GREEN)
            self._style_result("pass")
            if by_recognition:
                self.feedback.configure(
                    text=f"Cerca (≥ {threshold - self.config.near_miss_margin:.0f}%) y te entendí perfecto. ✓  {heard}".strip(),
                    text_color=INK_MUTED,
                )
            else:
                self.feedback.configure(
                    text=f"Todos los sonidos ≥ {threshold:.0f}%.  {heard}".strip(),
                    text_color=INK_MUTED,
                )
            self._coach_clear()
            self._refresh_hints()
        else:
            self.state = "fail"
            self._streak = 0  # un fallo corta la racha y el combo
            self._combo = 0
            self._flash(RED)
            # Parcial (>= 40) -> banner ambar; lejos (< 40) -> banner rojo.
            partial = worst_score >= 40 if worst_label is not None else a.accuracy >= 40
            badge_color = AMBER if partial else RED
            icon = "⚠" if partial else "✕"
            self._style_result("fail_amber" if partial else "fail_red")
            if worst_label is not None:
                self._score_badge(
                    f"{icon}  [{worst_label}] {worst_score:.0f}%  ·  faltan sonidos",
                    badge_color,
                )
            else:
                self._score_badge(f"{icon}  {a.accuracy:.0f}%", badge_color)
            # Pista estatica: instantanea, discreta (vive en feedback). El umbral
            # vive arriba a la izquierda (goal_label), no acá: no es feedback.
            tip = self._fail_hint(a, is_multiword)
            self.feedback.configure(
                text=f"{tip}" + (f"   ·   {heard}" if heard else ""),
                text_color=INK_MUTED,
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
    def _score_badge(self, text: str, text_color: str) -> None:
        """Setea el texto del score con su color semantico.

        El fondo del banner ya no lo lleva el badge: lo pone _style_result sobre
        result_card. Aca solo va el texto + su color (GREEN pass, AMBER/RED fail,
        DIM idle)."""
        self.score.configure(text=text, text_color=text_color)

    def _score_color(self, score: float) -> str:
        # Verde = pasa el umbral (la regla: TODOS deben estar verdes para
        # derrotar). Ambar = parcial (>= 40). Rojo = lejos (< 40).
        if score >= self.config.pass_threshold:
            return GREEN
        if score >= 40:
            return AMBER
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
        # Hay tiles -> reinsertamos el contenedor en su lugar (antes del coach tip).
        self.units.pack(before=self.coach_tip, pady=(8, 0))
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
                font_size, sub, cols, pad = 16, 9, n, (5, 2)
            elif n <= 14:
                font_size, sub, cols, pad = 13, 8, 7, (4, 2)
            else:
                font_size, sub, cols, pad = 11, 7, 8, (3, 1)
        else:  # palabras
            if n <= 6:
                font_size, sub, cols, pad = 12, 8, n, (4, 2)
            elif n <= 12:
                font_size, sub, cols, pad = 11, 7, 6, (3, 2)
            elif n <= 24:
                font_size, sub, cols, pad = 10, 7, 8, (3, 1)
            else:
                font_size, sub, cols, pad = 9, 7, 9, (3, 1)
        threshold = self.config.pass_threshold
        for i, (text, score) in enumerate(units):
            # Tile NEUTRO (SURFACE2): el color va en el NUMERO + el borde, no en un
            # fill que gritaba. Borde: ok -> sutil; parcial (>=40) -> ambar; <40 -> rojo.
            if score >= threshold:
                border = BORDER
            elif score >= 40:
                border = AMBER
            else:
                border = RED
            cell = ctk.CTkFrame(
                self.units, fg_color=SURFACE2, corner_radius=8,
                border_width=1, border_color=border,
            )
            cell.grid(row=i // cols, column=i % cols, padx=pad[0], pady=pad[1])
            wlabel = ctk.CTkLabel(
                cell, text=text, text_color=FG,
                font=(UI, font_size, "bold"), fg_color="transparent",
            )
            wlabel.pack(padx=8, pady=(5, 0))
            slabel = ctk.CTkLabel(
                cell, text=f"{score:.0f}%", text_color=self._score_color(score),
                font=(UI, sub, "bold"), fg_color="transparent",
            )
            slabel.pack(padx=8, pady=(0, 5))
            if clickable:
                # Click en la palabra -> la reproduce (recordatorio rapido).
                # CTkFrame/CTkLabel exponen bind para el click; el cursor se setea
                # via configure(cursor=...).
                for widget in (cell, wlabel, slabel):
                    widget.configure(cursor="hand2")
                    widget.bind("<Button-1>", lambda _e, w=text: self._on_word_click(w))

    def _clear_units(self) -> None:
        for child in self.units.winfo_children():
            child.destroy()
        # Un CTkFrame VACIO no se encoge (queda en su tamaño default ~200x200), asi
        # que lo sacamos del layout cuando no tiene tiles para no dejar un hueco.
        self.units.pack_forget()

    # ---- recuadro del consejo de DeepSeek (la pista estatica vive en feedback) --
    def _coach_clear(self) -> None:
        self.coach_tip.configure(text="", fg_color="transparent", text_color=DIM)

    def _coach_loading(self) -> None:
        # Mientras DeepSeek piensa: texto tenue, sin recuadro.
        self.coach_tip.configure(
            text="🧠 pensando un consejo…", fg_color="transparent", text_color=DIM
        )

    def _coach_show(self, tip: str) -> None:
        # Consejo listo: card SURFACE1 redondeada con texto FG (surface-1 elevation).
        self.coach_tip.configure(
            text=f"🧠  {tip}", fg_color=SURFACE1, text_color=FG, corner_radius=10
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
        self.progress.configure(text="")
        self.incoming.configure(text="")
        self.hp_bar.pack_forget()  # sin barra de HP en la pantalla de victoria
        self.run_chrome.configure(text="")
        self.xp_flash.configure(text="")
        for child in self.progress_blocks.winfo_children():
            child.destroy()
        self.progress_blocks.pack_forget()  # vacio: no dejar el hueco de 200x200
        # WIN: card hero verde con texto BG (negro) — el bloque trofeo. Centrado
        # (no hereda el anchor="w" de la ultima oracion). El acento se funde con el
        # verde y la card resetea su borde (por si venimos del jefe con borde ambar).
        self.target_card.configure(fg_color=GREEN, border_color=GREEN, border_width=1)
        self.target_accent.configure(fg_color=GREEN)
        self.target.configure(
            text="🏆  ¡GANASTE!", text_color=BG, font=(UI, 28, "bold"),
            justify="center", anchor="center",
        )
        self._score_badge("", DIM)
        self._style_result("idle")
        self._clear_units()
        xp_line = f"   ·   +{self._run_xp} XP" if self._run_xp else ""
        self.feedback.configure(
            text=f"Leíste todo el párrafo. ¡Crack!{xp_line}", text_color=INK_MUTED
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

    root = ctk.CTk()
    App(root, config, Scorer(config), Coach(config), LocalAudio())
    root.mainloop()


if __name__ == "__main__":
    main()
