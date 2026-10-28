import pathlib,shutil,subprocess,tempfile,unittest
SOURCE=pathlib.Path(__file__).resolve().parents[1]
class PublicSourceChecks(unittest.TestCase):
    def fixture(self,root):
        (root/'scripts').mkdir();shutil.copy2(SOURCE/'scripts/check-public-source.py',root/'scripts/check-public-source.py');subprocess.run(['git','init','-q'],cwd=root,check=True)
    def run_check(self,root,history=False):
        return subprocess.run(['python3','scripts/check-public-source.py',*(['--history'] if history else [])],cwd=root,capture_output=True,text=True)
    def commit(self,root):
        subprocess.run(['git','add','.'],cwd=root,check=True);subprocess.run(['git','-c','user.name=Audit Fixture','-c','user.email=test@example.invalid','commit','-qm','fixture'],cwd=root,check=True)
    def test_finding_is_detected_without_printing_the_value(self):
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp);self.fixture(root);value='gh'+'p_'+'A'*36;(root/'README.md').write_text(value)
            result=self.run_check(root);self.assertNotEqual(result.returncode,0);self.assertIn('github-token',result.stdout);self.assertNotIn(value,result.stdout)
    def test_history_finding_survives_worktree_redaction(self):
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp);self.fixture(root);value='gh'+'p_'+'B'*36;(root/'README.md').write_text(value);self.commit(root)
            (root/'README.md').write_text('redacted');self.commit(root)
            self.assertEqual(self.run_check(root).returncode,0)
            result=self.run_check(root,True);self.assertNotEqual(result.returncode,0);self.assertIn('history:',result.stdout);self.assertNotIn(value,result.stdout)
    def test_forced_private_artifact_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp);self.fixture(root);(root/'.gitignore').write_text('state/\n');(root/'state').mkdir();(root/'state/secrets.json').write_text('{"fixture":"synthetic"}')
            subprocess.run(['git','add','-f','state/secrets.json'],cwd=root,check=True);result=self.run_check(root)
            self.assertNotEqual(result.returncode,0);self.assertIn('private-artifact',result.stdout)
if __name__=='__main__':unittest.main()
