#!/usr/bin/env bash
set -euo pipefail
cd /var/www/orange-bar
git fetch origin
ts=$(date +%s)
cp -a public/app.js "public/app.js.bak.$ts"
cp -a public/style.css "public/style.css.bak.$ts"
git checkout origin/main -- public/style.css public/i18n.js public/index.html public/ob-path.js
sed -i "s/className = 'nft-grid'/className = 'nft-list'/" public/app.js
sed -i 's/orange-bar-v9/orange-bar-v10/' public/sw.js
chown www-data:www-data public/style.css public/i18n.js public/index.html public/ob-path.js public/app.js public/sw.js
systemctl restart orange-bar
sleep 2
systemctl is-active orange-bar
curl -sS http://127.0.0.1:8787/api/health | head -c 400
echo