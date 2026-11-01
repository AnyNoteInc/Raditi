ARG V=8.3
FROM raditi-research-site:${V}
ARG V=8.3
COPY loaders/ioncube_loader_lin_${V}.so /usr/local/lib/raditi/ioncube/loader.so
COPY base.ini /etc/php/${V}/apache2/conf.d/10-raditi.ini
COPY base.ini /etc/php/${V}/cli/conf.d/10-raditi.ini
COPY --chmod=0755 no-sendmail.sh /usr/local/lib/raditi/no-sendmail
COPY --chmod=0755 entry.sh /usr/local/lib/raditi/entry.sh
COPY t.php t2.php bitrix_server_test.php /usr/local/lib/raditi/
COPY apache.conf /usr/local/lib/raditi/apache.conf
RUN echo "zend_extension=/usr/local/lib/raditi/ioncube/loader.so" > /etc/php/${V}/apache2/conf.d/00-ioncube.ini; cp /etc/php/${V}/apache2/conf.d/00-ioncube.ini /etc/php/${V}/cli/conf.d/00-ioncube.ini; apt-get -v >/dev/null; rm -f /var/www/html/index.html; install -d -o 999 -g 999 -m 0700 /var/lib/mysql; install -d -o 33 -g 33 /var/www/html
