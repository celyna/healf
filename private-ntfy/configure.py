import os, pathlib, re, secrets, subprocess, json, urllib.request, urllib.error, base64
os.umask(0o077)
root = pathlib.Path('/opt/private-ntfy')
server_url = os.environ.get('NTFY_SERVER', '').rstrip('/')
if not server_url.startswith('https://'):
    raise SystemExit('Set NTFY_SERVER to your HTTPS ntfy origin.')
credentials = root / 'phone-login.txt'
if credentials.exists():
    raise SystemExit('Credentials already exist; refusing to replace them.')
def run(args, **kwargs):
    result = subprocess.run(args, capture_output=True, text=True, **kwargs)
    if result.returncode:
        raise RuntimeError('Configuration command failed: ' + ' '.join(args[:3]))
    return result.stdout + result.stderr
password = secrets.token_urlsafe(24)
publisher_password = secrets.token_urlsafe(32)
for user, pw, permission in [('phone',password,'ro'),('oura-publisher',publisher_password,'wo')]:
    run(['docker','exec','-e','NTFY_PASSWORD','oura-private-ntfy','ntfy','user','add',user],env={**os.environ,'NTFY_PASSWORD':pw})
    run(['docker','exec','oura-private-ntfy','ntfy','access',user,'oura-health',permission])
output = run(['docker','exec','oura-private-ntfy','ntfy','token','add','--label=oura-app','oura-publisher'])
match = re.search(r'\btk_[A-Za-z0-9]+\b',output)
if not match: raise RuntimeError('Could not extract publishing token; nothing logged.')
token = match.group(0)
envfile = pathlib.Path('/opt/oura-ntfy/.env')
content = envfile.read_text()
for key, value in {'NTFY_SERVER':server_url,'NTFY_TOPIC':'oura-health','NTFY_TOKEN':token}.items():
    content = re.sub(r'^'+key+r'=.*$',lambda _:key+'='+value,content,flags=re.M)
envfile.write_text(content)
envfile.chmod(0o600)
credentials.write_text('Server: '+server_url+'\nTopic: oura-health\nUsername: phone\nPassword: '+password+'\n')
credentials.chmod(0o600)
print('Private phone account and write-only application token configured. Credentials saved on server, not displayed.')
