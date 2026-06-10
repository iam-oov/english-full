# Review UX/UI - Pronunciation Tetris

## Resumen ejecutivo

La idea del producto es buena.

La mecánica de:

1. Escuchar.
2. Repetir.
3. Obtener feedback por palabra.
4. Derrotar mini-jefes (oraciones).
5. Llegar al jefe final (párrafo completo).

es divertida y genera progreso visible.

El problema no es la mecánica.

El problema es que la interfaz transmite:

- herramienta técnica
- aplicación de consola con botones
- software educativo de los 90s

cuando en realidad debería transmitir:

- videojuego de entrenamiento
- progreso
- recompensa
- dominio gradual

---

# Problemas principales

## 1. Demasiado espacio vacío

La pantalla tiene enormes áreas negras.

Eso hace que el usuario sienta que:

> "algo falta"

La atención se dispersa.

Especialmente en pantallas ultrawide.

### Solución

Crear una columna central fija.

```txt
┌──────────────────────────────┐
│ Header                       │
│                              │
│ Boss actual                  │
│                              │
│ Texto                        │
│                              │
│ Acción principal             │
│                              │
│ Feedback                     │
│                              │
│ Navegación                   │
└──────────────────────────────┘
```

Como Duolingo.

No como una aplicación de escritorio tradicional.

---

# 2. No existe una jerarquía visual clara

Actualmente todo compite por atención.

Por ejemplo:

- Pronunciation Trainer
- Objetivo 80%
- Navegación
- Texto
- Botones
- Resultados

Todo parece igual de importante.

---

## Solución

Jerarquía:

### Nivel 1

Elemento principal.

```txt
Sentence 3 of 8
```

### Nivel 2

Texto a pronunciar.

```txt
When Don Gonzalo entered the room...
```

### Nivel 3

Acción.

```txt
🎤 Hold Space to Speak
```

### Nivel 4

Feedback.

```txt
entered 63%
```

### Nivel 5

Atajos.

```txt
Q Previous
W Next
```

Pequeños.

Abajo.

---

# 3. El texto parece una alerta

Actualmente la oración está dentro de una caja oscura enorme.

Visualmente parece:

```txt
ERROR
WARNING
```

No parece contenido.

---

## Solución

Hacerlo más parecido a una tarjeta de lectura.

```txt
─────────────────────────

When Don Gonzalo entered the room,
he saw a man and a woman kneeling
next to the coffin.

─────────────────────────
```

Más respiración.

Más margen.

Más legible.

---

# 4. Los cuadrados de palabras parecen debug

Actualmente:

```txt
when 97
don 97
gonzalo 94
...
```

parecen métricas internas.

No progreso.

---

## Solución

Convertirlos en "tiles".

Ejemplo:

🟩 Perfecto

🟨 Casi

🟥 Necesita práctica

```txt
┌─────────┐
│ entered │
│   63%   │
└─────────┘
```

Con animación.

No simplemente color plano.

---

# 5. El jefe final es visualmente caótico

La pantalla final tiene:

- mucho amarillo
- muchas palabras
- muchos cuadros
- mucho texto

No sabes dónde mirar.

---

## Solución

Mostrar únicamente:

```txt
Boss Battle

82%
```

Luego:

```txt
Weak Spots
```

- corpse's
- across
- knelt

Y permitir expandir detalles.

---

# 6. No existe sensación de videojuego

Se llama Pronunciation Tetris.

Pero no se siente como juego.

Se siente como examen.

---

## Solución

Agregar elementos RPG ligeros.

### Barra de progreso

```txt
██████░░░░
6/10 bosses
```

---

### XP

```txt
+40 XP
```

---

### Combo

```txt
3 perfect words in a row
```

---

### Accuracy streak

```txt
Current streak: 5
```

---

### Boss HP

```txt
Sentence HP

██████░░░░░░
63%
```

Cuando dices mejor una palabra:

```txt
████████░░░░
81%
```

---

# 7. El botón principal debería dominar la pantalla

Actualmente:

```txt
ESPACIO: grabá la oración
```

parece un texto cualquiera.

---

## Solución

Botón gigante.

```txt
╔════════════════════╗
║   🎤 PRESS SPACE   ║
║      TO TALK       ║
╚════════════════════╝
```

Es la acción principal.

Debe ser imposible ignorarla.

---

# 8. El modo de práctica es poco claro

Actualmente aparece:

```txt
R (Practicar): entered x1
```

No comunica valor.

---

## Solución

Panel lateral.

```txt
Needs Practice

1. entered
2. corpse's
3. across
```

Al presionar R:

```txt
Practice Queue
```

Y vas derrotando palabras.

---

# 9. Falta retroalimentación inmediata

Cuando una palabra sale mal, el usuario espera al final.

Eso rompe el flujo.

---

## Solución

Mientras habla:

```txt
when       ✓
don        ✓
gonzalo    ✓
entered    ✗
the        ✓
room       ✓
```

Feedback instantáneo.

Como karaoke.

---

# 10. La pantalla inicial es la más débil

Actualmente parece una herramienta interna.

No parece un producto terminado.

---

## Solución

Pantalla inicial tipo juego.

```txt
Pronunciation Tetris

Level 4
Accuracy: 82%

──────────────────

Paste your text

[________________]

──────────────────

ENTER → Start
```

Mucho más limpia.

---

# Rediseño conceptual

```txt
─────────────────────────────

        Pronunciation Tetris

        Sentence 3 / 8

Boss HP
██████████░░░░░░░

─────────────────────────────

When Don Gonzalo entered the room,
he saw a man and a woman kneeling
next to the coffin.

─────────────────────────────

🎤 PRESS SPACE TO SPEAK

─────────────────────────────

Weak words

entered      63%
coffin       72%

─────────────────────────────

Q Previous
W Next
R Practice
ESC Exit

─────────────────────────────
```

# Prioridad de cambios

## Impacto enorme / poco trabajo

- Reducir espacio vacío.
- Mejorar tipografía.
- Mover atajos al pie.
- Hacer enorme el botón principal.
- Convertir palabras en tiles modernos.
- Mostrar progreso de jefes.

## Impacto enorme / trabajo medio

- Barra de HP para cada oración.
- XP y streaks.
- Feedback en tiempo real.
- Cola de práctica para palabras débiles.

## Impacto enorme / trabajo grande

- Animaciones.
- Sonidos.
- Modo campaña.
- Niveles.
- Sistema de logros.
