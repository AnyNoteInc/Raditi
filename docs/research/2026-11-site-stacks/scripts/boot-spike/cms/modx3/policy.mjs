// The allow list of modx.md §6.1 and the rules of §6.2–§6.4, as the report proposes.
const all = (table, columns) => ({ table, where: [], ...(columns ? { columns } : {}) })
const startup = ['context','system_eventnames','namespaces','extension_packages','workspaces','content_type','media_sources_contexts','media_sources_elements']
const code = ['site_templates','site_htmlsnippets','site_snippets','site_plugins','site_plugin_events','site_tmplvars','site_tmplvar_templates','site_tmplvar_access','categories','categories_closure','property_set','element_property_sets']
const rights = ['access_actiondom','access_category','access_context','access_elements','access_media_source','access_menus','access_namespace','access_permissions','access_policies','access_policy_template_groups','access_policy_templates','access_resource_groups','access_resources','access_templatevars','membergroup_names','user_group_roles','menus','actiondom','actions_fields','fc_profiles','fc_profiles_usergroups','fc_sets','dashboard','dashboard_widget','dashboard_widget_placement','lexicon_entries']
const secretish = ['%key%','%token%','%secret%','%pass%','%api%','mail\\_smtp\\_user','mail\\_dkim\\_%','proxy\\_username','site\\_url','base\\_url','http\\_host','url\\_scheme']
export const tables = [
  ...startup.map((t) => all(t)),
  { table: 'system_settings', where: [{ op: 'notLike', column: 'key', patterns: secretish }, { op: 'notLike', column: 'xtype', patterns: ['text-password'] }] },
  { table: 'context_setting', where: [{ op: 'notLike', column: 'key', patterns: secretish }] },
  all('media_sources', { properties: 'scrub_secrets' }),
  { table: 'site_content', where: [{ op: 'in', column: 'deleted', values: ['0'] }] },
  { table: 'site_tmplvar_contentvalues', where: [{ op: 'inCopied', column: 'contentid', table: 'site_content', key: 'id' }] },
  { table: 'context_resource', where: [{ op: 'inCopied', column: 'resource', table: 'site_content', key: 'id' }] },
  { table: 'document_groups', where: [{ op: 'inCopied', column: 'document', table: 'site_content', key: 'id' }] },
  all('documentgroup_names'),
  ...code.map((t) => all(t)),
  ...rights.map((t) => all(t)),
  all('transport_packages'),
  { table: 'users', where: [{ op: 'inCopied', column: 'id', table: 'site_content', key: 'createdby' }],
    columns: { username: 'synthetic_login', password: 'random_password_hash', cachepwd: 'empty', salt: 'empty', remote_key: 'empty', remote_data: 'empty', session_stale: 'empty' } },
  { table: 'user_attributes', where: [{ op: 'inCopied', column: 'internalKey', table: 'users', key: 'id' }],
    columns: { fullname: 'synthetic_name', email: 'synthetic_email', phone: 'empty', mobilephone: 'empty', address: 'empty', country: 'empty', city: 'empty', state: 'empty', zip: 'empty', fax: 'empty', photo: 'empty', comment: 'empty', website: 'empty', extended: 'empty', sessionid: 'empty' } },
]
const set = (key, value) => ({ table: 'system_settings', match: { column: 'key', value: key }, set: { value } })
export const overrides = [set('site_status', '1'), set('site_unavailable_page', '0'), set('session_cookie_domain', ''), set('session_cookie_secure', '0'), set('manager_login_url_alternate', ''), set('emailsender', 'admin@preview.invalid'), set('mail_use_smtp', '0'), set('auto_check_pkg_updates', '0'), set('feed_modx_news_enabled', '0'), set('feed_modx_security_enabled', '0'), set('passwordless_activated', '0')]
