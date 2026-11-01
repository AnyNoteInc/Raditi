cd /var/www/html
q() { php -r '$m=new mysqli("gap6-db","root","<hidden>","mx");$r=$m->query($argv[1]);if($r instanceof mysqli_result){while($x=$r->fetch_row())echo implode(" | ",$x),"\n";}' "$1"; }
page() { curl -s http://gap6-modx/ | grep -o 'MARK[^<]*' | tr '\n' ' '; echo; }
wipe() { find core/cache -mindepth 1 -delete; }
q "INSERT INTO modx_site_htmlsnippets (name,description,snippet) VALUES ('gapchunk','','MARK chunk-v1')"
q "INSERT INTO modx_site_snippets (name,description,snippet) VALUES ('gapsnip','','return \"MARK snipcached-v1\";')"
q "INSERT INTO modx_site_snippets (name,description,snippet) VALUES ('gapsnipu','','return \"MARK snipuncached-v1\";')"
q "INSERT INTO modx_site_htmlsnippets (name,description,snippet,static,static_file,source) VALUES ('gapstatic','','x',1,'assets/gap/static.html',0)"
q "INSERT INTO modx_site_snippets (name,description,snippet,static,static_file,source) VALUES ('gapstaticsnip','','return 1;',1,'assets/gap/static.php',0)"
q "UPDATE modx_site_templates SET content='<html><body><div>[[\$gapchunk]]</div><div>[[gapsnip]]</div><div>[[!gapsnipu]]</div><div>[[\$gapstatic]]</div><div>[[!gapstaticsnip]]</div><div>[[*pagetitle]]</div></body></html>' WHERE id=1"
mkdir -p assets/gap; printf 'MARK static-chunk-v1' > assets/gap/static.html; printf '<?php\nreturn "MARK static-snip-v1";\n' > assets/gap/static.php; chown -R www-data:www-data assets
wipe; sleep 1
echo "--- 1 first render"; page
echo "--- 2 write DB v2 directly, no cache clear"
q "UPDATE modx_site_htmlsnippets SET snippet='MARK chunk-v2' WHERE name='gapchunk'"
q "UPDATE modx_site_snippets SET snippet='return \"MARK snipcached-v2\";' WHERE name='gapsnip'"
q "UPDATE modx_site_snippets SET snippet='return \"MARK snipuncached-v2\";' WHERE name='gapsnipu'"
page
echo "--- 3 static files v2 over SFTP-like write, no cache clear"
sleep 2; printf 'MARK static-chunk-v2' > assets/gap/static.html; printf '<?php\nreturn "MARK static-snip-v2";\n' > assets/gap/static.php
page
q "SELECT name,snippet FROM modx_site_htmlsnippets WHERE name='gapstatic'"
echo "--- 4 remove only core/cache/resource"
ls core/cache; find core/cache/resource -mindepth 1 -delete
page
q "SELECT name,snippet FROM modx_site_htmlsnippets WHERE name='gapstatic'"
echo "--- 5 remove core/cache/includes and scripts"
find core/cache/includes core/cache/scripts -mindepth 1 -delete 2>/dev/null
page
echo "--- 6 remove everything in core/cache"
wipe; page
ls core/cache; tail -3 core/cache/logs/error.log 2>/dev/null
