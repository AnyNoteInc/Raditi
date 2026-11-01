#!/bin/bash
# The same previews under real gVisor (Colima, profile gvisor), probed from inside the container: PHP, MariaDB and Apache under runsc.
export DOCKER_CONTEXT=colima-gvisor
B=<work>/research/boot-spike
export FILES_MJS=$B/scripts/files-patched.mjs
probe() { # probe <container> <host> <port> <paths...>
  c=$1; h=$2; pt=$3; shift 3
  docker exec -i $c php -r '
    [$x,$h,$pt]=array_slice($argv,0,3); foreach (array_slice($argv,3) as $p) {
      $s=microtime(true); $ctx=stream_context_create(["http"=>["header"=>"Host: $h:$pt\r\n","ignore_errors"=>true,"timeout"=>60,"follow_location"=>0]]);
      $b=@file_get_contents("http://127.0.0.1:8080$p",false,$ctx); $st=$http_response_header[0]??"NO-ANSWER";
      printf("%-36s %s %d bytes %d ms | first: %s\n",$p,$st,strlen((string)$b),(microtime(true)-$s)*1000,substr(preg_replace("/\s+/"," ",(string)$b),0,50));
    }' "$h" "$pt" "$@"
}
run() { tag=$1; work=$2; host=$3; port=$4; shift 4
  echo "=== $tag under runsc"
  start=$(date +%s)
  ./preview-up.sh $tag $host $port $work runsc 2>&1 | grep -v ssl-verify | tail -2 | cut -c1-170
  docker inspect -f 'runtime={{.HostConfig.Runtime}} running={{.State.Running}}' bs-pv-$tag
  docker exec bs-pv-$tag sh -c 'dmesg 2>/dev/null | head -2 | cut -c1-70'
  probe bs-pv-$tag $host $port "$@"
  docker logs bs-pv-$tag 2>&1 | grep -E 'PHP (Fatal|Warning)|\[error\]|ERROR' | sed 's/^\[[^]]*\] //' | cut -c1-150 | sort | uniq -c | sort -rn | head -4
  echo "total $(( $(date +%s)-start )) s"
  docker rm -f bs-pv-$tag >/dev/null; docker volume rm -f bs-pv-$tag-files bs-pv-$tag-db >/dev/null
}
run j5 $B/work/j5 site-j5-chat-a.localhost 28105 / /blog /blog/welcome-to-your-blog /sample-layouts/category-list /nope /administrator/index.php
run oc4 $B/work/oc4c site-oc4-chat-a.localhost 28141 / /en-gb/catalog/desktops /en-gb/product/iphone /nope /admin/
run oc3 $B/work/oc3 site-oc3-chat-a.localhost 28143 / /desktops /about_us /canon-eos-5d /nope /admin/
run mx3 $B/work/mx3 site-mx3-chat-a.localhost 28131 / /o-kompanii.html /novosti/ /novosti/pervaya.html /nope /manager/
run mx2 $B/work/mx2 site-mx2-chat-a.localhost 28132 / /o-kompanii.html /novosti/pervaya.html /manager/
echo RUNSC-DONE
