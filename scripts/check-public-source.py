#!/usr/bin/env python3
"""Check common credential patterns and private artifacts; never print secret values."""
import argparse,json,pathlib,re,subprocess,sys
root=pathlib.Path(__file__).resolve().parent.parent
parser=argparse.ArgumentParser();parser.add_argument('--history',action='store_true');args=parser.parse_args()
patterns={
    'private-key':rb'-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----',
    'github-token':rb'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b',
    'cloud-access-key':rb'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b',
    'api-key':rb'\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b',
    'slack-token':rb'\bxox[baprs]-[A-Za-z0-9-]{20,}\b',
    'private-network-url':rb'https?://(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)(?::\d+)?(?:/|\b)',
    'personal-home-path':rb'/(?:Users|home)/[A-Za-z0-9_.-]+/',
}
patterns={name:re.compile(value) for name,value in patterns.items()}
# Literal assignments are reviewed separately from variable names and placeholders.
literal=re.compile(rb"""(?i)(?:[A-Z0-9_]*(?:APP_SECRET|API_KEY|ACCESS_TOKEN|PASSWORD))[\"']?\s*[:=]\s*[\"']([A-Za-z0-9_+/.=-]{20,})[\"']""")
findings=[]
def scan(label,data):
    for kind,pattern in patterns.items():
        for match in pattern.finditer(data):findings.append({'path':label,'line':data.count(b'\n',0,match.start())+1,'kind':kind})
    for match in literal.finditer(data):
        value=match.group(1).upper()
        if value.startswith((b'REPLACE_',b'YOUR_',b'EXAMPLE_',b'SYNTHETIC_',b'FIXTURE_',b'TEST_')):continue
        findings.append({'path':label,'line':data.count(b'\n',0,match.start())+1,'kind':'literal-credential'})
raw=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z'],cwd=root)
paths=sorted(set(x.decode() for x in raw.split(b'\0') if x))
for name in paths:
    path=root/name
    if not path.is_file():continue
    parts=pathlib.PurePosixPath(name).parts
    if any(x in {'.local','node_modules','state','dist','__pycache__'} for x in parts) or path.name in {'secrets.json','credentials.json','web-login-url','.env'} or path.suffix.lower() in {'.pem','.key','.p12','.log'}:
        findings.append({'path':name,'kind':'private-artifact'})
    scan(name,path.read_bytes())
objects=0
if args.history:
    entries=subprocess.check_output(['git','rev-list','--objects','--all'],cwd=root).splitlines()
    for entry in entries:
        oid=entry.split(b' ',1)[0].decode()
        kind=subprocess.check_output(['git','cat-file','-t',oid],cwd=root).strip()
        if kind not in {b'blob',b'commit'}:continue
        data=subprocess.check_output(['git','cat-file','-p',oid],cwd=root);scan('history:'+oid[:12],data);objects+=1
print(json.dumps({'files':len(paths),'historyObjects':objects,'findings':findings},indent=2))
sys.exit(1 if findings else 0)
