<?php
error_reporting(E_ALL & ~E_DEPRECATED & ~E_STRICT);
$r = array();
$r['php'] = PHP_VERSION; $r['sapi'] = php_sapi_name();
$r['ext_count'] = count(get_loaded_extensions());
$want = array('apcu','bcmath','bz2','calendar','ctype','curl','dom','exif','fileinfo','filter','ftp','gd','gettext','gmp','hash','iconv','imagick','intl','json','ldap','libxml','mbstring','mcrypt','memcached','mysqli','mysqlnd','openssl','pcre','PDO','pdo_mysql','Phar','posix','redis','SimpleXML','soap','sockets','sysvmsg','sysvsem','sysvshm','shmop','tokenizer','xml','xmlreader','xmlrpc','xmlwriter','xsl','zip','zlib','Zend OPcache','ionCube Loader');
$miss = array(); foreach ($want as $e) if (!extension_loaded($e)) $miss[] = $e;
$r['missing'] = $miss;
if (function_exists('ioncube_loader_version')) $r['ioncube'] = ioncube_loader_version();
if (function_exists('opcache_get_status')) { $s = @opcache_get_status(false); $r['opcache'] = array('on'=>$s ? $s['opcache_enabled'] : null, 'cached'=>$s ? $s['opcache_statistics']['num_cached_scripts'] : null, 'hits'=>$s ? $s['opcache_statistics']['hits'] : null, 'jit'=> isset($s['jit']) ? array('on'=>$s['jit']['on'],'buf'=>$s['jit']['buffer_size']) : null, 'model'=>ini_get('opcache.preferred_memory_model')); }
// IPC
if (function_exists('sem_get')) { $k = 0x7261; $s=@sem_get($k); $a=$s?@sem_acquire($s):false; $b=$s?@sem_release($s):false; $r['sysvsem']=array('get'=>(bool)$s,'acq'=>$a,'rel'=>$b, 'err'=>error_get_last()); }
if (function_exists('shm_attach')) { $s=@shm_attach(0x7262, 4096); $ok=$s?@shm_put_var($s,1,'v'):false; $v=$s?@shm_get_var($s,1):null; if($s)@shm_remove($s); $r['sysvshm']=array($ok,$v); }
if (function_exists('shmop_open')) { $s=@shmop_open(0x7263,'c',0644,128); $w=$s?@shmop_write($s,'x',0):null; if($s)@shmop_delete($s); $r['shmop']=array((bool)$s,$w); }
if (function_exists('msg_get_queue')) { $q=@msg_get_queue(0x7264); $o=$q?@msg_send($q,1,'m'):false; $t=null;$m=null; $g=$q?@msg_receive($q,0,$t,64,$m,true,MSG_IPC_NOWAIT):false; if($q)@msg_remove_queue($q); $r['sysvmsg']=array($o,$g,$m); }
if (function_exists('apcu_store')) { $r['apcu']=array(@apcu_store('k','v'), @apcu_fetch('k'), ini_get('apc.enabled')); }
// locks
foreach (array('/tmp/l','/var/www/html/l') as $p) { $f=@fopen($p,'c'); $r['flock:'.$p]=$f?flock($f,LOCK_EX|LOCK_NB):false; if($f){flock($f,LOCK_UN);fclose($f);@unlink($p);} }
// mail, locale
$r['mail']=@mail('nobody@example.invalid','s','b');
$r['locale_cp1251']=setlocale(LC_ALL,'ru_RU.CP1251'); $r['locale_utf8']=setlocale(LC_ALL,'ru_RU.UTF-8'); setlocale(LC_ALL,'C');
$r['iconv']=function_exists('iconv')?bin2hex(iconv('UTF-8','CP1251','я')):null;
$r['tz']=date_default_timezone_get().' '.date('H:i T');
$r['pcre_jit']=array(ini_get('pcre.jit'), preg_match('/(a+)+b/','aaaab'), preg_last_error());
// gd and imagick
if (function_exists('imagecreatetruecolor')) { $im=imagecreatetruecolor(4,4); ob_start(); imagepng($im); $p=ob_get_clean(); $r['gd']=array(strlen($p)>0, function_exists('imagettftext'), function_exists('imagewebp')); }
if (class_exists('Imagick')) { try { $i=new Imagick(); $i->newImage(4,4,'white'); $i->setImageFormat('png'); $r['imagick']=strlen($i->getImageBlob())>0; } catch (Exception $e) { $r['imagick']=$e->getMessage(); } }
// session
if (@session_start()) { $_SESSION['a']=1; $r['session']=session_id()!=='' ; session_write_close(); }
// DB
$h='127.0.0.1'; $u='preview'; $p='<hidden>';
foreach (array('mysqli','pdo','mysql') as $d) {
  try {
    if ($d==='mysqli') { $c=@mysqli_connect($h,$u,$p,'preview',3306); if(!$c){$r['db:mysqli']=mysqli_connect_error();continue;} $q=mysqli_query($c,"SELECT VERSION(),@@sql_mode,@@character_set_server,@@collation_server,@@innodb_strict_mode,@@character_set_client,@@collation_connection"); $r['db:mysqli']=mysqli_fetch_row($q); $r['db:mysqli:charset']=mysqli_character_set_name($c);
      @mysqli_query($c,"SET NAMES cp1251"); @mysqli_query($c,"CREATE TABLE IF NOT EXISTS z (id INT PRIMARY KEY, d DATETIME NOT NULL DEFAULT '0000-00-00 00:00:00', t VARCHAR(20)) ENGINE=MyISAM DEFAULT CHARSET=cp1251"); $r['db:zero_date_table']=mysqli_error($c)===''?'ok':mysqli_error($c);
      @mysqli_query($c,"INSERT IGNORE INTO z (id,t) VALUES (1,'".iconv('UTF-8','CP1251','Тест')."')"); $x=mysqli_query($c,"SELECT d,HEX(t) FROM z WHERE id=1"); $r['db:zero_date_row']=$x?mysqli_fetch_row($x):mysqli_error($c);

      @mysqli_query($c,"SET NAMES utf8mb4");
      @mysqli_query($c,"CREATE TABLE IF NOT EXISTS s (id INT PRIMARY KEY, n INT NOT NULL, v VARCHAR(3) NOT NULL) ENGINE=InnoDB");
      $ok=@mysqli_query($c,"REPLACE INTO s VALUES (1,'','abcdef')"); $r['db:strict_insert']=$ok?'stored':mysqli_error($c);
      $cols=array(); for($i=0;$i<200;$i++) $cols[]="c$i VARCHAR(255)"; 
      $ok=@mysqli_query($c,"CREATE TABLE IF NOT EXISTS w (id INT PRIMARY KEY, ".implode(',',$cols).") ENGINE=InnoDB ROW_FORMAT=COMPACT DEFAULT CHARSET=utf8mb4"); $r['db:wide_table']=$ok?'created':substr(mysqli_error($c),0,60);
      mysqli_close($c);
    }
    if ($d==='pdo') { $c=new PDO("mysql:host=$h;port=3306;dbname=preview",$u,$p); $r['db:pdo']=$c->query('SELECT 1')->fetchColumn(); }
    if ($d==='mysql') { if(function_exists('mysql_connect')){ $c=@mysql_connect("$h:3306",$u,$p); $r['db:mysql']=$c?mysql_get_server_info($c):mysql_error(); } }
  } catch (Exception $e) { $r['db:'.$d]='EXC '.$e->getMessage(); }
}
echo json_encode($r);
