#!/bin/sh
echo "### models (hardened, enabled_providers)"; "$OC" models 2>&1 | head -12
echo "### debug config: how secrets print"; "$OC" debug config 2>&1 | grep -n -E 'apiKey|Authorization|dummy' | sed 's/raditi-glm-dummy-[a-z]*-token-0*/<DUMMY-TOKEN-IN-CLEAR>/' | head
echo "### providers list"; "$OC" providers list 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | head -8
