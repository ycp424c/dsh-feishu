import importlib.util,json,os,pathlib,shutil,subprocess,sys,tempfile,unittest
spec=importlib.util.spec_from_file_location('runner_integration',pathlib.Path(__file__).resolve().parents[1]/'scripts/sandbox.py');runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
BWRAP=os.environ.get('DSH_FEISHU_TEST_BWRAP') or shutil.which('bwrap')
@unittest.skipUnless(sys.platform=='linux' and BWRAP,'Linux bubblewrap required')
class SandboxIntegrationTests(unittest.TestCase):
    def run_profile(self,writable):
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp).resolve();workspace=root/'state/workspace';subdir=workspace/'project';subdir.mkdir(parents=True)
            (root/'state/private-canary').write_text('synthetic')
            script="import json,pathlib;pathlib.Path('relative-proof.txt').write_text('SUBDIR');print(json.dumps({'cwd':str(pathlib.Path.cwd()),'privateVisible':pathlib.Path("+repr(str(root/'state/private-canary'))+").exists()}))"
            profile=['--ro-bind','/','/','--bind' if writable else '--ro-bind',str(workspace),str(workspace),'--','/usr/bin/python3','-c',script]
            result=subprocess.run(runner.command(root,BWRAP,profile,{}),cwd=subdir,env=runner.child_environment(os.environ,workspace),capture_output=True,text=True,timeout=15)
            if writable:
                self.assertEqual(result.returncode,0,result.stderr);self.assertEqual(json.loads(result.stdout),{'cwd':str(subdir),'privateVisible':False})
                self.assertEqual((subdir/'relative-proof.txt').read_text(),'SUBDIR');self.assertFalse((workspace/'relative-proof.txt').exists())
            else:
                self.assertNotEqual(result.returncode,0);self.assertFalse((subdir/'relative-proof.txt').exists());self.assertFalse((workspace/'relative-proof.txt').exists())
    def test_explicit_subdirectory_and_relative_writes_are_preserved(self):self.run_profile(True)
    def test_subdirectory_does_not_widen_readonly_policy(self):self.run_profile(False)
if __name__=='__main__':unittest.main()
