#!/usr/bin/env python3
"""DSH-compatible workspace runner; credentials and private state stay outside."""
import argparse,json,os,pathlib,sys

SAFE_ENV={'PATH','LANG','LANGUAGE','TZ','TERM','COLORTERM','NO_COLOR'}
def child_environment(environment, workspace):
    result={k:v for k,v in environment.items() if k in SAFE_ENV or k.startswith('LC_')}
    result.update(HOME=str(workspace),TMPDIR='/tmp')
    return result

def command(root,binary,arguments,environment,*,protect_paths=(),readonly_roots=(),attachment_environment='DSH_FEISHU_ALLOWED_FILES',legacy_profile=False,browser_assets=None):
    root=pathlib.Path(root).resolve();workspace=root/'state/workspace'
    if '--' not in arguments:raise ValueError('Missing command separator')
    split=arguments.index('--');profile,argv=arguments[:split],arguments[split+1:]
    if not argv:raise ValueError('Missing command')
    writable=any(profile[i]=='--bind' and pathlib.Path(profile[i+1]).resolve()==workspace.resolve() and pathlib.Path(profile[i+2]).resolve()==workspace.resolve() for i in range(max(0,len(profile)-2)))
    mounts=[]
    if legacy_profile:
        prefix=profile
        for mask in [root/'state',*map(pathlib.Path,protect_paths)]:
            if mask.exists():mounts+=['--tmpfs',str(mask)]
    else:
        prefix=['--unshare-pid','--die-with-parent','--dev','/dev','--proc','/proc','--tmpfs','/tmp']
        system_roots=['/usr','/bin','/sbin','/lib','/lib64','/etc/ssl/certs','/etc/ld.so.cache','/etc/resolv.conf','/etc/hosts','/etc/nsswitch.conf','/etc/passwd','/etc/group']
        for item in [*system_roots,*map(str,readonly_roots)]:
            p=pathlib.Path(item)
            if p.exists():
                actual=p.resolve();prefix+=['--ro-bind',str(actual),str(actual)]
                if actual!=p:prefix+=['--ro-bind',str(actual),str(p)]
    mounts+=['--bind' if writable else '--ro-bind',str(workspace),str(workspace)]
    if browser_assets:
        assets=pathlib.Path(browser_assets).resolve(strict=True)
        mounts+=['--dir',str(assets.parent),'--ro-bind',str(assets),str(assets)]
    for path in json.loads(environment.get(attachment_environment,'[]')):
        p=pathlib.Path(path).resolve(strict=True)
        if not p.is_relative_to(root/'state/dsh') or not p.is_file():raise ValueError('Invalid attachment mount')
        mounts+=['--dir',str(p.parent),'--ro-bind',str(p),str(p)]
    return [str(binary),*prefix,'--unshare-user','--new-session',*mounts,'--',*argv]

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--root',required=True);parser.add_argument('--bwrap',required=True)
    parser.add_argument('--readonly-root',action='append',default=[]);parser.add_argument('--protect',action='append',default=[])
    args,rest=parser.parse_known_args()
    try:
        argv=command(args.root,args.bwrap,rest,os.environ,readonly_roots=args.readonly_root,protect_paths=args.protect)
        os.execve(args.bwrap,argv,child_environment(os.environ,pathlib.Path(args.root)/'state/workspace'))
    except Exception:
        print('FEISHU_SANDBOX_UNAVAILABLE',file=sys.stderr);return 125
if __name__=='__main__':sys.exit(main())
