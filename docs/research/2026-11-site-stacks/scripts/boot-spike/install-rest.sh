#!/bin/bash
# Background: the other branches on the same synthetic production.
SRC=<work>/research/src
ASW="setpriv --reuid=33 --regid=33 --clear-groups"
DBA="--db_hostname 127.0.0.1 --db_username site --db_password <hidden> --db_database site --db_port 3306 --db_prefix oc_"
# Joomla 6.2.0
./prod-up.sh j6 18106 13306 $SRC/joomla/pkg-6.2.0 | tail -1
s=$(date +%s); docker exec bs-prod-j6 sh -c "cd /var/www/html && $ASW php installation/joomla.php install --site-name='Спайк Joomla 6' --admin-user='Admin User' --admin-username=spikeadmin --admin-password='<hidden>' --admin-email=admin@example.test --db-type=mysqli --db-host=127.0.0.1 --db-user=site --db-pass='<hidden>' --db-name=site --db-prefix=jos_ --db-encryption=0 --no-interaction 2>&1 | tail -3"; echo "j6 install $(( $(date +%s)-s )) s"
docker exec bs-prod-j6 sh -c "cd /var/www/html; rm -rf installation; cp htaccess.txt .htaccess; sed -i 's/public \$sef_rewrite = false/public \$sef_rewrite = true/' configuration.php"
node j-sample.mjs http://127.0.0.1:18106 2>&1 | tail -3 | cut -c1-200
# OpenCart 3.0.5.1
./prod-up.sh oc3 18143 13343 $SRC/opencart/oc-3.0.5.1/upload | tail -1
docker exec bs-prod-oc3 sh -c "cd /var/www/html; ls; cp config-dist.php config.php; cp admin/config-dist.php admin/config.php; chown 33:33 config.php admin/config.php; ls system/storage/vendor | head -5"
s=$(date +%s); docker exec bs-prod-oc3 sh -c "cd /var/www/html/install && $ASW php cli_install.php install --username spikeadmin --email admin@example.test --password '<hidden>' --http_server http://127.0.0.1:18143/ --db_driver mysqli $DBA 2>&1 | tail -6 | cut -c1-240"; echo "oc3 install $(( $(date +%s)-s )) s"
docker exec bs-prod-oc3 sh -c "cd /var/www/html; rm -rf install; cp .htaccess.txt .htaccess 2>/dev/null; ls -a | head -20"
docker exec bs-prod-oc3 mariadb --no-defaults --socket=/run/mysqld/mysqld.sock -uroot site -N -e "update oc_setting set value='1' where \`key\`='config_seo_url'; select count(*) from information_schema.tables where table_schema='site'; select engine,count(*) from information_schema.tables where table_schema='site' group by engine; select 'prod',count(*) from oc_product;"
curl -s -o /dev/null -w 'oc3 home %{http_code} %{size_download}\n' http://127.0.0.1:18143/
# ocStore 3.0.3.7 needs an older PHP: tried on 8.3 first, the result is recorded as is.
./prod-up.sh ocs 18144 13344 $SRC/opencart/ocstore-3.0.3.7/upload | tail -1
docker exec bs-prod-ocs sh -c "cd /var/www/html; ls | head -30; cp config-dist.php config.php; cp admin/config-dist.php admin/config.php; chown 33:33 config.php admin/config.php"
s=$(date +%s); docker exec bs-prod-ocs sh -c "cd /var/www/html/install && $ASW php cli_install.php install --username spikeadmin --email admin@example.test --password '<hidden>' --http_server http://127.0.0.1:18144/ --db_driver mysqli $DBA 2>&1 | tail -6 | cut -c1-300"; echo "ocs install $(( $(date +%s)-s )) s"
curl -s -o /tmp/ocs.html -w 'ocs home %{http_code} %{size_download}\n' http://127.0.0.1:18144/; head -c 300 /tmp/ocs.html; echo
# MODX 2.8.9
./prod-up.sh mx2 18132 13332 $SRC/modx/dist-2.8.9/$(ls $SRC/modx/dist-2.8.9 | head -1) | tail -1
sed 's/<language>ru/<language>ru/' /tmp/modx3.xml > /tmp/modx2.xml
docker cp /tmp/modx2.xml bs-prod-mx2:/tmp/modx.xml; docker exec bs-prod-mx2 chmod 644 /tmp/modx.xml
s=$(date +%s); docker exec bs-prod-mx2 sh -c "cd /var/www/html/setup && $ASW php index.php --installmode=new --config=/tmp/modx.xml 2>&1 | tail -6 | cut -c1-240"; echo "mx2 install $(( $(date +%s)-s )) s"
curl -s -o /tmp/mx2.html -w 'mx2 home %{http_code} %{size_download}\n' -H 'Host: prod.spike.test' http://127.0.0.1:18132/
echo INSTALL-REST-DONE
