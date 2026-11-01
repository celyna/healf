import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const template = readFileSync(new URL('./.env.example', import.meta.url),'utf8');
const secrets = { ADMIN_PASSWORD:randomBytes(24).toString('base64url'), ENCRYPTION_KEY:randomBytes(32).toString('hex'), WEBHOOK_VERIFICATION_TOKEN:randomBytes(24).toString('base64url'), NTFY_TOPIC:'oura-'+randomBytes(20).toString('hex') };
let result = template;
for (const [key,value] of Object.entries(secrets)) result = result.replace(`${key}=\n`,`${key}=${value}\n`);
try { writeFileSync('.env',result,{flag:'wx',mode:0o600}); console.log('Created .env with fresh secrets. Add your Oura credentials and ntfy settings. Existing files are never overwritten.'); }
catch(e) { if(e.code==='EEXIST') { console.error('.env already exists; keeping it unchanged.'); process.exitCode=1; } else throw e; }
