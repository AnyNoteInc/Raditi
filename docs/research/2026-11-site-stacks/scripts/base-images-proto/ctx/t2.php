<?php
$r=array('php'=>PHP_VERSION,'sapi'=>php_sapi_name());
$r['scanned']=php_ini_scanned_files(); $r['scanned']=array_values(array_filter(array_map('trim',explode(',',(string)$r['scanned'])),function($f){return strpos($f,'raditi')!==false||strpos($f,'ioncube')!==false;}));
$r['short_open_tag']=ini_get('short_open_tag'); $r['func_overload']=ini_get('mbstring.func_overload'); $r['strlen_ya']=strlen("я");
$r['max_input_vars']=ini_get('max_input_vars'); $r['file_cache']=ini_get('opcache.file_cache');
$s=function_exists('opcache_get_status')?@opcache_get_status(false):null;
$r['jit']=isset($s['jit'])?array('on'=>$s['jit']['on'],'buf'=>$s['jit']['buffer_size'],'free'=>$s['jit']['buffer_free']):null;
$r['file_cache_only']=isset($s['file_cache_only'])?$s['file_cache_only']:null;
$r['opcache_dir']=is_dir('/tmp/opcache')?array_values(array_diff(scandir('/tmp/opcache'),array('.','..'))):null;
if (function_exists('curl_init')) { $c=curl_init('https://example.com/'); curl_setopt($c,CURLOPT_RETURNTRANSFER,1); curl_setopt($c,CURLOPT_TIMEOUT,10); $b=curl_exec($c); $r['https']=array(curl_getinfo($c,CURLINFO_HTTP_CODE),curl_error($c)); $v=curl_version(); $r['ssl']=$v['ssl_version']; }
$r['openssl']=defined('OPENSSL_VERSION_TEXT')?OPENSSL_VERSION_TEXT:null;
$c=@mysqli_connect('127.0.0.1','preview','<hidden>','preview',3306);
if($c){ if(function_exists('mysqli_report'))mysqli_report(MYSQLI_REPORT_OFF); $cols=array(); for($i=0;$i<100;$i++) $cols[]="c$i VARCHAR(100)";
 $ok=@mysqli_query($c,"CREATE TABLE IF NOT EXISTS w2 (id INT PRIMARY KEY, ".implode(',',$cols).") ENGINE=InnoDB ROW_FORMAT=COMPACT DEFAULT CHARSET=utf8mb4"); $r['wide']=$ok?'created':substr(mysqli_error($c),0,70); 
 $q=@mysqli_query($c,"SELECT @@innodb_strict_mode,@@sql_mode,@@time_zone,@@system_time_zone,NOW()"); $r['db']=$q?mysqli_fetch_row($q):null; }
$r['php_now']=date('Y-m-d H:i:s');
echo json_encode($r);
