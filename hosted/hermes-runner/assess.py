"""One isolated Hermes reasoning run. Keys arrive only on stdin, never argv."""
import contextlib
import io
import json
import os
import sys

REVISION = 'f30105a0b4b3d0c1baa6c464189755ccdbc1ac7f'

def assess(payload, agent_class=None):
    if agent_class is None:
        from run_agent import AIAgent
        agent_class = AIAgent
    if payload.get('model') not in ('deepseek-flash', 'deepseek-v4-pro'):
        raise ValueError('Unsupported model')
    agent = agent_class(
        provider='anthropic', api_mode='anthropic_messages',
        base_url=payload.get('_test_base_url') if os.environ.get('WEAVE_HERMES_TEST_MODE') == '1' else 'https://api.deepseek.com/anthropic',
        api_key=payload['apiKey'], model=payload['model'],
        max_iterations=2, max_tokens=2400, run_budget_seconds=100,
        enabled_toolsets=[], disabled_toolsets=['terminal', 'file', 'web', 'browser', 'cronjob', 'memory'],
        skip_context_files=True, skip_memory=True, skip_background_review=True,
        load_soul_identity=False, save_trajectories=False, checkpoints_enabled=False,
        quiet_mode=True, verbose_logging=False,
        session_id=payload['run']['leaseId'], user_id=payload['run']['owner'],
        ephemeral_system_prompt=payload['system'], cwd=os.environ['HERMES_HOME'],
        request_overrides={'thinking': {'type': 'disabled'}},
    )
    try:
        # Defense in depth if upstream adds default tools to an empty selection.
        agent.tools = []
        agent.valid_tool_names = set()
        result = agent.run_conversation(json.dumps(payload['context'], ensure_ascii=False))
        if not result.get('completed') or not isinstance(result.get('final_response'), str):
            raise ValueError('Hermes did not complete the judgment')
        text = result['final_response'].strip()
        if text.startswith('```'):
            text = text.split('\n', 1)[1].rsplit('```', 1)[0].strip()
        value = json.loads(text)
        if not isinstance(value, dict):
            raise ValueError('Expected a decision object')
        return value
    finally:
        close = getattr(agent, 'close', None)
        if close:
            close()

def main():
    try:
        # Hermes boot diagnostics must never be mixed with its JSON result.
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            if sys.argv[1:] == ['--probe']:
                from run_agent import AIAgent
                result = {'ok': callable(AIAgent), 'revision': REVISION, 'engine': 'hermes'}
            else:
                raw = sys.stdin.buffer.read(64001)
                if len(raw) > 64000:
                    raise ValueError('Input too large')
                result = {'decision': assess(json.loads(raw))}
        print(json.dumps(result, ensure_ascii=False))
    except Exception:
        if os.environ.get('WEAVE_HERMES_TEST_MODE') == '1':
            import traceback
            traceback.print_exc(file=sys.stderr)
        print(json.dumps({'error': 'Hermes judgment failed'}))
        sys.exit(1)

if __name__ == '__main__':
    main()
