#!/usr/bin/env bash
# Builds a .deb for Pronunciation Tetris. The package copies the source modules
# into /opt/pronunciation-tetris and, on install (postinst), creates a plain
# system venv there and pip-installs the runtime deps. No uv on the target.
set -euo pipefail

APP_NAME="pronunciation-tetris"
APP_TITLE="Pronunciation Tetris"
VERSION=$(python3 -c "import re;print(re.search(r'^version\s*=\s*\"(.+?)\"',open('pyproject.toml').read(),re.M).group(1))")
ARCH="$(dpkg --print-architecture)"
PKG_DIR="${APP_NAME}_${VERSION}_${ARCH}"

echo "Building ${APP_NAME} ${VERSION} (${ARCH}) .deb..."
rm -rf "$PKG_DIR" "${PKG_DIR}.deb"
mkdir -p "${PKG_DIR}/DEBIAN" \
         "${PKG_DIR}/opt/${APP_NAME}" \
         "${PKG_DIR}/usr/bin" \
         "${PKG_DIR}/usr/share/applications" \
         "${PKG_DIR}/usr/share/icons/hicolor/128x128/apps"

# --- control ---
cat > "${PKG_DIR}/DEBIAN/control" << EOF
Package: ${APP_NAME}
Version: ${VERSION}
Section: education
Priority: optional
Architecture: ${ARCH}
Depends: python3 (>= 3.12), python3-venv, python3-tk, libasound2, libportaudio2, libssl3, alsa-utils
Maintainer: iam-oov <osvaldo@tiriel.ai>
Description: ${APP_TITLE}
 English pronunciation game scored phoneme-by-phoneme via Azure
 Pronunciation Assessment. Paste a paragraph; beat every sound to win.
EOF

# --- postinst: system venv + runtime deps ---
cat > "${PKG_DIR}/DEBIAN/postinst" << 'EOF'
#!/bin/bash
set -e
INSTALL_DIR="/opt/pronunciation-tetris"
VENV_DIR="${INSTALL_DIR}/venv"
PY="$(command -v python3.12 || command -v python3)"
echo "Setting up venv with ${PY}..."
"$PY" -m venv "$VENV_DIR"
"${VENV_DIR}/bin/pip" install --quiet --upgrade pip
"${VENV_DIR}/bin/pip" install --quiet \
  "azure-cognitiveservices-speech>=1.40.0" "requests>=2.34.2" "sounddevice>=0.5.5"
echo "Pronunciation Tetris installed. Run: pronunciation-tetris"
EOF
chmod 755 "${PKG_DIR}/DEBIAN/postinst"

# --- prerm: remove only the generated venv (leaves the user's ~/.config) ---
cat > "${PKG_DIR}/DEBIAN/prerm" << 'EOF'
#!/bin/bash
set -e
rm -rf /opt/pronunciation-tetris/venv
EOF
chmod 755 "${PKG_DIR}/DEBIAN/prerm"

# --- source: all root modules + the credentials template ---
cp ./*.py "${PKG_DIR}/opt/${APP_NAME}/"
cp .env.example "${PKG_DIR}/opt/${APP_NAME}/.env.example"

# --- launcher: seeds the XDG .env on first run (runs as the user) ---
cat > "${PKG_DIR}/usr/bin/${APP_NAME}" << 'EOF'
#!/bin/bash
APP_DIR="/opt/pronunciation-tetris"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/pronunciation-tetris"
if [ ! -f "${CONFIG_DIR}/.env" ]; then
  mkdir -p "${CONFIG_DIR}"
  cp "${APP_DIR}/.env.example" "${CONFIG_DIR}/.env"
  echo "Created ${CONFIG_DIR}/.env — edit it with your AZURE_SPEECH_KEY before playing." >&2
fi
exec "${APP_DIR}/venv/bin/python" "${APP_DIR}/app.py" "$@"
EOF
chmod 755 "${PKG_DIR}/usr/bin/${APP_NAME}"

# --- 128x128 icon (Pillow via uv; skipped gracefully if uv is absent) ---
if command -v uv >/dev/null; then
  uv run --with pillow python -c "
from PIL import Image, ImageDraw, ImageFont
img = Image.new('RGBA', (128, 128), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([6, 6, 122, 122], radius=18, fill='#2d6cdf', outline='#1b4fae', width=3)
try:
    f = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 64)
except Exception:
    f = ImageFont.load_default()
d.text((64, 64), 'PT', fill='#ffffff', font=f, anchor='mm')
img.save('${PKG_DIR}/usr/share/icons/hicolor/128x128/apps/${APP_NAME}.png')
print('icon ok')
"
else
  echo "uv not found: skipping icon (the .desktop entry still works)."
fi

# --- desktop entry ---
cat > "${PKG_DIR}/usr/share/applications/${APP_NAME}.desktop" << EOF
[Desktop Entry]
Name=${APP_TITLE}
Comment=English pronunciation game scored phoneme-by-phoneme (Azure)
Exec=${APP_NAME}
Icon=${APP_NAME}
Terminal=false
Type=Application
Categories=Education;Audio;
Keywords=english;pronunciation;speech;learning;tetris;
EOF

dpkg-deb --build --root-owner-group "$PKG_DIR"
echo "Built: ${PKG_DIR}.deb  ->  sudo dpkg -i ${PKG_DIR}.deb"
