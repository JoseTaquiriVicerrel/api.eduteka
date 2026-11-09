#!/usr/bin/env bash
# Auditoria de SOLO LECTURA de un Redis (Fase 0 del plan de separacion de servicios).
# No escribe ni borra nada: usa INFO, CONFIG GET, MODULE LIST y SCAN.
#
#   REDIS_HOST=127.0.0.1 REDIS_PORT=6379 REDIS_PASSWORD=... deploy/redis-audit.sh
#   REDIS_PORT=6380 REDIS_PASSWORD=$QUEUE_REDIS_PASSWORD deploy/redis-audit.sh   # la de colas
#
# Lo que hay que mirar en la salida:
#   - version y modulos: el monolito usa RedisJSON (json.get/json.set), asi que debe aparecer ReJSON
#     (Redis Stack) o ser Redis >= 8.
#   - maxmemory 0 = sin tope: Redis crece hasta que el sistema lo mate. Hay que fijarlo.
#   - maxmemory-policy: la cache debe quedar en volatile-lru; la de colas en noeviction.
#   - claves por prefijo: cuanto ocupa cada uso (sesiones, cache de examenes, contadores, math).
set -euo pipefail

HOST="${REDIS_HOST:-127.0.0.1}"
PORT="${REDIS_PORT:-6379}"
SAMPLE="${SAMPLE:-200000}"   # tope de claves recorridas con SCAN (no bloquea: SCAN es incremental)

cli() {
  if [ -n "${REDIS_PASSWORD:-}" ]; then
    REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli -h "$HOST" -p "$PORT" "$@"
  else
    redis-cli -h "$HOST" -p "$PORT" "$@"
  fi
}

echo "== Redis $HOST:$PORT"
cli INFO server | grep -E '^(redis_version|redis_mode|os|uptime_in_days|executable|config_file):' || true

echo; echo "== Modulos"
cli MODULE LIST || echo "(MODULE LIST no disponible)"

echo; echo "== Memoria y expulsion"
cli INFO memory | grep -E '^(used_memory_human|used_memory_peak_human|maxmemory_human|maxmemory_policy|mem_fragmentation_ratio):' || true
cli CONFIG GET maxmemory
cli CONFIG GET maxmemory-policy

echo; echo "== Persistencia"
cli CONFIG GET appendonly
cli CONFIG GET appendfsync
cli CONFIG GET save
cli INFO persistence | grep -E '^(rdb_last_save_time|rdb_last_bgsave_status|aof_enabled|aof_last_write_status):' || true

echo; echo "== Clientes y pub/sub"
cli INFO clients | grep -E '^(connected_clients|blocked_clients|maxclients):' || true
cli PUBSUB CHANNELS 'edk:*' || true
cli PUBSUB NUMSUB edk:simulacrum:events edk:content:events || true

echo; echo "== Claves por base"
cli INFO keyspace

echo; echo "== Claves por prefijo (primer segmento antes de ':'), muestra de hasta $SAMPLE"
cli --scan --count 1000 | head -n "$SAMPLE" | awk -F: '{ print $1 }' | sort | uniq -c | sort -rn | head -40

echo; echo "== Claves sin TTL por prefijo (las que volatile-lru NUNCA expulsara), muestra de 2000"
cli --scan --count 1000 | head -n 2000 | while read -r key; do
  ttl="$(cli TTL "$key")"
  [ "$ttl" = "-1" ] && echo "${key%%:*}"
done | sort | uniq -c | sort -rn | head -20
