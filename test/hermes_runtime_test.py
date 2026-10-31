import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('weave_hermes', Path(__file__).parents[1] / 'hosted/hermes-runner/assess.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class HermesRuntimeTests(unittest.TestCase):
    def test_native_anthropic_mode_context_and_tool_boundaries(self):
        captured = {}
        class Agent:
            def __init__(self, **kwargs):
                captured.update(kwargs)
            def run_conversation(self, prompt):
                self_test.assertEqual(self.tools, [])
                self_test.assertEqual(self.valid_tool_names, set())
                captured['prompt'] = json.loads(prompt)
                return {'completed': True, 'final_response': '{"decision":"quiet"}'}
            def close(self):
                captured['closed'] = True
        self_test = self
        with tempfile.TemporaryDirectory() as home, patch.dict(os.environ, {'HERMES_HOME': home}):
            result = module.assess({'apiKey':'sk-test-only-123456','model':'deepseek-flash','run':{'owner':'u:owner','leaseId':'lease'},'system':'只返回 JSON','context':{'private':'owner-only'}}, Agent)
        self.assertEqual(result, {'decision':'quiet'})
        self.assertEqual(captured['provider'],'anthropic')
        self.assertEqual(captured['api_mode'],'anthropic_messages')
        self.assertEqual(captured['base_url'],'https://api.deepseek.com/anthropic')
        self.assertTrue(captured['skip_context_files'])
        self.assertTrue(captured['skip_memory'])
        self.assertTrue(captured['skip_background_review'])
        self.assertFalse(captured['save_trajectories'])
        self.assertEqual(captured['enabled_toolsets'],[])
        self.assertNotIn('sk-test-only-123456',json.dumps(captured['prompt']))
        self.assertTrue(captured['closed'])

    def test_model_output_is_not_executed_as_code_or_accepted_as_an_action(self):
        closed=[]
        class Agent:
            def __init__(self,**kwargs): pass
            def run_conversation(self,prompt):return {'completed':True,'final_response':'__import__("os").system("echo bad")'}
            def close(self):closed.append(True)
        with tempfile.TemporaryDirectory() as home, patch.dict(os.environ,{'HERMES_HOME':home}):
            with self.assertRaises(json.JSONDecodeError):module.assess({'apiKey':'dummy','model':'deepseek-flash','run':{'owner':'u:owner','leaseId':'lease'},'system':'JSON','context':{}},Agent)
        self.assertEqual(closed,[True])

if __name__=='__main__':unittest.main()
