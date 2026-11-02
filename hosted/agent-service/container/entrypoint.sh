#!/bin/sh
# Runs inside the one-off agent container (docs/ARCHITECTURE.md §6). The container has no network
# (--network none); model requests leave only through the proxy socket mounted at /run/weave.
set -eu
socat TCP-LISTEN:4321,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/run/weave/proxy.sock &
sleep 0.2
exec "$@"
