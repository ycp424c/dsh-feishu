import hashlib,json,pathlib,shutil,subprocess,sys,tempfile,unittest
SOURCE=pathlib.Path(__file__).resolve().parents[1]
@unittest.skipUnless(sys.platform=='linux' and (SOURCE/'runtime/node_modules/yaml').is_dir(),'Linux runtime required')
class DoctorTests(unittest.TestCase):
    def run_doctor(self,runner_status):
        with tempfile.TemporaryDirectory() as temp:
            temp=pathlib.Path(temp);release=temp/'release';scripts=release/'scripts';scripts.mkdir(parents=True);shutil.copy2(SOURCE/'scripts/doctor.mjs',scripts/'doctor.mjs')
            runtime=release/'runtime';(runtime/'node_modules').mkdir(parents=True);(runtime/'node_modules/yaml').symlink_to((SOURCE/'runtime/node_modules/yaml').resolve(),target_is_directory=True)
            (runtime/'package.json').write_text('{"name":"doctor-fixture","type":"module"}');lock=runtime/'package-lock.json';lock.write_text('{}')
            (release/'upstream.lock.json').write_text(json.dumps({'runtimeLockSha256':hashlib.sha256(lock.read_bytes()).hexdigest()}))
            root=temp/'instance';profile=root/'state/dsh/profiles/web';profile.mkdir(parents=True);workspace=root/'state/workspace';workspace.mkdir()
            secrets=root/'state/secrets.json';secrets.write_text('{"DSH_FEISHU_APP_SECRET":"synthetic","DSH_MODEL_API_KEY":"synthetic"}');secrets.chmod(0o600)
            binary=temp/'fake-bwrap';binary.write_text('#!'+sys.executable+'\nimport sys\nsys.exit(0 if sys.argv[1:]==["--version"] else 125)\n');binary.chmod(0o700)
            marker=temp/'runner-probe';runner=temp/'fake-runner.py';runner.write_text('import pathlib,sys;pathlib.Path('+repr(str(marker))+').write_text("ran");sys.exit('+str(runner_status)+')')
            patch=[{'id':'sandbox','config':{'runnerCommand':[sys.executable,str(runner),'--bwrap',str(binary)]}},{'id':'dsh-feishu','config':{'workspace':str(workspace)}}]
            (profile/'cordis.patch.yml').write_text(json.dumps(patch))
            result=subprocess.run(['node',str(scripts/'doctor.mjs'),str(root)],capture_output=True,text=True,timeout=20)
            self.assertTrue(marker.exists(),'doctor never exercised the configured runner')
            return result,json.loads(result.stdout)
    def test_version_success_does_not_hide_an_unusable_sandbox(self):
        result,report=self.run_doctor(125);self.assertNotEqual(result.returncode,0);self.assertFalse(report['ok']);self.assertIn('Configured sandbox cannot execute a workspace command',report['errors'])
    def test_configured_runner_success_passes_startup(self):
        result,report=self.run_doctor(0);self.assertEqual(result.returncode,0,result.stderr);self.assertTrue(report['ok'])
if __name__=='__main__':unittest.main()
