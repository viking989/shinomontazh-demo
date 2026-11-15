#!/usr/bin/env bash
set -Eeuo pipefail

DOMAIN="${1:-}"
if [[ ! "$DOMAIN" =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$ ]]; then
  echo "Использование: sudo bash deploy/timeweb-install.sh site.example.ru" >&2
  echo "Укажите домен без https://, пути и завершающего слеша." >&2
  exit 2
fi

if [[ "${EUID}" -ne 0 ]]; then
  echo "Запустите установщик через sudo: sudo bash deploy/timeweb-install.sh $DOMAIN" >&2
  exit 2
fi

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

if ! command -v docker >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1 || { ! docker compose version >/dev/null 2>&1 && ! command -v docker-compose >/dev/null 2>&1; }; then
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "Автоустановка поддерживает Ubuntu/Debian. Установите Docker Compose вручную." >&2
    exit 3
  fi
  echo "Устанавливаем недостающие компоненты Docker…"
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates
  if ! command -v docker >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io
  fi
  if ! docker compose version >/dev/null 2>&1 && ! command -v docker-compose >/dev/null 2>&1; then
    if ! DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose-v2; then
      DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose
    fi
  fi
  systemctl enable --now docker
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "Docker установлен, но Docker Compose не найден." >&2
  exit 3
fi

if [[ -f .env ]]; then
  echo ".env уже существует — сохраняем домен и секреты без изменений."
  ACTIVE_DOMAIN="$(sed -n 's/^DOMAIN=//p' .env | head -n 1)"
else
  ENV_TMP="$(mktemp ./.env.tmp.XXXXXX)"
  chmod 600 "$ENV_TMP"
  sed \
    -e "s/^DOMAIN=.*/DOMAIN=$DOMAIN/" \
    -e "s|^PUBLIC_ORIGIN=.*|PUBLIC_ORIGIN=https://$DOMAIN|" \
    .env.customer.example > "$ENV_TMP"
  mv "$ENV_TMP" .env
  ACTIVE_DOMAIN="$DOMAIN"
fi

echo "Собираем и запускаем сайт…"
"${COMPOSE[@]}" up -d --build
"${COMPOSE[@]}" ps

echo "Ждём готовности приложения…"
for attempt in {1..30}; do
  if curl -fsS http://127.0.0.1:3100/api/health >/dev/null 2>&1; then
    CADDY_ID="$("${COMPOSE[@]}" ps -q caddy)"
    if [[ -z "$CADDY_ID" ]] || [[ "$(docker inspect -f '{{.State.Running}}' "$CADDY_ID" 2>/dev/null || true)" != "true" ]]; then
      echo "Приложение работает, но HTTPS-прокси Caddy не запущен:" >&2
      "${COMPOSE[@]}" logs --tail=80 caddy >&2
      exit 4
    fi
    SITE_ID="$(sed -n 's/^SITE_ID=//p' .env | head -n 1)"
    echo
    echo "Сайт запущен: https://$ACTIVE_DOMAIN"
    echo "Кабинет: https://$ACTIVE_DOMAIN/s/$SITE_ID/admin"
    echo "Проверка: https://$ACTIVE_DOMAIN/api/health"
    echo "Если HTTPS ещё не открылся, проверьте A-запись домена и подождите выпуск сертификата."
    exit 0
  fi
  sleep 2
done

echo "Приложение не прошло проверку. Последние сообщения:" >&2
"${COMPOSE[@]}" logs --tail=80 app >&2
exit 4
