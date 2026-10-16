// Responses recorded from a disposable gitea/gitea:1.27.3-rootless on 2026-10-04 (bodies as sent).
// Only the secrets differ: the token value is the placeholder `__TOKEN__` and
// token_last_eight is zeroed. The instance ran with ROOT_URL https://gitea.example.test/.
export interface RecordedResponse {
  status: number
  body: string
}

/** Synthetic: the shape of a Gitea access token, never issued by any server. */
export const RECORDED_TOKEN = `${'0123456789abcdef'.repeat(2)}01234567`

export const giteaRecorded = {
  repository: {
    status: 200,
    body: '{"id":1,"owner":{"id":3,"login":"sites","login_name":"","source_id":0,"full_name":"","email":"3+sites@noreply.gitea.example.test","avatar_url":"https://gitea.example.test/avatars/d27edbd18c3bdf9ce1d013c6626ba26c","html_url":"https://gitea.example.test/sites","language":"","is_admin":false,"last_login":"0001-01-01T00:00:00Z","created":"2026-10-04T06:00:32Z","restricted":false,"active":false,"prohibit_login":false,"location":"","website":"","description":"","visibility":"private","followers_count":0,"following_count":0,"starred_repos_count":0,"username":"sites"},"name":"demo","full_name":"sites/demo","description":"","empty":false,"private":true,"fork":false,"template":false,"mirror":false,"size":24,"language":"","languages_url":"https://gitea.example.test/api/v1/repos/sites/demo/languages","html_url":"https://gitea.example.test/sites/demo","url":"https://gitea.example.test/api/v1/repos/sites/demo","link":"","ssh_url":"ssh://git@localhost:2222/sites/demo.git","clone_url":"https://gitea.example.test/sites/demo.git","original_url":"","website":"","stars_count":0,"forks_count":0,"watchers_count":2,"branch_count":1,"open_issues_count":0,"open_pr_counter":0,"release_counter":0,"default_branch":"main","archived":false,"created_at":"2026-10-04T06:00:32Z","updated_at":"2026-10-04T06:00:32Z","archived_at":"1970-01-01T00:00:00Z","permissions":{"admin":false,"push":true,"pull":true},"has_code":true,"has_issues":true,"internal_tracker":{"enable_time_tracker":true,"allow_only_contributors_to_track_time":true,"enable_issue_dependencies":true},"has_wiki":true,"has_pull_requests":true,"has_projects":true,"projects_mode":"all","has_releases":true,"has_packages":true,"has_actions":true,"ignore_whitespace_conflicts":false,"allow_merge_commits":true,"allow_rebase":true,"allow_rebase_explicit":true,"allow_squash_merge":true,"allow_fast_forward_only_merge":true,"allow_merge_update":true,"allow_rebase_update":true,"allow_manual_merge":false,"autodetect_manual_merge":false,"default_delete_branch_after_merge":false,"default_merge_style":"merge","default_update_style":"merge","default_allow_maintainer_edit":true,"avatar_url":"","internal":false,"mirror_interval":"","object_format_name":"sha1","mirror_updated":"0001-01-01T00:00:00Z","mirror_last_sync_at":"0001-01-01T00:00:00Z","topics":[],"licenses":[]}',
  },
  repositoryMoved: {
    status: 301,
    body: '<a href="/api/v1/repos/sites/demo2">Moved Permanently</a>.\n\n',
  },
  repositoryBadToken: {
    status: 401,
    body: '{"message":"invalid username, password or token","url":"https://gitea.example.test/api/swagger"}',
  },
  repositoryMissing: {
    status: 404,
    body: '{"message":"not found","url":"https://gitea.example.test/api/swagger"}',
  },
  currentToken: {
    status: 200,
    body: '{"id":1,"name":"raditi-core","scopes":["write:repository","write:user"],"created_at":"2026-10-04T06:00:32Z","last_used_at":"2026-10-04T06:00:32Z","user":{"id":2,"login":"raditi-bot"}}',
  },
  tokenCreated: {
    status: 201,
    body: '{"id":2,"name":"raditi-git-r-1791100000-0123456789abcdef","sha1":"__TOKEN__","token_last_eight":"00000000","scopes":["read:repository"],"created_at":"0001-01-01T00:00:00Z","last_used_at":"0001-01-01T00:00:00Z"}',
  },
  tokenScopeTooBroad: {
    status: 403,
    body: '{"message":"cannot create an access token with a broader scope than the authenticating token","url":"https://gitea.example.test/api/swagger"}',
  },
  tokenHeaderAuthRefused: {
    status: 401,
    body: '{"message":"auth required","url":"https://gitea.example.test/api/swagger"}',
  },
  tokenList: {
    status: 200,
    body: '[{"id":1,"name":"raditi-core","sha1":"","token_last_eight":"00000000","scopes":["write:repository","write:user"],"created_at":"2026-10-04T06:00:32Z","last_used_at":"2026-10-04T06:00:32Z"},{"id":2,"name":"raditi-git-r-1791100000-0123456789abcdef","sha1":"","token_last_eight":"00000000","scopes":["read:repository"],"created_at":"2026-10-04T06:00:32Z","last_used_at":"2026-10-04T06:00:32Z"}]',
  },
  tokenAlreadyDeleted: {
    status: 404,
    body: '{"message":"access token not found","url":"https://gitea.example.test/api/swagger"}',
  },
  tokenDeleted: { status: 204, body: '' },
  // POST /orgs/<org>/repos with { name, private: true, auto_init: false, default_branch: 'main' },
  // recorded the same day from the same image. The private organization `sites` had a team with
  // only the right to create repositories; its member's token had write:organization and
  // write:repository. GET of the created repository by its creator answered the body of the 201.
  organizationRepositoryCreated: {
    status: 201,
    body: '{"id":3,"owner":{"id":7,"login":"sites","login_name":"","source_id":0,"full_name":"","email":"","avatar_url":"https://gitea.example.test/avatars/d27edbd18c3bdf9ce1d013c6626ba26c","html_url":"https://gitea.example.test/sites","language":"","is_admin":false,"last_login":"0001-01-01T00:00:00Z","created":"2026-10-04T20:16:08Z","restricted":false,"active":false,"prohibit_login":false,"location":"","website":"","description":"","visibility":"private","followers_count":0,"following_count":0,"starred_repos_count":0,"username":"sites"},"name":"site-0b6f6d1e-5f0f-4c53-9d0a-7c2f4d3e2a10","full_name":"sites/site-0b6f6d1e-5f0f-4c53-9d0a-7c2f4d3e2a10","description":"","empty":true,"private":true,"fork":false,"template":false,"mirror":false,"size":23,"language":"","languages_url":"https://gitea.example.test/api/v1/repos/sites/site-0b6f6d1e-5f0f-4c53-9d0a-7c2f4d3e2a10/languages","html_url":"https://gitea.example.test/sites/site-0b6f6d1e-5f0f-4c53-9d0a-7c2f4d3e2a10","url":"https://gitea.example.test/api/v1/repos/sites/site-0b6f6d1e-5f0f-4c53-9d0a-7c2f4d3e2a10","link":"","ssh_url":"ssh://git@localhost:2222/sites/site-0b6f6d1e-5f0f-4c53-9d0a-7c2f4d3e2a10.git","clone_url":"https://gitea.example.test/sites/site-0b6f6d1e-5f0f-4c53-9d0a-7c2f4d3e2a10.git","original_url":"","website":"","stars_count":0,"forks_count":0,"watchers_count":3,"branch_count":0,"open_issues_count":0,"open_pr_counter":0,"release_counter":0,"default_branch":"main","archived":false,"created_at":"2026-10-04T20:16:08Z","updated_at":"2026-10-04T20:16:09Z","archived_at":"1970-01-01T00:00:00Z","permissions":{"admin":true,"push":true,"pull":true},"has_code":true,"has_issues":true,"internal_tracker":{"enable_time_tracker":true,"allow_only_contributors_to_track_time":true,"enable_issue_dependencies":true},"has_wiki":true,"has_pull_requests":true,"has_projects":true,"projects_mode":"all","has_releases":true,"has_packages":true,"has_actions":true,"ignore_whitespace_conflicts":false,"allow_merge_commits":true,"allow_rebase":true,"allow_rebase_explicit":true,"allow_squash_merge":true,"allow_fast_forward_only_merge":true,"allow_merge_update":true,"allow_rebase_update":true,"allow_manual_merge":false,"autodetect_manual_merge":false,"default_delete_branch_after_merge":false,"default_merge_style":"merge","default_update_style":"merge","default_allow_maintainer_edit":true,"avatar_url":"","internal":false,"mirror_interval":"","object_format_name":"sha1","mirror_updated":"0001-01-01T00:00:00Z","mirror_last_sync_at":"0001-01-01T00:00:00Z","topics":[],"licenses":[]}',
  },
  // The same request again. A name that differs only in letter case gets this answer too.
  organizationRepositoryExists: {
    status: 409,
    body: '{"message":"The repository with the same name already exists.","url":"https://gitea.example.test/api/swagger"}',
  },
  // A member of the organization whose teams may not create repositories.
  organizationRepositoryForbidden: {
    status: 403,
    body: '{"message":"User is not allowed to create repositories in this organization.","url":"https://gitea.example.test/api/swagger"}',
  },
  // A token without write:organization: it had write:repository alone, as a write grant has.
  organizationRepositoryScopeMissing: {
    status: 403,
    body: '{"message":"token does not have at least one of required scope(s), required=[write:organization], token scope=write:repository","url":"https://gitea.example.test/api/swagger"}',
  },
  // No such organization; a private one the account is not a member of answers the same.
  organizationMissing: {
    status: 404,
    body: '{"message":"not found","url":"https://gitea.example.test/api/swagger"}',
  },
} satisfies Record<string, RecordedResponse>
