<?php
// Spike: the generated configuration of a Joomla preview, with no secret in it: everything that
// differs per preview comes from the settings file, as infra/wordpress/preview-wp-config.php does.
class JConfig
{
    public $offline = false;
    public $offline_message = '';
    public $display_offline_message = 1;
    public $offline_image = '';
    public $sitename = 'Предпросмотр';
    public $editor = 'tinymce';
    public $captcha = '0';
    public $list_limit = 20;
    public $access = 1;
    public $debug = false;
    public $debug_lang = false;
    public $debug_lang_const = true;
    public $dbtype = 'mysqli';
    public $host = '';
    public $user = '';
    public $password = '';
    public $db = '';
    public $dbprefix = '';
    public $dbencryption = 0;
    public $dbsslverifyservercert = false;
    public $dbsslkey = '';
    public $dbsslcert = '';
    public $dbsslca = '';
    public $dbsslcipher = '';
    public $force_ssl = 0;
    public $live_site = '';
    public $secret = '';
    public $gzip = false;
    public $error_reporting = 'default';
    public $helpurl = '';
    public $offset = 'UTC';
    public $cors = false;
    public $mailonline = false;
    public $massmailoff = true;
    public $mailer = 'mail';
    public $mailfrom = 'noreply@preview.invalid';
    public $fromname = 'Предпросмотр';
    public $sendmail = '/usr/sbin/sendmail';
    public $smtpauth = false;
    public $smtpuser = '';
    public $smtppass = '';
    public $smtphost = 'localhost';
    public $smtpsecure = 'none';
    public $smtpport = 25;
    public $caching = 0;
    public $cache_handler = 'file';
    public $cachetime = 15;
    public $cache_platformprefix = false;
    public $MetaDesc = '';
    public $MetaAuthor = true;
    public $MetaVersion = false;
    public $robots = 'noindex, nofollow';
    public $sef = true;
    public $sef_rewrite = true;
    public $sef_suffix = false;
    public $unicodeslugs = false;
    public $feed_limit = 10;
    public $feed_email = 'none';
    public $log_path = '/var/www/html/administrator/logs';
    public $tmp_path = '/var/www/html/tmp';
    public $lifetime = 30;
    public $session_handler = 'database';
    public $session_metadata = true;
    public $session_metadata_for_guest = true;
    public $shared_session = false;

    public function __construct()
    {
        $raw = @file_get_contents('/run/raditi/preview/settings.json');
        $settings = is_string($raw) ? json_decode($raw, true, 32) : null;
        if (!is_array($settings) || !is_array($settings['database'] ?? null)) {
            http_response_code(503);
            echo "Предпросмотр ещё не готов.\n";
            exit(1);
        }
        $database = $settings['database'];
        $this->host = $database['host'] . ':' . $database['port'];
        $this->user = $database['user'];
        $this->password = $database['password'];
        $this->db = $database['name'];
        $this->dbprefix = (string) ($settings['settings']['TABLE_PREFIX'] ?? 'jos_');
        $this->secret = substr(hash_hmac('sha256', 'raditi-preview:secret', (string) $database['password']), 0, 16);
        if (!empty($settings['settings']['CACHING'])) {
            $this->caching = (int) $settings['settings']['CACHING'];
        }
        if (!empty($settings['settings']['TMP_PATH'])) {
            $this->tmp_path = $settings['settings']['TMP_PATH'];
            $this->log_path = $settings['settings']['LOG_PATH'];
        }
        if (!empty($settings['settings']['ERROR_REPORTING'])) {
            $this->error_reporting = $settings['settings']['ERROR_REPORTING'];
        }
    }
}
