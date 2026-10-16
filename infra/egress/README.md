# `egress-1`: узел выхода к провайдерам моделей

Путь шлюза подписок (роль `llm`) к провайдеру модели, до которого из России напрямую не дойти. Узел — ВМ за рубежом с HTTPS-прокси: mTLS, `CONNECT` только к точному списку `host:443` и проба канала `/probe`. Решения — spec §19, «Выход к провайдерам моделей», и [p3-design.md](../../docs/research/2026-09-subscriptions/p3-design.md) §3.7.

Единственному провайдеру продукта узел не нужен: к Z.ai роль `llm` ходит сама — так решил владелец 05.10.2026, и адаптер `zai-coding` объявляет это сам (`direct` в описании его запросов). Узел остаётся возможностью для других провайдеров (ответ владельца П2) и настройкой роли: когда его прокси задан (`LLM_EGRESS_PROXY_URL` и три файла), через него идут все провайдеры, поэтому `api.z.ai:443` стоит в списке `LLM_EGRESS_ALLOW`. Когда прокси не задан, роль сама соединяется только с тем провайдером, чей адаптер объявил, что узел ему не нужен. Достижим ли `api.z.ai` из России без узла, не измерялось. Поднимать узел до появления провайдера, которому он нужен, не требуется; порядок ниже — на этот случай.

Что видит узел: имена хостов из списка, адреса провайдеров, объёмы и время соединений. Чего не видит: тел и токенов — TLS идёт от шлюза прямо до провайдера внутри туннеля. Секретов на узле нет, кроме ключа TLS-сервера. Взломанный узел может рвать соединения, но подменить провайдера не может: шлюз проверяет провайдера встроенным набором CA Node.

| Файл | Что это |
| --- | --- |
| `llm-egress.mjs` | Прокси на `node:https` без зависимостей |
| `llm-egress.test.mjs` | Проверки в `pnpm test:infra` на синтетическом CA из `make-ca.sh` (нужен `openssl`) |
| `make-ca.sh` | Выпуск CA и сертификатов — на машине владельца |
| `raditi-egress.service` | Юнит systemd: свой системный пользователь, из прав — только занять порт 443 |
| `nftables.conf` | Файрвол узла |
| `env.example` | Образец `/etc/raditi/egress.env`: белый список, CN и отпечатки сертификатов клиентов, предел пробы |

Docker на узле не нужен: прокси — один файл без зависимостей, а Docker переписывает правила файрвола.

## Как работает прокси

- **Клиенты.** Роль `llm` с сертификатом `app-1` и на время ручной проверки канала (раздел 5) владелец с `op-1`. TLS 1.3, сертификат клиента обязателен. Без сертификата, с сертификатом чужого CA или серверного CA (нет `clientAuth`) соединение рвётся на рукопожатии. CN не из `EGRESS_CLIENT_CN_ALLOW` или SHA-256 отпечаток сертификата не из `EGRESS_CLIENT_SHA256` — 403. Отпечаток — это отзыв: старый сертификат с тем же CN действителен по цепочке до своего срока, и только удаление его отпечатка из списка закрывает ему вход.
- **`CONNECT host:port`** — только точная пара из `LLM_EGRESS_ALLOW`, регистр не важен. Имя прокси резолвит сам, только IPv4: провайдер всегда видит один адрес узла. Если среди адресов есть частный, loopback, link-local (в том числе 169.254.169.254), CGNAT, документационный, multicast или зарезервированный — 403. Иначе туннель к первому адресу.
- **`GET /probe?bytes=N`**, N от 1 до `EGRESS_PROBE_MAX_BYTES` (не больше 1 МиБ) — N случайных байт. Проверяет, что канал из России не обрывается после 16 КБ. С B9 роль `llm` пробует 64 КБ раз в 5 минут, владелец — 1 МиБ.
- **Пределы:** 64 туннеля одновременно, простой туннеля — 11 минут, разрешение имени и соединение с провайдером вместе — 10 секунд, зависшая проба — 2 минуты. Истечение времени освобождает слот; поздний ответ DNS уже не открывает соединение. Туннель, который первым закрыл провайдер (так кончается каждый запрос роли: она шлёт `connection: close`), завершается вместе с соединением клиента: слот не ждёт простоя. Если клиент не закрылся, прокси обрывает туннель через 5 секунд после того, как отдал ему весь ответ провайдера (в журнале — `client_lingered`); пока клиент ответ не забрал, туннель живёт, и предел ему — простой.
- **Ответы:** 403 — клиент, хост, адрес или путь не разрешены; 405 — метод не `CONNECT` и не `GET`; 400 — размер пробы; 502 — имя не разрешилось или провайдер отказал в соединении; 503 — занято 64 туннеля; 504 — разрешение имени и соединение с провайдером не уложились в 10 секунд.
- **Журнал** — journald, по JSON-строке на событие:
  - `connect` — `cn`, `host` (только значение из списка, иначе `null`), `result`, `ms`, `up`, `down`;
  - `probe` — `cn`, `result`, `ms`, `bytes`;
  - `request` — отказ в запросе, кроме пробы;
  - `tls` — отказ на рукопожатии и его код.

  Адресов клиентов, путей, тел и имён хостов не из списка в журнале нет.

## 1. ВМ

- 1 vCPU, 1 ГБ, 10 ГБ, Ubuntu 24.04, постоянный IPv4.
- Страна — из списка стран, которые обслуживает провайдер, и из перечня Роскомнадзора (приказ № 128). По умолчанию — Казахстан (spec §20, вопрос 2). Россия и Беларусь не подходят.
- Провайдер — не Hetzner, DigitalOcean и OVH: соединения из России к ним обрываются после 16 КБ ([Cloudflare, 26.06.2025](https://blog.cloudflare.com/russian-internet-users-are-unable-to-access-the-open-internet/)).
- Вход — только по SSH-ключу.

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
| `clients/op-1.pem` и `op-1-key.pem` | На 14 дней: машина владельца (проверка канала) | Ключ — да |
| `clients/app-1.pem` и `app-1-key.pem` (M10) | app-ВМ: `/run/raditi/llm/egress-client.pem` и `egress-client-key.pem` через vault-agent | Ключ — да |

- **Сроки:** корень — 10 лет, промежуточные CA — 5 лет, сервер и `app-1` — 397 дней, `op-1` — 14 дней. `make-ca.sh` печатает дату окончания.
- **Отпечаток.** Для каждого листового сертификата `make-ca.sh` печатает строку `sha256=…`. Отпечатки клиентских сертификатов (`app-1`, `op-1`) записываются в `EGRESS_CLIENT_SHA256` на узле; без них прокси не стартует (в `env.example` стоят заглушки).
- **Перевыпуск** листового сертификата — та же команда, каждый раз с новым ключом. Старый сертификат с тем же CN остаётся действительным по цепочке до своего срока, поэтому порядок такой: добавить новый отпечаток в `EGRESS_CLIENT_SHA256` и перезапустить прокси → разложить новый сертификат клиенту → удалить старый отпечаток и снова перезапустить. CA выпускается один раз: повторный `ca` отказывает.
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
install -m 0644 env.example /etc/raditi/egress.env      # впишите отпечатки, проверьте значения
install -m 0640 -o root -g raditi-egress root.pem client-ca.pem /etc/raditi/egress/
install -m 0640 -o root -g raditi-egress egress-1.raditi.internal.pem /etc/raditi/egress/server.pem
install -m 0640 -o root -g raditi-egress egress-1.raditi.internal-key.pem /etc/raditi/egress/server-key.pem
install -m 0644 raditi-egress.service /etc/systemd/system/
shred -u egress-1.raditi.internal-key.pem                # копия ключа в домашнем каталоге
```

Ключ сервера читают только root и группа `raditi-egress`, в которой нет никого, кроме сервиса. В `/etc/raditi/egress.env` замените заглушки `EGRESS_CLIENT_SHA256` отпечатками `sha256=…`, которые `make-ca.sh` напечатал для `app-1` и `op-1` (сертификата `app-1` до M10 нет — оставьте только `op-1`). С заглушками прокси не стартует.

**Журнал — 14 дней:**

```sh
install -d /etc/systemd/journald.conf.d
printf '[Journal]\nMaxRetentionSec=14day\n' >/etc/systemd/journald.conf.d/raditi.conf
systemctl restart systemd-journald
```

## 4. Файрвол

В `/etc/nftables.conf` (копия `nftables.conf`) замените заглушки в угловых скобках. Пока хоть одна осталась, `nft -c` отказывает файлу, и правила с непроверенным адресом не загрузятся:
- `PROXY_CLIENTS` — `<APP_VM_IPV4>`, внешний адрес app-ВМ (адрес NAT-шлюза облака), и на время проверки канала `<OWNER_IPV4>`, адрес владельца; до M10 app-ВМ нет — оставьте только адрес владельца;
- `ADMIN` — `<ADMIN_IPV4>`, откуда заходит SSH;
- `RESOLVERS` — `<RESOLVER_IPV4>`, резолверы провайдера (`resolvectl dns`).

Кроме 443 и DNS, открыты:
- DHCP — иначе ВМ потеряет адрес;
- NTP — без точного времени TLS не работает;
- HTTP и HTTPS на публичные адреса — для обновлений.

В частные, link-local, CGNAT, документационные, тестовые, multicast и зарезервированные адреса исходящие закрыты: `NON_PUBLIC` — тот же список, который прокси не набирает сам (`BLOCKED_IPV4` в `llm-egress.mjs`; тест держит их равными). Это вторая линия после проверки в самом прокси.

Правила применяются с откатом через 5 минут, чтобы не потерять SSH. Откат сначала останавливает прокси: узел без правил туннели не принимает:

```sh
install -m 0644 nftables.conf /etc/nftables.conf     # затем впишите адреса
nft -c -f /etc/nftables.conf                         # с заглушками — ошибка, это ожидаемо
systemd-run --on-active=5min --unit=nft-rollback \
  /bin/sh -c 'systemctl stop raditi-egress; /usr/sbin/nft flush ruleset'
systemctl enable nftables && systemctl restart nftables
nft list table inet raditi_egress >/dev/null && echo loaded
# в новом окне войдите по SSH ещё раз; вошли — отмените откат:
systemctl stop nft-rollback.timer
```

Если откат сработал, прокси остановлен: исправьте файл, примените его снова тем же порядком, затем `systemctl start raditi-egress`.

cloud-init после установки лучше выключить (`touch /etc/cloud/cloud-init.disabled`): он ходит в сервис метаданных 169.254.169.254, а файрвол его закрывает.

**Запуск:**

```sh
systemctl daemon-reload && systemctl enable --now raditi-egress
journalctl -u raditi-egress -o cat -n 5     # {"event":"listening","port":443,"pinned":true}
systemd-analyze security raditi-egress
```

Юнит требует `nftables.service`: если правила не загрузились, прокси не стартует.

## 5. Проверка с машины владельца в России

`curl` с поддержкой HTTPS-прокси — системный на macOS или из Homebrew. Функция работает в bash и zsh:

```sh
IP='<внешний адрес egress-1>'   # замените: curl не примет заглушку
H=egress-1.raditi.internal
CA=~/raditi-egress-ca
egress() {
  curl --resolve "$H:443:$IP" --proxy "https://$H:443" --proxy-cacert "$CA/root.pem" \
    --proxy-cert "$CA/clients/op-1.pem" --proxy-key "$CA/clients/op-1-key.pem" "$@"
}
```

1. **Хосты списка проходят.** Код ответа любой, кроме `000`: туннель работает. Загрузка больше 16 КБ должна прийти целиком. Ответ `502` и `"result":"resolve"` в журнале узла — неверные `RESOLVERS` в `nftables.conf`.

   ```sh
   for url in https://api.z.ai/; do
     egress -sS -o /dev/null --max-time 60 -w "$url %{http_code} %{size_download}\n" "$url"
   done
   ```

2. **Хост вне списка — нет:** `egress -sS -o /dev/null https://example.com/` → `CONNECT tunnel failed, response 403`.
3. **Без сертификата — нет:** `curl -sS --resolve "$H:443:$IP" --cacert "$CA/root.pem" "https://$H/probe?bytes=10"` → ошибка TLS `certificate required`.
4. **Проба 1 МиБ.** Ожидается `200 1048576`.

   ```sh
   curl -sS --resolve "$H:443:$IP" --cacert "$CA/root.pem" \
     --cert "$CA/clients/op-1.pem" --key "$CA/clients/op-1-key.pem" --max-time 60 \
     -o /dev/null -w '%{http_code} %{size_download} %{speed_download}\n' \
     "https://$H/probe?bytes=1048576"
   ```

   Загрузка встаёт около 16 КБ и обрывается по времени — канал режется. Тогда до продолжения нужен другой провайдер узла или другая страна. Запасной транспорт — AmneziaWG (spec §20, вопрос 3).
5. **Журнал на узле:** `journalctl -u raditi-egress -o cat --since -15min`.
   - Для `op-1` — строки `connect` с `ok`, `forbidden_host` с `"host":null`, `tls` с `ERR_SSL_PEER_DID_NOT_RETURN_A_CERTIFICATE`, `probe` на 1048576 байт.
   - Вашего адреса там нет: `journalctl -u raditi-egress -o cat | grep -c '<ваш адрес>'` → `0`.

Ту же проверку повторите из облака, где будет app-ВМ: у адресов дата-центров своя судьба (roadmap P14).

## 6. Обслуживание

- **После проверки канала** уберите `op-1` из `EGRESS_CLIENT_CN_ALLOW` и его отпечаток из `EGRESS_CLIENT_SHA256`, адрес владельца — из `PROXY_CLIENTS`, затем `systemctl restart nftables raditi-egress`. Сертификат `op-1` и так истекает через 14 дней.
- **Сертификат клиента** `app-1` перевыпускайте раз в год в порядке из раздела 2: новый отпечаток добавляется до раскладки сертификата, старый удаляется после.
- **Сертификат сервера** перевыпускайте раз в год: `make-ca.sh server …` → `/etc/raditi/egress/server*.pem` с теми же владельцем и правами → `systemctl restart raditi-egress`.
- **Обновления.** Систему обновляет `unattended-upgrades`. Node — новый архив по шагу 3 и новая ссылка `/opt/node`. Прокси — `llm-egress.mjs` из той ревизии репозитория, что выкладывается. После любого из них — `systemctl restart raditi-egress`.
- **Новый хост** добавляется только вместе с адаптером провайдера, которому он нужен: правка `egress.env`, затем перезапуск.
- **Утёк ключ клиента** (взлом app-ВМ, потерянный ключ `op-1`). Удалите его отпечаток из `EGRESS_CLIENT_SHA256` и перезапустите прокси: старая пара сразу получает 403, хотя её цепочка и CN действительны до срока. Затем выпустите новый сертификат (`make-ca.sh client …`), добавьте его отпечаток, перезапустите и разложите сертификат клиенту. Пока у клиента нет нового сертификата, роль `llm` к провайдерам не ходит.
- **Подозрение на взлом узла.** Остановите сервис, переустановите ВМ, выпустите новый серверный сертификат. Старый серверный сертификат действителен по цепочке до срока: с ним можно выдать себя за прокси, но тела и токены идут внутри TLS до провайдера, и такой «прокси» видит только имена хостов и объёмы — столько же, сколько взломанный узел. Отзывается он только новым CA. Если под подозрением ключи CA — выпустите новый CA и все сертификаты (`make-ca.sh ca` в новый каталог), замените `root.pem` у роли `llm` и отпечатки на узле. Токенов на узле нет.
- **Второй узел** `egress-2` в другой стране и у другого провайдера — до первого клиента (M10). Аккаунт при этом остаётся за одним узлом.

## Локально

- `pnpm test:infra` запускает `llm-egress.test.mjs`: туннели, отказы, `/probe`, пределы, сертификаты из `make-ca.sh`, отзыв по отпечатку, совпадение `NON_PUBLIC` с проверкой прокси и заглушки файрвола.
- Запуск на своей машине — каталог с `server.pem`, `server-key.pem`, `root.pem` и `client-ca.pem`:

  ```sh
  EGRESS_TLS_DIR=<каталог> EGRESS_LISTEN_HOST=127.0.0.1 EGRESS_LISTEN_PORT=18443 \
    LLM_EGRESS_ALLOW=api.z.ai:443 EGRESS_CLIENT_CN_ALLOW=op-1 node infra/egress/llm-egress.mjs
  ```

  Без `EGRESS_CLIENT_SHA256` прокси пускает по одному CN — так только локально; на узле список отпечатков обязателен (`env.example`).

- Локальный экземпляр в стенде `verify:llm-gateway` запускает этот же файл: один ход стенда идёт через него, остальные — напрямую.
