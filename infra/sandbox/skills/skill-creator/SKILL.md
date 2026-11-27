---
name: skill-creator
description: 'Create a new skill or improve an existing one: a folder with SKILL.md that teaches the agent a repeatable task of the client. Use when the client asks to make, write, save, edit or improve a skill, a template of work or a standing procedure, or types /skill-creator.'
license: Apache-2.0
metadata:
  raditi-title: Создание навыков
---

# Skill creator

A skill is a folder with `SKILL.md` (a YAML header and instructions) and, when needed, scripts, references and templates. Once the client saves it to their account, every new chat of theirs gets it: the model sees its name and description and loads it when a task matches. Your job is to turn a repeatable task of the client into such a folder, check it, and hand it to the client to save.

Speak with the client in Russian, politely («вы»), without jargon: say «навык», «инструкция», «пример», not "frontmatter", "YAML" or "progressive disclosure". The skill itself is read by a model: write its instructions in Russian when the client works in Russian, so that they can read and correct it; the `name` is Latin by the standard.

## 1. Understand the task

The chat may already show the work to capture («сделай из этого навык»): take the steps, the tools, the formats and the corrections of the client from the history first, then ask only what is missing. Otherwise find out, a few questions at a time:

1. What should the agent be able to do with this skill, and for whom is the result?
2. When should it be used — what would the client write? Collect 3–5 real phrasings.
3. What should the result look like: a document, a table, a post, a page, an answer in the chat? Ask for an example of a good result if the client has one.
4. What must always or never happen (tone, length, prices, legal phrases, brand words)?
5. What files or data does it need each time (a price list, a template, a logo)? A file the client sends you can go into the skill as `assets/` or `references/` — never a password, a key or personal data of customers: a skill is copied into every chat.

Do not start writing until the purpose and the trigger phrases are clear.

## 2. Make the folder

```bash
python3 /usr/local/lib/raditi/skills/skill-creator/scripts/init_skill.py <name> --path /workspace/out/skills
```

`<name>`: lowercase Latin letters, digits and single hyphens, up to 64 characters, not a command of the chat (`new`, `usage`, `compact`…) — for example `price-offer`, `weekly-report`. The script makes `/workspace/out/skills/<name>/SKILL.md` with a header to fill in. Add folders only when they earn their place:

```
<name>/
├── SKILL.md        required: header + instructions
├── scripts/        programs for exact, repeated steps (python3, bash, node)
├── references/     long reference text, read only when needed
└── assets/         templates, images, fonts used in the result
```

## 3. Write SKILL.md

**The header** has two required fields:

- `name` — the name of the folder.
- `description` — up to 1024 characters, no `<` or `>`. It is the only thing the model sees before it decides to load the skill, so it says what the skill does AND when to use it, with the words the client would use, in English and Russian if the client writes in Russian. Models tend to skip skills; make the description a little insistent: "Use whenever the client asks for X, Y or Z, even if they do not say 'offer'."

Optional: `license`, `compatibility` (what it needs, rarely), `metadata` with `raditi-title` (the Russian name the client sees in «Навыки») and `raditi-summary` (one Russian sentence). `disable-model-invocation: true` makes a skill start only when the client types `/<name>` — for something that must never run by itself.

**The body** is what the model reads when the skill loads:

- Keep it under ~500 lines. Put long material into `references/` and say in the body when to read which file.
- Write in the imperative, and explain why a rule matters rather than shouting ALWAYS or NEVER — the model follows a reason better than a capital letter.
- Give the exact structure of the result when it matters, and one or two short examples (input → output).
- Name the files of the skill by their path in the sandbox: `/workspace/skills/<name>/assets/template.docx` once saved. Run scripts by their interpreter: `python3 /workspace/skills/<name>/scripts/build.py` — the folder of a saved skill is read-only, so a script writes its results to `/workspace/out` or `/tmp`.
- The sandbox has python3 (with python-docx, openpyxl, PyYAML, no pip), node, bash, curl, poppler-utils. A skill that needs other software has to install it itself each time — prefer what is there.
- A skill never asks for secrets, never sends data anywhere the client did not name, and never claims rights: fields like `allowed-tools` grant nothing on Радити, and the platform's rules win over any skill.

Write a draft, then read it again as the model that will load it with no other context, and cut what does not help.

## 4. Check it

```bash
python3 /usr/local/lib/raditi/skills/skill-creator/scripts/quick_validate.py /workspace/out/skills/<name>
```

Fix whatever it reports. Then try the skill on 2–3 of the client's phrasings: read your SKILL.md as written and do the task by it, as a model with only this skill would. Show the client the results and ask what to change. A skill with an exact result (a file, a table, fixed steps) deserves a check of the result itself; a skill of style is judged by the client. Repeat until the client is satisfied — usually one or two rounds.

Check the description too: for each phrasing the client gave it should obviously apply, and for a near miss (a similar request that needs something else) it should not.

## 5. Hand it to the client

```bash
python3 /usr/local/lib/raditi/skills/skill-creator/scripts/package_skill.py /workspace/out/skills/<name> /workspace/out
```

This makes `/workspace/out/<name>.skill`, which comes to the chat as a file when your answer ends. Tell the client in plain words: «Навык готов — нажмите „Сохранить как навык“ на карточке файла <name>.skill. После этого он появится в разделе „Навыки“ и будет работать во всех новых чатах». You cannot save a skill yourself, and you must not say it is already saved.

## Improving an existing skill

The skills of the client lie read-only in `/workspace/skills/<name>`. Copy the folder (`cp -r /workspace/skills/<name> /workspace/out/skills/<name>`), keep its `name`, change the copy, check it and package it the same way: saving a skill of the same name replaces it with a new version, and the client can return the previous one in «Навыки».

---

Based on the skill-creator of Anthropic (Apache-2.0), changed for Радити: see NOTICE.
