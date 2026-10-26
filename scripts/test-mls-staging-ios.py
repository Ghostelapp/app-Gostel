#!/usr/bin/env python3
"""Install and exercise only the synthetic staging app in a dedicated simulator.
Reads a diagnostics database (status only), never the encrypted vault or keys.
"""
import json
from pathlib import Path
import plistlib
import sqlite3
import subprocess
import time

root = Path(__file__).resolve().parent.parent
app = root / '.cache/mls-staging-ios/Build/Products/Release-iphonesimulator/GhostelStaging.app'
if not (app / 'Info.plist').exists(): raise SystemExit('Build the staging simulator app first')
with (app / 'Info.plist').open('rb') as file: info = plistlib.load(file)
if info.get('CFBundleIdentifier') != 'app.ghostel.staging': raise SystemExit('Refusing to install a non-staging app')
bundle = info['CFBundleIdentifier']
def sim(*args):
    return subprocess.check_output(['xcrun', 'simctl', *args], text=True).strip()
devices = json.loads(sim('list', 'devices', '--json'))['devices']
matches = [d for group in devices.values() for d in group if d.get('isAvailable') and d['name'] == 'Ghostel MLS Staging']
if len(matches) != 1: raise SystemExit('Create exactly one available simulator named Ghostel MLS Staging first')
device = matches[0]
if device['state'] != 'Booted': sim('boot', device['udid'])
sim('bootstatus', device['udid'], '-b')
sim('install', device['udid'], str(app))
data = Path(sim('get_app_container', device['udid'], bundle, 'data'))
database = data / 'Documents/SQLite/ghostel-mls-diagnostics.db'
def results():
    if not database.exists(): return []
    with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as db:
        try: return [json.loads(row[0]) for row in db.execute('SELECT result FROM results ORDER BY id')]
        except sqlite3.OperationalError: return []
def run():
    count = len(results())
    subprocess.run(['xcrun', 'simctl', 'terminate', device['udid'], bundle], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    # Simulator builds explicitly enable the synthetic startup check.
    sim('launch', device['udid'], bundle)
    for attempt in range(120):
        values = results()
        if len(values) > count:
            outcome = values[-1]
            if outcome.get('status') != 'PASS': raise RuntimeError(str(outcome))
            return outcome
        time.sleep(1)
    raise RuntimeError('Native diagnostic timed out; inspect staging app logs')
first = run()
sim('terminate', device['udid'], bundle)
second = run()
if second['persistedRuns'] != first['persistedRuns'] + 1: raise RuntimeError('Native state did not survive process restart')
print(json.dumps({'status':'PASS', 'checks':['native WebView/WASM exchange', 'SQLite + SecureStore persistence', 'process restart'], 'platform': second['platform'], 'bytes': second['bytes'], 'persistedRuns': second['persistedRuns']}))
sim('terminate', device['udid'], bundle)
