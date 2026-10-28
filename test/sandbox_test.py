import importlib.util,pathlib,tempfile,unittest
spec=importlib.util.spec_from_file_location('runner',pathlib.Path(__file__).resolve().parents[1]/'scripts/sandbox.py');runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
class SandboxTests(unittest.TestCase):
    def test_strict_runner_preserves_readonly_and_has_no_host_root_bind(self):
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp).resolve();workspace=root/'state/workspace';workspace.mkdir(parents=True)
            profile=['--ro-bind','/','/','--ro-bind',str(workspace),str(workspace),'--','/usr/bin/true']
            args=runner.command(root,'/usr/bin/bwrap',profile,{})
            self.assertNotIn(['--ro-bind','/','/'],[args[i:i+3] for i in range(len(args)-2)])
            self.assertIn(['--ro-bind',str(workspace),str(workspace)],[args[i:i+3] for i in range(len(args)-2)])
            self.assertNotIn(['--bind',str(workspace),str(workspace)],[args[i:i+3] for i in range(len(args)-2)])
            self.assertIn('--unshare-pid',args)
    def test_only_runtime_attested_dsh_files_can_be_mounted(self):
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp).resolve();(root/'state/workspace').mkdir(parents=True);secret=root/'secret';secret.write_text('secret')
            with self.assertRaises(ValueError):runner.command(root,'bwrap',['--','true'],{'DSH_FEISHU_ALLOWED_FILES':'["'+str(secret)+'"]'})
    def test_child_environment_excludes_credentials_and_host_home(self):
        env=runner.child_environment({'PATH':'/usr/bin','HOME':'/private-home','DSH_MODEL_API_KEY':'secret','THIRD_PARTY_APP_SECRET':'secret','UNRELATED_TOKEN':'secret','LC_ALL':'C'},pathlib.Path('/workspace'))
        self.assertEqual(env,{'PATH':'/usr/bin','HOME':'/workspace','TMPDIR':'/tmp','LC_ALL':'C'})
if __name__=='__main__':unittest.main()
