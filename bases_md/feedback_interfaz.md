CRÍTICO - Fondo negro total
El negro puro (#000) en pantalla grande cansa la vista y hace que el texto en blanco tenga demasiado contraste. Cambiar a un gris oscuro suave (#0f1117 o #1a1d27) hace que toda la UI se sienta más moderna de inmediato.

CRÍTICO - Chips de palabras: rojo vs verde no da info útil
Los chips verdes con texto verde encima tienen bajísimo contraste y son casi ilegibles. El rojo saturado para el chip problemático grita demasiado. Mejor: chip con fondo sutil (un gris oscuro) con el score en color semántico solo en el número. El chip en foco / fallado puede tener un borde de acento en lugar de fondo rojo sólido.

ALTO - Banner de error no diferencia error de advertencia
El banner "[entered] 63% · faltan sonidos" usa rojo aunque el resultado no es un fracaso total — es un parcial. El rojo comunica falla completa. Usar ámbar/naranja para scores bajos y reservar el rojo solo si el score cae por debajo de ~40%. Agregar un ícono que refuerce el estado visualmente.

ALTO - Progress bar de oraciones: icónica pero sin contexto
Los 8 cuadritos en la parte superior son difíciles de leer de un vistazo — la diferencia entre "completado", "en progreso" y "pendiente" no es obvia. Reemplazar con una barra de progreso segmentada o agregar un tooltip al hover. El icono de corona para el jefe final sí funciona, mantenerlo.

MEDIO - Atajos de teclado: texto pequeño y enterrado
La barra de atajos al fondo es un wall of text en fuente diminuta. Agruparlos visualmente en píldoras con la tecla resaltada (como hacen apps modernas tipo Figma o Linear). Además, el hint central "ESPACIO: reintentar" podría tener un fondo de card propio en lugar de flotar sobre el negro.

MEDIO - El texto de la oración no respira
El cuadro de la oración tiene buen tamaño de fuente pero el fondo dark del contenedor se confunde con el fondo general. Aumentar el padding interno, agregar un borde sutil lateral izquierdo de acento, y aumentar ligeramente el line-height para oraciones largas. El texto se siente comprimido verticalmente.

Lo que sí funciona — no tocar

El enfoque en teclado es correcto y vale la pena preservarlo. La metáfora de "jefe final" (Oración 8/8 con fondo amarillo) crea un buen momento de recompensa. El desglose por palabra con score numérico es la feature central y no tiene competencia — solo necesita mejor presentación visual.
