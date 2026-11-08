<?php
// configuration.php of a Raditi preview: the same file for every preview, with no secret in it.
// What differs per preview — its address, the database of its container, the settings read from
// production — comes from the settings file the platform writes on a tmpfs, through prologue.php
// (docs/plan/62-site-stacks.md, Т21, Т33, Т56; docs/plan/62-slices/e3.md, Э3.7). The platform
// writes this file over every tree it writes; the site's own configuration.php never reaches a
// preview. The syntax is that of PHP 7.3: the branches j3 and j4 run it too.
// Not require_once: Joomla includes this file inside a method, and the prologue must set its
// variable in the scope of every include.
require '/run/raditi/preview/prologue.php'; // NOSONAR

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
    // A preview sends no mail in the site's name (Т56): mail is off, and PHP's sendmail is a stub.
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
    public $sitename_pagetitles = 0;
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

    /**
     * The settings file of the preview, which prologue.php read. A static property: Joomla includes
     * this file inside a method, where no global variable is seen, and its Registry reads
     * get_object_vars(new JConfig), which a static property is not part of.
     */
    public static $raditi = array();

    public function __construct()
    {
        $settings = self::$raditi;
        if (!is_array($settings['database'] ?? null)) {
            if (PHP_SAPI !== 'cli' && !headers_sent()) {
                http_response_code(503);
            }
            echo "Предпросмотр ещё не готов.\n";
            exit(1);
        }
        // The database of the preview's own container, on its loopback (docs/plan/58).
        $database = $settings['database'];
        $this->host = (string) $database['host'] . ':' . (int) $database['port'];
        $this->user = (string) $database['user'];
        $this->password = (string) $database['password'];
        $this->db = (string) $database['name'];
        $values = is_array($settings['settings'] ?? null) ? $settings['settings'] : array();
        $this->dbprefix = (string) ($values['TABLE_PREFIX'] ?? 'jos_');
        // The key of this preview: derived from its database password, which only this preview and
        // the runtime know, so a rebuild with the same database keeps the sessions.
        $this->secret = substr(hash_hmac('sha256', 'raditi-preview:secret', $this->password), 0, 16);

        // What production shows to visitors, read from its configuration (joomlaReadLayout).
        $texts = array('SITENAME' => 'sitename', 'META_DESC' => 'MetaDesc', 'OFFSET' => 'offset');
        $switches = array('SEF' => 'sef', 'SEF_REWRITE' => 'sef_rewrite', 'SEF_SUFFIX' => 'sef_suffix',
            'UNICODESLUGS' => 'unicodeslugs');
        $numbers = array('SITENAME_PAGETITLES' => 'sitename_pagetitles', 'LIST_LIMIT' => 'list_limit',
            'FEED_LIMIT' => 'feed_limit');
        foreach ($texts as $name => $property) {
            if (is_string($values[$name] ?? null)) {
                $this->$property = $values[$name];
            }
        }
        foreach ($switches as $name => $property) {
            if (is_string($values[$name] ?? null)) {
                $this->$property = $values[$name] === '1';
            }
        }
        foreach ($numbers as $name => $property) {
            if (is_string($values[$name] ?? null) && ctype_digit($values[$name])) {
                $this->$property = (int) $values[$name];
            }
        }
    }
}

JConfig::$raditi = $raditi_preview;
// A page of a preview, not of production: what the scenario «broken only on production» reads.
define('RADITI_PREVIEW_ORIGIN', $raditi_preview['origin']);
unset($raditi_preview);
