Каталог `/run/raditi/traefik` нужен резолверу `pages` (wildcard опубликованных страниц `*.<PAGES_BASE_DOMAIN>`, DNS-01): создаётся на tmpfs, владелец `65532:65532`, права `0700`; файлы принадлежат `65532:65532`, права `0400`. Значения рендерит vault-agent из `kv/platform/app/traefik`; в репозиторий они не помещаются. На app-ВМ провайдер — Yandex Cloud DNS (`PREVIEW_DNS_PROVIDER=yandexcloud`), на едином сервере — reg.ru (`infra/server/README.md`).

| Файл | Содержимое |
| --- | --- |
| `yandex-cloud-iam-token` | Авторизованный ключ сервисного аккаунта Yandex Cloud в base64 (переменная lego `YANDEX_CLOUD_IAM_TOKEN`), роль `dns.editor` только на зону `PAGES_BASE_DOMAIN` |
| `yandex-cloud-folder-id` | Каталог Yandex Cloud, в котором лежит эта зона |

Резолвер `le` сертификатов кабинета их не использует. Предпросмотров чатов и их резолвера `preview` с 15.11.2026 нет ([план 83](../../../../docs/plan/83-remove-projects.md), БП13).
