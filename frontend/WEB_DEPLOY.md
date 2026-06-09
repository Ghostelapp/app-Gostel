# ghostel.app Web App

The Expo frontend can also run as an installable browser application at
`https://app.ghostel.app`.

## Build

```bash
cd ~/apps/app-Gostel/frontend
export EXPO_PUBLIC_BACKEND_URL=https://api.ghostel.app
yarn install
yarn web:build
```

The production files are generated in `frontend/dist-web`.

## Deploy

```bash
sudo mkdir -p /var/www/ghostel-web-app
sudo cp -r dist-web/* /var/www/ghostel-web-app/
sudo chown -R www-data:www-data /var/www/ghostel-web-app
sudo nginx -t
sudo systemctl reload nginx
```

Use the example Nginx configuration from `frontend/deploy/app.ghostel.app.nginx`.
After DNS starts resolving, enable HTTPS:

```bash
sudo certbot --nginx -d app.ghostel.app
```

## Verify

```bash
curl -I https://app.ghostel.app
curl https://app.ghostel.app/manifest.webmanifest
curl https://api.ghostel.app/api/
```
