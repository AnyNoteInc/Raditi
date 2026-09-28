# `egress-1`: узел выхода к провайдерам моделей

Единственный путь шлюза подписок (роль `llm`) к `chatgpt.com`, `auth.openai.com` и `api.kimi.ai`: из России OpenAI отвечает 403, а соединения к Cloudflare, за которым стоит Kimi, обрываются после 16 КБ. Узел — ВМ за рубежом с HTTPS-прокси: mTLS, `CONNECT` только к точному списку `host:443` и проба канала `/probe`. Решения — spec §19, «Выход к провайдерам моделей», и [p3-design.md](../../docs/research/2026-09-subscriptions/p3-design.md) §3.7. Поднимает и оплачивает владелец до разведки P3.0 (roadmap, P3).

Что видит узел: имена хостов из списка, адреса провайдеров, объёмы и время соединений. Чего не видит: тел и токенов — TLS идёт от шлюза прямо до провайдера внутри туннеля. Секретов на узле нет, кроме ключа TLS-сервера. Взломанный узел может рвать соединения, но подменить провайдера не может: шлюз проверяет провайдера встроенным набором CA Node.

| Файл | Что это |
| --- | --- |
| `llm-egress.mjs` | Прокси на `node:https` без зависимостей |
| `llm-egress.test.mjs` | Проверки в `pnpm test:infra` на синтетическом CA из `make-ca.sh` (нужен `openssl`) |
| `make-ca.sh` | Выпуск CA и сертификатов — на машине владельца |
| `raditi-egress.service` | Юнит systemd: свой системный пользователь, из прав — только занять порт 443 |
| `nftables.conf` | Файрвол узла |
| `env.example` | Образец `/etc/raditi/egress.env`: белый список, CN клиентов, предел пробы |

Docker на узле не нужен: прокси — один файл без зависимостей, а Docker переписывает правила файрвола.

## Как работает прокси

- **Клиенты.** Роль `llm` с сертификатом `app-1` и на время проверки P3 владелец с `op-1`. TLS 1.3, сертификат клиента обязателен. Без сертификата, с сертификатом чужого CA или серверного CA (нет `clientAuth`) соединение рвётся на рукопожатии. CN не из `EGRESS_CLIENT_CN_ALLOW` — 403.
- **`CONNECT host:port`** — только точная пара из `LLM_EGRESS_ALLOW`, регистр не важен. Имя прокси резолвит сам, только IPv4: провайдер всегда видит один адрес узла. Если среди адресов есть частный, loopback, link-local (в том числе 169.254.169.254), CGNAT, документационный, multicast или зарезервированный — 403. Иначе туннель к первому адресу.
- **`GET /probe?bytes=N`**, N от 1 до `EGRESS_PROBE_MAX_BYTES` (не больше 1 МиБ) — N случайных байт. Проверяет, что канал из России не обрывается после 16 КБ. С B9 роль `llm` пробует 64 КБ раз в 5 минут, владелец — 1 МиБ.
- **Пределы:** 64 туннеля одновременно, простой туннеля — 11 минут, соединение с провайдером — 10 секунд, зависшая проба — 2 минуты.
- **Ответы:** 403 — клиент, хост, адрес или путь не разрешены; 405 — метод не `CONNECT` и не `GET`; 400 — размер пробы; 502 — имя не разрешилось или провайдер отказал в соединении; 503 — занято 64 туннеля; 504 — провайдер не ответил за 10 секунд.
- **Журнал** — journald, по JSON-строке на событие:
  - `connect` — `cn`, `host` (только значение из списка, иначе `null`), `result`, `ms`, `up`, `down`;
  - `probe` — `cn`, `result`, `ms`, `bytes`;
  - `request` — отказ в запросе, кроме пробы;
  - `tls` — отказ на рукопожатии и его код.

  Адресов клиентов, путей, тел и имён хостов не из списка в журнале нет.

## 1. ВМ

- 1 vCPU, 1 ГБ, 10 ГБ, Ubuntu 24.04, постоянный IPv4.
- Страна — из [списка стран ChatGPT](https://help.openai.com/en/articles/7947663-chatgpt-supported-countries) и из перечня Роскомнадзора (приказ № 128). По умолчанию — Казахстан (spec §20, вопрос 2). Россия, Беларусь, Китай и Гонконг не подходят.
- Провайдер — не Hetzner, DigitalOcean и OVH: соединения из России к ним обрываются после 16 КБ ([Cloudflare, 26.06.2025](https://blog.cloudflare.com/russian-internet-users-are-unable-to-access-the-open-internet/)).
- Вход — только по SSH-ключу.
- Для разведки P3.0 — отдельная ВМ `spike-1` у того же провайдера и в той же стране: [infra/dev/llm-verify/README.md](../dev/llm-verify/README.md).

## 2. Сертификаты — на машине владельца

Нужен OpenSSL 3 (на macOS — `brew install openssl`). Каталог CA держите вне репозитория, на зашифрованном диске:

```sh
CA=~/raditi-egress-ca
infra/egress/make-ca.sh ca "$CA"
infra/egress/make-ca.sh server "$CA" egress-1.raditi.internal
infra/egress/make-ca.sh client "$CA" op-1 14
```

Сертификат `app-1` для app-ВМ выпускается той же командой в M10: `make-ca.sh client "$CA" app-1`.

| Файл в `$CA` | Куда | Секрет |
| --- | --- | --- |
| `root-key.pem`, `server-ca-key.pem`, `client-ca-key.pem` | Остаются офлайн у владельца. Не на ВМ и не в git | Да |
| `root.pem` | `egress-1`: `/etc/raditi/egress/root.pem`. app-ВМ: `/run/raditi/llm/egress-ca.pem` (M10). Машина владельца — для `curl` | Нет |
| `client-ca.pem` | `egress-1`: `/etc/raditi/egress/client-ca.pem` | Нет |
| `server/egress-1.raditi.internal.pem` и `…-key.pem` | `egress-1`: `server.pem` и `server-key.pem` в `/etc/raditi/egress/` | Ключ — да |
| `clients/op-1.pem` и `op-1-key.pem` | На 14 дней: машина владельца (проверка канала и `verify:llm-gateway --real`) и, если разведка идёт через узел, `spike-1` | Ключ — да |
| `clients/app-1.pem` и `app-1-key.pem` (M10) | app-ВМ: `/run/raditi/llm/egress-client.pem` и `egress-client-key.pem` через vault-agent | Ключ — да |

- **Сроки:** корень — 10 лет, промежуточные CA — 5 лет, сервер и `app-1` — 397 дней, `op-1` — 14 дней. `make-ca.sh` печатает дату окончания.
- **Перевыпуск** листового сертификата — та же команда, каждый раз с новым ключом. CA выпускается один раз: повторный `ca` отказывает.
- **CN** — без личных данных. Имени `egress-1.raditi.internal` в DNS нет: оно нужно только для проверки TLS, клиент подключается по IP.
- **Файлы клиента** содержат сертификат вместе с клиентским CA. Прокси проверяет цепочку до корня, `clientAuth` и то, что выпустил его именно клиентский CA.

## 3. Установка

Всё под root на `egress-1`:

```sh
apt-get update && apt-get -y upgrade && apt-get -y install nftables unattended-upgrades xz-utils libatomic1
ufw status        # если active — ufw disable: файрволом управляет nftables
timedatectl       # «System clock synchronized: yes»: без точного времени TLS не работает
```

**Node 26.10** — та же версия, что в репозитории:

```sh
v=v26.10.0 a=linux-x64          # linux-arm64 на ARM
cd /tmp
curl -fsSLO "https://nodejs.org/dist/$v/node-$v-$a.tar.xz"
curl -fsSLO "https://nodejs.org/dist/$v/SHASUMS256.txt"
grep " node-$v-$a.tar.xz\$" SHASUMS256.txt | sha256sum -c -
tar -xJf "node-$v-$a.tar.xz" -C /opt && ln -sfn "/opt/node-$v-$a" /opt/node
/opt/node/bin/node --version
```

Подпись `SHASUMS256.txt` проверяется ключами релизов Node.js — [Verifying binaries](https://github.com/nodejs/node#verifying-binaries).

**Файлы.** С машины владельца, из корня репозитория, — в домашний каталог администратора:

```sh
scp infra/egress/{llm-egress.mjs,env.example,raditi-egress.service,nftables.conf} \
  "$CA"/{root.pem,client-ca.pem} "$CA"/server/egress-1.raditi.internal{,-key}.pem <админ>@<адрес egress-1>:
```

На `egress-1` из этого каталога:

```sh
useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin raditi-egress
install -d -m 0755 /opt/raditi/egress
install -d -m 0750 -o root -g raditi-egress /etc/raditi/egress
install -m 0644 llm-egress.mjs /opt/raditi/egress/
install -m 0644 env.example /etc/raditi/egress.env      # проверьте значения
install -m 0640 -o root -g raditi-egress root.pem client-ca.pem /etc/raditi/egress/
install -m 0640 -o root -g raditi-egress egress-1.raditi.internal.pem /etc/raditi/egress/server.pem
install -m 0640 -o root -g raditi-egress egress-1.raditi.internal-key.pem /etc/raditi/egress/server-key.pem
install -m 0644 raditi-egress.service /etc/systemd/system/
shred -u egress-1.raditi.internal-key.pem                # копия ключа в домашнем каталоге
```

Ключ сервера читают только root и группа `raditi-egress`, в которой нет никого, кроме сервиса.

**Журнал — 14 дней:**

```sh
install -d /etc/systemd/journald.conf.d
printf '[Journal]\nMaxRetentionSec=14day\n' >/etc/systemd/journald.conf.d/raditi.conf
systemctl restart systemd-journald
```

## 4. Файрвол

В `/etc/nftables.conf` (копия `nftables.conf`) замените примерные адреса:
- `PROXY_CLIENTS` — внешний адрес app-ВМ (адрес NAT-шлюза облака) и на время P3 — адрес владельца;
- `ADMIN` — откуда заходит SSH;
- `RESOLVERS` — резолверы провайдера (`resolvectl dns`).

Кроме 443 и DNS, открыты:
- DHCP — иначе ВМ потеряет адрес;
- NTP — без точного времени TLS не работает;
- HTTP и HTTPS на публичные адреса — для обновлений.

В частные и link-local адреса исходящие закрыты. Это вторая линия после проверки в самом прокси.

Правила применяются с откатом через 5 минут, чтобы не потерять SSH:

```sh
install -m 0644 nftables.conf /etc/nftables.conf     # затем впишите адреса
nft -c -f /etc/nftables.conf
systemd-run --on-active=5min --unit=nft-rollback /usr/sbin/nft flush ruleset
systemctl enable nftables && systemctl restart nftables
# в новом окне войдите по SSH ещё раз; вошли — отмените откат:
systemctl stop nft-rollback.timer
```

cloud-init после установки лучше выключить (`touch /etc/cloud/cloud-init.disabled`): он ходит в сервис метаданных 169.254.169.254, а файрвол его закрывает.

**Запуск:**

```sh
systemctl daemon-reload && systemctl enable --now raditi-egress
journalctl -u raditi-egress -o cat -n 5     # {"event":"listening","port":443}
systemd-analyze security raditi-egress
```

Юнит требует `nftables.service`: если правила не загрузились, прокси не стартует.

## 5. Проверка с машины владельца в России

`curl` с поддержкой HTTPS-прокси — системный на macOS или из Homebrew. Функция работает в bash и zsh:

```sh
IP=203.0.113.7                  # внешний адрес egress-1
H=egress-1.raditi.internal
CA=~/raditi-egress-ca
egress() {
  curl --resolve "$H:443:$IP" --proxy "https://$H:443" --proxy-cacert "$CA/root.pem" \
    --proxy-cert "$CA/clients/op-1.pem" --proxy-key "$CA/clients/op-1-key.pem" "$@"
}
```

1. **Три хоста проходят.** Код ответа любой, кроме `000`: туннель работает. Что провайдер отвечает адресу узла, выясняет разведка P3.0. У `chatgpt.com` загрузка больше 16 КБ должна прийти целиком. Ответ `502` и `"result":"resolve"` в журнале узла — неверные `RESOLVERS` в `nftables.conf`.

   ```sh
   for url in https://chatgpt.com/ https://auth.openai.com/ https://api.kimi.ai/; do
     egress -sS -o /dev/null --max-time 60 -w "$url %{http_code} %{size_download}\n" "$url"
   done
   ```

2. **Четвёртый — нет:** `egress -sS -o /dev/null https://example.com/` → `CONNECT tunnel failed, response 403`.
3. **Без сертификата — нет:** `curl -sS --resolve "$H:443:$IP" --cacert "$CA/root.pem" "https://$H/probe?bytes=10"` → ошибка TLS `certificate required`.
4. **Проба 1 МиБ.** Ожидается `200 1048576`.

   ```sh
   curl -sS --resolve "$H:443:$IP" --cacert "$CA/root.pem" \
     --cert "$CA/clients/op-1.pem" --key "$CA/clients/op-1-key.pem" --max-time 60 \
     -o /dev/null -w '%{http_code} %{size_download} %{speed_download}\n' \
     "https://$H/probe?bytes=1048576"
   ```

   Загрузка встаёт около 16 КБ и обрывается по времени — канал режется. Тогда до продолжения нужен другой провайдер или другая страна (гейт «схема A», roadmap P3). Запасной транспорт — AmneziaWG (spec §20, вопрос 3).
5. **Журнал на узле:** `journalctl -u raditi-egress -o cat --since -15min`.
   - Для `op-1` — строки `connect` с `ok`, `forbidden_host` с `"host":null`, `tls` с `ERR_SSL_PEER_DID_NOT_RETURN_A_CERTIFICATE`, `probe` на 1048576 байт.
   - Вашего адреса там нет: `journalctl -u raditi-egress -o cat | grep -c '<ваш адрес>'` → `0`.

Ту же проверку повторите из облака, где будет app-ВМ: у адресов дата-центров своя судьба (roadmap P14).

## 6. Обслуживание

- **После P3** уберите `op-1` из `EGRESS_CLIENT_CN_ALLOW`, адрес владельца — из `PROXY_CLIENTS`, затем `systemctl restart nftables raditi-egress`. Сертификат `op-1` и так истекает через 14 дней.
- **Сертификат сервера** перевыпускайте раз в год: `make-ca.sh server …` → `/etc/raditi/egress/server*.pem` с теми же владельцем и правами → `systemctl restart raditi-egress`.
- **Обновления.** Систему обновляет `unattended-upgrades`. Node — новый архив по шагу 3 и новая ссылка `/opt/node`. Прокси — `llm-egress.mjs` из той ревизии репозитория, что выкладывается. После любого из них — `systemctl restart raditi-egress`.
- **Новый хост** — например, `auth.kimi.ai:443` для входа Kimi по OAuth — добавляется только вместе с кодом шлюза, которому он нужен: правка `egress.env`, затем перезапуск.
- **Подозрение на взлом.** Остановите сервис, переустановите ВМ, выпустите новый серверный сертификат. Если под подозрением ключи CA — выпустите новый CA и все сертификаты. Токенов на узле нет. Но взломанный узел может рвать соединения во время обновления токенов (spec §18) — посмотрите алерт на долю неясных обновлений.
- **Второй узел** `egress-2` в другой стране и у другого провайдера — до первого клиента (M10). Аккаунт при этом остаётся за одним узлом.

## Локально

- `pnpm test:infra` запускает `llm-egress.test.mjs`: туннели, отказы, `/probe`, пределы, сертификаты из `make-ca.sh`.
- Запуск на своей машине — каталог с `server.pem`, `server-key.pem`, `root.pem` и `client-ca.pem`:

  ```sh
  EGRESS_TLS_DIR=<каталог> EGRESS_LISTEN_HOST=127.0.0.1 EGRESS_LISTEN_PORT=18443 \
    LLM_EGRESS_ALLOW=chatgpt.com:443 EGRESS_CLIENT_CN_ALLOW=op-1 node infra/egress/llm-egress.mjs
  ```

- Локальный экземпляр с фейками подписок в профиле `llm` и в стенде `verify:llm-gateway` запускает этот же файл (коммиты B2 и B13 из p3-design.md §15).
