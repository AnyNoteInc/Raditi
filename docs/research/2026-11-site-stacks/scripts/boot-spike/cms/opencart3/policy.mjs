// The allow list of opencart.md §6.1, §6.2 and §6.5, OC 3 column.
const all = (table) => ({ table, where: [] })
const skel = ['store','language','currency','event','extension','seo_url','api','api_ip','length_class','length_class_description','weight_class','weight_class_description',
 'tax_class','tax_rate','tax_rate_to_customer_group','tax_rule','geo_zone','zone','zone_to_geo_zone','country','customer_group','customer_group_description','custom_field','custom_field_customer_group','custom_field_description','custom_field_value','custom_field_value_description',
 'layout','layout_route','layout_module','module','banner','banner_image','theme','translation','stock_status','order_status','return_action','return_reason','return_status','location','user_group','modification','extension_install','extension_path']
const content = ['product','product_attribute','product_description','product_discount','product_filter','product_image','product_option','product_option_value','product_recurring','product_related','product_reward','product_special','product_to_category','product_to_download','product_to_layout','product_to_store',
 'attribute','attribute_description','attribute_group','attribute_group_description','filter','filter_description','filter_group','filter_group_description','option','option_description','option_value','option_value_description','manufacturer','manufacturer_to_store','recurring','recurring_description',
 'category','category_description','category_filter','category_path','category_to_layout','category_to_store','information','information_description','information_to_layout','information_to_store']
const secretKeys = ['config\\_encryption','config\\_mail\\_smtp\\_hostname','config\\_mail\\_smtp\\_username','config\\_mail\\_smtp\\_password','config\\_mail\\_alert\\_email','config\\_ftp\\_%','config\\_api\\_id','config\\_google\\_analytics','%password%','%secret%','%token%','%\\_key']
export const settingRule = (extra = []) => ({ table: 'setting', where: [
  { op: 'in', column: 'store_id', values: ['0'] },
  { op: 'like', column: 'code', patterns: ['config', 'theme\\_%', 'module\\_%', 'total\\_%', 'shipping\\_%', 'dashboard\\_%', 'report\\_%', 'developer', 'currency\\_%', ...extra] },
  { op: 'notLike', column: 'key', patterns: secretKeys } ], columns: { value: 'scrub_secrets' } })
export const tables = [...skel, ...content].map(all).concat(settingRule())
export const tablesOffline = [...skel, ...content].map(all).concat(settingRule(['payment\\_cod', 'payment\\_free\\_checkout']))
export const overrides = [
  { table: 'setting', match: { column: 'key', value: 'config_email' }, set: { value: 'admin@preview.invalid' } },
  { table: 'setting', match: { column: 'key', value: 'config_maintenance' }, set: { value: '0' } },
  { table: 'setting', match: { column: 'key', value: 'config_error_display' }, set: { value: '1' } },
  { table: 'setting', match: { column: 'key', value: 'config_compression' }, set: { value: '0' } },
]

const ocstore = ['article','article_description','article_image','article_related','article_related_mn','article_related_product','article_related_wb','article_to_blog_category','article_to_download','article_to_layout','article_to_store','blog_category','blog_category_description','blog_category_path','blog_category_to_layout','blog_category_to_store','manufacturer_description','manufacturer_to_layout','product_related_article','product_related_mn','product_related_wb','shipping_courier']
export const tablesOcstore = [...tablesOffline, ...ocstore.map(all)]
