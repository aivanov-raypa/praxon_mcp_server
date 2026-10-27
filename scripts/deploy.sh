#!/usr/bin/env bash
# Despliegue del servidor de Praxon: copia de seguridad, actualización del código, instalación, pruebas, reinicio con pm2,
# comprobación y vuelta atrás automática si algo falla.
#
# Uso (desde cualquier carpeta, en el servidor):
#   ./scripts/deploy.sh                 despliega la rama actual (git pull --ff-only)
#   ./scripts/deploy.sh --branch main   cambia a esa rama y la despliega
#   ./scripts/deploy.sh --skip-tests    NO recomendado: salta las pruebas (queda avisado)
#   ./scripts/deploy.sh --dry-run       hace todo menos reiniciar (para ensayar)
#
# Variables opcionales: PM2_APP (nombre en pm2, por defecto "praxon"), BACKUP_DIR (por defecto ../praxon-backups),
# BACKUP_KEEP (copias que se conservan, 14), HEALTH_URL (por defecto http://127.0.0.1:<PORT>/health).
# No lee ni muestra el contenido de .env: solo el valor de PORT para la comprobación.
set -Eeuo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# git pull puede reemplazar este mismo fichero mientras se ejecuta (bash lo lee poco a poco): se ejecuta desde una copia temporal.
if [ -z "${DEPLOY_REEXEC:-}" ]; then
  TMP_SCRIPT="$(mktemp)"
  cp "${BASH_SOURCE[0]}" "$TMP_SCRIPT"
  export APP_DIR DEPLOY_REEXEC=1 DEPLOY_TMP="$TMP_SCRIPT"
  exec bash "$TMP_SCRIPT" "$@"
fi
[ -z "${DEPLOY_TMP:-}" ] || trap 'rm -f "$DEPLOY_TMP"' EXIT
PM2_APP="${PM2_APP:-praxon}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/../praxon-backups}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"
BRANCH=""
SKIP_TESTS=0
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --branch) BRANCH="${2:?falta el nombre de la rama}"; shift 2 ;;
    --skip-tests) SKIP_TESTS=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n 2,14p "$APP_DIR/scripts/deploy.sh"; exit 0 ;;
    *) echo "Opción desconocida: $1" >&2; exit 2 ;;
  esac
done

log()  { printf '\n[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; return 1; }  # el retorno distinto de 0 activa la vuelta atrás (trap ERR)

cd "$APP_DIR"
for cmd in git node npm pm2 tar curl; do command -v "$cmd" >/dev/null || fail "Falta el comando: $cmd"; done

# Node >= 22.9 (engines de package.json)
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=9)?0:1)' \
  || fail "Hace falta Node 22.9 o superior (hay $(node -v))."

# Un solo despliegue a la vez
exec 9>"$APP_DIR/.deploy.lock"
flock -n 9 || fail "Ya hay un despliegue en curso."

[ -f .env ] || fail "No existe .env en $APP_DIR."
[ -z "$(git status --porcelain --untracked-files=no)" ] || fail "Hay cambios locales sin confirmar en el código; confírmalos o descártalos antes de desplegar."

PREV_SHA="$(git rev-parse HEAD)"
PREV_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
ROLLBACK_ARMED=0
SERVICE_TOUCHED=0

rollback() {
  local code=$?
  trap - ERR
  printf '\nFALLO en el despliegue (código %s).\n' "$code" >&2
  if [ "$ROLLBACK_ARMED" = 1 ]; then
    log "Vuelta atrás a ${PREV_SHA:0:8}..."
    git checkout --quiet "$PREV_BRANCH" 2>/dev/null || true
    git reset --hard --quiet "$PREV_SHA" || true
    npm ci --no-audit --no-fund --silent || true
    if [ "$SERVICE_TOUCHED" = 1 ]; then
      pm2 restart "$PM2_APP" --update-env >/dev/null 2>&1 || true
      echo "Servidor devuelto a la versión anterior. La copia de datos está en: ${BACKUP_FILE:-<sin copia>}" >&2
      echo "Si los datos también cambiaron, se restauran con: tar -xzf \"${BACKUP_FILE:-copia.tar.gz}\" -C \"$APP_DIR\"" >&2
    else
      echo "El servicio en marcha no se ha reiniciado: sigue con la versión anterior. Código y dependencias restaurados." >&2
    fi
  else
    echo "El servicio no se ha tocado." >&2
  fi
  exit "$code"
}
trap rollback ERR

# 1. Copia de seguridad de data/ y logs/ (el .env va aparte, en vuestro gestor de secretos)
log "1/7 Copia de seguridad de data/ y logs/"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
BACKUP_FILE="$BACKUP_DIR/praxon-$(date '+%Y%m%d-%H%M%S')-${PREV_SHA:0:8}.tar.gz"
( umask 077; tar -czf "$BACKUP_FILE" -C "$APP_DIR" $( [ -d data ] && echo data ) $( [ -d logs ] && echo logs ) )
echo "   $BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))"
ls -1t "$BACKUP_DIR"/praxon-*.tar.gz 2>/dev/null | tail -n +"$((BACKUP_KEEP + 1))" | xargs -r rm -f --

# 2. Código
log "2/7 Actualizando el código"
git fetch --quiet origin
[ -z "$BRANCH" ] || git checkout --quiet "$BRANCH"
git pull --ff-only --quiet
NEW_SHA="$(git rev-parse HEAD)"
if [ "$NEW_SHA" = "$PREV_SHA" ]; then
  echo "   Sin cambios nuevos (${NEW_SHA:0:8}); se continúa para reinstalar, probar y reiniciar."
else
  echo "   ${PREV_SHA:0:8} -> ${NEW_SHA:0:8}"
  git --no-pager log --oneline "$PREV_SHA..$NEW_SHA" | head -15 | sed 's/^/   /'
fi
ROLLBACK_ARMED=1

# 3. Dependencias exactas del lock
log "3/7 Instalando dependencias (npm ci)"
npm ci --no-audit --no-fund --silent

# 4. Pruebas (usan dobles de MyRAYPA, GitHub y Anthropic: no leen .env ni data/ ni llaman a sistemas reales)
if [ "$SKIP_TESTS" = 1 ]; then
  log "4/7 Pruebas OMITIDAS (--skip-tests). Se despliega sin verificar."
else
  log "4/7 Ejecutando pruebas"
  npm test --silent
fi

# 5. Aviso de vulnerabilidades (informativo: no detiene el despliegue)
log "5/7 Auditoría de dependencias"
npm audit --omit=dev --audit-level=high >/dev/null 2>&1 && echo "   Sin vulnerabilidades altas o críticas." \
  || echo "   AVISO: hay vulnerabilidades altas o críticas. Revisa con: npm audit --omit=dev"

if [ "$DRY_RUN" = 1 ]; then
  ROLLBACK_ARMED=0
  log "Ensayo terminado (--dry-run): no se ha reiniciado nada."
  exit 0
fi

# 6. Reinicio con pm2
log "6/7 Reiniciando con pm2 ($PM2_APP)"
SERVICE_TOUCHED=1
if pm2 describe "$PM2_APP" >/dev/null 2>&1; then
  pm2 restart "$PM2_APP" --update-env >/dev/null
else
  echo "   No existe '$PM2_APP' en pm2: se crea."
  pm2 start npm --name "$PM2_APP" --cwd "$APP_DIR" -- start >/dev/null
fi
pm2 save >/dev/null

# 7. Comprobación: pm2 en línea y /health respondiendo
log "7/7 Comprobando que arranca"
PORT_VALUE="$(grep -E '^PORT=' .env | tail -1 | cut -d= -f2 | tr -d '[:space:]"'"'" || true)"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:${PORT_VALUE:-8080}/health}"
ok=0
for _ in $(seq 1 20); do
  sleep 1
  STATUS="$(pm2 jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const p=JSON.parse(s).find(x=>x.name===process.argv[1]);console.log(p?p.pm2_env.status:"ausente")}catch{console.log("desconocido")}})' "$PM2_APP")"
  if [ "$STATUS" = "online" ] && curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then ok=1; break; fi
done
[ "$ok" = 1 ] || fail "El servidor no responde en $HEALTH_URL (estado pm2: ${STATUS:-?}). Log: pm2 logs $PM2_APP --lines 50"

# Estable unos segundos: detecta reinicios en bucle
sleep 5
RESTARTS_OK="$(pm2 jlist | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s).find(x=>x.name===process.argv[1]);console.log(p&&p.pm2_env.status==="online"?"si":"no")})' "$PM2_APP")"
[ "$RESTARTS_OK" = si ] || fail "El servidor se ha caído tras arrancar. Log: pm2 logs $PM2_APP --lines 50"

trap - ERR
log "Despliegue correcto: ${NEW_SHA:0:8} en $(git rev-parse --abbrev-ref HEAD). Copia de datos: $BACKUP_FILE"
