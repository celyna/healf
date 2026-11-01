import pathlib, urllib.request, urllib.error, base64, json
env = dict(line.split('=',1) for line in pathlib.Path('/opt/oura-ntfy/.env').read_text().splitlines() if '=' in line and not line.startswith('#'))
login = dict(line.split(': ',1) for line in pathlib.Path('/opt/private-ntfy/phone-login.txt').read_text().splitlines())
base = env['NTFY_SERVER']
phone = 'Basic '+base64.b64encode(('phone:'+login['Password']).encode()).decode()
publisher = 'Bearer '+env['NTFY_TOKEN']
def request(path, auth=None, data=None):
    headers = {'Authorization':auth} if auth else {}
    req = urllib.request.Request(base+path,headers=headers,data=data)
    try:
        with urllib.request.urlopen(req,timeout=20) as r: return r.status
    except urllib.error.HTTPError as e: return e.code
checks = [
    ('Anonymous read denied',request('/oura-health/json?poll=1') in (401,403)),
    ('Anonymous publish denied',request('/oura-health',data=b'Unauthorized probe') in (401,403)),
    ('Phone can read',request('/oura-health/json?poll=1',phone)==200),
    ('Phone cannot publish',request('/oura-health',phone,b'Unauthorized probe') in (401,403)),
    ('Publisher cannot read',request('/oura-health/json?poll=1',publisher) in (401,403)),
    ('Private test published',request('/oura-health',publisher,b'Private Oura notification server is ready. No health data is included in this test.')==200)
]
for label,ok in checks: print(label+': '+('PASS' if ok else 'FAIL'))
if not all(ok for _,ok in checks): raise SystemExit(1)
