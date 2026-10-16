# 3. Цветовая гамма

[← Оглавление ревью](README.md)

## 3.1 Решение и токены

Палитра сохраняется. Все цвета лендинга идут из `packages/ui/src/theme/tokens.ts`, сырых литералов в CSS-модулях и в `apps/web/src/app` нет; весь текст, кроме одной пары в переходном состоянии [color-01], проходит WCAG 2.x AA; нейтральные лежат на одной линии тона (от 87° у card до 49° у ink), а accent (42°) и marker (83°) — соседняя пара, которую при протанопии и дейтеранопии разводит светлота (70 против 85). Слабые места — в состояниях и нетекстовых элементах, а не в базовых тонах. Поэтому новые базовые hex не добавляются; допускаются производные роли в `brandColorRoles` через `color-mix` из существующих токенов. В токенах меняются три вещи: появляется производная роль `ruleStrong` для контуров управления, `accentHover` становится различимым, дубль `shadowMedium` удаляется. Статусы остаются тёплыми, белого текста на accent нет (2.85:1), лендинг остаётся светлым при системной тёмной теме.

| Токен | HEX | OKLCH (L % / C / H°) | Роль |
|---|---|---|---|
| `card` | #FFFCF5 | 99.1 / 0.010 / 87.5 | поверхности макета сайта в демо |
| `paper` | #FFF8EC | 98.1 / 0.018 / 81.3 | фон страницы; текст на тёмных полях |
| `snow` | #FFF1DE | 96.4 / 0.029 / 75.7 | текст на `ruleInk` (недоступная кнопка чата) |
| `paper2` | #F3E7D5 | 93.3 / 0.027 / 78.2 | плашки шагов, макет кофейни |
| `rule` | #E1CDB6 | 85.9 / 0.038 / 71.2 | разделители (декор); с контуров управления уходит |
| `onInk` | #C6AE95 | 76.5 / 0.044 / 68.2 | вторичный текст на `ink` и `ink2` |
| `ok` | #79573B | 48.6 / 0.061 / 60.1 | статус успеха (= `success`), точки-метки |
| `graphite` | #695547 | 46.6 / 0.034 / 56.7 | пояснения и сноски |
| `ruleInk` | #5A3C28 | 38.6 / 0.053 / 54.2 | сообщение клиента в чате; линии и наведение на тёмном |
| `ink2` | #352217 | 27.3 / 0.035 / 50.8 | подвал чата |
| `ink` | #241710 | 21.9 / 0.025 / 49.3 | основной текст, тёмные поля, весь текст на accent и marker |
| `marker` | #FFC547 | 85.4 / 0.152 / 83.0 | ключевое слово, результат правки, бейдж, финальное поле |
| `accentLight` | #FFB86B | 83.4 / 0.125 / 66.9 | контур «Применить правку» на ink; primary тёмной темы приложения |
| `accent` | #FF6B24 | 70.3 / 0.196 / 42.2 | заливка основных действий и крупных цветовых полей; цветом текста не бывает |
| `accentText` | #A63D12 | 50.2 / 0.148 / 39.6 | мелкий акцентный текст, контур оранжевых кнопок, фокус, заполнение ползунка |
| `accentHover` = 85 % accent + marker, станет **65 %** | #FF7929 → **#FF8B30** | 72.2 / 0.185 / 46.4 → 75.0 / 0.171 / 53.2 | наведение на оранжевые заливки |
| `accentSoft` = 16 % accent + paper | #FFE1CC | 93.0 / 0.043 / 58.1 | рекомендованный тариф, «Предыдущая версия сохранена»; добавится выбранный сценарий |
| `accentRule` = 75 % accent + ink | #C8561F | 59.2 / 0.159 / 42.8 | линии на accent; под текст не годится (ink на нём 3.99:1) |
| `accentInk` = 40 % accent + ink | #7C3918 | 42.6 / 0.103 / 44.2 | текст на `accentSoft` |
| `markerRule` = 80 % marker + ink | #D3A23C | 74.1 / 0.130 / 82.3 | линии на marker |
| `markerSoft` = 70 % marker + paper | #FFD479 | 88.9 / 0.121 / 85.0 | объявлена, в `apps/web/src` не используется |
| **`ruleStrong`** = 70 % graphite + rule (новая) | **#8D7968** | 59.0 / 0.035 / 62.4 | контуры элементов управления и линии; не текст |

`onAccent` = `onAccentMuted` = `ink` (`packages/ui/src/theme/tokens.ts:75`, `:77`); `error` и `warning` на главной не используются. `ruleStrong` = `color-mix(in srgb, var(--raditi-graphite) 70%, var(--raditi-rule))` публикуется как `--raditi-rule-strong` без дополнительного кода (`packages/ui/src/theme/tokens.ts:94-99`): к paper 3.93:1, к paper2 3.39:1, к accentSoft 3.33:1, к ink 4.21:1. Роль — только для границ, не для текста, и не для янтарных полей (к marker 2.63:1); разделители остаются на `rule`.

## 3.2 Пары «текст / фон» и нетекстовые элементы

| Пара (элемент / фон) | HEX | Контраст | Порог | Статус | Где |
|---|---|---|---|---|---|
| graphite / marker — адрес сайта 10px после «Применить» | #695547 / #FFC547 | 4.46 | 4.5 | не проходит [color-01] | `apps/web/src/components/landing/site-demo.module.css:106-108`, `:122-131` |
| graphite / ink — контур «Отменить правку» в чате демо | #695547 / #241710 | 2.48 | 3 | не проходит; кнопку опознают подпись (16.51) и значок [color-02] | `apps/web/src/components/landing/site-demo.module.css:439-443` |
| rule / paper — контур ненажатого сценария, пустая часть дорожки ползунка, круг кнопки меню | #E1CDB6 / #FFF8EC | 1.46 | 3 | не проходит [color-03] | `apps/web/src/components/landing/site-demo.module.css:482`, `apps/web/src/components/landing/pricing.module.css:52-57`, `apps/web/src/components/landing/landing.module.css:1125` |
| onInk / paper2 — линия между «W» и «Радити» | #C6AE95 / #F3E7D5 | 1.74 | декор | роль текста тёмной панели на светлом [color-04] | `apps/web/src/components/landing/landing.module.css:495` |
| accentHover рядом с accent — наведение на заливку | #FF7929 / #FF6B24 | 1.08 (ΔE 2.6) | — | неразличимо [color-07] | `packages/ui/src/theme/tokens.ts:76` |
| marker на marker — выделение текста на янтарных полях | #FFC547 / #FFC547 | 1.00 | — | невидимо, по коду [color-11] | `apps/web/src/components/landing/landing.module.css:67-70`, `:859-860` |
| snow 8 % на paper — наведение на кнопку аватара при тёмной схеме | #FFF7EB / #FFF8EC | 1.00 | — | невидимо, по коду [color-13] | `apps/web/src/components/landing/landing.module.css:161-163` |
| paper2 / paper — фон наведения «Отменить правку» в карточке | #F3E7D5 / #FFF8EC | 1.16 | — | слабый; отклик держит контур graphite → ink [color-19] | `apps/web/src/components/landing/landing.module.css:769-772` |
| accent / marker — заливка финальной кнопки; её контур accentText / marker | #FF6B24, #A63D12 / #FFC547 | 1.81; 4.04 | 3 | проходит только контуром 1px [color-06] | `apps/web/src/components/landing/landing.module.css:888-890` |
| accentText / marker — «Радити.» в финальном заголовке, 28–61px | #A63D12 / #FFC547 | 4.04 | 3 (крупный) | проходит только как крупный | `apps/web/src/components/landing/landing.module.css:873-875` на поле `:859-862` |
| ink / accent — текст 11–17px блока безопасности, изменённая плашка акции 9–10px, подписи CTA | #241710 / #FF6B24 | 6.12 (APCA Lc 49) | 4.5 | проходит; по APCA — уровень крупного текста [color-09], [color-16] | `apps/web/src/components/landing/landing.module.css:593-596`, `apps/web/src/components/landing/site-demo.module.css:201-205` |
| accent / paper, accent / accentSoft — заливки CTA и кнопки рекомендованного тарифа | #FF6B24 / #FFF8EC, #FFE1CC | 2.69; 2.30 | 3 | проходят за счёт контура accentText (6.03; 5.14) | `apps/web/src/components/landing/landing.module.css:277-280`, `apps/web/src/components/landing/pricing.module.css:288-292` |
| white / accent | #FFFFFF / #FF6B24 | 2.85 | 4.5 | запрещено и не используется | — |
| ink / paper; paper / ink | #241710, #FFF8EC | 16.51 | 4.5 | проходит | основной текст, шапка; тёмная полоса, чат, подвал |
| graphite / paper; accentText / paper; ok / paper | #695547; #A63D12; #79573B / #FFF8EC | 6.65; 6.03; 6.14 | 4.5 | проходит | сноски 10–12px; номера шагов, цитаты, цена; статус 12px |
| ink / paper2; accentText / paper2 | #241710; #A63D12 / #F3E7D5 | 14.27; 5.22 | 4.5 | проходит | плашки шагов; макет кофейни |
| ink / marker; marker / ink | #241710, #FFC547 | 11.06 | 4.5; 3 | проходит | маркер заголовка, бейдж, финальный блок, «Изменено»; выделение на тёмном |
| onInk / ink; onInk / ink2; paper / ruleInk; snow / ruleInk | #C6AE95; #FFF8EC; #FFF1DE | 8.21; 7.10; 9.42; 8.94 | 4.5 | проходит | подвал, подписи чата; сообщение клиента; недоступная кнопка чата |
| ink, graphite / accentSoft; accentInk / accentSoft | #241710, #695547; #7C3918 / #FFE1CC | 14.06, 5.66; 6.94 | 4.5 | проходит | рекомендованный тариф; «Предыдущая версия сохранена» |
| Фокус: accentText / paper, accentSoft, marker; paper / ink; marker / ink | #A63D12; #FFF8EC; #FFC547 | 6.03, 5.14, 4.04; 16.51; 11.06 | 3 | проходит | обводка на каждом фоне, отступ 3–5px |
| «Применить правку»: accent / ink, контур accentLight / ink; бегунок и заполнение ползунка accentText / paper | #FF6B24, #FFB86B / #241710; #A63D12 / #FFF8EC | 6.12, 10.22; 6.03 | 3 | проходит | чат демо; калькулятор тарифов |

Проходящие пары — по сводной таблице аудита (расчёт от значений `packages/ui/src/theme/tokens.ts:2-19`). Текстовых полей на лендинге нет, пар для placeholder нет; недоступное состояние одно — кнопка чата. Не сняты на стенде и оценены только по коду: настоящие устройства, шапка вошедшего пользователя, сценарий «Акция» после применения.

## 3.3 Что меняем

| Роль или токен | Сейчас | Станет | Контраст до → после | Зачем | id | P | Труд. |
|---|---|---|---|---|---|---|---|
| `ruleStrong`, новая роль в `brandColorRoles` | цвета с 3:1 к бумаге нет: rule 1.46, onInk 2.01, дальше сразу graphite 6.65 | `color-mix(in srgb, var(--raditi-graphite) 70%, var(--raditi-rule))` ≈ #8D7968; дописать во frontmatter `apps/web/DESIGN.md` и в `design.json` | — → 3.93 к paper | граница 3:1 без нового базового hex | [color-04] | P3 | M |
| Контур `.demo .scenario` (`apps/web/src/components/landing/site-demo.module.css:482`) | `var(--raditi-rule)` | `var(--raditi-rule-strong)` | 1.46 → 3.93 | три пилюли читаются как переключатель | [color-03] | P2 | S |
| Дорожка `.range` (`apps/web/src/components/landing/pricing.module.css:52-57`) | один слой 3px: accentText до `--range-progress`, дальше rule | два слоя фона: заполнение 3px и под ним линия 1px `ruleStrong` на всю ширину (код ниже) | пустая часть 1.46 → 3.93 | перекраска пустой части слила бы её с заполнением: accentText к ruleStrong 1.54:1 против 4.13:1 к rule | [color-03] | P2 | S |
| `.connectLine` и круг `.menuToggle` (`apps/web/src/components/landing/landing.module.css:495`, `:1125`) | onInk на paper2; rule на paper | `var(--raditi-rule-strong)` | 1.74 → 3.39; 1.46 → 3.93 | роль текста тёмной панели уходит со светлого | [color-04] | P3 | S |
| `accentHover` (`packages/ui/src/theme/tokens.ts:76`) | 85 % accent + marker, #FF7929 | 65 %, #FF8B30; синхронизировать `apps/web/DESIGN.md:15`, `:156` и `design.json`; проверить MUI contained в обеих темах (`packages/ui/src/theme/create-app-theme.ts:128`) | к accent 1.08 → 1.21 (ΔE 2.6 → 6.4); ink на нём 6.63 → 7.43 | наведение видно, сдвиг «к янтарю» сохранён | [color-07] | P2 | S |
| Наведение на «Применить правку» (`apps/web/src/components/landing/site-demo.module.css:508-510`) и финальную кнопку (`apps/web/src/components/landing/landing.module.css:895-897`) | у кнопки демо цвет — единственный отклик; финальная уходит к янтарю | кнопке демо — сдвиг стрелки, как у тарифов (`apps/web/src/components/landing/pricing.module.css:275-277`); финальной — свой hover: заливка остаётся accent, отклик — уже существующий сдвиг стрелки (`:295-296`) | финальная к полю при наведении: 1.67 → 1.81 (с новым `accentHover` было бы 1.49) | отклик не только цветом; кнопка не растворяется в янтаре | [color-07] | P2 | S |
| Выбранный сценарий (`apps/web/src/components/landing/site-demo.module.css:493-497`) | accent, контур accentText, текст ink — как у CTA | `background: var(--raditi-accent-soft); border-color: var(--raditi-accent-text); color: var(--demo-ink)` и галочка существующим значком `Check` в заранее отведённом месте пилюли (`font-weight` не менять: сдвигает ряд); обновить `apps/web/.impeccable/design.json:162` и абзац «Живое демо» в DESIGN.md | текст 6.12 → 14.06; контур к бумаге 6.03 | accent остаётся только у действий | [color-05] | P2 | S |
| Наведение на контурные кнопки (`apps/web/src/components/landing/site-demo.module.css:517-520`, `apps/web/src/components/landing/landing.module.css:769-772`) | четыре варианта: инверсия ink / paper («Войти», тарифы), paper2 с контуром ink, ruleInk с контуром onInk, текст и контур accentText | правило в DESIGN.md: действие, уводящее со страницы, инвертируется; действие на месте — фон на ступень темнее и контур ink. Сценарий — paper2 и контур ink; `.undoButton:hover` — плюс `box-shadow: inset 0 0 0 1px var(--ink)`, `border-width` не менять | контур сценария при наведении 6.03 → 16.51 | одно нейтральное наведение | [color-19] | P3 | S |
| «Отменить правку» в чате (`apps/web/src/components/landing/site-demo.module.css:439-443`, `:512-515`) | контур graphite; при наведении onInk и фон ruleInk | в покое `border-color: var(--raditi-on-ink)`; при наведении `var(--raditi-paper)` и прежний фон ruleInk | 2.48 → 8.21; наведение 8.21 → 16.51 | отмена видна как кнопка | [color-02] | P2 | S |
| Адрес в демо после «Применить» (`apps/web/src/components/landing/site-demo.module.css:106-108`) | graphite на marker, 10px | `.stage[data-phase='applied'] .address { color: var(--demo-ink) }` | 4.46 → 11.06 | единственная текстовая пара ниже 4.5:1 | [color-01] | P3 | S |
| Изменённая плашка акции (`apps/web/src/components/landing/site-demo.module.css:201-205`) | accent / ink, 9–10px | `background: var(--demo-marker); color: var(--demo-ink)`; после правки снять сценарий «Акция» в состоянии «Изменено» | 6.12 → 11.06 | янтарь означает «изменено» во всех трёх сценариях (`apps/web/DESIGN.md:209`) | [color-16] | P3 | S |
| Цена в карточке сохранённой версии (`apps/web/src/components/landing/landing.module.css:716-724`) | всегда accentText; состояния различаются цифрой, словами и поворотом | пока правка действует: `.versionCard[data-reverted='false'] .versionItem > strong { color: var(--ink); background: linear-gradient(transparent 58%, var(--marker) 58% 94%, transparent 94%) }`; после отмены — accentText без полосы; дописать в `apps/web/DESIGN.md:221`; после задачи 5.7 атрибут `data-reverted` переезжает на `.safetyDemo` — селектор обновить | ink на marker 11.06; accentText на marker дал бы 4.04 — мало для знака «₽» 20px/400 (`:725-730`) | состояние подтверждено цветом, как в демо | [color-17] | P3 | S |
| Нажатие, `:active` | правил нет, кроме бегунка (`apps/web/src/components/landing/pricing.module.css:91-93`); подсветка касания отключена (`apps/web/src/components/landing/landing.module.css:57-62`) | `.primaryButton`, `.finalButton`, `.demo .action`, `.pricing .recommended .action` — `:active { transform: scale(0.98) }` и заливка как при наведении (accentHover), без затемнения; при reduced motion — только заливка; у финальной кнопки на янтарном поле заливка при нажатии не меняется (accentHover к marker — 1.49:1); контурным — отклик правила [color-19], не paper2 | текст 6.12 без изменений (на accentRule было бы 3.99) | касание на телефоне получает отклик | [color-08] | P3 | S |
| Текст на accent (`apps/web/src/components/landing/landing.module.css:633-646`, `:773-779`, `:508-514`) | `.safetyList p` 14px/400, `.safetyNote` 12px, `.safetyCaption` 12px (11px на телефоне, `:1540-1542`), подпись «Вы» 10px | не мельче 14px и вес 500 всему тексту мельче 16px: `.safetyList p`, `.safetyNote`, `.safetyCaption` — 14px/500; «Вы» — 12px/500; согласовать с разделом типографики | 6.12 (Lc 49) без изменений | поле не осветляем, читаемость добираем кеглем и весом | [color-09] | P3 | S |
| `::selection` (`apps/web/src/components/landing/landing.module.css:67-70`, `apps/web/src/components/landing/site-demo.module.css:40-43`) | ink на marker | умолчание перевернуть: `color: var(--marker); background: var(--ink)`; прежнюю пару оставить тёмным поверхностям (панель чата, подвал) | на янтаре 1.00 → 11.06 | выделение видно на бумаге, янтаре и accent | [color-11] | P3 | S |
| `shadowMedium` (`packages/ui/src/theme/tokens.ts:85-86`) | ink 25 % рядом с `shadowSoft` 24 %; одно использование — мобильное меню (`apps/web/src/components/landing/landing.module.css:1150`) | меню — на `--raditi-shadow-soft`, `shadowMedium` удалить; сравнить снимок `menu-0390-open` до и после | — | роль без различимого результата | [color-21] | P3 | S |
| Превью `apps/web/.impeccable/design.json:162`, `:176`, `:184`, `:198` | `.ds-scenario:hover` — текст accent (2.69:1); `.ds-range` — заполнение accent; `.ds-undo` — контур onInk (2.01:1); `.ds-plan-action` — прозрачный контур | синхронизировать с CSS-модулями одним заходом после [color-02], [color-03], [color-05], [color-07]; дописать геометрию тени мобильного меню | — | превью не показывают пары, запрещённые `apps/web/DESIGN.md:248` | [color-18] | P3 | S |
| `theme-color`, фон и `color-scheme` документа | не заданы для лендинга | правка 3.6 | — | оформление браузера в цвет страницы | [color-12] | P2 | S |
| Шапка вошедшего пользователя | тёмная палитра MUI на светлой странице | правка 3.6 после снимка | аватар к бумаге 1.61 → 6.03 | одна схема в пределах поверхности | [color-13] | P3 | S |
| `error` (`packages/ui/src/theme/tokens.ts:25`) | #9C3D26 рядом с `info` = accentText: ΔE 2.4, 1.06:1; на главной не используется (`apps/web/src/components/landing/pricing.tsx:41`) | в план лендинга не входит — отдельная задача по формам: светлая и тёмная пары, Alert и подписи полей в обеих темах | — | ошибка не должна выглядеть как акцентная ссылка | [color-15] | P3 | S |

Дорожка ползунка после правки:

```css
.range {
  background:
    linear-gradient(to right, var(--pricing-accent) 0 var(--range-progress), transparent var(--range-progress) 100%)
      center / 100% 3px no-repeat,
    linear-gradient(var(--raditi-rule-strong), var(--raditi-rule-strong)) center / 100% 1px no-repeat;
}
```

Там, где поправки проверяющих расходились: для выбранного сценария [color-05] взят вариант скептика по коду (accentSoft) — заливка ink / paper совпала бы с наведённой «Войти» (`apps/web/src/components/landing/landing.module.css:177-180`) и с правилом «инверсия означает переход»; для выделения текста [color-11] — вариант ревьюера правил: перевернуть умолчание в каждом модуле вместо перечня янтарных поверхностей. Роль `accentActive` не вводится: затемнение 90 % (#E96322) отличается от accent на 1.18:1 — для короткого нажатия мало, а темнее нельзя. При `prefers-reduced-motion` сжатия и сдвига стрелки нет, остаётся мгновенная смена заливки: действующий блок (`apps/web/src/components/landing/landing.module.css:1598-1606`) отключает только `animation` и `transition`, поэтому правила с `transform` объявляются под `no-preference` (раздел 4.3). Оговорка «Так будет устроена защита сайта. Попробуйте: нажмите „Отменить правку“ на карточке.» (новая формулировка задачи 2.6) остаётся вне макета карточки: на десктопе на месте, 14px/500, на телефоне объединяется с подписью под карточкой [color-09].

## 3.4 Площади и конкуренция акцента

| Снимок, 1440 / 390 | Кремовые | accentSoft | Тёмные | accent | marker |
|---|---|---|---|---|---|
| Вся страница | 61.8 / 64.1 % | 2.3 / 4.3 % | 18.0 / 14.8 % | 9.8 / 10.4 % | 6.9 / 4.0 % |
| Первый экран | 80.4 / 86.5 % | 0.2 / 0.1 % | 13.1 / 4.7 % | 2.6 / 3.5 % | 1.5 / 1.5 % |
| Блок безопасности | 19.1 / 25.6 % | 3.3 / 4.1 % | 2.3 / 3.4 % | 72.9 / 63.9 %; точным совпадением с #FF6B24 — 68.9 / 57.0 % | 1.7 / 1.5 % |
| Финальный блок (только 1440) | 0 % | 0 % | 3.7 % | 2.4 % | 93.0 % |

| Где акцент спорит сам с собой | Что происходит | Что делаем |
|---|---|---|
| Первый экран | три оранжевые заливки в одном кадре: «Начать с Радити» 215×56, выбранный сценарий «Цена» 65×44, «Применить правку» 449×52 — и оранжевая точка «Интерактивное демо»; самая широкая плашка — кнопка демо, а не регистрация (`apps/web/src/components/landing/site-demo.module.css:493-497`, `:427-430`, `apps/web/src/components/landing/landing.module.css:277-280`) | выбранный сценарий уходит на accentSoft [color-05]; оранжевыми остаются два действия |
| Блок безопасности | текст 11–17px на самом насыщенном цвете палитры; на телефоне секция 1106px при экране 844px, не меньше половины экрана остаётся оранжевой 702px прокрутки (`apps/web/src/components/landing/landing.module.css:593-596`) | поле не осветляем: смесь 50 % с marker (#FF9836) поднимает ink до 8.13:1, но выделение «Всё обратимо.» падает с 1.81 до 1.36:1; кегль и вес — [color-09], на телефоне оговорка объединяется с подписью под карточкой |
| Финальный блок | кнопка accent на поле marker — 1.81:1, границу держит контур accentText 1px (4.04:1), при наведении 1.67:1 (`apps/web/src/components/landing/landing.module.css:859-860`, `:888-897`) | свой hover без сдвига к янтарю [color-07]; контур 2px ink или тёмная кнопка — вопрос владельцу [color-06], см. 3.8 |

Правило площадей:

- По странице держим распределение, близкое к 60-30-10: кремовые 62–64 %, тёмные 15–18 %, accent около 10 %, marker 4–7 %; оранжевая полоса одна, цветные секции разделены нейтральными.
- Заливка accent — только действие или крупное цветовое поле. Состояние выбора — accentSoft, «изменено» и «результат» — marker, наведение на вторичное действие — нейтральное.
- В секции одна оранжевая кнопка, остальные действия — контур ink (как в тарифах); в первый экран новые заливки accent не добавляем.
- Текст на accent — не мельче 14px/500 (подпись «Вы» — 12px/500); accentText на marker — только крупный заголовок (4.04:1).

## 3.5 Состояния и «цвет не единственный носитель»

| Состояние | Сейчас | Что делаем | Что несёт смысл кроме цвета |
|---|---|---|---|
| Наведение на оранжевую заливку | сдвиг цвета неразличим, ΔE 2.6 | 65 % accent, ΔE 6.4 [color-07] | подъём CTA на 2px, сдвиг стрелки |
| Наведение на таче | `@media (hover: hover)` есть только в `apps/web/src/components/landing/site-demo.module.css:507`; в `apps/web/src/components/landing/landing.module.css:177`, `:287`, `:895` и `apps/web/src/components/landing/pricing.module.css:270` hover не обёрнут, поэтому касание, как правило, включает его: «Войти» и контурные тарифы инвертируются, оранжевые кнопки и кнопки демо не отвечают | отклик на касание даёт `:active` [color-08] | сжатие кнопки |
| Нажатие | правил `:active` нет | `transform: scale(0.98)` и заливка наведения, без затемнения [color-08] | форма |
| Выбранный сценарий | заливка accent, как у CTA; невыбранные — контур 1.46:1 | accentSoft, контур accentText, галочка [color-05]; невыбранные — контур `ruleStrong` [color-03]; наведение — контур ink [color-19] | `aria-pressed`, галочка, заливка среди контурных |
| «Было → станет» в демо | изменённые строки — marker, изменённая плашка акции — accent | янтарь во всех трёх сценариях [color-16] | подписи «До правки / Изменено / Возвращено», пунктирный контур становится сплошным, зачёркнутое «до» и стрелка, `aria-live` |
| Карточка сохранённой версии | цена и статус одного цвета до и после отмены | янтарная полоса под ценой, пока правка действует [color-17] | цифра, текст статуса с `role="status"`, подпись кнопки, направление жеста цены (поворот карточки после задачи 5.7 одинаков в обоих состояниях) |
| Выделение текста | невидимо на янтарных полях | инверсия marker на ink [color-11] | — |

Цветовая слепота (модель Machado, полная дихромазия): accent и marker не сливаются — ΔE 21.2 при протанопии и 14.6 при дейтеранопии (в норме 19.8), их разводит светлота; ink на accent — 4.74:1 и 7.01:1. Тёплые статусы различимы хуже: ok к graphite — ΔE 2.6–3.4, ok к error — 4.3 и 3.0 (в норме 8.1), поэтому подпись и значок у статуса обязательны. Строка статуса ok цветом не отличается от пояснений — вопрос владельцу [color-14].

## 3.6 Системная тёмная тема

Лендинг остаётся светлым, но только внутри `.page`: `color-scheme: light` задан на `.page` (`apps/web/src/components/landing/landing.module.css:11`), а корневой элемент при системной тёмной схеме и при cookie `theme=dark` получает `color-scheme: dark`, фон `body` — ink, `theme-color` не задан — в `apps/web/src` нет экспорта `viewport` (`apps/web/src/app/layout.tsx:13-18` — только `metadata`). Внутри страницы разницы нет (снимок тёмной схемы совпадает со светлым); эффект возможен за её пределами — полосы прокрутки окна, область оттяжки, панели мобильного браузера — и на устройствах не проверялся [color-12]. Правка из двух частей: экспорт в `apps/web/src/app/(about)/page.tsx` и правила в `apps/web/src/components/landing/landing.module.css` рядом с `:1608-1612`, вне медиазапроса.

```ts
import type { Metadata, Viewport } from 'next'
import { brandColors } from '@repo/ui/theme/tokens'

export const viewport: Viewport = { themeColor: brandColors.paper }
```

```css
:global(html):has(.page) {
  color-scheme: light;
  background: var(--raditi-paper);
}
:global(body):has(.page) {
  background: var(--raditi-paper);
}
```

`themeColor` — только импортом `brandColors.paper`, без литерала. Правила стоят вне слоя `mui` и перекрывают CssBaseline; они остаются в модуле лендинга, поэтому формы и приложение сохраняют свои темы. Перед правкой свериться с `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/generate-viewport.md` (`apps/web/AGENTS.md`). Проверка — iOS Safari и Chrome для Android в тёмной системной теме, до и после; отдельно — нижняя оттяжка под тёмным подвалом.

Шапка вошедшего пользователя [color-13] оценена по коду: `.page` переопределяет `--raditi-*` и `color-scheme`, но не `--mui-palette-*`, поэтому при тёмной схеме аватар (`apps/web/src/components/application/user-avatar.tsx:49-50`) становится accentLight (к бумаге 1.61:1), фон наведения кнопки аватара невидим (1.00:1), а меню открывается тёмным в портале вне `.page`. Сначала снять шапку вошедшего пользователя в тёмной схеме и убедиться в дефекте. Затем правка в модуле лендинга, только токенами: `.headerIdentity > button:hover { background: var(--paper-2); box-shadow: inset 0 0 0 1px var(--ink) }` и `.headerIdentity :global(.MuiAvatar-root) { background: var(--raditi-accent-text); color: var(--raditi-white) }` (6.37:1). Меню остаётся в теме пользователя; перевод темы на селектор по атрибуту в план не входит.

## 3.7 Принципы и референсы

| Принцип | Источник | Применение к Радити |
|---|---|---|
| OKLCH даёт воспринимаемую светлоту: ступени получают изменением L и C при одном тоне | [Evil Martians — OKLCH in CSS](https://evilmartians.com/chronicles/oklch-in-css-why-quit-rgb-hsl) | таблица 3.1 ведётся в OKLCH; новая роль лежит на линии нейтральных: `ruleStrong` — 62° между rule 71° и graphite 57° |
| Текст — не ниже 4.5:1; крупный (примерно 24px или 18.5px жирный) — 3:1 | [W3C — SC 1.4.3](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) | [color-01]; знак «₽» 20px/400 — не крупный текст [color-17]; accentText на marker — только заголовок |
| Компоненты интерфейса — 3:1 к соседним цветам; граница не обязательна, если элемент опознаётся по видимому содержимому | [W3C — SC 1.4.11](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html) | оранжевые кнопки на бумаге (2.69:1) допустимы; контуры сценариев и отмены — вопрос понятности, решается `ruleStrong` и onInk [color-02], [color-03] |
| APCA учитывает полярность; Lc 75 — минимум для основного текста, 60 — для прочего содержательного, 45 — для крупного | [APCA in a Nutshell](https://github.com/Myndex/SAPC-APCA/blob/master/documentation/APCA_in_a_Nutshell.md), [Bronze Simple Mode](https://readtech.org/ARC/tests/bronze-simple-mode/), [apcacontrast.com](https://www.apcacontrast.com/) | ориентир, не норматив: ink на accent — Lc 49, поэтому мелкий текст на accent укрупняем и утяжеляем [color-09] |
| Акцент — для того, что должно выделяться сильнее всего; доли 60 / 30 / 10 | [NN/g — Using Color to Enhance Your Design](https://www.nngroup.com/articles/color-enhance-design/) | правило площадей 3.4; состояние выбора не красим цветом действия [color-05] |
| «Перевёрнутый контраст»: светлая плашка с тёмным текстом того же тона не перетягивает внимание | [конспект книги Refactoring UI](https://www.sglavoie.com/posts/book-summary-refactoring-ui/) (конспект, не сама книга) | выбранный сценарий и рекомендованный тариф — accentSoft с тёмным текстом |
| Производные состояния выводятся из базового цвета; `color-mix()` доступен во всех браузерах с мая 2023 (Chrome 111, Firefox 113, Safari 16.2) | [MDN — color-mix()](https://developer.mozilla.org/en-US/docs/Web/CSS/color_value/color-mix), [caniuse: color-mix](https://caniuse.com/mdn-css_types_color_color-mix), [caniuse: relative colors](https://caniuse.com/css-relative-colors) | `ruleStrong` и `accentHover` — `color-mix` в `brandColorRoles`; относительные цвета (Chrome 131, Firefox 133, Safari 18) не используем: полная поддержка 87 % против 94 % у `color-mix` |
| Цвет — не единственный носитель смысла; красно-зелёные нарушения — у 8 % мужчин и 0.5 % женщин, коричневые, оранжевые и красные легко путаются | [W3C — SC 1.4.1](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html), [Colour Blind Awareness](https://www.colourblindawareness.org/colour-blindness/types-of-colour-blindness/) | тёплые статусы — всегда с подписью и значком; состояния демо — подписью и контуром; проверка в [Chrome DevTools](https://developer.chrome.com/docs/devtools/rendering/apply-effects), режим Deuteranopia |
| `color-scheme` задаёт холст, полосы прокрутки и элементы форм; `theme-color` — цвет интерфейса браузера вокруг страницы; в Next.js это `themeColor` в `viewport` | [MDN — color-scheme](https://developer.mozilla.org/en-US/docs/Web/CSS/color-scheme), [MDN — theme-color](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/meta/name/theme-color), [Next.js — generateViewport](https://nextjs.org/docs/app/api-reference/functions/generate-viewport) | правка 3.6 [color-12]; `color-scheme: only light` — запасной вариант, если на Android проявится автозатемнение Chrome |

| Бренд | Ссылка | Что заимствуем | Чего избегаем |
|---|---|---|---|
| Anthropic | https://www.anthropic.com | тёплые нейтральные на всю шкалу (ivory #FAF9F5, #F0EEE6, #E8E6DC, oat #E3DACC) и тёплый тёмный #141413 вместо чёрного — у Радити так же, от paper до ink; состояние акцента — именованный токен (по проверке, `--color-clay-hover` #C6613F в CSS claude.com), у Радити это роль `accentHover` | приглушённый акцент clay #D97757: у Радити директива на яркую пару |
| Headspace | https://www.headspace.com | тёплый почти белый фон #F9F4F2 вместо чистого белого — у Радити это paper | отдельный холодный цвет действия (кнопка «Try for free» — #0061EF, оранжевых hex на главной нет): действие остаётся в тёплой семье |
| Mailchimp | https://mailchimp.com/design/ (переадресует на страницу brand-assets) | крупное яркое поле под тёмный текст («Cavendish Yellow is Mailchimp's hero color. We use Peppercorn for accents») — финальный блок ink на marker, 11.06:1; тёплая тень rgba(35,30,21,.15) — у Радити тени от ink | жёлтый или янтарный как цвет действия и мелкого текста |
| Яндекс Бизнес | https://business.yandex.ru | один акцент на ссылки и наведение (#6A67F8, `--link-hover-color`) при тёмном основном тексте #323555 — у Радити мелкий акцентный текст только accentText | холодную фиолетово-синюю гамму |
| Банк Точка (публикация Sostav) | https://www.sostav.ru/publication/tochka-rebrending-56489.html | метод: один цвет-настроение и семья «сложных смешанных цветов» вместо набора разных тонов — выразительность внутри оранжевый → янтарь → шоколад | саму палитру: она фиолетовая |
| Авито (публикация Sostav) | https://www.sostav.ru/publication/avito-56824.html | предупреждение: «„Ламповый“ бежевый цвет исключен из палитры» ради технологичности — крем держим светлым (paper, L 98 %) и рядом с ярким акцентом | многоцветную маркировку разделов и чисто белую основу |
| Tailwind CSS, палитра по умолчанию | https://tailwindcss.com/docs/colors | линейка для сверки: orange-500 oklch(70.5% 0.213 47.6) и amber-400 oklch(82.8% 0.189 84.4) почти совпадают с accent и marker | значения как есть: orange желтее accent (47.6° против 42.2°), stone почти серый (хрома 0.001–0.006) — кремовость пропадёт |

В таблицу не вошли три референса исследования: дизайн-система Dodo (страница не открылась), Т-Банк и Самокат (страницы не подтвердили вывод). Hinge проверен и исключён: палитра холодная.

## 3.8 Спорное

| id | Суть | Возражение | Что нужно для решения |
|---|---|---|---|
| [color-06] | Финальная кнопка: accent на marker — 1.81:1, держится на контуре 1px; предложена тёмная кнопка ink с подписью paper (к полю 11.06:1) | ревьюер правил: противоречит `apps/web/DESIGN.md:201` («Финальный CTA сохраняет эту роль на янтарном поле») и `:129`; соседство accent и marker — цветовая директива; WCAG 1.4.11 выполняется | ответ владельца: оставить accent и дать контур 2px ink (11.06:1 к полю) с записью исключения в DESIGN.md либо сменить роль на ink; до ответа в плане только собственное наведение без сдвига к янтарю (задача 4.4) |
| [color-14] | Статус ok (#79573B) в ΔE 3.4 от graphite: строка «Новая цена на сайте. Снимок сохранён.» не отличается от пояснений (`packages/ui/src/theme/tokens.ts:14`, `apps/web/src/components/landing/landing.module.css:748`); предложен зелёный #3F704B | ревьюер правил: нарушает `apps/web/DESIGN.md:135` («статусы остаются тёплыми») и возвращает цвет исторического прототипа; правка обеих тем ради строки 12px и двух точек 6px | ответ владельца: ok не менять, усилить формой — строка статуса ink, вес 500, галочка крупнее и цветом accentText, точки-метки одной роли — по умолчанию; либо зелёный статус с правкой DESIGN.md и PRODUCT.md |
| [color-20] | Реплика клиента в шаге 2 — оранжевая плашка (`apps/web/src/components/landing/landing.module.css:498-507`), в чате демо — ruleInk; «Применить» в шаге 3 — тёмная пилюля, в демо — оранжевая кнопка | ревьюер правил: плашка — единственное яркое пятно секции и читается как сообщение, а не как кнопка (скептик по коду это подтвердил); посетитель расхождения не заметит | ответ владельца: плашку оставить, записать в DESIGN.md, что иллюстрации шагов — декоративные цветовые поля, поправить только подпись «Вы» [color-09] — по умолчанию; либо реплика на ruleInk, а пилюля шага 3 — accent |

## 3.9 Отклонено

- [color-10] `onAccentMuted` равен `onAccent` — оба проверяющих отклонили: правило уже записано (`apps/web/DESIGN.md:121`, `:133`), для посетителя ничего не меняется. Роль не удаляем, значение не меняем; достаточно однострочного комментария у `packages/ui/src/theme/tokens.ts:77` попутно с [color-09].
