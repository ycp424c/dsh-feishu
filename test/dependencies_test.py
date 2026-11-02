import hashlib,json,pathlib,unittest

ROOT=pathlib.Path(__file__).resolve().parents[1]
def read(name):return json.loads((ROOT/name).read_text())

class DependencyConsistencyTests(unittest.TestCase):
    def test_plugin_runtime_and_provenance_select_one_exact_release(self):
        plugin=read('package.json');runtime=read('runtime/package.json');upstream=read('upstream.lock.json')
        version=plugin['dshFeishu']['dshVersion']
        self.assertEqual(runtime['dependencies']['@deepseek-ai/dsh'],version)
        self.assertEqual(upstream['dsh']['ref'],'dsh-v'+version)
        self.assertEqual(upstream['larkSdk'],plugin['dependencies']['@larksuiteoapi/node-sdk'])
        self.assertEqual(upstream['runtimeLockSha256'],hashlib.sha256((ROOT/'runtime/package-lock.json').read_bytes()).hexdigest())
        for dependency,pin in plugin['peerDependencies'].items():
            with self.subTest(dependency=dependency):self.assertEqual(pin,version)
        for name in ['package-lock.json','runtime/package-lock.json']:
            lock=read(name);manifest=plugin if name=='package-lock.json' else runtime
            self.assertEqual(lock['packages']['']['dependencies'],manifest['dependencies'])
            for path,package in lock['packages'].items():
                dependency=path.split('node_modules/')[-1]
                if dependency.startswith('@deepseek-ai/dsh'):
                    with self.subTest(path=path):self.assertEqual(package['version'],version)
                if name=='runtime/package-lock.json' and dependency.startswith('@deepseek-ai/dsh-'):
                    self.assertEqual(runtime['overrides'][dependency],version)
        self.assertEqual(read('package-lock.json')['packages']['']['version'],plugin['version'])

if __name__=='__main__':unittest.main()
