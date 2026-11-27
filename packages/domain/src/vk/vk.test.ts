import { describe, expect, it } from 'vitest'

import { builtinMcpServerInfo, builtinMcpServers } from '../builtin-mcp/index.ts'
import { vkCommentUrl, vkPostUrl } from '../ports/vk-api.ts'
import {
  vkCommentsArgumentsSchema,
  vkPostProposeArgumentsSchema,
  vkProposalPayloadSchema,
  vkPublishAtProblem,
  vkReplyProposeArgumentsSchema,
} from './arguments.ts'
import { vkErrorOf, vkRefusalCodes, vkRefusalText, vkRefusalTexts } from './errors.ts'
import { vkLimits } from './limits.ts'
import { vkCommunitySecretPath, vkSecretSchema } from './secrets.ts'

const communityId = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'

describe('the refusals of VK', () => {
  it.each([
    [5, 'VK_KEY_INVALID'],
    [27, 'VK_KEY_INVALID'],
    [15, 'VK_ACCESS_DENIED'],
    [6, 'VK_RATE_LIMITED'],
    [9, 'VK_RATE_LIMITED'],
    [214, 'VK_POST_REFUSED'],
    [219, 'VK_POST_REFUSED'],
    [212, 'VK_NOT_FOUND'],
    [10, 'VK_UNREACHABLE'],
    [1051, 'VK_FAILED'],
    [100, 'VK_FAILED'],
  ])('maps the error %i of VK to %s', (code, expected) => {
    expect(vkErrorOf(code).code).toBe(expected)
  })

  it('has a Russian text for every code and none for a code of somebody else', () => {
    for (const code of vkRefusalCodes) expect(vkRefusalTexts[code]).toMatch(/[а-я]/)
    expect(vkRefusalText('VK_KEY_INVALID')).toBe(vkRefusalTexts.VK_KEY_INVALID)
    expect(vkRefusalText('REPO_READ_ONLY')).toBeNull()
  })
})

describe('the keys of VK', () => {
  it('keeps the key of a community under its workspace', () => {
    expect(vkCommunitySecretPath('ws', 'c1')).toBe('kv/workspaces/ws/vk/c1')
  })

  it('takes one printable word and refuses spaces and short values', () => {
    expect(vkSecretSchema.safeParse({ token: 'vk1.a.abcdefghijklmnop' }).success).toBe(true)
    expect(vkSecretSchema.safeParse({ token: 'vk1.a. abcdefghijklmnop' }).success).toBe(false)
    expect(vkSecretSchema.safeParse({ token: 'short' }).success).toBe(false)
    expect(vkSecretSchema.safeParse({ token: 'vk1.a.abcdefghijklmnop', extra: 'x' }).success).toBe(
      false,
    )
  })
})

describe('the arguments of the VK tools', () => {
  it('takes a post with line breaks and refuses control characters and extra fields', () => {
    expect(
      vkPostProposeArgumentsSchema.safeParse({ communityId, text: 'Новость\n\nВторая строка' })
        .success,
    ).toBe(true)
    expect(vkPostProposeArgumentsSchema.safeParse({ communityId, text: 'a\u0007b' }).success).toBe(
      false,
    )
    expect(
      vkPostProposeArgumentsSchema.safeParse({ communityId, text: 'x', groupId: 1 }).success,
    ).toBe(false)
    expect(
      vkPostProposeArgumentsSchema.safeParse({
        communityId,
        text: 'x'.repeat(vkLimits.postChars + 1),
      }).success,
    ).toBe(false)
  })

  it('names a community by its id in Raditi, never by the id of VK', () => {
    expect(vkCommentsArgumentsSchema.safeParse({ communityId: '123', postId: 1 }).success).toBe(
      false,
    )
    expect(vkCommentsArgumentsSchema.safeParse({ communityId, postId: 1 }).success).toBe(true)
  })

  it('takes a reply to one comment of one post', () => {
    expect(
      vkReplyProposeArgumentsSchema.safeParse({
        communityId,
        postId: 5,
        commentId: 7,
        text: 'Спасибо!',
      }).success,
    ).toBe(true)
    expect(
      vkReplyProposeArgumentsSchema.safeParse({ communityId, postId: 5, text: 'Спасибо!' }).success,
    ).toBe(false)
  })

  it('keeps a proposal of either kind', () => {
    expect(
      vkProposalPayloadSchema.safeParse({ kind: 'post', text: 'x', publishAt: null }).success,
    ).toBe(true)
    expect(
      vkProposalPayloadSchema.safeParse({ kind: 'reply', postId: 1, commentId: 2, text: 'x' })
        .success,
    ).toBe(true)
    expect(vkProposalPayloadSchema.safeParse({ kind: 'delete', postId: 1 }).success).toBe(false)
  })

  it('bounds a delayed post between 10 minutes and a year ahead', () => {
    const now = new Date('2026-11-27T10:00:00Z')
    expect(vkPublishAtProblem(new Date('2026-11-27T10:05:00Z'), now)).toMatch(/10 minutes/)
    expect(vkPublishAtProblem(new Date('2026-11-27T11:00:00Z'), now)).toBeNull()
    expect(vkPublishAtProblem(new Date('2028-01-01T00:00:00Z'), now)).toMatch(/year/)
    expect(vkPublishAtProblem(new Date('nope'), now)).toMatch(/instant/)
  })
})

describe('the addresses of VK', () => {
  it('names a post and a comment of a community wall', () => {
    expect(vkPostUrl(123, 45)).toBe('https://vk.com/wall-123_45')
    expect(vkCommentUrl(123, 45, 6)).toBe('https://vk.com/wall-123_45?reply=6')
  })
})

describe('the built-in MCP servers', () => {
  it('describes every server for the cabinet', () => {
    for (const server of builtinMcpServers) {
      expect(builtinMcpServerInfo[server].title.length).toBeGreaterThan(0)
      expect(builtinMcpServerInfo[server].summary).toMatch(/[а-я]/)
    }
    expect(builtinMcpServerInfo.vk.needsKey).toBe(true)
  })
})
