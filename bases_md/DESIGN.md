# DESIGN.md — Pronunciation Tetris (tkinter desktop · HashiCorp marketing system)

> **Platform:** Python + tkinter on Linux. No CSS, no web fonts, no `border-radius`,
> no `rgba()` alpha, no gradients, no `box-shadow`, no 3D illustrations. The only
> styling surfaces are: solid hex `bg`/`fg`, system fonts (`family`/`size`/`"bold"`),
> `padx`/`pady`/`ipadx`/`ipady`, `relief`, and `highlightthickness` +
> `highlightbackground` for a 1px-style colored frame.
>
> **Aesthetic source of truth:** the project-root `DESIGN.md`, an extracted
> **HashiCorp marketing** system — near-black canvas, charcoal surface-lift, 1px
> translucent gray hairlines, white/gray ink, accent-blue `#2b89ff` for interactive,
> uppercase eyebrow labels, surface-lift elevation (no shadows), `rounded.md` 8px
> CTAs. The brand reads as **restrained, engineered, monochrome** — the deliberate
> OPPOSITE of the neo-brutalist arcade version this file replaces. We adapt that
> system honestly to a desktop app: where a web signature has **no tkinter
> equivalent we say so and pick the closest faithful approximation**, never pretend.
>
> **This is a restyle only.** Keys (`F/D/S/A/R/X/Q/W` + `SPACE/ESC/Ctrl+R/Ctrl+T`),
> the `KEYS` dict, the state machine, threading, and all behavior stay identical.
> The **30 tests** (23 SOLID/architecture/integration + 7 config) assert behavior and
> the ports/adapters boundary (no Azure import on `import app`); **none assert
> colors, fonts, or widgets** (verified). Do not add imports to `app.py`, do not move
> logic, do not rename `KEYS`. All 30 stay green.

---

## 0. tkinter ⇄ HashiCorp-web compromises (read first)

The HashiCorp system is a WEB spec. Four of its signatures have **no native tkinter
equivalent**. Each is resolved honestly, not faked:

| HashiCorp web signature | tkinter reality | Resolution in this spec |
|---|---|---|
| `rounded.md` 8px / `rounded.lg` 12px corners on buttons & cards | tkinter widgets are **rectangular**; there is no `border-radius` at all | **Everything is SQUARE.** Buttons, the entry, the cards, the chips — all 90° corners. We do not simulate rounding (no fake corner pixmaps). Stated, not hidden. |
| 1px **translucent** hairline `rgba(178,182,189,0.1)` | tkinter borders are **opaque**; no alpha channel | Approximate with a **solid dim-gray 1px frame** via `highlightthickness=1 + highlightbackground=HAIRLINE`, where `HAIRLINE = #3b3d45` (the surface-3 token). On a `#15181e` surface that reads as a faint divider (≈1.6:1 — intentionally subtle, "felt more than seen", matching the brand) while still clearly bounding the field. |
| Gradients, 3D product illustrations, surface blur (glassmorphism) | none exist in tkinter | **Omitted entirely.** Depth comes only from charcoal surface-lift + the hairline. The per-product chromatic cards are also out — see §2 (NO product-accent mixing). |
| `hashicorpSans` / Inter / Geist web fonts; web type scale (`display-xl` 80px) | named web fonts are not guaranteed system fonts; 80px is absurd in an 880×760 window | Use **`TkDefaultFont`** (compact system UI font — a prior "DejaVu Sans" attempt felt *zoomed/too big*). **Re-map the scale to desktop point sizes** (§3). Preserve only the *weight* hierarchy (`normal` vs `bold`) and the tight-display/relaxed-body *feel* via size contrast — tkinter `Label`s have **no line-height control**, so hierarchy rides on size + weight alone. |

Two HashiCorp ideas map **cleanly** and we lean on them hard:

- **Elevation = surface lift, NOT shadow.** HashiCorp already uses `canvas → surface-1
  → surface-2` charcoal levels + a hairline instead of drop shadows. That is exactly
  what tkinter can do well (`bg` levels + `highlightbackground`). **Zero offset
  shadow frames anywhere.**
- **Monochrome chrome + one saturated interactive accent.** White/gray text on a
  near-black ground, with `ACCENT` blue reserved for the title and interactive/active
  states. tkinter handles flat solid fills perfectly.

---

## 1. Visual Theme

**"A black-canvas, charcoal-surface engineering console."** Pronunciation Tetris
becomes a quiet, technical desktop tool dressed in HashiCorp's marketing language:
a **near-black canvas** holds the whole window; meaningful groups lift one charcoal
step to **`SURFACE1`** cards bounded by a single faint **gray hairline**; type is
**white ink** with two muted grays for chrome; and one **accent-blue** carries the
title and every interactive/active moment. Sections are introduced by **uppercase,
ink-subtle eyebrow labels** ("PRONUNCIATION TRAINER", "TARGET", "SCORE") that mark
each zone as a category — the brand's most portable signature. Elevation is
expressed purely by surface lift + hairline, never by shadow; corners are square
(tkinter has no radius); status uses HashiCorp's own semantic set (Nomad-green
success, Vault-yellow warning, Consul-red error). The result is intentionally
**restrained and engineered** — the exact opposite of the bright, bordered,
neon-glow neo-brutalist board it replaces. The single memorable thing is the
**monochrome surface-lift hierarchy punctuated by lone accent-blue interactions and
tiny uppercase eyebrows** — confident and developer-facing, not consumer-y.

---

## 2. Color Palette

HashiCorp tokens mapped to tkinter constants. **Existing constant NAMES are kept**
(`BG FG DIM GREEN RED YELLOW ACCENT`) for a clean diff; new names are added
(`SURFACE1 SURFACE2 HAIRLINE INK_MUTED INK_SUBTLE`). All ratios are WCAG 2.1,
computed against the stated background.

**Canvas decision:** HashiCorp's canvas is **pure black `#000000`**. We **keep pure
black** rather than a near-black. Justification: the brand spec is explicit ("Canvas,
footer, comparison tables, hero — all black"), there is no glow or blur that needs a
lifted floor to read against (unlike the old neo-brutalist theme, which used
`#0F1419` *specifically* so its cyan glow would show — that requirement is gone), and
pure black maximizes the contrast of every charcoal surface above it, making the
surface-lift hierarchy read more crisply. White ink on black is the highest possible
contrast (21:1).

> All ratios below are **computed** (WCAG 2.1 relative-luminance formula), not
> estimated, and are accurate to ±0.01.

| Constant | Hex | HashiCorp token | Role | Contrast (vs which bg) |
|---|---|---|---|---|
| `BG` | `#000000` | `canvas` / `primary` | App canvas — root, chrome, every band's floor. | — (it is the bg) |
| `SURFACE1` *(new)* | `#15181e` | `surface-1` | Charcoal **card** lift — target card, entry field, score/coach panels. | fill→BG **1.18:1** → relies on `HAIRLINE` for the visible edge |
| `SURFACE2` *(new)* | `#1f232b` | `surface-2` | Two steps up — secondary button (mic "Probar"), hovered/active chrome. | fill→BG **1.33:1** → also carries `HAIRLINE` |
| `HAIRLINE` *(new)* | `#3b3d45` | `surface-3` / `hairline` | The **1px solid gray frame** standing in for the translucent web hairline. | as frame on SURFACE1 **1.64:1** (intentionally faint divider); on BG **1.94:1** |
| `FG` | `#ffffff` | `ink` / `on-primary` | Primary ink — headlines, emphasized body, card text. | FG→BG **21.00:1**; FG→SURFACE1 **17.78:1**; FG→SURFACE2 **15.75:1** |
| `INK_MUTED` *(new)* | `#b2b6bd` | `ink-muted` | Secondary ink — body/instructions, "próxima", status echoes. | →BG **10.32:1**; →SURFACE1 **8.74:1**; →SURFACE2 **7.74:1** (all ≥4.5 ✔) |
| `DIM` | `#656a76` | `ink-subtle` | Tertiary/chrome ink — eyebrows, goal label, hint rows, footnotes. | →BG **3.88:1** ⚠ (≥3:1 UI/large ✔, **<4.5 body**); →SURFACE1 **3.28:1**; →SURFACE2 **2.91:1** |
| `INK_SUBTLE` *(new)* | `#656a76` | `ink-subtle` | **Alias of `DIM`** (same token). Use either name; they are identical. | (see `DIM`) |
| `ACCENT` | `#2b89ff` | `accent-blue` | The one interactive accent — title, focus border, active/recording state. | as text →BG **6.12:1**; →SURFACE1 **5.19:1** (≥4.5 ✔); →SURFACE2 **4.59:1** (≥4.5 ✔) |
| `GREEN` | `#00ca8e` | `semantic-success` (= Nomad green) | Pass / defeated status. | as text →BG **9.84:1**; **black text on GREEN fill 9.84:1**; white-on-GREEN only 2.13 ✘ |
| `RED` | `#e62b1e` | `semantic-error` (= Consul red) | Fail status. | white text on RED fill **4.44:1** (just under 4.5 ⚠); **black on RED fill 4.73:1 ✔** |
| `YELLOW` | `#ffcf25` | `semantic-warning` (= Vault yellow) | Near-miss / warning / "processing". | **black text on YELLOW fill 14.20:1**; white-on-YELLOW only 1.48 ✘ |

**Accessibility contract (HashiCorp dark edition):**

- **White/muted ink passes easily on the dark surfaces.** `FG` (21.00 / 17.78 /
  15.75), `INK_MUTED` (10.32 / 8.74 / 7.74) all clear **4.5:1** for body on BG /
  SURFACE1 / SURFACE2. Use `INK_MUTED` for relaxed body (instructions, echoes) and
  `FG` for emphasis/headlines.
- **`DIM` / `INK_SUBTLE` (`#656a76`) is small CHROME ONLY — it does NOT pass body
  4.5:1 anywhere.** Measured: **3.88:1 on `BG`**, **3.28:1 on SURFACE1**, **2.91:1 on
  SURFACE2**. It clears the **3:1 large-text/UI** bar **only on `BG`** (3.88) and only
  for ≥18px-equivalent or bold ≥14px-equivalent text. **Rule:** `DIM` is allowed
  exclusively for **small bold/peripheral chrome on the canvas** — eyebrows
  (`(UI,9,"bold")`), goal label, the hint rows, `incoming` — and **never** as body
  copy nor on a `SURFACE1`/`SURFACE2` card. This matches HashiCorp reserving
  `ink-subtle` for "helper text, timestamps, footnotes" — peripheral, not body. Where
  a subtle label must sit on a card, use `INK_MUTED` (≥7.74) instead. *(If a future
  reviewer wants strict 4.5 even on chrome, the honest fix is to bump `DIM` toward
  `ink-muted`; this spec keeps the `ink-subtle` token as HashiCorp ships it and
  confines it to the ≥3:1-eligible chrome zone.)*
- **HAIRLINE carries the edge, not the fill.** `SURFACE1` (1.18:1) and `SURFACE2`
  (1.33:1) do **not** clear 3:1 against `BG` on their own — a bare charcoal card
  nearly dissolves into black. That is *intended* ("borders felt more than seen"),
  but to keep the field/card legibly bounded every surface gets
  `highlightthickness=1, highlightbackground=HAIRLINE`. The hairline itself is faint
  (1.64:1 on SURFACE1) — a divider, not a high-contrast frame — exactly the HashiCorp
  brand intent. Field/card legibility rides on the **white/muted text inside** (≥7.74)
  plus the surface step, not on the border contrast.
- **Status fills use BLACK text, not white.** Measured black-(`BG`)-on-fill: `GREEN`
  **9.84:1**, `YELLOW` **14.20:1**, `RED` **4.73:1** — all clear 4.5:1. The white
  alternatives FAIL: white-on-`GREEN` 2.13, white-on-`YELLOW` 1.48, white-on-`RED`
  4.44 (just under 4.5). So every status badge/chip/cell uses **black text**.
  (HashiCorp itself uses `inverse-ink` black on its light Vault-yellow button for the
  same reason.) Note `RED` is the tight one at 4.73 — keep its text **black and bold**;
  do not switch it to white.
- **`ACCENT` as text passes; as a text-bearing fill it's borderline.** Accent-blue is
  **6.12:1 on BG**, **5.19:1 on SURFACE1**, **4.59:1 on SURFACE2** — all ≥4.5, so it's
  safe for the title and link-like labels. As a **fill** the only legible text is
  **white at ≈3.43:1**, which clears just the **3:1 large/bold** bar — acceptable
  *only* for the short bold recording badge (`🟢 ¡HABLÁ AHORA!`, large bold). Elsewhere
  this spec uses `ACCENT` as **text and as the focus hairline**, never as small-text
  fill — see §5 / §8.
- **60-30-10:** ~60% black canvas (`BG`), ~30% charcoal surfaces + white/muted ink
  (`SURFACE1`/`SURFACE2`/`FG`/`INK_MUTED`), ~10% the single accent-blue + semantic
  status colors. Status color is always paired with text/glyph, never the sole signal.

**HashiCorp brand rules we honor literally:**
- **NO product-accent mixing.** HashiCorp uses per-product colors (Terraform purple,
  Vault yellow, Waypoint cyan …) as *identity* tokens and forbids mixing them in one
  viewport. This is a single-purpose app with **no product identity to signal**, so we
  use **only** `accent-blue` for interactivity and reuse the **semantic** subset
  (success/warning/error) for status. We do **not** introduce Terraform purple, etc.
  This both respects "don't combine multiple product accents" and keeps the chrome
  monochrome.
- **NO light mode.** HashiCorp marketing IS dark; we ship dark only.

---

## 3. Typography

**Font:** **`TkDefaultFont`** everywhere (the compact system UI proportional font).
HashiCorp's `hashicorpSans`/Inter/Geist are not guaranteed system fonts; a prior
**"DejaVu Sans"** attempt made the UI feel **zoomed/too big**, so we default to the
system UI font, which is sized for desktop chrome. HashiCorp says **"No mono"** on the
marketing surface, so — unlike the old theme — we use the **proportional UI font even
for the score and unit readouts**. `TkFixedFont` (`MONO`) stays *defined and
available* only as an escape hatch if a strictly column-aligned numeric readout is
later wanted; **the spec does not use it**.

Define module-level family aliases (keeps edits DRY, no behavior change):
`UI = "TkDefaultFont"`, and keep `MONO = "TkFixedFont"` available but unused.

**Scale re-map (web → desktop).** HashiCorp's `display-xl` 80px / `display-lg` 56px
are absurd in an 880×760 window. The hierarchy is re-mapped to **sane tkinter point
sizes**, calibrated so nothing feels "zoomed", while preserving HashiCorp's *weight*
ladder (500 body → tkinter `normal`; 600 emphasis / 700 display → tkinter `bold`) and
the tight-display/relaxed-body *feel* via **size contrast** (no line-height in tk):

| HashiCorp web token | web px | Desktop role here | tk size | weight |
|---|---|---|---|---|
| `display-xl/lg` (hero) | 80 / 56 | App/hero title (`target` in input · win trophy) | **28** (win **30**) | bold |
| `headline` | 28 | (largest in-game block) BOSS card | **18** (15 if >220 chars) | bold |
| `card-title` | 22 | SENTENCE card · WORD practice card | SENTENCE **16** (14 if >90); WORD **20** | bold |
| `subhead` | 20 | section sub-line / score badge | score **15** | bold |
| `body-lg` / `body` | 18 / 16 | relaxed body — instructions, feedback, coach | **12** | normal (coach: bold) |
| `body-sm` | 14 | entry field text · `incoming` status line | **11** | normal |
| `caption` | 13 | progress label · hint rows | **10** | normal/bold |
| `eyebrow` | 12 (uppercase, +0.6px track) | **eyebrow labels** + goal label | **9** | bold (uppercased text) |

Concrete per-region table (all `TkDefaultFont`):

| Region (var) | font tuple | Notes |
|---|---|---|
| App title (`target`, input) | `(UI, 28, "bold")` | hero; was 30 |
| Win trophy (`target`, win) | `(UI, 30, "bold")` | was 40 — 40 felt zoomed |
| `target` — BOSS | `(UI, 18, "bold")` (12 if >220 chars) | keep existing length logic |
| `target` — SENTENCE | `(UI, 16, "bold")` (14 if >90) | keep existing length logic |
| `target` — WORD (practice) | `(UI, 20, "bold")` | was 32 — 32 felt zoomed |
| Eyebrow labels (new, see §5) | `(UI, 9, "bold")` | UPPERCASE text, `DIM` fg |
| `goal_label` (🎯 objetivo) | `(UI, 9)` | keep 9 |
| `progress` (Oración · 2/7) | `(UI, 10)` | normal weight (chrome) |
| `progress_blocks` glyphs (■▶♛) | `(UI, 11, "bold")` | keep compact |
| `incoming` (status line) | `(UI, 11)` | was 10; +1 for body legibility |
| `entry` (paste box) | `(UI, 11)` | was 13 — 13 felt large; body-sm |
| mic menu / button | `(UI, 10, "bold")` | keep |
| `score` badge | `(UI, 15, "bold")` | **UI, not MONO** (no-mono brand) |
| unit chip — glyph (≤7) | `(UI, 16, "bold")` | UI; per-tier sizes below |
| unit chip — sub score | `(UI, 9, "bold")` | UI |
| `feedback` | `(UI, 12)` | relaxed body, normal weight |
| `coach_tip` | `(UI, 12, "bold")` | emphasis body |
| `hint` (SPACE line) | `(UI, 12, "bold")` | the one prominent CTA-ish line |
| `hint_keys` | `(UI, 10)` | chrome |
| `hint_sys` | `(UI, 9)` | chrome; was 8, +1 |

Unit-grid scale-down tiers in `_render_units` keep their existing breakpoints; only
swap family → `UI` and re-map sizes down a touch so dense grids don't feel zoomed:
`≤7 → 16/9`, `≤14 → 13/8`, `≤30 → 11/7`, `>30 → 9/7` (glyph/sub), all bold.

**Eyebrow treatment (the portable HashiCorp signature).** HashiCorp eyebrows are
12px, 600 weight, **uppercase**, **+0.6px letter-spacing**. tkinter `Label`s have
**no letter-spacing** control — we approximate by **(a)** uppercasing the text in the
string literal, **(b)** `DIM` (`ink-subtle`) color, **(c)** small size `(UI, 9,
"bold")`. The tracking is the one eyebrow property we lose; uppercase + subtle color +
small bold still reads unmistakably as a category label. (Optional, cosmetic-only: a
single thin space between letters can fake tracking, e.g. `"T A R G E T"` — leave this
OFF by default; it can hurt readability and is not required.)

**Calibration note ("no zoom").** Every hero/headline size dropped from the previous
theme (title 30→28, win 40→30, WORD 32→20) and body sizes are 11–12, because the
prior "DejaVu Sans" + larger scale read as zoomed. `TkDefaultFont` is already
desktop-calibrated; these point sizes were chosen so the 880×760 window feels like a
dense console, not a blown-up web page.

---

## 4. Component Stylings (widget-by-widget)

`hlbg` = `highlightbackground`, `hlt` = `highlightthickness`. The border, where
present, is the **1px solid `HAIRLINE`** (`hlt=1, hlbg=HAIRLINE`) — square, faint,
opaque (no rounding, no alpha). **Cards = `SURFACE1`**, chrome = `BG`,
secondary-button = `SURFACE2`. **No shadow column** — elevation is surface-lift only.

| Widget (var) | bg | fg | font | border (hlt/hlbg) | padding (ipad / pack) |
|---|---|---|---|---|---|
| `root` | `BG` | — | — | none | — |
| `flash_bar` | `BG` (pulses `GREEN`/`RED`) | — | — | none, `height=6` | `fill="x"` |
| `goal_label` (🎯) | `BG` | `DIM` | `(UI,9)` | none | `place x=12 y=12` |
| eyebrow labels (new) | `BG` | `DIM` | `(UI,9,"bold")` | none | small `pady` above each zone |
| `progress` | `BG` | `DIM` | `(UI,10)` | none | `pady=(8,0)` |
| `progress_blocks` (container) | `BG` | — | — | none | `pady=(8,0)` |
| progress block (each Label) | fill `GREEN`/`RED`/`SURFACE2` (pending) | **`BG`** on GREEN/RED; `INK_MUTED` on pending | `(UI,11,"bold")` | `hlt=1, hlbg=HAIRLINE` | `ipadx=6 ipady=2`, pack `padx=3` |
| `incoming` (status line) | `BG` | `INK_MUTED`/`DIM` | `(UI,11)` | none | `pady=(8,0)` |
| `target` (card) | `SURFACE1` (BOSS/win → status fill, see §7) | `FG`/`ACCENT`/`BG`* | `(UI, per §3)` | **`hlt=1, hlbg=HAIRLINE`** | `ipadx=24 ipady=18`, `expand=True` |
| `entry` (paste box) | `SURFACE1` | `FG` (`insertbackground=FG`) | `(UI,11)` | `hlt=1, hlbg=HAIRLINE`; **focus → `ACCENT` (see §5)** | `padx=10 pady=8` |
| `mic_row` (container) | `BG` | — | — | none | `pady=(8,0)` |
| mic `Label` (🎙) | `BG` | `DIM` | `(UI,10)` | none | `padx=(0,6)` |
| `mic_menu` (OptionMenu) | `SURFACE2` | `FG` | `(UI,10,"bold")` | `hlt=1, hlbg=HAIRLINE`, `relief=flat`, `activebackground=SURFACE1, activeforeground=FG` | — |
| `mic_menu["menu"]` | `SURFACE2` | `FG` | — | `activebackground=SURFACE1, activeforeground=FG` | — |
| `mic_test_btn` ("Probar") | `SURFACE2` | `FG` | `(UI,10,"bold")` | `bd=0, hlt=1, hlbg=HAIRLINE`, `relief=flat`, `activebackground=SURFACE1, activeforeground=FG`, `cursor=hand2` | `padx=12 ipady=2` |
| `score` (badge) | `BG` idle → on result/status `GREEN`/`RED`/`ACCENT`/`YELLOW` fill (§7) | `BG` on status fill; white on `ACCENT`; `DIM` idle | `(UI,15,"bold")` | on fill `hlt=1, hlbg=HAIRLINE`; idle `hlt=0` | `ipadx=10 ipady=4` |
| `units` (container) | `BG` | — | — | none | `pady=(8,0)` |
| unit `cell` (Frame) | fill `GREEN`/`YELLOW`/`RED` by score | — | — | `hlt=1, hlbg=HAIRLINE` | grid per tier; `ipadx=4 ipady=2` |
| unit glyph `Label` | = cell fill | `BG` (black on status fill) | `(UI, per tier, "bold")` | none | — |
| unit sub `Label` | = cell fill | `BG` | `(UI, sub, "bold")` | none | — |
| `feedback` | `BG` | `INK_MUTED` (body) / `DIM` (system) | `(UI,12)` | none | `pady=(8,0)` |
| `coach_tip` (idle/loading) | `BG` | `DIM` | `(UI,12,"bold")` | none | `pady=(8,0)` |
| `coach_tip` (shown) | `SURFACE1` | `FG`; the 🧠 lead + key word may use `ACCENT` | `(UI,12,"bold")` | `hlt=1, hlbg=HAIRLINE` | `ipadx=12 ipady=8` |
| `hint` (SPACE line) | `SURFACE2` | `FG` | `(UI,12,"bold")` | `hlt=1, hlbg=HAIRLINE` | `ipadx=10 ipady=3` |
| `hint_keys` | `BG` | `DIM` | `(UI,10)` | none | `pady=(0,4)` |
| `hint_sys` | `BG` | `DIM` | `(UI,9)` | none | `pady=(0,8)` |

\* `target` fg: input title = **`ACCENT`** on `SURFACE1`; SENTENCE = **`FG`** on
`SURFACE1`; BOSS = **`BG`** (black text) on a **`YELLOW`** card fill (warning =
the boss is the hard objective); WORD = **`ACCENT`** on `SURFACE1`; win = **`BG`**
(black) on a **`GREEN`** card fill. Keep all existing size/length logic untouched.

**Idle vs filled badge.** The `score` badge is borderless text (`DIM` on `BG`) when
idle/empty; the moment it shows a status fill it gains the hairline (`hlt=1,
hlbg=HAIRLINE`) and black/white text per §7. Toggle `highlightthickness` between `0`
and `1`. (The existing `_score_badge(text, fill, fg)` helper already does this toggle
— only the values change.)

**Why `SURFACE2` (not `ACCENT`) for the `hint` and the "Probar" button.** HashiCorp's
`button-secondary` is `surface-2` charcoal with ink text — quiet, not a colored fill.
The SPACE-hint line and the mic-test button are secondary affordances, so they take
the **secondary-button** treatment: `SURFACE2` fill + hairline + `FG` text, square.
This keeps `ACCENT` reserved for the title, focus, and active-recording state, so the
one blue accent stays meaningful (HashiCorp: the accent signals interactivity, it is
not decoration).

---

## 5. FIRST SCREEN — the `input` state (detailed)

This is the user's explicit focus: how `_show_input` should look in HashiCorp
language. Build it as an **eyebrow → hero title → relaxed instruction → square
surface-1 field → labeled mic control → secondary square button** stack, all on the
black canvas with charcoal lift and one accent.

**Element-by-element:**

1. **Eyebrow** — a small uppercase, `DIM` (`ink-subtle`) label **above** the hero
   title: `"PRONUNCIATION TRAINER"`, `(UI, 9, "bold")`, `bg=BG`, `fg=DIM`. This is the
   single most portable HashiCorp signature; it marks the screen as a category. (New
   widget; place it in the `target`-card zone or as its own `Label` above the card —
   simplest is a dedicated eyebrow `Label` packed just above `self.target`.)
2. **Hero title** — `self.target` shows `"Pronunciation Tetris"` (drop the 🎤 emoji
   for the restrained brand, or keep it small — your call; HashiCorp marketing is
   icon-light) in **`ACCENT`** blue, `(UI, 28, "bold")`, on a `SURFACE1` card with the
   `HAIRLINE` frame. Accent-on-surface1 is 5.19:1 (passes). The title is the one place
   the accent is used at display size — it reads like a HashiCorp hero headline.
3. **Instruction** — `self.feedback`, **relaxed body** in `INK_MUTED` (not `FG`, not
   `DIM`): *"Pegá un párrafo (oraciones separadas por «.» o saltos de línea) y apretá
   Shift+Enter."* `(UI, 12)`, `bg=BG`, `fg=INK_MUTED`. (Currently it uses `FG`; switch
   to `INK_MUTED` so the title/`FG` emphasis ladder reads — HashiCorp body is the
   muted gray, headlines are pure white/accent.)
4. **Entry field** — `self.entry` as a **square `SURFACE1` field** with the
   `HAIRLINE` frame: `bg=SURFACE1, fg=FG, insertbackground=FG, relief="flat", hlt=1,
   hlbg=HAIRLINE`, `(UI, 11)`. This mirrors HashiCorp `text-input` (surface-1 fill,
   ink text) — minus the 8px rounding (square; stated).
   - **Accent-blue focus border (feasible in tkinter):** HashiCorp's focused input
     shows a 1px accent-blue ring. In tkinter, set on creation
     `highlightcolor=ACCENT` (the color used **when the widget has keyboard focus**)
     and `highlightbackground=HAIRLINE` (used when unfocused), with `hlt=1`. When the
     `Text` gains focus tkinter automatically draws the 1px frame in
     `highlightcolor` → the field's border turns **accent-blue on focus** and back to
     the faint hairline on blur, **with no extra binding code**. This is a genuine
     tkinter feature (not a fake), so it's the faithful equivalent of HashiCorp's
     focus ring. (`_show_input` already calls `self.entry.focus_set()`, so the field
     opens focused → its border starts accent-blue, a nice "active here" cue.)
5. **Mic row** — `self.mic_row`, a **labeled control** (HashiCorp pattern: small
   label + control): the 🎙 `Label` in `DIM`, the `OptionMenu` styled as a quiet
   `SURFACE2` control with the hairline, and the **"Probar (Ctrl+T)" button as a
   square secondary button** (`SURFACE2` + `HAIRLINE` + `FG`, not a yellow fill). The
   secondary-button treatment keeps the screen monochrome; the accent is saved for
   the title and the focused field.
6. **Hint** — the SPACE-line `hint` shows `"Shift+Enter: empezar"` as the
   **secondary-button chip** (`SURFACE2` + hairline + `FG`), with `hint_keys` showing
   `"Ctrl+T: probar micrófono"` in `DIM`, and `hint_sys` (`"Ctrl+R: reset · ESC:
   salir"`) in `DIM`.

**ASCII layout sketch — first screen (`input`):**

```
┌──────────────────────────────────────────────────────────────┐ ← root, BG (#000)
│ 🎯 objetivo: 94% por sonido            (goal_label, DIM, place)│
│                                                                │
│                  PRONUNCIATION TRAINER     ← eyebrow, DIM, UPPER│
│        ┌────────────────────────────────────────────┐         │
│        │                                            │ SURFACE1 │ ← target card
│        │            Pronunciation Tetris            │ +HAIRLINE│   (hairline frame,
│        │              (ACCENT, 28 bold)             │  (square)│    square corners)
│        └────────────────────────────────────────────┘         │
│                                                                │
│   Pegá un párrafo (… «.» o saltos…) y apretá Shift+Enter.      │ ← feedback, INK_MUTED
│                                                                │
│        ┌────────────────────────────────────────────┐         │
│        │ |cursor                                     │ SURFACE1 │ ← entry, square,
│        │                                            │ border = │   border = ACCENT
│        │                                            │ ACCENT   │   while focused,
│        └────────────────────────────────────────────┘ (focus) │   HAIRLINE on blur
│                                                                │
│   🎙 Micrófono:  [ Predeterminado del sistema ▾ ]  [ Probar (Ctrl+T) ]│ ← mic_row
│                  SURFACE2+hairline                  SURFACE2+hairline   (secondary,
│                                                                │        square)
│                                                                │
│              ┌──────────────────────────────┐                 │
│              │      Shift+Enter: empezar     │ SURFACE2+hairline│ ← hint (secondary
│              └──────────────────────────────┘                 │   chip, square)
│              Ctrl+T: probar micrófono   (hint_keys, DIM)       │
│              Ctrl+R: reset  ·  ESC: salir  (hint_sys, DIM)     │
└──────────────────────────────────────────────────────────────┘
```

Everything square; the only blue is the title and the focused field's border;
everything else is black/charcoal/white/gray. That restraint IS the HashiCorp feel.

---

## 6. Layout & Spacing

HashiCorp's spacing is 8px-based (`4 / 8 / 12 / 16 / 24 / 32`). Mapped to tkinter
`pady`/`ipadx`. **Keep the existing pack order** (flash_bar → goal → progress →
progress_blocks → incoming → target → entry → mic_row → score → units → feedback →
coach_tip → … bottom hints). Only restyle.

- **Spacing scale (px):** use `4 / 8 / 12 / 16 / 24`. Map existing `pady` to it:
  `(6,0)`→`(8,0)`, `(4,0)`→`(8,0)`, `(10,0)` stays. Card interior padding follows
  HashiCorp's 24px card padding → `ipadx=24 ipady=18` on the `target` card; smaller
  chips use `ipadx≈10, ipady≈3–4`. Don't invent in-between values.
- **Surface-lift grouping — which zones are canvas vs surface-1:**
  - **CANVAS (`BG`) chrome:** goal label, eyebrows, progress label, progress-blocks
    container, `incoming`, `feedback`, `coach_tip` (idle), and the three bottom hint
    rows. These are flat text on black — HashiCorp keeps meta/labels on the canvas.
  - **SURFACE1 cards:** the `target` card, the `entry`, the shown `coach_tip`. These
    lift one charcoal step + hairline — HashiCorp's `feature-card`/`text-input`.
  - **SURFACE2 controls:** mic menu, "Probar" button, the `hint` SPACE chip — the
    secondary-button level.
  - **Status fills:** `score` badge (on result), `units` cells, `progress_blocks`
    (on state) take the semantic GREEN/YELLOW/RED fill momentarily.
- **Square-frame rule:** any chip/card = `SURFACE*`-or-status fill + `hlt=1` +
  `hlbg=HAIRLINE` + internal `ipadx/ipady ≥ 4` (so text never touches the frame).
  Corners are square — stated, not faked.
- **The dark canvas IS the whitespace** (HashiCorp principle): zones separate by
  surface lift, not by big empty gaps. Keep `expand=True` on the `target` so the hero
  card stays the visual anchor.
- **Touch/click targets:** clickable word chips and the mic button must be ≥ ~44px
  tall in practice — guarantee with `ipady≥8` on the mic button and the existing chip
  padding on word cells. (Desktop-mouse app, but the bar is honored anyway.)

---

## 7. Elevation — surface-lift recipe (no shadows)

HashiCorp expresses depth as **surface lift + hairline**, never drop shadow — which
maps cleanly to tkinter. **There are no offset shadow frames anywhere in this spec.**

| Level | HashiCorp | tkinter recipe | Used by |
|---|---|---|---|
| 0 — flat | canvas, hero, footer | `bg=BG`, no border | goal/eyebrow/progress/incoming/feedback/hint rows, root |
| 1 — charcoal lift | `surface-1` + 1px hairline | `bg=SURFACE1, hlt=1, hlbg=HAIRLINE` | `target` card, `entry`, shown `coach_tip` |
| 2 — surface-2 lift | `surface-2` + 1px hairline | `bg=SURFACE2, hlt=1, hlbg=HAIRLINE` | mic menu, "Probar" button, `hint` SPACE chip |
| status — semantic fill | (HashiCorp uses semantic colors for state) | `bg=GREEN/YELLOW/RED, hlt=1, hlbg=HAIRLINE`, **black text** | `score` badge, `units` cells, `progress_blocks` |

Recipe (the only one needed): a lifted element gets a charcoal/status `bg`, a 1px
`HAIRLINE` `highlightbackground`, and internal `ipad`. To go "up" a level, raise the
`bg` from `BG → SURFACE1 → SURFACE2`. **Do not** use `relief="raised"/"sunken"`
(beveled 3D contradicts the flat, engineered HashiCorp surface) and **do not** add a
second offset Frame as a shadow (HashiCorp has no shadows on dark). The hairline +
the charcoal step are the entire depth system.

**Hairline subtlety guard.** The hairline (`#3b3d45`) is *meant* to be faint on
`SURFACE1` (≈1.6:1) — "felt more than seen". That is enough to bound a field/card
because the eye also reads the `bg` step. Do **not** brighten the hairline toward
white to "fix" the contrast — that would re-create the neo-brutalist bright-border
look we are explicitly leaving. If a card ever needs to read harder, lift its `bg`
(SURFACE1→SURFACE2), don't brighten the border.

---

## 8. State Feedback

States: `input | ready | recording | fail | pass | win`. Color is always paired with
text/glyph — never the sole signal. Status colors are the HashiCorp **semantic**
set; `ACCENT` blue marks the **active/interactive** moment.

**`input`** — see §5 in full. Eyebrow + accent title on SURFACE1, INK_MUTED
instruction, SURFACE1 entry (focus border ACCENT), SURFACE2 mic controls + SPACE
chip. `flash_bar` idle (`BG`).

**`ready`** — `target` card shows the sentence/word: SENTENCE → `FG` on `SURFACE1`;
WORD → `ACCENT` on `SURFACE1`. `score` idle (`BG`, `DIM`, no frame). `units` and
`coach_tip` cleared. `hint` SPACE chip (SURFACE2 + hairline + `FG`):
"ESPACIO: grabá la oración/el párrafo/la palabra".

**`recording`** (`_set_recording_status` traffic-light; the `score` badge carries it):
- `listening` → badge fill **`ACCENT`** blue, text `🟢 ¡HABLÁ AHORA!` in **white**
  (active state = the one moment the accent is a fill; white-on-accent 3.43:1, OK for
  this short bold badge). feedback in `INK_MUTED`. *(Accent = "you're live now".)*
- `speech` → badge fill **`ACCENT`**, text `🎤 Te escucho…` white — still the active
  accent.
- `processing` → badge fill **`YELLOW`** (warning/working), text `⏳ Procesando…` in
  **black** (`BG`) — 14.20:1.
- "Preparando micrófono…" → idle badge: `BG` bg, `DIM` fg (no fill, no frame yet).
- `hint`/`hint_keys` blank during recording (unchanged behavior).

  *(If you prefer to keep the literal green/red "traffic light", `listening` may use
  `GREEN`/black instead of `ACCENT`/white — both are HashiCorp-legal. This spec
  recommends `ACCENT` for "active" to keep GREEN exclusively for PASS, so green never
  means two different things. Pick one and be consistent.)*

**`fail`**
- `flash_bar` pulses **`RED`** 450ms (existing `_flash`; durations unchanged).
- `score` badge: fill **`RED`**, **black text** (`BG`) — `❌ [worst] 72% · faltan
  sonidos` (black-on-red 4.73:1; white-on-red 4.44 fails, so use black + bold).
- `units` grid: each cell filled by `_score_color` (GREEN/YELLOW/RED), **black text**,
  hairline frame.
- `feedback`: actionable hint in `INK_MUTED` (urgency comes from the RED badge + RED
  flash; we don't lean on colored body text).
- `coach_tip`: loading → `DIM` "🧠 pensando…"; shown → `SURFACE1` card + hairline,
  `FG` text (lead 🧠 / key term may be `ACCENT`).

**`pass`**
- `flash_bar` pulses **`GREEN`** 450ms.
- `score` badge: fill **`GREEN`**, **black text** — `✅ 96% ¡DERROTADA!` (9.84:1).
- progress block for this target flips to `GREEN` fill ("defeated"), black glyph.
- `feedback`: confirmation in `INK_MUTED`. `coach_tip` cleared.
- `hint` SPACE chip: "ESPACIO: siguiente".

**`win`**
- `flash_bar` pulses `GREEN`.
- `target`: `🏆 ¡GANASTE!`, `(UI, 30, "bold")`, on a **`GREEN`-filled** hero card with
  **black text** (`BG`) — black-on-GREEN 9.84:1. `feedback` `INK_MUTED`. `hint`:
  "ESPACIO: jugar otro párrafo".

**Progress blocks (`_render_progress_blocks`)** — fills, not fg colors:
- defeated → fill `GREEN`, glyph fg **`BG`** (black);
- failed → fill `RED`, glyph fg **`BG`**;
- pending → fill `SURFACE2`, glyph fg **`INK_MUTED`**;
- `HAIRLINE` frame on every block; current `▶`, boss `♛`, others `■` glyph as today.

**`_score_color` stays the same thresholds** (≥threshold→GREEN, ≥75→YELLOW, else RED)
but its return value drives the **cell fill**, with `fg=BG` (black) fixed.

**The flash bar** is reinforcement, never the sole signal (the badge + chip fills
already state pass/fail). Keep the 450ms `_flash`; this also satisfies
reduced-motion (a single brief color pulse, no looping animation).

---

## 9. Do's / Don'ts (tkinter + HashiCorp)

**Do**
- Express depth with **surface lift** (`BG → SURFACE1 → SURFACE2`) + a **1px solid
  `HAIRLINE`** frame (`hlt=1, hlbg=HAIRLINE`). That is HashiCorp's whole elevation
  system and it maps cleanly to tkinter.
- Keep the chrome **monochrome**: white/`INK_MUTED`/`DIM` text on black/charcoal.
  Reserve **`ACCENT` blue** for the title, the focused-entry border, and the
  active/recording state — interactivity, not decoration.
- Use **uppercase eyebrow labels** (`DIM`, `(UI,9,"bold")`) above each zone — the
  most portable HashiCorp signature.
- Put status as a **semantic fill with BLACK (`BG`) text** inside a hairline-framed
  chip (GREEN pass, YELLOW warn, RED fail). Black text clears 4.5:1 on all three;
  white-on-RED does not.
- Use `INK_MUTED` for relaxed body, `FG` for headlines/emphasis, `DIM` only for small
  chrome **on the canvas** (eyebrows, hints, labels).
- Set the entry's `highlightcolor=ACCENT` + `highlightbackground=HAIRLINE` so its
  border turns accent-blue **on focus** automatically (faithful HashiCorp focus ring).
- Keep corners **square** and **state it** — there is no tkinter `border-radius`.
- Reuse the existing `_flash` (450ms) and the `_score_badge` toggle helper.

**Don't**
- Don't fake rounded corners (no corner pixmaps / no `relief` tricks) — square is the
  honest tkinter answer; the brand still reads via surface + hairline + eyebrow.
- Don't brighten the `HAIRLINE` toward white to "increase contrast" — that re-creates
  the neo-brutalist bright border we're replacing. Lift the `bg` a level instead.
- Don't add **drop/offset shadow Frames** — HashiCorp has no shadows on dark; depth is
  surface lift only.
- Don't use `relief="raised"/"sunken"` (beveled 3D contradicts the flat engineered
  surface).
- Don't put **white text on a `RED` fill** (4.44:1, just fails) — use **black bold**
  (`BG`, 4.73:1). Don't put `DIM` body text on a `SURFACE1`/`SURFACE2` card (3.28 /
  2.91, fails 4.5); use `INK_MUTED` there, keep `DIM` to small bold chrome on the
  canvas only (3.88 on BG, ≥3:1 large/UI).
- Don't introduce **product-accent colors** (Terraform purple, Waypoint cyan, etc.)
  or **mix accents** — this app has no product identity; one accent-blue only.
- Don't ship a **light mode** — HashiCorp marketing is dark only.
- Don't use **`MONO`/`TkFixedFont`** for the readouts — HashiCorp says "no mono"; use
  the proportional `UI` font everywhere. (Keep `MONO` defined but unused.)
- Don't bump font sizes back up — `TkDefaultFont` at the §3 sizes is calibrated to not
  feel "zoomed"; a previous DejaVu + larger scale did.
- Don't add new imports to `app.py` (the architecture test forbids pulling Azure in on
  `import app`; styling needs none).
- Don't rename `KEYS`, move handlers, or change `_split_sentences`, `judge`, the
  `Game`/`Target` model, or the queue/threading code — the 30 tests assert that.

---

## 10. Implementation Guide (ordered edits in `app.py`)

Apply in order. After each numbered block the app still runs and the **30 tests stay
green** (23 SOLID/architecture/integration + 7 config — none touch styling). No
behavior, key, or import changes. **Palette constants first**, then per-widget, with
the **FIRST SCREEN** steps called out (steps 3 + 8).

1. **Palette + font constants (lines ~68–82).** Replace values and add the new names,
   keeping the existing names:
   ```python
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
   ```
   Remove the now-unused `PANEL`, `INK`, `BORDER`, `SHADOW`, `PENDING_FILL`
   constants. **Update the `_bordered` helper** to the hairline (was a 3px near-white
   border): `def _bordered(w, thick=1): w.config(highlightthickness=thick,
   highlightbackground=HAIRLINE, relief="flat"); return w`. (All current `_bordered`
   call sites keep working; they now draw the faint hairline. Change their `thick`
   args to `1`.)
2. **`_build_ui` — flash bar:** keep `bg=BG`; set `height=6`.
3. **`_build_ui` / `_show_input` — FIRST SCREEN (see §5).** (a) Add an **eyebrow
   `Label`** `"PRONUNCIATION TRAINER"` (`bg=BG, fg=DIM, font=(UI,9,"bold")`) packed
   just above the `target` card. (b) `target` input title → `text="Pronunciation
   Tetris"`, `bg=SURFACE1, fg=ACCENT, font=(UI,28,"bold")`. (c) Instruction
   (`self.feedback` in `_show_input`) → `fg=INK_MUTED` (was `FG`). (d) `entry` →
   `bg=SURFACE1, fg=FG, insertbackground=FG, relief="flat"`, and set the focus ring:
   `self.entry.config(highlightthickness=1, highlightcolor=ACCENT,
   highlightbackground=HAIRLINE)` (replaces the old `_bordered(self.entry,4)`). (e)
   mic row: see step 6.
4. **`_build_ui` — fonts:** swap every `("TkDefaultFont", …)`/`(UI,…)` tuple to the
   §3 sizes. **Use `UI` everywhere, including the `score` badge and `units` chips
   (drop `MONO`).** Key changes: title 30→28, win 40→30, WORD 32→20, entry 13→11,
   incoming 10→11, hint_sys 8→9, score → `(UI,15,"bold")`.
5. **`target` card:** `bg=SURFACE1`, `_bordered(self.target,1)` (hairline), keep
   `ipadx=24 ipady=18` + `pack(expand=True)`. In `_render_target`: BOSS → card
   `bg=YELLOW`, label `fg=BG` (black); SENTENCE → `bg=SURFACE1`, `fg=FG`; WORD →
   `bg=SURFACE1`, `fg=ACCENT`. Keep all existing size/length logic. (Old BOSS used
   `fg=YELLOW` text — replace with black-on-yellow fill.)
6. **mic menu + "Probar" button (secondary, square):** menu `bg=SURFACE2, fg=FG`,
   `_bordered(...,1)`, `activebackground=SURFACE1, activeforeground=FG`; same for
   `["menu"]`. Button `bg=SURFACE2, fg=FG`, `_bordered(...,1)`,
   `activebackground=SURFACE1, activeforeground=FG`, `ipady=2`, drop `bd=0`→keep but
   border via hlt. (Old button was `YELLOW`/`INK`; the secondary monochrome treatment
   keeps the screen restrained — accent is saved for title/focus.)
7. **`score` badge:** keep the `_score_badge(text, fill, fg)` helper; it already
   toggles the border. Change the toggle to `hlt=1, hlbg=HAIRLINE` when `fill != BG`,
   else `hlt=0`; font `(UI,15,"bold")`, `ipadx=10 ipady=4`. Route the status/result
   calls through it with these fill/fg pairs:
   - listening → `ACCENT` / white (`FG`)  · speech → `ACCENT` / `FG`
   - processing → `YELLOW` / `BG` (black)
   - preparing → `BG` / `DIM` (idle, no frame)
   - pass → `GREEN` / `BG`  · fail (and `not a.ok` "—") → `RED` / `BG`
   Text strings unchanged. (Old used colored TEXT on `BG`; now it's a filled chip with
   black/white text.)
8. **`_render_progress_blocks`:** color the **fill**, not `fg`: `bg =
   {"defeated":GREEN,"failed":RED}.get(status, SURFACE2)`, `fg = BG if status in
   ("defeated","failed") else INK_MUTED`, `font=(UI,11,"bold")`, `hlt=1,
   hlbg=HAIRLINE`, `ipadx=6 ipady=2`, `pack(side="left", padx=3)`. Keep the
   `▶`/`♛`/`■` glyph logic. (Old used `fg=color` on `bg=BG` with a near-white border.)
9. **`_render_units`:** per cell, `cell` Frame `bg=color`, `hlt=1, hlbg=HAIRLINE`,
   `ipadx=4 ipady=2`; glyph + sub Labels `bg=color, fg=BG` (black), family `UI`, keep
   the per-tier breakpoints but use the §3 sizes (16/9, 13/8, 11/7, 9/7), bold. Keep
   the `clickable` binding as-is. (Old used `fg=color` text + `MONO` + bright border.)
10. **`feedback`:** set the **default body color to `INK_MUTED`** (was `FG`/`YELLOW`)
    everywhere it carries info/fail/instruction in `_build_ui` / `_show_input` /
    `_enter_ready` / `_on_assessment` / `_fail_hint` / `_set_recording_status`. Keep
    `DIM` where the line is small system chrome ("limpiar/última/info"). Status echoes
    that previously used `GREEN`/`RED`/`ACCENT` as text may stay (they pass on black),
    but **prefer `INK_MUTED`** so the badge/chip carries the color. (Only the color arg
    changes; behavior identical.)
11. **`coach_tip`:** `_coach_clear` → `bg=BG`, empty text (fg `DIM`), `hlt=0`;
    `_coach_loading` → `bg=BG, fg=DIM, hlt=0`; `_coach_show` → `bg=SURFACE1, fg=FG,
    hlt=1, hlbg=HAIRLINE`, `ipadx=12 ipady=8` (the 🧠 lead may be `ACCENT`). (Was an
    accent-fill block with a 4px near-white border; now a quiet surface-1 card.)
12. **`hint` SPACE line:** secondary chip — `bg=SURFACE2, fg=FG, hlt=1,
    hlbg=HAIRLINE, ipadx=10 ipady=3, font=(UI,12,"bold")`. (Was a `GREEN` fill + `INK`
    text + near-white border.) `hint_keys`/`hint_sys` stay borderless `DIM` on `BG`.
    The transient `self.hint.config(text=…)` strings in `_set_recording_status`/
    `_start_*` reuse the same chip styling — only set `text`, don't re-touch bg/fg.
13. **`_win`:** `target` card `bg=GREEN`, label `fg=BG` (black), `font=(UI,30,"bold")`.
    (Old `fg=GREEN` text → green fill + black text.)
14. **`main()` config-error window:** mirror the palette — `bg=BG`, error label
    `fg=FG` on a `SURFACE1` card with a `RED` `highlightbackground` (or simple `fg=FG`
    with a `RED` 1px border), second label `fg=DIM`. Low priority; cosmetic only.

**Verification after edits:** run the suite — expect **30 passed** (23
SOLID/architecture/integration + 7 config; none assert styling — verified). The
architecture tests only fail if you add an Azure-importing dependency to `app`/`audio`
— styling adds none. Launch with `uv run app.py` and eyeball each state (input
focus-ring blue; ready/recording/fail/pass/win; the eyebrow + accent title).

---

### Quality checklist (self-verified)
- **Distinctiveness:** monochrome black-canvas console with charcoal surface-lift,
  lone accent-blue interactions, and uppercase eyebrows — a restrained engineering
  brand, not a default dark theme; the inverse of the neo-brutalist arcade it
  replaces. ✔
- **Typography:** single `TkDefaultFont`, desktop-calibrated sizes (no zoom),
  weight-only hierarchy (HashiCorp's small 500/600/700 ladder), eyebrow = uppercase +
  DIM + small bold (tracking lost honestly), no mono. ✔
- **Color:** pure-black canvas + 2 charcoal surfaces + faint gray hairline + white &
  2 muted grays + 1 accent-blue + semantic green/yellow/red. 60-30-10. Every text/bg
  pair measured: body ≥4.5:1 (`FG` 15.75–21.00, `INK_MUTED` 7.74–10.32); `DIM` is
  small-chrome-on-canvas only (3.88 on BG, ≥3:1 large/UI, **not** body); status fills
  use **black text** (GREEN 9.84, YELLOW 14.20, RED 4.73). ✔
- **Layout:** canvas-vs-surface-1-vs-surface-2 zones, 8px-based spacing, square
  one-shape language, existing pack order preserved. ✔
- **Elevation:** surface lift + hairline only — **no shadows** (clean tkinter map of
  HashiCorp's model). ✔
- **Motion:** only the existing 450ms `_flash`; reduced-motion safe (color is
  reinforcement, never sole signal). ✔
- **Components:** one square hairline-framed shape, all 6 states specified, accent
  reserved for interactivity. ✔
- **Technical:** tkinter-native (`hlt`/`hlbg`/`bg` levels), no web styles (no radius,
  no alpha, no gradient, no shadow), keys/behavior/imports untouched, 30 tests stay
  green. ✔
- **HashiCorp rules honored:** no product-accent mixing, no light mode, no mono,
  surface-lift over shadow, eyebrow above every zone, `rounded.md` honestly → square. ✔
```
