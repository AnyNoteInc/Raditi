# Проверка спайка 4: скрипты

Независимые проверки к разделу «Проверка» в `../README.md`. Они идут другим путём, чем стенд: свой `dom.mjs`, своя каноническая форма (`canon.mjs`), текст и HTML читателя — из настоящих `DocumentMarkdown` и `rehypeDocumentRules` репозитория, а не из `hast-util-to-text`.

## Как запустить

Внутри репозитория pnpm ставить нельзя, поэтому всё идёт в каталоге запуска `<scratch>`:

```bash
cp -R harness <scratch>/harness && cp -R verify <scratch>/harness/verify
cd <scratch>/harness && pnpm install && pnpm add zod@4.6.5 @tiptap/extension-code@3.34.0
node run.mjs                                  # results/*.json — нужны nbsp-only.mjs
sh verify/setup.sh <корень репозитория>       # копии doc-render и domain, ссылка @repo/domain, каталог s212
cd verify && node doc-render-real.mjs         # и так же остальные *.mjs
cd s212 && pnpm install && node check-212.mjs ../canon-212.json && cd .. && node compare-212.mjs canon-212.json
```

`verify/` должен лежать внутри `harness/`: тогда у стенда и у проверок одна копия `@tiptap/core`.

## Что какой скрипт проверяет

| Скрипт | Что |
| --- | --- |
| `doc-render-real.mjs` | `<br>`, сноски и выравнивание в настоящем `DocumentMarkdown` |
| `tiptap-defects.mjs` | 18 ошибок `@tiptap/markdown` из отчёта: редактор с Markdown в начальном содержимом, а не `setContent` |
| `image-crash.mjs`, `image-crash-uid.mjs` | Откуда сбой картинки в строке: блочная `Image`, `UniqueID`, `check()` |
| `corpus-tiptap.mjs` | Корпус через `@tiptap/markdown`: новый редактор на документ, неразрывные пробелы в строках таблиц и вне их |
| `nbsp-only.mjs` | В скольких документах с другими видимыми словами меняются только неразрывные пробелы |
| `new-constructs.mjs`, `new-run.mjs` | 52 новые конструкции через оба моста: круг, второй круг, `check()`, текст читателя до и после канона |
| `edits-wide.mjs` | Замена и выделение жирным последнего слова в каждом текстовом блоке корпуса транзакцией ProseMirror |
| `quotes-lines.mjs` | Цитаты агента целыми строками, текст читателя — из doc-render, строки таблиц тоже |
| `canon-visible.mjs` | Что канон моста меняет в тексте читателя (сырой текст → канон) |
| `bridge-schema.mjs`, `bridge-code-fix.mjs` | `check()` документов моста и метка `code` без `excludes` |
| `planted-bug.mjs` | Положительный контроль: посаженная в копию моста ошибка Tiptap и то, какие сравнения её видят |
| `section-levels.mjs`, `setext-section.mjs` | Правило уровней заголовков раздела (`sectionMarkdownProblem`) против канона и подчёркнутых заголовков |
| `uid-element.mjs` | Id `UniqueID` без элемента и с `element: null` |
| `editor-made.mjs` | Формы, которые оставляет человек: буквенная нумерация, жирное у цифры, пустые абзацы, `<u>`, `<br>` |
| `s212/check-212.mjs`, `compare-212.mjs` | Канон моста на `mdast-util-to-markdown` 2.1.2 из lockfile репозитория против 2.2.3 |
