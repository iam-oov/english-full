// @ts-check
import { defineConfig } from "astro/config";
import react from "@astrojs/react";

// Sitio 100% estático: el juego corre entero en el navegador (Azure Speech SDK
// para JS habla directo con el servicio). No hay backend: las credenciales las
// pone el jugador en Ajustes y viven en su localStorage.
export default defineConfig({
  integrations: [react()],
});
