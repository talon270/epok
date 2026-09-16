#!/bin/sh
# epok — serve locally so reminders work.
#
# file:// is not a secure context, so Chrome will not grant notification
# permission and will not register a service worker. localhost IS a secure
# context. Everything except reminders works by opening index.html directly.
#
#   ./serve.sh   then open http://localhost:8731

cd "$(dirname "$0")" || exit 1
echo "epok → http://localhost:8731"
exec python3 -m http.server 8731 --bind 127.0.0.1
