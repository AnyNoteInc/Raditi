// The built-in skills of the platform (docs/plan/97-skills.md, Нв5, Нв6, §5): folders of the
// sandbox image under SANDBOX_BUILTIN_SKILLS (`infra/sandbox/skills/<name>/` in the repository),
// their version the image's. `skill-creator` is on for every account until it turns it off; the
// skills of the catalog of Радити wait until an account turns them on. A row of `account_skills`
// exists for a built-in skill only when its account changed the default.
//
// The cabinet reads the texts here, the sandbox reads the files: a test of @repo/skill-sources
// checks that every entry has its folder and that the name and description of its `SKILL.md` are
// these.

export interface BuiltinSkill {
  readonly name: string
  /** What the client reads, in Russian. */
  readonly title: string
  readonly summary: string
  /** The `description` of its `SKILL.md`, as the model reads it. */
  readonly description: string
  /** On for an account that never changed it. */
  readonly defaultEnabled: boolean
  /** Shown under «Каталог Радити» rather than among the platform's own tools. */
  readonly catalog: boolean
  /** The licence of the folder, when it is not the platform's own text. */
  readonly license?: string
}

export const builtinSkills: readonly BuiltinSkill[] = Object.freeze([
  {
    name: 'skill-creator',
    title: 'Создание навыков',
    summary:
      'Агент помогает описать повторяющуюся работу навыком: задаёт вопросы, пишет инструкцию и предлагает сохранить навык в ваш аккаунт.',
    description:
      'Create a new skill or improve an existing one: a folder with SKILL.md that teaches the agent a repeatable task of the client. Use when the client asks to make, write, save, edit or improve a skill, a template of work or a standing procedure, or types /skill-creator.',
    defaultEnabled: true,
    catalog: false,
    license: 'Apache-2.0',
  },
  {
    name: 'commercial-offer',
    title: 'Коммерческое предложение',
    summary:
      'Коммерческое предложение для клиента: структура, выгоды, цены и следующий шаг — документом Word или артефактом.',
    description:
      'Write a commercial offer (коммерческое предложение) of a small business to its customer: structure, benefits, prices, terms and a call to action, as a document. Use when the client asks for a commercial offer, a proposal to a customer, a КП or a price offer.',
    defaultEnabled: false,
    catalog: true,
  },
  {
    name: 'product-cards',
    title: 'Карточки товаров',
    summary:
      'Названия, описания и характеристики товаров для сайта и маркетплейсов — по фото, таблице или списку.',
    description:
      'Write product cards for an online store or a marketplace (Ozon, Wildberries, Яндекс Маркет): titles, descriptions, characteristics and keywords from photos, a table or a list. Use when the client asks to describe goods, make product cards or fill a catalog.',
    defaultEnabled: false,
    catalog: true,
  },
  {
    name: 'social-posts',
    title: 'Посты для соцсетей',
    summary: 'Посты и контент-план для ВКонтакте, Telegram и других сетей в голосе вашего бизнеса.',
    description:
      'Write posts and a content plan for social networks of a small business (VK, Telegram, Одноклассники, Дзен) in the voice of the business. Use when the client asks for posts, a content plan, a publication or texts for social networks.',
    defaultEnabled: false,
    catalog: true,
  },
])

export const builtinSkillNames: ReadonlySet<string> = new Set(builtinSkills.map((s) => s.name))

export const builtinSkill = (name: string): BuiltinSkill | undefined =>
  builtinSkills.find((skill) => skill.name === name)
