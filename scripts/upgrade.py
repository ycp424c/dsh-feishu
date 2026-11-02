#!/usr/bin/env python3
"""Upgrade one idle instance. Never overwrite state after possible live writes."""
import argparse,datetime,importlib.util,json,os,pathlib,re,shutil,subprocess,time

def idle(status):return all(status.get(k)==0 for k in ['activeTasks','queuedConversations','pendingApprovals'])
def select(root,release):
    link=root/'current.next';link.unlink(missing_ok=True);link.symlink_to(release,target_is_directory=True);os.replace(link,root/'current')
def compatible(old,release):
    expected=json.loads((release/'package.json').read_text())['dshFeishu']
    for target in [old,release]:
        declared=json.loads((target/'package.json').read_text())['dshFeishu']
        engine=json.loads((target/'runtime/node_modules/@deepseek-ai/dsh/package.json').read_text())['version']
        if engine!=expected['dshVersion'] or declared!=expected:
            raise SystemExit('Engine or contract/state-format change requires a separate migration plan')
def main():
    p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--release',required=True);a=p.parse_args()
    root=pathlib.Path(a.root).resolve();release=pathlib.Path(a.release).resolve();old=(root/'current').resolve(strict=True)
    if release.parent!=root/'releases' or release==old:raise SystemExit('Expected a new release inside root/releases')
    # Reject engine/state transitions before touching a live instance. This
    # script can only roll back code against an unchanged runtime/state format.
    compatible(old,release)
    spec=importlib.util.spec_from_file_location('host_api',old/'scripts/host-api.py');api=importlib.util.module_from_spec(spec);spec.loader.exec_module(api)
    service=(root/'state/service-name').read_text().strip()+'.service'
    def ctl(action):subprocess.run(['systemctl','--user',action,service],check=True)
    def ready(enabled):
        end=time.monotonic()+60
        while time.monotonic()<end:
            try:
                s=api.call(root,timeout=3)
                if s['version']==json.loads((release/'package.json').read_text())['version'] and s['enabled']==enabled and s.get('ready',True) and (not enabled or s['connected']):return s
            except Exception:pass
            time.sleep(1)
        raise RuntimeError('Readiness failed')
    status=api.call(root,timeout=5)
    was_enabled=status.get('enabled') is True
    if not idle(status) or not status.get('ready',True) or (was_enabled and not status.get('connected')):raise SystemExit('Instance must be healthy and idle')
    subprocess.run(['node',str(release/'scripts/doctor.mjs'),str(root)],check=True)
    envpath=root/'state/service.env';env=envpath.read_text()
    if ('DSH_FEISHU_ENABLED='+('1' if was_enabled else '0')) not in env:raise SystemExit('Service flag differs from observed state')
    backup=root/'state/backups'/datetime.datetime.now(datetime.timezone.utc).strftime('upgrade-%Y%m%dT%H%M%SZ');backup.mkdir(parents=True,mode=0o700)
    if not idle(api.call(root,timeout=5)):raise SystemExit('Instance became busy')
    (backup/'release.json').write_text(json.dumps({'previous':str(old),'next':str(release)}))
    unitpath=pathlib.Path.home()/'.config/systemd/user'/service;old_unit=unitpath.read_text()
    new_unit,count=re.subn(r'^KillMode=.*$', 'KillMode=mixed', old_unit, flags=re.MULTILINE)
    if count!=1:raise SystemExit('Expected one explicit systemd KillMode')
    (backup/'service.unit').write_text(old_unit)
    live=False
    try:
        unitpath.write_text(new_unit);subprocess.run(['systemctl','--user','daemon-reload'],check=True)
        ctl('stop')
        for name in ['dsh','feishu','workspace','service.env']:
            source=root/'state'/name
            if source.is_dir():shutil.copytree(source,backup/name,symlinks=True)
            elif source.exists():shutil.copy2(source,backup/name)
        envpath.write_text(env.replace('DSH_FEISHU_ENABLED=1','DSH_FEISHU_ENABLED=0'));envpath.chmod(0o600);select(root,release);ctl('start');ready(False)
        result=api.call(root,'/feishu/api/probe',{'key':'upgrade-check','content':'请只读取工作目录，回复当前可用。不要执行外部写入。'})
        if not result.get('text') or result.get('delivery')!='none':raise RuntimeError('Model preflight failed')
        ctl('stop');ctl('start');ready(False)
        resumed=api.call(root,'/feishu/api/probe',{'key':'upgrade-check','content':'继续上一轮，只回复当前可用。不要执行外部写入。'})
        if resumed.get('sessionId')!=result.get('sessionId'):raise RuntimeError('Session resume failed')
        ctl('stop');envpath.write_text(env);envpath.chmod(0o600);live=was_enabled;ctl('start');final=ready(was_enabled)
        (root/'state/last-upgrade.json').write_text(json.dumps({'release':release.name,'backup':str(backup),'connected':final['connected'],'enabled':was_enabled,'realFeishuAcceptance':'pending'},indent=2)+'\n')
        print(json.dumps({'upgraded':True,'release':release.name,'realFeishuAcceptance':'pending'}))
    except Exception:
        if live:raise SystemExit('Live traffic may exist; retain current state and backup for controlled recovery')
        ctl('stop');select(root,old);unitpath.write_text(old_unit);subprocess.run(['systemctl','--user','daemon-reload'],check=True);envpath.write_text(env);envpath.chmod(0o600);ctl('start')
        raise SystemExit('Preflight failed; previous code restored, compatible current state retained')
if __name__=='__main__':main()
