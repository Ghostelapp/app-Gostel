import json
import unittest
from backend.push_privacy import private_push
from backend.fcm import build_message


class PushPrivacy(unittest.TestCase):
    def test_provider_payload_cannot_contain_plaintext_profiles_or_previews(self):
        secret = 'PRIVATE_TEST_VALUE'
        for is_call in (True,False):
            payload = build_message(token='test',title=secret,body=secret,is_call=is_call,
                data={'type':'incoming_call' if is_call else 'message',
                      'call_id':'call-1','conversation_id':'conv-1','caller_id':'user-1',
                      'caller_name':secret,'sender_name':secret,'title':secret,'body':secret,
                      'avatar':secret,'encryptedDisplayName':secret,'profile':{'bio':secret}})
            self.assertNotIn(secret,json.dumps(payload))
            self.assertEqual(payload['message']['data']['conversation_id'],'conv-1')

    def test_invites_and_group_events_do_not_reveal_sender_or_group_name(self):
        for event in ('contact_invite','group_added'):
            title, body, data = private_push({'type':event,'from_user_id':'private-user',
                'group_name':'private-group','sender_name':'private-name','content':'private-content'})
            self.assertEqual(title,'ghostel.app')
            self.assertEqual(body,'New activity')
            self.assertNotIn('private',json.dumps(data))

    def test_call_control_preserves_cleanup_routing_without_preview(self):
        title, body, data = private_push({'type':'call_control','call_id':'c',
            'call_control_action':'accepted','accepted_by':'u','caller_name':'private-name'})
        self.assertEqual(body,'')
        self.assertEqual(data['call_control_action'],'accepted')
        self.assertEqual(data['call_id'],'c')
        self.assertNotIn('private-name',json.dumps(data))

    def test_apns_payload_uses_generic_name_even_if_caller_supplies_private_fields(self):
        # Execute the real builder without importing APNs credentials/HTTP dependencies.
        import ast
        import time
        from pathlib import Path
        tree = ast.parse((Path(__file__).parents[1] / 'apns.py').read_text())
        node = next(n for n in tree.body if isinstance(n, ast.FunctionDef)
                    and n.name == 'build_voip_payload')
        env = dict(Any=object, private_push=private_push, time=time)
        exec(compile(ast.Module(body=[node],type_ignores=[]),'apns.py','exec'),env)
        payload = env['build_voip_payload']({'call_id':'c','caller_id':'u',
            'caller_name':'PRIVATE_NAME','encryptedDisplayName':'PRIVATE_VALUE'})
        self.assertNotIn('PRIVATE',json.dumps(payload))
        self.assertEqual(payload['caller_name'],'ghostel.app call')
        self.assertEqual(payload['call_id'],'c')
