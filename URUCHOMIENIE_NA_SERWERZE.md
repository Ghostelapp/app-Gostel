# Ghostel - uruchomienie na zewnetrznym serwerze

Ten plik jest napisany najprosciej jak sie da. Celem jest postawienie:

- backendu aplikacji Ghostel,
- strony WWW i panelu z repo `webapp1`,
- MongoDB,
- Nginx + HTTPS,
- konfiguracji pod aplikacje mobilna.

Zakladam Ubuntu 24.04 LTS na VPS.

## 1. Jaki serwer wybrac

Najprosciej: wybierz VPS w Europie, najlepiej Ubuntu 24.04 LTS.

Moja rekomendacja na start:

- minimum do testow: 2 vCPU, 4 GB RAM, 60-80 GB NVMe,
- sensowny start produkcyjny: 4 vCPU, 8 GB RAM, 120 GB NVMe,
- gdy bedzie wiecej uzytkownikow: osobna baza MongoDB albo wiekszy VPS.

Najlepszy wybor dla Ghostel na start:

1. Hetzner Cloud - dobra cena/wydajnosc, lokalizacje w Europie, prosta administracja. Wybralbym jako pierwszy wybor, jesli nie potrzebujesz polskiego panelu i polskiego wsparcia.
2. OVHcloud VPS - dobry wybor, jesli chcesz panel po polsku, ochrone Anty-DDoS, codzienne backupy w cenie i europejskie centrum danych.
3. DigitalOcean - bardzo prosty panel, ale zwykle wychodzi drozej za podobne zasoby.

Na start bierz:

```text
Ubuntu 24.04 LTS
4 vCPU
8 GB RAM
120 GB NVMe
lokalizacja: Niemcy / Francja / Polska albo najblizej uzytkownikow
```

Zrodla do sprawdzenia przed zakupem:

- Hetzner informuje o aktualizacjach cen i nowych planach Cloud: https://docs.hetzner.cloud/whats-new
- OVHcloud opisuje VPS, backupy, Anty-DDoS, IPv4 i nielimitowany transfer: https://www.ovhcloud.com/pl/vps/

## 2. Domeny

Najprostszy uklad:

```text
ghostel.app          -> strona WWW
www.ghostel.app      -> strona WWW
api.ghostel.app      -> backend aplikacji mobilnej
panel-api.ghostel.app -> backend strony/panelu
```

W panelu domeny dodaj rekordy DNS typu `A`:

```text
ghostel.app           A   IP_TWOJEGO_SERWERA
www.ghostel.app       A   IP_TWOJEGO_SERWERA
api.ghostel.app       A   IP_TWOJEGO_SERWERA
panel-api.ghostel.app A   IP_TWOJEGO_SERWERA
```

Po zmianie DNS czasem trzeba poczekac od kilku minut do kilku godzin.

## 3. Pierwsze logowanie na serwer

Na swoim komputerze:

```bash
ssh root@IP_TWOJEGO_SERWERA
```

Zaktualizuj system:

```bash
apt update && apt upgrade -y
```

Dodaj zwyklego uzytkownika:

```bash
adduser ghostel
usermod -aG sudo ghostel
```

Zaloguj sie juz jako `ghostel`:

```bash
su - ghostel
```

## 4. Instalacja pakietow

```bash
sudo apt update
sudo apt install -y git curl unzip nginx certbot python3-certbot-nginx python3 python3-venv python3-pip docker.io docker-compose-plugin ufw dnsutils
```

Wlacz Dockera:

```bash
sudo systemctl enable --now docker
sudo usermod -aG docker ghostel
```

Wyloguj sie i zaloguj ponownie, zeby grupa `docker` zadzialala:

```bash
exit
ssh ghostel@IP_TWOJEGO_SERWERA
```

Zainstaluj Node 20 i Yarn:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g yarn@1.22.22
node -v
yarn -v
```

## 5. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

Nie otwieraj publicznie portow `8000`, `8001` ani `27017`. Ma je widziec tylko lokalny serwer.

## 6. MongoDB

Najprosciej na start przez Docker:

```bash
docker run -d \
  --name ghostel-mongo \
  --restart unless-stopped \
  -p 127.0.0.1:27017:27017 \
  -v ghostel-mongo-data:/data/db \
  mongo:7
```

Sprawdzenie:

```bash
docker ps
```

## 7. Pobranie kodu

Utworz katalog:

```bash
mkdir -p ~/apps
cd ~/apps
```

Pobierz aplikacje:

```bash
git clone ADRES_REPO_APP_GHOSTEL app-Gostel
```

`ADRES_REPO_APP_GHOSTEL` zamien na adres repozytorium aplikacji, np. `git@github.com:TwojeKonto/app-Gostel.git`.

Pobierz strone:

```bash
git clone https://github.com/Ghostelapp/webapp1.git webapp1
```

Jesli repo aplikacji jest prywatne, uzyj adresu SSH z GitHuba.

## 8. Backend aplikacji Ghostel

Wejdz do backendu:

```bash
cd ~/apps/app-Gostel/backend
python3 -m venv .venv
. .venv/bin/activate
pip install --upgrade pip wheel setuptools
pip install -r requirements.txt
```

Utworz `.env`:

```bash
cp .env.example .env
nano .env
```

Ustaw minimum:

```env
MONGO_URL=mongodb://127.0.0.1:27017
DB_NAME=ghostel
JWT_SECRET=TU_WKLEJ_DLUGI_LOSOWY_SEKRET
APP_NAME=Ghostel

ADMIN_EMAIL=twoj-admin@ghostel.app
ADMIN_PASSWORD=TU_MOCNE_HASLO_ADMINA
DEMO_EMAIL=demo@ghostel.app
DEMO_PASSWORD=TU_MOCNE_HASLO_DEMO

CORS_ORIGINS=https://ghostel.app,https://www.ghostel.app
FCM_SERVICE_ACCOUNT_PATH=/home/ghostel/apps/app-Gostel/backend/firebase-service-account.json
```

Sekret JWT wygenerujesz tak:

```bash
openssl rand -hex 32
```

Firebase:

1. Wejdz w Firebase Console.
2. Project settings.
3. Service accounts.
4. Generate new private key.
5. Zapisz plik jako:

```bash
~/apps/app-Gostel/backend/firebase-service-account.json
```

Uprawnienia:

```bash
chmod 600 ~/apps/app-Gostel/backend/firebase-service-account.json
```

Test backendu:

```bash
cd ~/apps/app-Gostel/backend
. .venv/bin/activate
python -m uvicorn server:app --host 127.0.0.1 --port 8000
```

W drugim terminalu:

```bash
curl http://127.0.0.1:8000/api/
```

Jesli widzisz `status: ok`, backend dziala.

Zatrzymaj test `CTRL+C`.

## 9. Service systemd dla backendu aplikacji

Utworz plik:

```bash
sudo nano /etc/systemd/system/ghostel-app.service
```

Wklej:

```ini
[Unit]
Description=Ghostel mobile app backend
After=network.target docker.service

[Service]
User=ghostel
WorkingDirectory=/home/ghostel/apps/app-Gostel/backend
EnvironmentFile=/home/ghostel/apps/app-Gostel/backend/.env
ExecStart=/home/ghostel/apps/app-Gostel/backend/.venv/bin/python -m uvicorn server:app --host 127.0.0.1 --port 8000
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Wlacz:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ghostel-app
sudo systemctl status ghostel-app
```

Logi:

```bash
journalctl -u ghostel-app -f
```

## 10. Backend strony i panelu `webapp1`

```bash
cd ~/apps/webapp1/backend
python3 -m venv .venv
. .venv/bin/activate
pip install --upgrade pip wheel setuptools
pip install -r requirements.txt
cp .env.example .env
nano .env
```

Ustaw:

```env
MONGO_URL=mongodb://127.0.0.1:27017
DB_NAME=ghostel_web
JWT_SECRET=TU_INNY_DLUGI_LOSOWY_SEKRET
ADMIN_EMAIL=twoj-admin@ghostel.app
ADMIN_PASSWORD=TU_MOCNE_HASLO_ADMINA
FRONTEND_URL=https://ghostel.app

GHOSTEL_API_URL=https://api.ghostel.app/api
GHOSTEL_ADMIN_EMAIL=twoj-admin@ghostel.app
GHOSTEL_ADMIN_PASSWORD=TU_HASLO_ADMINA_Z_BACKENDU_APLIKACJI
SEED_SAMPLE_DATA=false
```

Test:

```bash
python -m uvicorn server:app --host 127.0.0.1 --port 8001
```

W drugim terminalu:

```bash
curl http://127.0.0.1:8001/api/
```

Zatrzymaj test `CTRL+C`.

Service:

```bash
sudo nano /etc/systemd/system/ghostel-web-api.service
```

Wklej:

```ini
[Unit]
Description=Ghostel website/admin backend
After=network.target docker.service

[Service]
User=ghostel
WorkingDirectory=/home/ghostel/apps/webapp1/backend
EnvironmentFile=/home/ghostel/apps/webapp1/backend/.env
ExecStart=/home/ghostel/apps/webapp1/backend/.venv/bin/python -m uvicorn server:app --host 127.0.0.1 --port 8001
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Wlacz:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ghostel-web-api
sudo systemctl status ghostel-web-api
```

## 11. Frontend strony WWW

```bash
cd ~/apps/webapp1/frontend
yarn install
nano .env
```

Wklej:

```env
REACT_APP_BACKEND_URL=https://panel-api.ghostel.app
REACT_APP_GHOSTEL_APP_URL=https://ghostel.app/download
```

Zbuduj:

```bash
yarn build
```

Build bedzie w:

```text
~/apps/webapp1/frontend/build
```

## 12. Nginx

Utworz konfiguracje:

```bash
sudo nano /etc/nginx/sites-available/ghostel
```

Wklej i zmien domeny, jesli masz inne:

```nginx
server {
    listen 80;
    server_name ghostel.app www.ghostel.app;

    root /home/ghostel/apps/webapp1/frontend/build;
    index index.html;

    location / {
        try_files $uri /index.html;
    }
}

server {
    listen 80;
    server_name api.ghostel.app;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}

server {
    listen 80;
    server_name panel-api.ghostel.app;

    location / {
        proxy_pass http://127.0.0.1:8001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Wlacz strone:

```bash
sudo ln -s /etc/nginx/sites-available/ghostel /etc/nginx/sites-enabled/ghostel
sudo nginx -t
sudo systemctl reload nginx
```

## 13. HTTPS

Gdy DNS juz wskazuje na serwer:

```bash
sudo certbot --nginx -d ghostel.app -d www.ghostel.app -d api.ghostel.app -d panel-api.ghostel.app
```

Wybierz przekierowanie HTTP -> HTTPS, jesli certbot zapyta.

Sprawdzenie odnawiania:

```bash
sudo certbot renew --dry-run
```

## 14. Test po wdrozeniu

Sprawdz:

```bash
curl https://api.ghostel.app/api/
curl https://panel-api.ghostel.app/api/
```

Sprawdz uslugi:

```bash
sudo systemctl status ghostel-app
sudo systemctl status ghostel-web-api
sudo systemctl status nginx
docker ps
```

Sprawdz logi:

```bash
journalctl -u ghostel-app -f
journalctl -u ghostel-web-api -f
sudo tail -f /var/log/nginx/error.log
```

## 15. Konfiguracja aplikacji mobilnej

W aplikacji mobilnej musisz ustawic produkcyjny backend.

W repo `app-Gostel` ustaw:

```bash
cd ~/apps/app-Gostel/frontend
nano .env
```

Wpisz:

```env
EXPO_PUBLIC_BACKEND_URL=https://api.ghostel.app/api
```

Potem zbuduj nowa aplikacje:

```bash
yarn install
cd android
./gradlew assembleRelease
```

Do Google Play najlepiej budowac AAB:

```bash
./gradlew bundleRelease
```

Po zmianie adresu backendu trzeba zainstalowac nowa wersje aplikacji na telefonach.

## 16. Firebase Push

Sprawdz trzy rzeczy:

1. `frontend/google-services.json` ma ten sam package name co aplikacja.
2. `frontend/android/app/google-services.json` tez jest aktualny.
3. Backend ma poprawny `firebase-service-account.json`.

Po wdrozeniu zrob test:

1. Zaloguj telefon 1.
2. Zaloguj telefon 2.
3. Zamknij aplikacje na telefonie 2.
4. Wyslij wiadomosc z telefonu 1.
5. Zrob polaczenie z telefonu 1.
6. Sprawdz push i full-screen incoming call.

## 17. Backup

Najprosciej: codzienny dump MongoDB.

Utworz katalog:

```bash
mkdir -p ~/backups
```

Test backupu:

```bash
docker exec ghostel-mongo mongodump --archive=/tmp/ghostel.archive
docker cp ghostel-mongo:/tmp/ghostel.archive ~/backups/ghostel-$(date +%F).archive
```

Dodaj cron:

```bash
crontab -e
```

Wklej:

```cron
0 3 * * * docker exec ghostel-mongo mongodump --archive=/tmp/ghostel.archive && docker cp ghostel-mongo:/tmp/ghostel.archive /home/ghostel/backups/ghostel-$(date +\%F).archive
```

Raz na jakis czas kopiuj backup poza serwer.

## 18. Aktualizacja aplikacji na serwerze

Backend aplikacji:

```bash
cd ~/apps/app-Gostel
git pull
cd backend
. .venv/bin/activate
pip install -r requirements.txt
sudo systemctl restart ghostel-app
```

Strona:

```bash
cd ~/apps/webapp1
git pull
cd backend
. .venv/bin/activate
pip install -r requirements.txt
sudo systemctl restart ghostel-web-api

cd ../frontend
yarn install
yarn build
sudo systemctl reload nginx
```

## 19. Najczestsze problemy

### Domena nie dziala

Sprawdz DNS:

```bash
dig ghostel.app
dig api.ghostel.app
```

### Backend nie dziala

```bash
sudo systemctl status ghostel-app
journalctl -u ghostel-app -n 100
```

### Aplikacja mobilna nie laczy sie z backendem

Sprawdz, czy w buildzie aplikacji jest:

```env
EXPO_PUBLIC_BACKEND_URL=https://api.ghostel.app/api
```

Potem przebuduj i zainstaluj aplikacje ponownie.

### Push nie dziala

Sprawdz:

- Firebase service account na backendzie,
- `google-services.json` w Androidzie,
- package name aplikacji,
- logi backendu:

```bash
journalctl -u ghostel-app -f
```

### Certbot nie wydaje certyfikatu

Najczesciej DNS jeszcze nie wskazuje na serwer albo firewall blokuje port 80.

```bash
sudo ufw status
sudo nginx -t
```

## 20. Co zrobic przed prawdziwa produkcja

Przed publicznym startem:

- zmien wszystkie hasla testowe,
- ustaw mocne `JWT_SECRET` dla obu backendow,
- nie trzymaj sekretow w repozytorium,
- wlacz backupy VPS u operatora,
- zrob regularny backup MongoDB poza serwer,
- sprawdz polityke prywatnosci i regulamin,
- nie pisz, ze aplikacja ma SOC 2, dopoki nie ma zewnetrznego audytu,
- zrob test na dwoch telefonach: wiadomosci, push, polaczenia, wygaszony ekran, odrzucanie polaczen.

## 21. Najprostsza decyzja

Gdybym mial wybrac teraz bez komplikowania:

```text
VPS: Hetzner Cloud albo OVHcloud
System: Ubuntu 24.04 LTS
Rozmiar: 4 vCPU / 8 GB RAM / 120 GB NVMe
Baza: MongoDB w Dockerze na tym samym VPS
Proxy: Nginx
SSL: Certbot Let's Encrypt
```

To wystarczy na start, testy, pierwszych uzytkownikow i publikacje aplikacji. Gdy ruch urosnie, wtedy rozdzielamy baze MongoDB na osobny serwer albo usluge managed.
