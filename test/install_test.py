import importlib.util,os,pathlib,shutil,subprocess,sys,tempfile,unittest
spec=importlib.util.spec_from_file_location('install',pathlib.Path(__file__).resolve().parents[1]/'scripts/install.py');install=importlib.util.module_from_spec(spec);spec.loader.exec_module(install)
class InstallTests(unittest.TestCase):
    def test_service_names_and_specifier_paths_are_rejected(self):
        with self.assertRaises(ValueError):install.unit(pathlib.Path('/tmp/example'),'/usr/bin/node','unsafe.service\nExecStart=bad')
        with self.assertRaises(ValueError):install.unit(pathlib.Path('/tmp/%user'),'/usr/bin/node','fixture')
    @unittest.skipUnless(sys.platform=='linux' and shutil.which('systemd-analyze') and os.environ.get('XDG_RUNTIME_DIR'),'real user systemd parser required')
    def test_generated_paths_are_understood_by_the_real_systemd_parser(self):
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp)/'instance with spaces';(root/'current/scripts').mkdir(parents=True);(root/'state').mkdir();(root/'state/service.env').write_text('FIXTURE_FLAG=1\n');(root/'current/scripts/start.mjs').write_text('// static verifier fixture\n')
            unit=root/'fixture.service';unit.write_text(install.unit(root,shutil.which('node'),'fixture'))
            result=subprocess.run(['systemd-analyze','--user','verify','--man=no',str(unit)],capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertNotIn('path is not absolute',result.stderr)

@unittest.skipUnless(sys.platform=='linux' and shutil.which('systemd-analyze') and os.environ.get('XDG_RUNTIME_DIR'),'real user systemd required')
class ShutdownTests(unittest.TestCase):
    def test_wrapper_child_receives_one_signal_and_finishes_cleanup(self):
        import time,uuid
        name='dsh-feishu-signal-'+uuid.uuid4().hex[:12]
        units=pathlib.Path.home()/'.config/systemd/user';units.mkdir(parents=True,exist_ok=True);path=units/(name+'.service')
        def ctl(action):return subprocess.run(['systemctl','--user',action,name+'.service'],capture_output=True,text=True,check=True)
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp)/'instance with spaces';(root/'current/scripts').mkdir(parents=True);(root/'state').mkdir();(root/'state/service.env').write_text('FIXTURE_FLAG=1\n')
            (root/'current/scripts/child.mjs').write_text("""import fs from 'node:fs';import path from 'node:path';const root=process.env.DSH_FEISHU_ROOT;let count=0;fs.writeFileSync(path.join(root,'ready'),'1');process.on('SIGTERM',()=>{fs.writeFileSync(path.join(root,'term-count'),String(++count));if(count>1)process.exit(0);setTimeout(()=>{fs.writeFileSync(path.join(root,'graceful'),'1');process.exit(0)},150)});setInterval(()=>{},1000)""")
            (root/'current/scripts/start.mjs').write_text("""import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';const child=spawn(process.execPath,[fileURLToPath(new URL('./child.mjs',import.meta.url))],{stdio:'inherit'});process.on('SIGTERM',()=>child.kill('SIGTERM'));child.on('exit',()=>{process.exitCode=0})""")
            path.write_text(install.unit(root,shutil.which('node'),name))
            try:
                subprocess.run(['systemctl','--user','daemon-reload'],check=True,capture_output=True)
                ctl('start')
                for _ in range(100):
                    if (root/'ready').exists():break
                    time.sleep(.05)
                self.assertTrue((root/'ready').exists(),'Fixture child did not start')
                ctl('stop')
                self.assertEqual((root/'term-count').read_text(),'1')
                self.assertEqual((root/'graceful').read_text(),'1')
            finally:
                subprocess.run(['systemctl','--user','stop',name+'.service'],capture_output=True)
                path.unlink(missing_ok=True);subprocess.run(['systemctl','--user','daemon-reload'],capture_output=True)

if __name__=='__main__':unittest.main()
