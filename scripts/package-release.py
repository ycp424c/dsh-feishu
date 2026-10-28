#!/usr/bin/env python3
import datetime,hashlib,json,os,pathlib,posixpath,subprocess,sys,tarfile
root=pathlib.Path(__file__).resolve().parent.parent
subprocess.run([sys.executable,str(root/'scripts/prepare-runtime.py')],check=True)
runtime=pathlib.Path(os.environ.get('DSH_FEISHU_RUNTIME_SOURCE',str(root/'runtime'))).resolve()
meta=json.loads((root/'package.json').read_text());stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
name='dsh-feishu-'+meta['version']+'-'+stamp;output=root/'dist'/(name+'.tar.gz');output.parent.mkdir(exist_ok=True)
allowed=['package.json','package-lock.json','cordis.patch.yml','src','test','scripts','deploy','docs','examples','runtime','node_modules','upstream.lock.json','README.md','LICENSE','LICENSE.upstream','THIRD_PARTY_NOTICES.md','licenses','README.zh-CN.md','CONTRIBUTING.md','SECURITY.md','CHANGELOG.md']
def include(info):
    if any(part in ['.git','.local','__pycache__'] for part in pathlib.PurePosixPath(info.name).parts):return None
    if info.issym() and info.name.startswith('node_modules/@deepseek-ai/'):
        info.linkname=posixpath.relpath('runtime/node_modules/@deepseek-ai/'+pathlib.PurePosixPath(info.name).name,posixpath.dirname(info.name))
    return info
with tarfile.open(output,'w:gz') as tf:
    for item in allowed:
        if item=='runtime':
            for manifest_name in ['package.json','package-lock.json']:tf.add(root/'runtime'/manifest_name,arcname='runtime/'+manifest_name,filter=include)
            tf.add(runtime/'node_modules',arcname='runtime/node_modules',filter=include)
        elif (root/item).exists():tf.add(root/item,arcname=item,filter=include)
manifest={'release':name,'file':output.name,'version':meta['version'],'sha256':hashlib.sha256(output.read_bytes()).hexdigest(),'bytes':output.stat().st_size,'dshVersion':'0.2.0-rc.2','contractVersion':1,'runtimeLockSha256':hashlib.sha256((root/'runtime/package-lock.json').read_bytes()).hexdigest()}
(root/'dist/release.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps(manifest))
