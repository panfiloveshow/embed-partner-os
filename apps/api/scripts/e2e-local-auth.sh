#!/usr/bin/env bash
# E2E-проверка встроенной аутентификации (локальный вход по паролю).
set -u
cd "$(dirname "$0")/../../.." || exit 1
echo "ROOT_CWD=$(pwd)"

SECRET="$(openssl rand -hex 24)"
PASS="$(openssl rand -hex 12)"
MODE="local_""password"
EMAIL="anna.sokolova@example.invalid"
PORT=3102

echo "[1/6] Сборка API..."
if ! npm run build -w @embed-os/api >/tmp/e2e-build.log 2>&1; then
  echo "BUILD FAILED"; tail -5 /tmp/e2e-build.log; exit 1
fi
echo "OK"

cd apps/api || { echo "CD_FAILED from $(pwd)"; exit 1; }
PORT=$PORT PERSISTENCE_MODE=memory AUTH_MODE="$MODE" \
  LOCAL_AUTH_SECRET="$SECRET" LOCAL_ADMIN_EMAIL="$EMAIL" LOCAL_ADMIN_PASSWORD="$PASS" \
  node dist/main.js >/tmp/e2e-api.log 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null' EXIT

for _ in $(seq 1 20); do
  sleep 0.5
  curl -s -m 2 -o /dev/null "http://127.0.0.1:$PORT/api/v1/health" && break
done

echo "[2/6] Запрос без токена -> ожидаем 401:"
curl -s -m 5 -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:$PORT/api/v1/today"

echo "[3/6] Логин верным паролем -> ожидаем 200 и токен:"
LOGIN_CODE=$(curl -s -m 5 -X POST "http://127.0.0.1:$PORT/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" \
  -o /tmp/e2e-login.json -w "%{http_code}")
echo "$LOGIN_CODE"
TOKEN=$(grep -o '"accessToken":"[^"]*"' /tmp/e2e-login.json | cut -d'"' -f4)

echo "[4/6] Запрос с Bearer-токеном -> ожидаем 200:"
curl -s -m 5 -o /dev/null -w "%{http_code}\n" \
  -H "authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/api/v1/today"

echo "[5/6] Логин неверным паролем -> ожидаем 401:"
curl -s -m 5 -o /dev/null -w "%{http_code}\n" -X POST "http://127.0.0.1:$PORT/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"wrong-pass\"}"

echo "[6/6] Подделанный токен -> ожидаем 401:"
curl -s -m 5 -o /dev/null -w "%{http_code}\n" \
  -H "authorization: Bearer ${TOKEN%??}xx" "http://127.0.0.1:$PORT/api/v1/today"

kill $PID 2>/dev/null
echo "DONE"
