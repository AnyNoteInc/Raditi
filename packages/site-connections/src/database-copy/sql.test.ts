import { DatabaseCopyError } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import {
  createTableForSeed,
  hexLiteral,
  insertStatement,
  numberLiteral,
  quoteIdentifier,
  seedHeader,
  stringLiteral,
  tuple,
  utf8Literal,
} from './sql.ts'

const text = (value: Uint8Array) => Buffer.from(value).toString('latin1')

describe('literals of a seed', () => {
  it('escapes the bytes mysqldump escapes and keeps every other byte', () => {
    const value = Buffer.from([0x00, 0x0a, 0x0d, 0x1a, 0x22, 0x27, 0x5c, 0x41])
    expect(text(stringLiteral(value))).toBe(`'\\0\\n\\r\\Z\\"\\'\\\\A'`)
    expect(text(stringLiteral(Buffer.alloc(0)))).toBe(`''`)
  })

  it('keeps UTF-8 of four bytes and the bytes of an 8-bit encoding as they are', () => {
    const emoji = Buffer.from('Привет 🙂 «мир»', 'utf8')
    expect(stringLiteral(emoji).subarray(1, -1).equals(emoji)).toBe(true)
    // cp1251 «Ж», and a byte that is a backslash only in ASCII position.
    const cp1251 = Buffer.from([0xc6, 0x5c, 0xff])
    expect([...stringLiteral(cp1251)]).toEqual([0x27, 0xc6, 0x5c, 0x5c, 0xff, 0x27])
  })

  it('writes binary values in hex and made values as UTF-8 with an introducer', () => {
    expect(text(hexLiteral(Buffer.from([0x00, 0xff, 0x27])))).toBe(`X'00ff27'`)
    expect(text(hexLiteral(Buffer.alloc(0)))).toBe(`X''`)
    expect(text(utf8Literal('user7'))).toBe(`_utf8mb4 X'7573657237'`)
    expect(text(utf8Literal(''))).toBe(`_utf8mb4''`)
    expect(text(utf8Literal(`x'); DROP TABLE t; --`))).toMatch(/^_utf8mb4 X'[0-9a-f]+'$/)
  })

  it('writes a number unquoted only when it is one', () => {
    for (const number of ['0', '-12', '3.14', '1e-5', '18446744073709551615'])
      expect(text(numberLiteral(Buffer.from(number))!)).toBe(number)
    for (const other of ['1; DROP', '', 'NaN', '0x10', '1 2'])
      expect(numberLiteral(Buffer.from(other))).toBeNull()
  })

  it('quotes a name in backticks, doubling a backtick inside', () => {
    expect(quoteIdentifier('wp_posts')).toBe('`wp_posts`')
    expect(quoteIdentifier('a`b')).toBe('`a``b`')
  })
})

describe('statements of a seed', () => {
  it('drops the counter, the folders and the keys of the source and keeps the rest', () => {
    const create = Buffer.from(
      [
        'CREATE TABLE `wp_posts` (',
        "  `ID` bigint(20) unsigned NOT NULL AUTO_INCREMENT COMMENT 'AUTO_INCREMENT=5; stays -- here',",
        '  `post_title` text NOT NULL,',
        "  `kind` enum('a)','b''c','d\\'e') NOT NULL,",
        '  PRIMARY KEY (`ID`), KEY `title` (`post_title`(191))',
        ") ENGINE=InnoDB AUTO_INCREMENT=4512 DEFAULT CHARSET=utf8mb4 DATA DIRECTORY='/srv/mysql/' INDEX DIRECTORY='/srv/i' COLLATE=utf8mb4_unicode_ci ENCRYPTED=YES ENCRYPTION_KEY_ID=2 COMMENT='Записи'",
      ].join('\n'),
      'utf8',
    )
    const seed = createTableForSeed('wp_posts', create).toString('utf8')
    expect(seed).toContain("COMMENT 'AUTO_INCREMENT=5; stays -- here'")
    expect(seed).toContain(
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Записи'",
    )
    expect(seed).not.toMatch(/AUTO_INCREMENT=4512|DIRECTORY|ENCRYPT/)
    const plain = Buffer.from('CREATE TABLE `wp_x` (\n  `a` int\n)')
    expect(createTableForSeed('wp_x', plain).equals(plain)).toBe(true)
  })

  it('refuses a statement that is not one CREATE TABLE of the table, or of an engine elsewhere', () => {
    const statement = (tail: string, body = '  `a` int', name = 'wp_x') =>
      Buffer.from(`CREATE TABLE \`${name}\` (\n${body}\n)${tail}`, 'utf8')
    for (const [what, create] of [
      // FEDERATED and CONNECT reach another server, its password in the options.
      [
        'federated',
        statement(" ENGINE=FEDERATED CONNECTION='mysql://shop:password@127.0.0.1:3306/shop/leads'"),
      ],
      ['connect', statement(" ENGINE=CONNECT TABLE_TYPE=MYSQL OPTION_LIST='user=shop,password=x'")],
      ['connection of innodb', statement(" ENGINE=InnoDB CONNECTION='mysql://shop:pw@h/db/t'")],
      ['merge', statement(' ENGINE=MRG_MyISAM UNION=(`wp_a`,`wp_b`)')],
      // A second statement after the table, or inside its list of columns.
      ['after the table', statement(' ENGINE=InnoDB; DROP DATABASE preview')],
      [
        'in the columns',
        statement('', '  `a` int); DROP DATABASE preview; CREATE TABLE `y` (`b` int'),
      ],
      // Comments, the executable ones too, and partitions.
      ['executable comment', statement(' ENGINE=InnoDB\n/*!50100 PARTITION BY HASH (`a`) */')],
      ['comment in the columns', statement('', '  `a` int /* x */')],
      ['hash comment', statement('', '  `a` int # x')],
      ['dash comment', statement('', '  `a` int -- x')],
      ['partitions', statement(' ENGINE=InnoDB\n PARTITION BY HASH (`a`)\nPARTITIONS 2')],
      ['versioning', statement(' ENGINE=InnoDB WITH SYSTEM VERSIONING')],
      ['an unknown option', statement(' ENGINE=InnoDB `IETF_QUOTES`=YES')],
      // Another table, another statement, an unclosed list.
      ['another name', statement(' ENGINE=InnoDB', '  `a` int', 'wp_y')],
      ['a view', Buffer.from('CREATE VIEW `wp_x` AS SELECT 1')],
      ['unclosed', Buffer.from("CREATE TABLE `wp_x` (\n  `a` int COMMENT ')'")],
    ] as const)
      expect(() => createTableForSeed('wp_x', create), what).toThrow(
        new DatabaseCopyError('structure_unsupported'),
      )
    for (const engine of ['InnoDB', 'MyISAM', 'Aria', 'MEMORY'])
      expect(() => createTableForSeed('wp_x', statement(` ENGINE=${engine}`))).not.toThrow()
  })

  it('declares the encoding of the connection and loads ids of 0 and zero dates', () => {
    const header = text(seedHeader('utf8mb4', 'utf8mb4_unicode_ci'))
    expect(header).toContain('SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;')
    expect(header).toContain("SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';")
    expect(text(seedHeader('cp1251', null))).toContain('SET NAMES cp1251;\n')
  })

  it('groups tuples into one INSERT by column names', () => {
    const statement = insertStatement(
      'wp_options',
      ['option_name', 'option_value'],
      [
        tuple([stringLiteral(Buffer.from('blogname')), stringLiteral(Buffer.from('Магазин'))]),
        tuple([stringLiteral(Buffer.from('home')), utf8Literal('x')]),
      ],
    )
    expect(statement.toString('utf8')).toBe(
      "INSERT INTO `wp_options` (`option_name`, `option_value`) VALUES\n('blogname','Магазин'),\n('home',_utf8mb4 X'78');\n",
    )
  })
})
