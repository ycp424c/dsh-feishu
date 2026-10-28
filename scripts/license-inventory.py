#!/usr/bin/env python3
"""Generate traceable license metadata without resolving dependencies."""
import argparse,hashlib,json,pathlib,sys
root=pathlib.Path(__file__).resolve().parent.parent
p=argparse.ArgumentParser();p.add_argument('--check',action='store_true');args=p.parse_args()
packages=[];locks={}
for scope,name in [('sdk','package-lock.json'),('runtime','runtime/package-lock.json')]:
    path=root/name;locks[name]=hashlib.sha256(path.read_bytes()).hexdigest()
    for key,value in json.loads(path.read_text())['packages'].items():
        if not key:continue
        if not value.get('license'):raise SystemExit('Missing declared license: '+key)
        packages.append({'scope':scope,'name':key.split('node_modules/')[-1],'version':value['version'],'license':value['license']})
packages.sort(key=lambda x:(x['scope'],x['name'],x['version']))
text=json.dumps({'format':1,'lockfileSha256':locks,'packages':packages},indent=2)+'\n';output=root/'docs/dependency-licenses.json'
if args.check:
    if not output.exists() or output.read_text()!=text:raise SystemExit('Dependency inventory is stale; regenerate and review it')
else:output.write_text(text)
print(json.dumps({'packages':len(packages),'verified':args.check}))
