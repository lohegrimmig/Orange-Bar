#!/bin/bash
set -e
ENV=/var/www/orange-bar/.env
if grep -q 'www.mintlylab.com' "$ENV"; then
  echo 'www already in TRUSTED_APPS'
else
  sudo sed -i 's|https://ilf.assistentenplanung.de|https://ilf.assistentenplanung.de,https://www.mintlylab.com|' "$ENV"
  sudo systemctl restart orange-bar
  echo 'updated'
fi
grep ORANGE_TRUSTED_APPS "$ENV"
systemctl is-active orange-bar