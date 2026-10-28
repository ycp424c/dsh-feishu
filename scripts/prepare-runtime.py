#!/usr/bin/env python3
import hashlib,json,os,pathlib
root=pathlib.Path(__file__).resolve().parent.parent
lock=json.loads((root/'upstream.lock.json').read_text())
if hashlib.sha256((root/'runtime/package-lock.json').read_bytes()).hexdigest()!=lock['runtimeLockSha256']:raise SystemExit('Runtime lock mismatch')
runtime=pathlib.Path(os.environ.get('DSH_FEISHU_RUNTIME_SOURCE',str(root/'runtime'))).resolve()
source_digest=hashlib.sha256((runtime/'package-lock.json').read_bytes()).hexdigest()
if source_digest not in {lock['runtimeLockSha256'],lock.get('runtimeOriginLockSha256')}:raise SystemExit('Runtime source provenance mismatch')
meta=json.loads((root/'package.json').read_text())
for name,version in meta['peerDependencies'].items():
    target=runtime/'node_modules'/name
    if json.loads((target/'package.json').read_text())['version']!=version:raise SystemExit('Host peer mismatch: '+name)
    link=root/'node_modules'/name;link.parent.mkdir(parents=True,exist_ok=True)
    if link.is_symlink():link.unlink()
    elif link.exists():raise SystemExit('Refusing to replace host dependency directory: '+name)
    link.symlink_to(os.path.relpath(target,link.parent),target_is_directory=True)
print('Fixed host peers ready')
