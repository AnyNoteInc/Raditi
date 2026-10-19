Каталог `/run/raditi/traefik` нужен только с предпросмотрами (`docker-compose.preview.yml`): создаётся на tmpfs, владелец `65532:65532`, права `0700`; оба файла принадлежат `65532:65532`, права `0400`. Значения рендерит vault-agent из `kv/platform/app/traefik`; в репозиторий они не помещаются.

| Файл | Содержимое |
| --- | --- |
| `yandex-cloud-iam-token` | Авторизованный ключ сервисного аккаунта Yandex Cloud в base64 (переменная lego `YANDEX_CLOUD_IAM_TOKEN`), роль `dns.editor` только на зону `PREVIEW_BASE_DOMAIN` |
| `yandex-cloud-folder-id` | Каталог Yandex Cloud, в котором лежит эта зона |

Traefik читает их через `YANDEX_CLOUD_IAM_TOKEN_FILE` и `YANDEX_CLOUD_FOLDER_ID_FILE` только при выпуске и продлении wildcard-сертификата `*.<PREVIEW_BASE_DOMAIN>` (резолвер `preview`, DNS-01). Резолвер `le` сертификатов кабинета их не использует.
