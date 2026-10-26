#!/usr/bin/env python3
"""Persistent loopback staging, isolated from repository .env and push credentials.
Run with the staging venv. Ctrl-C stops both processes and retains test data.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
from pymongo import MongoClient

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('--smoke', action='store_true', help='Run full-backend MLS smoke test, then stop')
args = parser.parse_args()
folder = root / '.cache/mls-staging'
folder.mkdir(parents=True, exist_ok=True, mode=0o700)
lock = (folder / 'run.lock').open('w')
try:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    raise SystemExit('MLS staging is already running')
for port in (18794, 28794):
    with socket.socket() as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try: sock.bind(('127.0.0.1', port))
        except OSError: raise SystemExit(f'Port {port} is occupied; refusing to reuse an unknown service')
binary = root / '.cache/mongodb-test/mongod'
if not binary.is_file(): raise SystemExit('Install the official MongoDB binary at .cache/mongodb-test/mongod first')
credentials = folder / 'credentials.json'
if not credentials.exists():
    with credentials.open('x') as out:
        os.chmod(credentials, 0o600)
        json.dump({key: secrets.token_urlsafe(40) for key in ('jwt', 'admin', 'demo', 'alice', 'bob')}, out)
secret = json.loads(credentials.read_text())
# Copy executable source only: never copy .env, credentials, uploads or fixtures.
backend = folder / 'backend'
backend.mkdir(exist_ok=True)
for source in (root / 'backend').glob('*.py'): shutil.copyfile(source, backend / source.name)
if (backend / '.env').exists(): raise SystemExit('Unexpected .env in staging copy; refusing to start')
(folder / 'mongo').mkdir(exist_ok=True)
env = {key: os.environ[key] for key in ('PATH', 'HOME', 'TMPDIR', 'LANG') if key in os.environ}
env.update(MONGO_URL='mongodb://127.0.0.1:28794/?replicaSet=ghostel_staging', DB_NAME='ghostel_mls_staging',
    JWT_SECRET=secret['jwt'], ADMIN_EMAIL='staging-admin@example.com', ADMIN_PASSWORD=secret['admin'],
    DEMO_EMAIL='staging-demo@example.com', DEMO_PASSWORD=secret['demo'], MLS_ENABLED='true',
    SUPPORT_CONTACT_API_URL='http://127.0.0.1:18794/staging-support-disabled',
    APP_NAME='Ghostel Staging', CORS_ORIGINS='http://127.0.0.1:19006,http://localhost:19006',
    PYTHONUNBUFFERED='1')
mongo = api = None
try:
    mongo = subprocess.Popen([str(binary), '--dbpath', str(folder / 'mongo'), '--port', '28794', '--bind_ip', '127.0.0.1', '--nounixsocket', '--replSet', 'ghostel_staging', '--logpath', str(folder / 'mongo.log'), '--logappend'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    direct = MongoClient('mongodb://127.0.0.1:28794/?directConnection=true', serverSelectionTimeoutMS=500)
    for attempt in range(120):
        try: direct.admin.command('ping'); break
        except Exception:
            if mongo.poll() is not None: raise RuntimeError('MongoDB failed; see .cache/mls-staging/mongo.log')
            time.sleep(.25)
    try: direct.admin.command('replSetGetStatus')
    except Exception as error:
        if getattr(error, 'code', None) != 94: raise
        direct.admin.command('replSetInitiate', {'_id': 'ghostel_staging', 'members': [{'_id': 0, 'host': '127.0.0.1:28794'}]})
    for attempt in range(120):
        if direct.admin.command('hello').get('isWritablePrimary'): break
        time.sleep(.25)
    direct.close()
    with (folder / 'api.log').open('a') as logs:
        api = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'server:app', '--host', '127.0.0.1', '--port', '18794', '--log-level', 'warning'], cwd=backend, env=env, stdout=logs, stderr=logs)
        for attempt in range(120):
            try:
                with urllib.request.urlopen('http://127.0.0.1:18794/api/', timeout=.5): break
            except Exception:
                if api.poll() is not None: raise RuntimeError('Backend failed; see .cache/mls-staging/api.log')
                time.sleep(.25)
        else: raise RuntimeError('Backend readiness timed out')
        print('Ghostel Staging: http://127.0.0.1:18794 (MLS enabled; loopback only)', flush=True)
        print('Synthetic account secrets: .cache/mls-staging/credentials.json; Ctrl-C stops services.', flush=True)
        if args.smoke:
            result = subprocess.run(['node', 'scripts/smoke-mls-staging.cjs'], cwd=root, env=dict(env, GHOSTEL_MLS_TEST_URL='http://127.0.0.1:18794'))
            raise SystemExit(result.returncode)
        while api.poll() is None and mongo.poll() is None: time.sleep(1)
        raise RuntimeError('A staging process exited unexpectedly; inspect staging logs')
except KeyboardInterrupt:
    print('Stopping local staging; test data retained.')
finally:
    for process in (api, mongo):
        if process is not None:
            process.terminate()
            try: process.wait(timeout=10)
            except subprocess.TimeoutExpired: process.kill(); process.wait()
