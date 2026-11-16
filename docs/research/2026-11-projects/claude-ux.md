# How projects work in Claude, ChatGPT, Perplexity and Gemini: what Raditi should copy

Scope: this is web research only. No files were edited in any repo. Web pages are cited by URL. Raditi code is cited by file:line, read on `origin/main` or in the worktree named.

## 0. Three products are called "projects" at Anthropic. The owner's screenshots show the third.

| Product | What a "project" is | Where |
|---|---|---|
| **claude.ai chat projects** (the earlier version) | A folder of chats with shared knowledge files and instructions. The Projects page has three tabs: "Your projects", "Organization" and "Shared with you". | https://support.claude.com/en/articles/9519177-how-can-i-create-and-manage-projects |
| **Claude Code projects** (redesign, beta since 17.09.2026, Pro/Max/Ultra) | One coordinator conversation plus parallel cloud "threads". Settings are General / Memory / Environment / Plugins / Usage. There is a Library and a Scheduled tasks view. | https://code.claude.com/docs/en/claude-projects.md, https://claude.com/blog/projects-redesigned |
| **Cowork projects** (desktop; "Claude Cowork is now just Claude", with "Chat and Cowork unified") | A project holds a description, folders, instructions, links, linked chat projects and its own memory. You start a **session** inside the project. The right column has **Instructions (Add), Context (Add), Memory (View), Scheduled (Add)**. | https://claude.com/docs/cowork/guide/projects.md, https://support.claude.com/en/articles/14116274-organize-your-tasks-with-projects-in-claude-cowork, https://christopheralarcon.com/blog/how-to-use-claude-projects (caption of the right column), https://github.com/anthropics/claude-code/issues/79705 ("right sidebar shows Instructions / Memory / Context … 'Scheduled' section … with a '+' to add more") |

The owner's strings are «Новая сессия в проекте», «Инструкции / Контекст / Память / Запланировано», «Использовать память аккаунта» and «Новая запланированная задача». They match the third product: the unified Claude desktop app in Russian. Where that product is thin (memory as files, repositories, CI, deleting a project), the Claude Code projects beta is the closest documented model.

## 1. Facts: Claude

### 1.1 Availability and limits
- claude.ai projects are open to every plan, including Free. Free users can create at most **5 projects** (9519177; https://support.claude.com/en/articles/9517075-what-are-projects).
- Files in a project's knowledge:
  - **30 MB per file**;
  - "Unlimited [number of files], but total content must fit within Claude's context window";
  - "Text extraction only (except for multimodal PDFs)".
  - Source: https://support.claude.com/en/articles/8241126-upload-files-to-claude.md
- Files in a chat:
  - 500 MB per file and up to 20 files per chat;
  - images up to 8000×8000;
  - PDFs up to 1000 pages; text and visuals are read for PDFs of up to 100 pages, text only above that.
- Supported types:
  - documents: PDF, DOCX, CSV, TXT, HTML, ODT, RTF, EPUB, JSON and XLSX (XLSX needs code execution turned on);
  - images: JPEG, PNG, GIF and WebP (same article).
- RAG (paid plans only):
  - it turns on automatically when knowledge "approaches or exceeds the context window limit", and gives up to 10× more capacity;
  - Claude then uses a "project knowledge search tool", and the project shows "a visual indicator showing that your project is RAG-enabled";
  - the user cannot force it; it switches back when the knowledge shrinks.
  - Source: https://support.claude.com/en/articles/11473015
- Capacity bar: third-party guides say the knowledge panel shows the share of capacity used (one text file is about 1%). No Anthropic source confirms the exact wording (https://www.ai-toolbox.co/claude-management-and-productivity/how-to-use-claude-projects-guide-2026, https://fast.io/resources/claude-ai-projects-guide/).
- Claude Code projects have different limits:
  - uploads up to 1,000 files and 2 GB at a time, one file up to 480 MB;
  - at most 10 folders or Drive folders per project;
  - uploads are copies, and you re-upload with **Replace** to update one;
  - instructions are "up to 16,000 characters" (claude-projects.md).

### 1.2 Projects list and empty state
- The entry point is "Projects" in the sidebar or claude.ai/projects, then **"+ New Project"** in the upper right (9519177).
- Sorting: one third-party source lists Activity and Name. A bug report on the desktop app lists **Recent, Created, Alphabetical**. Another bug report says "Last updated" tracks only changes to the configuration (name, description, instructions, files), not chat activity (https://claudeissues.com/issue/59282-…, https://claudeissues.com/issue/84332-…).
- There is a search field. A miss shows "No projects match your search" (https://claudeissues.com/issue/48997-…).
- Each card shows the name, a short description and the last-updated date (ai-toolbox guide).
- Empty state: the owner's screenshot gives «Хотите создать проект?», «Загружайте материалы, задавайте собственные инструкции и организуйте сессии в одном пространстве.» and «Новый проект». No web source quotes it, so the screenshot is the reference.

### 1.3 Creating a project
- **claude.ai:** "Enter a name and description. **Claude does not have access to these details.**" On Team and Enterprise you also pick the visibility: private, or shared with the organisation (9519177).
- **Cowork:** "+" offers three starts:
  - "Start from scratch";
  - "Import from project", with the field "Search projects in Chat…" that copies a chat project's files and instructions;
  - "Use an existing folder on your computer".
  - You then set the name, description, folders and instructions. The description is read by Dispatch when it picks a project for a task (cowork/guide/projects.md; 14116274).
- **Claude Code** "New project" dialog:
  - **Name**;
  - **"What do you want to work on?" (optional)**, a one-line goal. "Claude in the conversation works toward it";
  - **Context (optional)**: repositories, files, folders and Drive folders, each added with **+**;
  - **Create project**.
  - Instructions are set only after the project exists.
  - On the first project Claude takes a turn of its own: an exploration thread and **Setup recommendations**, with **Update setup** to accept them (claude-projects.md).
- Owner's modal: «Создание проекта» with the fields «Над чем вы работаете?» (name), «Чего вы хотите достичь?» (goal) and «Контекст необязательно» with «Добавить контекст». This is the Code-style dialog (name, goal, context) on top of the Cowork project page.

### 1.4 Project page
- The project page has a composer at the top with the placeholder «Новая сессия в проекте X» (owner's screenshot) and the project's sessions or chats below it.
- The settings column on the right has four rows, **Instructions → Add**, **Context → Add**, **Memory → View** and **Scheduled → Add** (Alarcon caption; GitHub issue 79705).
- claude.ai: "Select a project in the sidebar to start a new … session with that project's folders mounted and instructions applied" (Cowork guide). The knowledge base sits on the right of the project page (9519177 search snippet).
- Gemini Notebooks use the same pattern: chats "appear under the prompt box" (https://blog.google/innovation-and-ai/products/gemini-app/notebooks-gemini-notebooklm/).

### 1.5 Instructions
- claude.ai: **"Set project instructions"**. They apply to every chat in the project. "Context is not shared across chats within a project unless the information is added into the project knowledge base" (9519177).
- Claude Code: "Text sent to each new thread and to Claude in the project conversation, up to 16,000 characters". They are set in **Project settings > Memory > Project instructions**, or by asking Claude.
  - Changes reach new threads, not ones already running.
  - A text field shows **Save changes** and **Discard** while it is being edited.
  - A suggested brief covers: what the project is for, where the work happens, how a thread checks its own work, what to do when something is missing, and what needs your go-ahead.
- ChatGPT: project instructions "override your global custom instructions" inside the project (https://elephas.app/resources/how-to-use-chatgpt-projects).

### 1.6 Context: the add menu, text, GitHub, Google Drive
- **Menu.** The "+" in project knowledge offers upload, text content, GitHub and Google Drive (9519177; https://claude.com/docs/connectors/github.md; https://claude.com/docs/connectors/google/drive.md). The owner's strings are «Загрузить с устройства», «Добавить текстовое содержимое» and «GitHub». A third-party guide gives "Add Content → Upload from device" (https://freshvanroot.com/blog/how-to-use-claude-projects/). My recollection is that the text-content dialog has a title field and a content field; no source fetched in this run confirms it.
- **GitHub in a claude.ai project**, all from https://claude.com/docs/connectors/github.md:
  - Path: "+" → **GitHub** → search your repositories or paste a URL → choose files and folders in a file browser → **Add files**.
  - **Private projects only.** In a shared project the option is dimmed with "Only accessible from private projects".
  - If GitHub is not connected, choosing it sends you to GitHub to sign in. Private repositories need the Claude GitHub App. Without access the dialog says "Claude cannot access that resource. If you know that it exists, you may first need to grant or request access here."
  - **Read only.** "Claude reads file names and contents only": file names, file contents and branch content. Commit history, pull requests, issues and metadata are not retrieved.
  - **Manual "Sync now"** refreshes the selected files. To change the selection, pick files again and press **Update**.
  - Several repositories are allowed "as long as the selected content fits within Claude's context window".
  - If access is lost, the preview is removed and the chat history stays.
  - For editing, running commands and opening PRs, the page points to Claude Code.
  - There is no automatic sync on push (https://claudeissues.com/issue/10647-…).
- **GitHub in Claude Code projects:**
  - Requires github.com with push access and the Claude GitHub App installed. GitHub Enterprise Server, **GitLab** and Bitbucket are not supported.
  - Every thread clones the project's repositories, works on its own branch from the default branch and opens a PR when asked or on its own for a concrete fix.
  - It then "watches the pull request with auto-fix", pushing fixes "when CI fails" and answering review comments.
  - The repository's CLAUDE.md is loaded, but its skills, .mcp.json and settings.json are not.
  - The Overview pane groups threads as "Ready for review", "Waiting on you", "Working", "Landing", "Idle" and "Resolved".
  - Source: claude-projects.md
- **Google Drive:**
  - Private projects only, with the same "Only accessible from private projects" message.
  - Docs are converted to Markdown, Sheets to CSV and Slides to plain text. Exports are capped at about 10 MB.
  - "Its content refreshes from Drive periodically when you open the project."
  - Source: drive.md

### 1.7 Memory
- claude.ai and Cowork:
  - "Each project has its own memory." In a project Claude uses that memory plus the account's memory from chats outside projects, but not other projects' memory.
  - **"To keep a project's memory fully separate, turn off 'Use account memory' under Memory on the project's page."**
  - Memory is saved "as individual topics while you chat, not as summaries after conversations end". The older mode, still used by some organisations, was a summary updated every 24 hours.
  - Memory is on by default on Free, Pro, Max and Ultra.
  - Memory can be skipped for one chat with "Memory" in the "+" menu before the first message; this cannot be changed later.
  - Memory is viewed and edited in Settings > Your Claude → Manage.
  - Sensitive topics are not stored by default. ID numbers and similar data are never stored.
  - "Deleting a conversation doesn't delete memory entries created from it."
  - Incognito chats are never saved to memory.
  - Sources: https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context.md; 14116274
- Empty state (owner's screenshot): «Память пока пуста. Память проека появится здесь после нескольких сессий» and the toggle «Использовать память аккаунта». A third-party guide says the memory panel starts empty and fills after a few chats.
- **Claude Code projects** keep memory as **files**:
  - "Notes Claude keeps about the project, such as requirements, decisions, and pitfalls, stored as files. Every cloud thread reads the index file `MEMORY.md` when it starts and opens the other files when it needs them."
  - The user asks Claude to remember or forget something. Files are read, edited and deleted in **Project settings > Memory** under **Auto memory**.
  - Claude saves the user's preferences about how to run the work to memory on its own.
  - Memory is separate from a repository's CLAUDE.md.
  - Source: claude-projects.md
- ChatGPT memory modes:
  - **Default memory**: project chats and other chats can refer to each other.
  - **Project-only memory**: only chats in this project.
  - The mode is chosen when the project is created, under "More options".
  - **Sharing a project switches it to project-only memory for good.**
  - Source: elephas; https://www.unite.ai/how-to-use-chatgpts-project-memory/

### 1.8 Scheduled tasks
- **Claude Desktop, local task**:
  - Dialog **"New scheduled task"** with **Name**, then the instruction box. The box's toolbar holds the **permission mode** and the **model**.
  - **Trigger** card. **Advanced settings → General → "Only on this computer"** and **Local folder**.
  - Frequencies: **Hourly, Daily, Weekdays, Weekly**, and in the edit form also **Manual** and **Custom** (cron, not more often than hourly, local time).
  - Detail page: **Run now**, **Status Active/Paused**, **Edit**, **History** (with skipped runs and why), **Always allowed**, **Delete**. Deleting archives the task's sessions.
  - Missed runs: one catch-up run within 7 days.
  - Each run is a new session.
  - The prompt is stored as `SKILL.md`.
  - A task can also be created in conversation, e.g. "set up a daily code review … at 9am".
  - Source: https://code.claude.com/docs/en/desktop-scheduled-tasks.md
- **Cloud task**:
  - Name and prompt; a **Trigger** row with **Schedule / GitHub event / API**, several allowed.
  - **Advanced settings**: repository, cloud environment, connectors.
  - Runs start in **auto mode** (this is the «Авто» on the owner's screenshot).
  - A preset time "on the hour" may start several minutes late.
  - Account limit: 100 runs per hour.
  - "The fired prompt is … not live user input and can't act as approval or consent".
  - A task "created from a project appear[s] in its **Scheduled tasks** view". In a project, a run "can continue a thread rather than start a new session".
  - Source: https://code.claude.com/docs/en/routines.md
- **Cowork**:
  - **Create with Claude**, or **Set up manually** → **Create scheduled task** with Task name, Prompt, Approval mode, Frequency, Model (optional) and Working folder (optional).
  - Frequencies: hourly, daily, weekly, on weekdays and manual.
  - Each run is its own session.
  - Source: https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork.md
- **Pause, archive and delete a project** (Claude Code):
  - Pause stops threads and scheduled tasks.
  - Archive hides the project and archives its threads; scheduled tasks don't run.
  - **Delete** "permanently removes the project along with its threads, its memory, and its files, and turns off the project's scheduled tasks … Branches and pull requests … aren't affected."

### 1.9 Private and shared projects
- claude.ai, Team and Enterprise only:
  - "Share project" with **Can view** (see the project and chat in it) or **Can edit** (change instructions and knowledge, manage members).
  - "Keep it private: Only you and members you invite can view or use this project."
  - GitHub and Drive work only in private projects.
  - Sources: 9519177; 9517075
- Claude Code projects belong to one user and cannot be shared.
- Cowork projects can be shared on Team and Enterprise (14116274).

### 1.10 Moving chats, stars, archive, delete
- **Move a chat (claude.ai):** the dropdown next to the chat name → **"Add to project"** → the "Move chat" dialog. The same dropdown removes the chat from a project or moves it to another one (9519177).
- In Claude Code projects threads cannot be moved in, out or between projects, and projects cannot be merged (claude-projects.md).
- **Star:** from the ⋯ menu on the list or the star in the project's upper right corner. Starred projects appear in the left side panel.
- **Archive:**
  - Archived projects move to the bottom of the list, and their chats stay available.
  - Sharing and knowledge are kept.
  - "Archived projects can't be deleted" until they are unarchived.
  - Unarchive from the archived tab or the ⋯ menu.
- **Delete:** ⋯ → "Delete" → **"Yes, delete"** (9519177). What happens to the chats in the consumer UI was not found. The Compliance API refuses to delete a project while chats are attached (https://platform.claude.com/docs/en/api/compliance/apps/projects/delete.md).
- Chat header with a project breadcrumb: not confirmed by any source.

## 2. ChatGPT Projects (help.openai.com returned 403; secondary sources)
- **Create:** "New project" with a name, an icon and colour shown in the sidebar, and the memory choice under "More options" (elephas; https://www.slashgear.com/1968178/…).
- **Instructions:** "Add instructions". They override the global custom instructions.
- **Files per project:**
  - Free 5, Go and Plus 25 (older sources say 20), Pro, Business, Enterprise and Edu 40;
  - up to 10 files per upload;
  - 25 GB per user;
  - about 80 uploads per 3 hours.
  - Source: elephas; https://help-lb.openai.com/en/articles/8555545-file-uploads-faq
- **Move chats:** drag a chat onto the project, or its menu → **"Move to project"**. Temporary chats and custom-GPT chats cannot be moved.
- **Layout:** there were **Chats** and **Sources** tabs. A 2026 redesign opens new projects straight into a chat, and project chats now sit under the project in the sidebar (https://community.openai.com/t/…/1381208, …/1381332). A Library tab holds every uploaded file.
- **Sharing:** view/chat or edit access, by invitation or by link. Collaborator limits are 5, 10 and 100 by plan. Sharing makes memory project-only permanently.
- **Delete:** removes the instructions, chats and files, with no restore (https://www.guideflow.com/tutorial/how-to-delete-a-project-in-chatgpt).

## 3. Perplexity Spaces, Gemini Gems and Notebooks, in brief
- **Perplexity Spaces:**
  - instructions for every thread in the Space;
  - files (PDF, DOCX, XLSX, PPTX, CSV, MD, audio and video) and links;
  - search limited to Files, Links or Web + Files + Links;
  - collaborators as viewers or participants;
  - an October 2026 guide says "Projects" replace Spaces, with tasks and connected tools (unconfirmed).
  - Sources: https://intercom.help/perplexity-ai/en/articles/10352961-what-are-spaces; https://getcoai.com/news/perplexity-now-lets-you-search-files-and-web-in-one-tool
- **Gemini Gems:**
  - name, instructions and up to 10 knowledge files of 100 MB each (secondary sources);
  - Drive files are always read in their latest version;
  - shared like Drive files.
  - **Gemini Notebooks** (08.04.2026): sections in the side panel, chats "appear under the prompt box", sources synced with NotebookLM.
  - Sources: https://fast.io/resources/gemini-gems-file-limit/; https://9to5google.com/2026/04/08/gemini-app-notebooks/

## 4. Raditi today
- The rail on `main` still has `{ href: '/projects', label: 'Проекты', icon: 'projects' }` at `apps/web/src/components/application/application-rail.tsx:19`. So does the `raditi-noprojects` worktree, at the same line, and `apps/web/src/app/robots.ts:22` lists `/projects` too.
- Plan 83 (BП1–БП12, `raditi-noprojects/docs/plan/83-remove-projects.md:23-38`):
  - removes site projects, Gitea, `git-providers`, git for turns, trusted publication, previews and `/release`;
  - every turn runs without a repository;
  - workspace variables are in Vault at `kv/workspaces/<ws>/env`;
  - agent skills live in the workspace.
- `git-providers` on `main` has GitHub and GitLab only as **stubs**:
  - `packages/git-providers/src/github.ts:6` — "TODO(P8): API client, likely a GitHub App";
  - `packages/git-providers/src/gitlab.ts:6` — "TODO(P8): REST API client";
  - every call goes to `notImplemented` (`stub-provider.ts`).
  - Only the Gitea clients and the "mirror, bundle, publication" machinery were real, and plan 83 deletes them. They can still be brought back from history.
- Personal instructions for all chats exist (plan 76): `CLIENT_INSTRUCTIONS_LIMIT = 2000` (`packages/domain/src/agent/client-instructions.ts:5` on `main`), sent in each pass of every chat. There is no account memory.
- Plan 82 (scheduled tasks, branch `feat/scheduled-tasks`, `raditi-sched/docs/plan/82-scheduled-tasks.md`) is already modelled on Claude's dialog and binds tasks to the **old** site projects:
  - Зп7: «Новая запланированная задача», «Название», a project picker "instead of «Авто»";
  - Зп8: «Один раз», «Каждый час», «Ежедневно», «По будням», «Еженедельно», «Ежемесячно», «Только вручную»;
  - Зп17: each run is a new chat;
  - Зп21: pause `project_gone`;
  - Зп16: limit of 20 enabled tasks.

## 5. Behaviour to mirror, with Raditi wording (rule 10: «вы»; a conversation is a «чат»)

**List `/projects`**
- Rail item «Проекты».
- Header «Проекты» and the button «Новый проект» at the upper right.
- Empty state: an illustration, «Хотите создать проект?», and the text «Загружайте материалы, задавайте свои инструкции и держите чаты по одному делу в одном месте.» This replaces «организуйте сессии».
- Cards show the name, the goal (one line) and «Обновлён 3 дня назад».
- Sorting «Недавние / По дате создания / По названию». Search appears only above 6 projects, as elsewhere in the cabinet.
- ⋯ menu: «Добавить в избранное», «Архивировать», «Удалить».
- A tab or filter «Архив». Starred projects are shown in the second panel of «Проекты».

**Modal «Создание проекта»**
- «Над чем вы работаете?»: the name, required, placeholder «Например, «Интернет-магазин чая»».
- «Чего вы хотите достичь?»: the goal, optional, placeholder «Например, «Запустить продажи к декабрю»».
- «Контекст» with the tag «необязательно», then «Добавить контекст». It opens the same menu as on the page.
- Buttons «Отмена» and «Создать проект».

**Project page `/projects/<id>`**
- At the top: name, goal, ⋯.
- Composer with the placeholder «Новый чат в проекте «<название>»» (instead of «Новая сессия в проекте»).
- Below it, the project's chats: list, search, archive.
- Right column with four cards:
  1. **«Инструкции»**: «Добавить» or «Изменить». Hint: «Агент читает их в каждом чате проекта». A textarea with «Сохранить» and «Отменить».
  2. **«Контекст»**: «+». The menu holds «Загрузить с устройства», «Добавить текст» (instead of «Добавить текстовое содержимое»; fields «Название» and «Текст») and «GitHub» / «GitLab». Below: the list of files and repositories, and a bar «Занято N % места в проекте».
  3. **«Память»**: «Посмотреть». Empty state: «Память пока пуста. Она появится здесь после нескольких чатов в проекте.» The toggle «Использовать общую память» only appears once account memory exists (Q5).
  4. **«Запланировано»**: «+». It opens «Новая запланированная задача» with the project already set.

**Chat**
- The chat header shows «<проект> / <название чата>».
- The chat menu has «Перенести в проект…» and «Убрать из проекта».
- A chat inside a project gets the instructions, context and memory of the project, plus the personal instructions from plan 76.

**Git and CI words.** Brand names stay. Russian replaces jargon:
- «Подключить GitLab»;
- «Репозиторий», «Ветка»;
- «Запрос на слияние» (GitLab's own Russian UI term), with the action «Принять в основную ветку» instead of merge;
- «Сборки и выкладки» instead of CI/CD, «Запуск сборки» for a pipeline, «Настроить сборку» instead of «настройка CI».

## Implications for Raditi projects

1. **The data model is new and has nothing to do with the old one.** The new project is a workspace-level entity (`projects`: name, goal, instructions, star, archive, deletion). `tasks.project_id` is nullable, and chats without a project stay as they are. None of the site tables or columns that plan 83 deletes come back. The rail link at `application-rail.tsx:19` gets its route again.
2. **Instructions follow Claude Code, not claude.ai.**
   - claude.ai hides the name and description from the model. Claude Code sends the goal to the coordinator.
   - The owner wants instructions in the prompt "every time", so the proposal is: project instructions in every pass of every project chat, as a separate section next to the plan 76 section, with the same `looksLikeSecret` check and treated as data, not rules.
   - The goal («Чего вы хотите достичь?») goes in as one line, the way Claude Code uses its goal.
   - Proposed limit: 8,000 characters (Claude Code allows 16,000; personal instructions allow 2,000).
3. **Context means files in the sandbox, not RAG.**
   - Claude Code mounts project files "under `/mnt/project-files`". The direct analogue in Raditi is a read-only `/workspace/project/` in every project chat turn, where the agent reads with OpenCode's tools (read, grep).
   - Raditi needs no vector index, which removes the "RAG mode" question. The capacity bar is total bytes against the limit.
   - Files are stored in S3 in Russia (rule 1), as `raditi-inbox` is today.
   - "Add text" saves a `.md` file in the same context.
4. **GitHub and GitLab are a large separate piece of work.**
   - Claude's chat projects only read a snapshot with manual "Sync now", and only in private projects.
   - Pull, branch, merge request, CI and "deploy" exist only in Claude Code projects, and only for GitHub.
   - What the owner asks for (linking a GitLab account to pull, merge, set up CI and see pipelines) is the Claude Code level.
   - In Raditi this means OAuth or a token in Vault (rule 2), and no long-lived secrets in the sandbox (rule 5).
   - The repository is cloned and pushed by the trusted side (`core`), as the old Gitea path did with its mirror, bundle and publication, which plan 83 deletes.
   - Merge requests, pipeline status and a merge are GitLab API calls from `core` or `mcp`. Only a merge into the main branch is the "dangerous" action, behind a client button (rule 4).
   - The client's code goes to GLM on Z.ai, under the 152-ФЗ gate (rule 1).
   - `git-providers/gitlab.ts` and `github.ts` on `main` are stubs, so there is no API client to reuse.
   - This should be its own stage of plan 84, after the base project.
5. **Memory belongs to the platform.**
   - The sandbox lives for one turn, so memory cannot stay inside it.
   - The closest working model is Claude Code: memory files with a `MEMORY.md` index, which the agent writes while it works ("remember" and "forget" too), and which the client sees and edits in «Память».
   - `core` applies the changes at the end of the turn, the way plan 73 applies page changes, and keeps them in PostgreSQL or S3.
   - Claude also has a per-project scope and the "Use account memory" toggle. Raditi has no account memory, so that toggle is either hidden or tied to a future account memory.
   - Choosing the OpenCode mechanism is a separate research piece.
6. **Scheduled tasks come from plan 82, re-bound.**
   - In Зп7 the picker now shows the new projects. From inside a project the project is fixed.
   - Pause `project_gone` happens when the project is deleted or archived, as Claude does for both.
   - Each run is a new chat in the project and spends credits.
   - Claude's «Авто» (permission mode) has no equivalent: the Raditi agent does not ask for permissions. Its slot holds «Размышление» (plan 82), and the model is always GLM.
7. **Moving chats is allowed (claude.ai, ChatGPT), not forbidden (Claude Code).** A chat's project is read at the start of each pass, so after a move the next pass sees the new context. Memory written earlier stays with the old project.
8. **Deleting and archiving.**
   - Claude Code deletes threads, memory and files, turns off scheduled tasks and leaves remote branches and PRs alone. ChatGPT deletes the chats with the project.
   - Raditi already has a 30-day trash for pages (plan 73) and chat archiving (plan 76 И9), so the same pattern fits.
9. **Sharing.** In Claude only Team and Enterprise share projects, and GitHub and Drive are closed in shared projects. In Raditi a project belongs to the workspace, so its visibility to members is the owner's decision (Q8).

## Questions for the owner

1. **«Сессия» or «чат».** Proposed: «чат» everywhere («Новый чат в проекте «X»»), because Raditi already calls conversations chats.
2. **Does the goal («Чего вы хотите достичь?») go into the agent's prompt?** Proposed: yes, as one line, as in Claude Code. claude.ai hides it from the model.
3. **Limit for project instructions.** Proposed: 8,000 characters. They are sent together with the personal 2,000-character instructions, with the same check against passwords and keys.
4. **Files in «Контекст».** Proposed:
   - 30 MB per file and 200 MB per project (Claude: 30 MB per file);
   - Claude's types plus MD;
   - files are copied into the sandbox read-only at `/workspace/project` on every turn;
   - no RAG; the bar «Занято N %».
5. **Memory model.** Proposed:
   - memory files with a `MEMORY.md` index per project, written by the agent during the turn and applied by `core` at the end of the turn;
   - shown and edited in «Память»;
   - no extra paid summarisation pass;
   - the «Использовать память аккаунта» toggle stays hidden until account memory exists.
6. **Scope of GitLab and GitHub.** Proposed, in stages:
   - first a read-only snapshot of selected files with «Обновить» (claude.ai level);
   - then GitLab via OAuth: branch, merge request and pipeline status, with merge into the main branch only by the client's button;
   - setting up CI from a template by the agent, with the client confirming;
   - GitHub after GitLab.
   - Tokens are in Vault and pushes are made by `core`.
7. **Where tasks are scheduled.** Proposed: plan 82 re-bound to the new projects. A task created inside a project gets that project. Deleting or archiving the project pauses its tasks with `project_gone`. «Авто» is replaced by «Размышление».
8. **Who sees a project.** Proposed: the author by default («Только вы»), with the option «Все в рабочем пространстве», and GitLab only in projects visible to the author alone, as Claude does.
9. **Deleting a project.** Proposed: to the trash for 30 days, together with its chats, files and memory. Scheduled tasks are paused, nothing is done to remote branches and merge requests, and restore is possible within the 30 days.
10. **Moving chats.** Proposed: «Перенести в проект…» and «Убрать из проекта» are allowed, and the move affects the next pass.
11. **Project limit per tariff.** Proposed: none (Claude limits only Free, to 5). Credits are the only limit.
12. **Rule 3 for the client's repositories.** «Прод один» used to be about sites. Proposed: the agent never pushes to the main branch itself; it creates its own branch and a merge request, and only the client merges.

Sources not reached: help.openai.com (403), openai.com/academy (403), freshvanroot (403), and the Russian claude.ai article 9519177 (redirect loop). ChatGPT facts therefore come from secondary sources.
