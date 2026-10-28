#!/usr/bin/env python3
import argparse,json,os,pathlib,re,shutil,subprocess,sys

def unit(root,node,service):
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,60}',service):raise ValueError('Invalid service name')
    if any(c in str(root)+str(node) for c in ['\n','\r','%']):raise ValueError('Unsupported path characters')
    quote=lambda p:json.dumps(str(p))
    return '\n'.join(['[Unit]','Description=DSH Feishu Bot','After=network-online.target','Wants=network-online.target','','[Service]','Type=simple','Environment='+quote('DSH_FEISHU_ROOT='+str(root)),'EnvironmentFile='+str(root/'state/service.env'),'ExecStart='+quote(node)+' '+quote(root/'current/scripts/start.mjs'),'Restart=on-failure','RestartSec=5','TimeoutStopSec=30','KillMode=mixed','UMask=0077','','[Install]','WantedBy=default.target',''])

def main():
    p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--release',required=True);p.add_argument('--config',required=True);p.add_argument('--service',default='dsh-feishu');p.add_argument('--bwrap',default='/usr/bin/bwrap');p.add_argument('--start',action='store_true');a=p.parse_args()
    root=pathlib.Path(a.root).resolve();release=pathlib.Path(a.release).resolve()
    if sys.platform!='linux':raise SystemExit('Linux required')
    if release.parent!=root/'releases':raise SystemExit('Release must be directly inside root/releases')
    if (root/'current').exists() or (root/'state/secrets.json').exists():raise SystemExit('Existing instance; use upgrade instead')
    node=shutil.which('node');text=unit(root,node,a.service)
    root.mkdir(parents=True,exist_ok=True)
    subprocess.run([node,str(release/'scripts/init.mjs'),'--root',str(root),'--config',a.config,'--bwrap',a.bwrap],check=True)
    units=pathlib.Path.home()/'.config/systemd/user';units.mkdir(parents=True,exist_ok=True);(units/(a.service+'.service')).write_text(text)
    (root/'state/service-name').write_text(a.service);(root/'state/service-name').chmod(0o600)
    subprocess.run(['systemctl','--user','daemon-reload'],check=True)
    if a.start:
        subprocess.run([node,str(release/'scripts/doctor.mjs'),str(root)],check=True)
        subprocess.run(['systemctl','--user','enable','--now',a.service+'.service'],check=True)
    print(json.dumps({'installed':True,'started':a.start,'credentials':'Configure state/secrets.json privately before starting'}))
if __name__=='__main__':main()
