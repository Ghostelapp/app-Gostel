#!/usr/bin/env python3
"""Starts only fresh loopback test services; never reads .env or production DBs."""
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.request
from pymongo import MongoClient

root = Path(__file__).resolve().parent.parent
binary = root / '.cache/mongodb-test/mongod'
if not binary.is_file():
    raise SystemExit('Missing local MongoDB test binary: .cache/mongodb-test/mongod')
def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]
port, http = free_port(), free_port()
with tempfile.TemporaryDirectory(prefix='ghostel-mls-integration-') as tmp:
    mongo = subprocess.Popen([str(binary), '--dbpath', tmp, '--port', str(port), '--bind_ip', '127.0.0.1', '--nounixsocket', '--replSet', 'ghostel-mls-test', '--logpath', tmp + '/mongo.log'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    server = None
    try:
        direct = MongoClient(f'mongodb://127.0.0.1:{port}/?directConnection=true', serverSelectionTimeoutMS=500)
        for i in range(60):
            try:
                direct.admin.command('ping'); break
            except Exception:
                time.sleep(.25)
        direct.admin.command('replSetInitiate', {'_id': 'ghostel-mls-test', 'members': [{'_id': 0, 'host': f'127.0.0.1:{port}'}]})
        for i in range(120):
            if direct.admin.command('hello').get('isWritablePrimary'): break
            time.sleep(.25)
        direct.close()
        env = dict(os.environ, GHOSTEL_MLS_TEST_HARNESS='1', GHOSTEL_MLS_TEST_MONGO=f'mongodb://127.0.0.1:{port}/?replicaSet=ghostel-mls-test')
        with open(tmp + '/api.log', 'w') as api_log:
            server = subprocess.Popen([os.sys.executable, '-m', 'uvicorn', 'backend.tests.mls_test_server:make_app', '--factory', '--host', '127.0.0.1', '--port', str(http), '--log-level', 'warning'], cwd=root, env=env, stdout=api_log, stderr=api_log)
            for i in range(120):
                try:
                    with urllib.request.urlopen(f'http://127.0.0.1:{http}/ready', timeout=.5): break
                except Exception:
                    if server.poll() is not None: raise RuntimeError(Path(tmp + '/api.log').read_text())
                    time.sleep(.25)
            result = subprocess.run(['node', '--test', 'tests/mls-integration.cjs'], cwd=root, env=dict(os.environ, GHOSTEL_MLS_TEST_URL=f'http://127.0.0.1:{http}'))
            if result.returncode: print(Path(tmp + '/api.log').read_text())
            raise SystemExit(result.returncode)
    finally:
        for process in (server, mongo):
            if process is not None:
                process.terminate()
                try: process.wait(timeout=10)
                except subprocess.TimeoutExpired: process.kill(); process.wait()
