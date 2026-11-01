#!/bin/zsh
for rt in runc runsc; do for v in 5.6 7.4 8.3 8.5; do for m in current stack; do
  echo "=== $v $rt $m"; timeout 170 ./run.sh $v $rt $m 2>&1 | grep -v "io_uring\|create_uring" | cut -c1-2600
done; done; done
echo MATRIX-DONE
