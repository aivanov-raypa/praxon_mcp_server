#!/usr/bin/env bash
# Configuración inicial del servidor Ubuntu para Praxon. Se ejecuta UNA vez, como root (sudo). Es repetible: si algo ya está
# hecho, lo salta.
#
# Qué hace: instala Node 22, git y pm2; crea el usuario "praxon" sin privilegios; genera una clave SSH de despliegue
# (solo lectura) para clonar el repositorio; clona el código; prepara el .env desde .env.example (con un PRAXON_TOKEN
# aleatorio, sin mostrarlo); abre el puerto de Praxon solo a la red interna con ufw; deja pm2 arrancando al encender la
# máquina y rotando sus logs. NO arranca Praxon: primero hay que rellenar el .env y después ejecutar scripts/deploy.sh.
#
# Uso:
#   sudo ./setup-server.sh --repo git@github.com:ORG/praxon_mcp_server.git --lan 192.168.1.0/24 [opciones]
#
# Opciones:
#   --repo URL        Repositorio por SSH (obligatorio)
#   --lan CIDR        Red interna desde la que se permite el acceso, p. ej. 192.168.1.0/24 (obligatorio salvo --no-firewall)
#   --branch RAMA     Rama a desplegar (por defecto main)
#   --user NOMBRE     Usuario del servicio (por defecto praxon)
#   --dir RUTA        Carpeta de la aplicación (por defecto /opt/praxon/app)
#   --port N          Puerto de Praxon (por defecto 8080)
#   --praxon-user ID  Nombre que aparece en la auditoría (PRAXON_USER; por defecto el usuario de sudo)
#   --no-firewall     No toca ufw
#   --no-auto-updates No activa las actualizaciones automáticas de seguridad
#   --yes             No pide confirmación antes de activar el cortafuegos
set -Eeuo pipefail

REPO=""; LAN=""; BRANCH="main"; APP_USER="praxon"; APP_DIR="/opt/praxon/app"; PORT=8080
PRAXON_USER_NAME="${SUDO_USER:-praxon}"; FIREWALL=1; AUTO_UPDATES=1; ASSUME_YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:?falta la URL}"; shift 2 ;;
    --lan) LAN="${2:?falta el CIDR}"; shift 2 ;;
    --branch) BRANCH="${2:?falta la rama}"; shift 2 ;;
    --user) APP_USER="${2:?falta el usuario}"; shift 2 ;;
    --dir) APP_DIR="${2:?falta la ruta}"; shift 2 ;;
    --port) PORT="${2:?falta el puerto}"; shift 2 ;;
    --praxon-user) PRAXON_USER_NAME="${2:?falta el nombre}"; shift 2 ;;
    --no-firewall) FIREWALL=0; shift ;;
    --no-auto-updates) AUTO_UPDATES=0; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    -h|--help) sed -n 2,26p "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "Opción desconocida: $1" >&2; exit 2 ;;
  esac
done

log()  { printf '\n[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
as_app() { sudo -u "$APP_USER" -H "$@"; }

[ "$(id -u)" = 0 ] || die "Ejecútalo con sudo."
[ -n "$REPO" ] || die "Falta --repo (por SSH, p. ej. git@github.com:ORG/praxon_mcp_server.git)."
case "$REPO" in git@*|ssh://*) ;; *) die "Usa la URL SSH del repositorio, no la https (se despliega con clave de despliegue)." ;; esac
[[ "$APP_USER" =~ ^[a-z][a-z0-9_-]{1,30}$ ]] || die "Nombre de usuario no válido: $APP_USER"
[[ "$PORT" =~ ^[0-9]{2,5}$ ]] && [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "Puerto no válido: $PORT"
[[ "$PRAXON_USER_NAME" =~ ^[A-Za-z0-9._-]{1,40}$ ]] || die "--praxon-user solo admite letras, números, punto, guion y guion bajo."
[[ "$APP_DIR" = /* ]] || die "--dir debe ser una ruta absoluta."
if [ "$FIREWALL" = 1 ]; then
  [ -n "$LAN" ] || die "Falta --lan (p. ej. 192.168.1.0/24), o usa --no-firewall."
  command -v python3 >/dev/null || apt-get install -y python3 >/dev/null
  python3 -c 'import ipaddress,sys; ipaddress.ip_network(sys.argv[1], strict=False)' "$LAN" 2>/dev/null || die "CIDR no válido: $LAN"
fi
. /etc/os-release
[ "${ID:-}" = ubuntu ] || echo "AVISO: este script está pensado para Ubuntu (aquí: ${ID:-desconocido})."

# 1. Paquetes base
log "1/9 Paquetes base"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ca-certificates gnupg rsync tar ufw openssl util-linux sudo python3 >/dev/null

# 2. Node 22 (el servidor exige >= 22.9)
log "2/9 Node.js"
node_ok() { command -v node >/dev/null && node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=9)?0:1)'; }
if ! node_ok; then
  echo "   Instalando Node 22 desde NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
  bash /tmp/nodesource_setup.sh >/dev/null
  rm -f /tmp/nodesource_setup.sh
  apt-get install -y -qq nodejs >/dev/null
fi
node_ok || die "No hay Node >= 22.9 (hay $(node -v 2>/dev/null || echo ninguno))."
echo "   Node $(node -v), npm $(npm -v)"

# 3. pm2
log "3/9 pm2"
command -v pm2 >/dev/null || npm install -g pm2 >/dev/null 2>&1
echo "   pm2 $(pm2 -v)"

# 4. Usuario del servicio (sin contraseña, sin sudo)
log "4/9 Usuario $APP_USER"
if id "$APP_USER" >/dev/null 2>&1; then
  echo "   Ya existe."
else
  useradd -m -s /bin/bash "$APP_USER"
  passwd -l "$APP_USER" >/dev/null
fi
APP_HOME="$(getent passwd "$APP_USER" | cut -d: -f6)"
BASE_DIR="$(dirname "$APP_DIR")"
mkdir -p "$BASE_DIR"
chown "$APP_USER:$APP_USER" "$BASE_DIR"
chmod 750 "$BASE_DIR"

# 5. Clave SSH de despliegue (solo lectura en GitHub)
log "5/9 Clave de despliegue"
as_app mkdir -p "$APP_HOME/.ssh"
chmod 700 "$APP_HOME/.ssh"
KEY="$APP_HOME/.ssh/praxon_deploy"
if [ ! -f "$KEY" ]; then
  as_app ssh-keygen -t ed25519 -N '' -C "praxon-deploy@$(hostname)" -f "$KEY" >/dev/null
  echo "   Clave generada."
fi
if ! grep -q 'IdentityFile .*praxon_deploy' "$APP_HOME/.ssh/config" 2>/dev/null; then
  as_app tee -a "$APP_HOME/.ssh/config" >/dev/null <<CFG_EOF
Host github.com
  HostName github.com
  User git
  IdentityFile $KEY
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
CFG_EOF
  chmod 600 "$APP_HOME/.ssh/config"
  chown "$APP_USER:$APP_USER" "$APP_HOME/.ssh/config"
fi
if ! as_app env GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND='ssh -o BatchMode=yes' git ls-remote "$REPO" >/dev/null 2>&1; then
  echo
  echo "================================================================"
  echo "GitHub todavía no acepta la clave de despliegue. Añádela así:"
  echo "  Repositorio -> Settings -> Deploy keys -> Add deploy key"
  echo "  Título: praxon-servidor   Allow write access: SIN marcar (solo lectura)"
  echo "  Clave pública:"
  echo
  cat "$KEY.pub"
  echo
  echo "Después vuelve a ejecutar este mismo comando."
  echo "================================================================"
  exit 3
fi
echo "   GitHub acepta la clave."

# 6. Código
log "6/9 Código ($BRANCH)"
if [ -d "$APP_DIR/.git" ]; then
  echo "   Ya está clonado en $APP_DIR."
else
  as_app env GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND='ssh -o BatchMode=yes' git clone --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
chmod +x "$APP_DIR/scripts/"*.sh 2>/dev/null || true

# 7. .env (token aleatorio, sin mostrarlo)
log "7/9 Configuración (.env)"
ENV_FILE="$APP_DIR/.env"
set_env() { # clave valor (valores sin saltos de línea ni '|')
  if grep -qE "^$1=" "$ENV_FILE"; then sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"; else printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"; fi
}
if [ -f "$ENV_FILE" ]; then
  echo "   Ya existe .env: no se toca."
else
  [ -f "$APP_DIR/.env.example" ] || die "El repositorio no tiene .env.example en la rama $BRANCH."
  ( umask 077; cp "$APP_DIR/.env.example" "$ENV_FILE" )
  SERVER_IP="$(hostname -I | awk '{print $1}')"
  set_env PORT "$PORT"
  set_env PRAXON_TOKEN "$(openssl rand -hex 32)"
  set_env PRAXON_USER "$PRAXON_USER_NAME"
  set_env PRAXON_PUBLIC_URL "ws://${SERVER_IP}:${PORT}/ws"
  chown "$APP_USER:$APP_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "   .env creado (permisos 600). Faltan por rellenar las claves y URLs (ver el final)."
fi
as_app mkdir -p "$APP_DIR/data" "$APP_DIR/logs"
chmod 700 "$APP_DIR/data"

# 8. Cortafuegos: solo la red interna
if [ "$FIREWALL" = 1 ]; then
  log "8/9 Cortafuegos (ufw)"
  if [ -n "${SSH_CLIENT:-}" ]; then
    SSH_IP="${SSH_CLIENT%% *}"
    python3 -c 'import ipaddress,sys; sys.exit(0 if ipaddress.ip_address(sys.argv[1]) in ipaddress.ip_network(sys.argv[2], strict=False) else 1)' "$SSH_IP" "$LAN" \
      || die "Estás conectado por SSH desde $SSH_IP, que no está dentro de $LAN: el cortafuegos te dejaría fuera. Revisa --lan o usa --no-firewall."
  fi
  echo "   Entrada: SSH (22) y Praxon ($PORT) solo desde $LAN; el resto, denegado."
  if [ "$ASSUME_YES" != 1 ]; then
    read -r -p "   ¿Activar ufw con estas reglas? [s/N] " ans
    [ "$ans" = s ] || [ "$ans" = S ] || die "Cancelado. Repite con --yes o con --no-firewall."
  fi
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw allow from "$LAN" to any port 22 proto tcp >/dev/null
  ufw allow from "$LAN" to any port "$PORT" proto tcp >/dev/null
  ufw --force enable >/dev/null
  ufw status | sed 's/^/   /'
else
  log "8/9 Cortafuegos: omitido (--no-firewall). Acuérdate de limitar el puerto $PORT a la red interna."
fi

# 9. pm2 al arrancar la máquina y rotación de logs
log "9/9 pm2 al arranque y rotación de logs"
env PATH="$PATH:$(dirname "$(command -v node)")" pm2 startup systemd -u "$APP_USER" --hp "$APP_HOME" >/dev/null
as_app pm2 install pm2-logrotate >/dev/null 2>&1 || true
as_app pm2 set pm2-logrotate:max_size 10M >/dev/null 2>&1 || true
as_app pm2 set pm2-logrotate:retain 14 >/dev/null 2>&1 || true
as_app pm2 set pm2-logrotate:compress true >/dev/null 2>&1 || true
if [ "$AUTO_UPDATES" = 1 ]; then
  apt-get install -y -qq unattended-upgrades >/dev/null
  echo "   Actualizaciones automáticas de seguridad activas."
fi

cat <<END_EOF

Servidor preparado. Quedan dos pasos manuales:

1) Rellena el .env EN el servidor (no pegues los valores en ningún chat):
     sudo -u $APP_USER -H nano $ENV_FILE
   Obligatorias: ANTHROPIC_API_KEY, MYRAYPA_API_URL, MYRAYPA_API_TOKEN, GITHUB_ORG, GITHUB_READ_TOKEN, GITHUB_TOKEN,
   GITHUB_MERGE_TOKEN, MERGE_ALLOWED_USERS. Deja TRIAGE_ENABLED=false hasta probar Praxon en la conversación.

2) Primer despliegue (instala, prueba, arranca con pm2 y comprueba /health):
     sudo -u $APP_USER -H $APP_DIR/scripts/deploy.sh

Despliegues futuros: el mismo comando del paso 2. Estado: sudo -u $APP_USER -H pm2 status
END_EOF
