-- Роли и базы dev-PostgreSQL. Скрипт из docker-entrypoint-initdb.d выполняется только на пустом
-- томе pgdata. На существующем томе запустите его вручную — он идемпотентный:
--   docker compose -f infra/dev/docker-compose.yml exec -T postgres \
--     psql -U raditi -d postgres -v ON_ERROR_STOP=1 < infra/dev/postgres-init.sql

-- Отдельная роль и база для LiteLLM (виртуальные ключи на ход и учёт токенов):
-- у шлюза моделей нет доступа к базе платформы (spec §9).
SELECT 'CREATE ROLE litellm LOGIN PASSWORD ''litellm'''
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'litellm') \gexec
SELECT 'CREATE DATABASE litellm OWNER litellm'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'litellm') \gexec
-- Старый bootstrap создавал пустую базу под владельцем raditi. Меняем владельца и на
-- существующем томе, иначе REVOKE ниже закроет подключение новой роли litellm.
ALTER DATABASE litellm OWNER TO litellm;

-- По умолчанию к любой базе может подключиться любая роль (PUBLIC). Закрываем: к raditi ходит
-- только владелец raditi (и роли, которым дали CONNECT явно), к litellm — только litellm.
REVOKE CONNECT, TEMPORARY ON DATABASE raditi FROM PUBLIC;
REVOKE CONNECT, TEMPORARY ON DATABASE litellm FROM PUBLIC;

-- postgres-exporter: только статистика (pg_monitor), без доступа к данным.
SELECT 'CREATE ROLE postgres_exporter LOGIN PASSWORD ''postgres_exporter'''
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'postgres_exporter') \gexec
GRANT pg_monitor TO postgres_exporter;
GRANT CONNECT ON DATABASE raditi TO postgres_exporter;
