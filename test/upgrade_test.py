import importlib.util,json,pathlib,tempfile,unittest

SOURCE=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('upgrade',SOURCE/'scripts/upgrade.py')
upgrade=importlib.util.module_from_spec(spec);spec.loader.exec_module(upgrade)

class CompatibilityTests(unittest.TestCase):
    def release(self,root,name,engine='0.2.1-rc.5',declared=None,state=1):
        path=root/name;package=path/'runtime/node_modules/@deepseek-ai/dsh';package.mkdir(parents=True)
        (package/'package.json').write_text(json.dumps({'version':engine}))
        (path/'package.json').write_text(json.dumps({'dshFeishu':{'dshVersion':declared or engine,'contractVersion':1,'stateFormatVersion':state}}))
        return path
    def test_same_engine_upgrade_and_rollback_are_compatible(self):
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp);old=self.release(root,'old');new=self.release(root,'new')
            upgrade.compatible(old,new);upgrade.compatible(new,old)
    def test_engine_changes_stale_installs_and_state_downgrades_fail_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp);new=self.release(root,'new')
            for name,opts in [('old-engine',{'engine':'0.2.0-rc.2'}),('stale',{'engine':'0.2.0-rc.2','declared':'0.2.1-rc.5'}),('state',{'state':2})]:
                other=self.release(root,name,**opts)
                with self.subTest(name=name),self.assertRaisesRegex(SystemExit,'migration plan'):upgrade.compatible(other,new)
                with self.subTest(name=name+' rollback'),self.assertRaisesRegex(SystemExit,'migration plan'):upgrade.compatible(new,other)

if __name__=='__main__':unittest.main()
