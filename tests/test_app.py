import asyncio
import io
import json
import os
import unittest
import wave
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi.testclient import TestClient

import app as app_module
from app import (
    app,
    build_hermes_command,
    build_qwen_tts_request,
    classify_emotion,
    parse_hermes_output,
    voice_settings,
)


ROOT = Path(__file__).resolve().parents[1]


class AniCompanionTests(unittest.TestCase):
    def test_health_reports_ready(self):
        client = TestClient(app)
        response = client.get('/api/health')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'status': 'ready', 'companion': 'Ani'})

    def test_parse_hermes_output_removes_session_footer(self):
        raw = "(French) Okay, je te vois.\n\nSession:        20260831_213745_88f867\nTitle:          Test\nDuration:       5s\n"
        reply, session_id = parse_hermes_output(raw)
        self.assertEqual(reply, '(French) Okay, je te vois.')
        self.assertEqual(session_id, '20260831_213745_88f867')

    def test_parse_hermes_output_handles_quiet_session_prefix(self):
        raw = 'session_id: 20260831_221918_7fb9e5\nOkay, je suis là.'
        reply, session_id = parse_hermes_output(raw)
        self.assertEqual(reply, 'Okay, je suis là.')
        self.assertEqual(session_id, '20260831_221918_7fb9e5')

    def test_parse_decorated_hermes_output_extracts_box_body(self):
        raw = "Query: salut\nInitializing agent...\n────────\n\n╭─ Hermes ─╮\n(French) Coucou.\n╰───────────╯\n\nResume this session with:\n  hermes --resume abc123\n\nSession:        abc123\nTitle: Test\n"
        reply, session_id = parse_hermes_output(raw)
        self.assertEqual(reply, '(French) Coucou.')
        self.assertEqual(session_id, 'abc123')

    def test_classify_emotion_detects_happy_and_sad(self):
        self.assertEqual(classify_emotion("C'est adorable ! J'adore."), 'happy')
        self.assertEqual(classify_emotion("Je suis désolée, c'est triste."), 'sad')

    def test_classify_emotion_understands_persona_sound_cues(self):
        self.assertEqual(classify_emotion('[sourit] Okay, je te suis.'), 'happy')
        self.assertEqual(classify_emotion('[rougit] Tu es mignon.'), 'shy')
        self.assertEqual(classify_emotion('[penche la tête] Comment ça ?'), 'curious')
        self.assertEqual(classify_emotion('[soupir] Ça me rend triste.'), 'sad')

    def test_build_hermes_command_resumes_known_session(self):
        command = build_hermes_command('session-123')
        self.assertIn('--resume', command)
        self.assertIn('session-123', command)
        self.assertEqual(command[-1], '-')

    def test_build_hermes_command_always_uses_local_ani_gemma(self):
        command = build_hermes_command('session-123')
        self.assertEqual(command[command.index('--model') + 1], 'ani-gemma4:latest')
        self.assertEqual(command[command.index('--provider') + 1], 'custom')

    def test_voice_settings_change_with_emotion(self):
        happy = voice_settings('happy')
        sad = voice_settings('sad')
        self.assertNotEqual(happy['rate'], sad['rate'])
        self.assertNotEqual(happy['pitch'], sad['pitch'])

    def test_prepare_spoken_text_removes_bracketed_emotions(self):
        spoken = app_module.prepare_spoken_text(
            '(Français) [sourit doucement] Bonjour François. [petit rire] Je suis là.'
        )
        self.assertEqual(spoken, 'Bonjour François. Je suis là.')

    def test_tts_does_not_forward_bracketed_cues_as_voice_instructions(self):
        text = ' '.join(
            f'[indication expressive numéro {index}] phrase {index}.'
            for index in range(40)
        )
        response = TestClient(app).post('/api/tts/plan', json={
            'text': text,
            'emotion': 'happy',
            'turn_id': 7,
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['instructions'], '')

    def test_reply_metadata_separates_text_emotion_and_actions(self):
        presentation = app_module.build_reply_presentation(
            '(French) [sourit] Bonjour François. [danse] [danse]'
        )
        self.assertEqual(presentation, {
            'reply': 'Bonjour François.',
            'speech': 'Bonjour François.',
            'emotion': 'happy',
            'actions': [{'name': 'dance'}],
        })

    def test_prepare_spoken_text_turns_ellipses_into_non_terminal_pauses(self):
        spoken = app_module.prepare_spoken_text(
            'Oh… attends... je termine cette phrase. 💙'
        )
        self.assertEqual(spoken, 'Oh, attends, je termine cette phrase.')

    def test_prepare_spoken_text_replaces_long_dashes_that_silence_qwen(self):
        spoken = app_module.prepare_spoken_text(
            'Oui, teste tranquillement — je suis là et je t’écoute.'
        )
        self.assertEqual(spoken, 'Oui, teste tranquillement. je suis là et je t’écoute.')

    def test_streaming_prompt_only_shapes_first_sentence_for_fast_tts_start(self):
        prompt = app_module.build_streaming_prompt('Raconte-moi quelque chose.')
        self.assertTrue(prompt.startswith('Raconte-moi quelque chose.'))
        self.assertIn('première phrase à environ dix mots maximum', prompt)
        self.assertIn('sans points de suspension', prompt)
        self.assertNotIn('de façon concise', prompt)
        self.assertNotIn('deux ou trois phrases', prompt)

    def test_tts_timing_logs_include_attempt_audio_metrics_and_ellipsis_text(self):
        source = (ROOT / 'app.py').read_text()
        for marker in (
            'tts.request',
            'tts.attempt.start',
            'tts.attempt.done',
            'tts.ready',
            'duration_ms',
            'rms',
            'raw_text=%r',
            'spoken_text=%r',
        ):
            self.assertIn(marker, source)

    def test_browser_reports_queue_fetch_and_playback_timings_to_server(self):
        script = (ROOT / 'static' / 'app.js').read_text()
        self.assertIn("fetch('/api/audio/timing'", script)
        for event in (
            'speech.queued',
            'tts.fetch.start',
            'tts.fetch.done',
            'audio.play.request',
            'audio.play.started',
            'audio.play.ended',
        ):
            self.assertIn(event, script)

    def test_timing_logger_is_enabled_at_info_level_in_service(self):
        self.assertTrue(app_module.logger.isEnabledFor(app_module.logging.INFO))
        self.assertTrue(app_module.logger.handlers)

    def test_audio_timing_endpoint_writes_client_measurements_to_journal(self):
        with self.assertLogs('ani-companion', level='INFO') as captured:
            response = TestClient(app).post('/api/audio/timing', json={
                'event': 'audio.play.started',
                'turn_key': 'server-secret-key',
                'chunk_seq': 3,
                'elapsed_ms': 1234.5,
                'duration_ms': 842.2,
                'text': 'Oh… attends...',
            })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'logged': True})
        log = '\n'.join(captured.output)
        self.assertIn('[ANI-TIMING]', log)
        self.assertIn('audio.play.started', log)
        self.assertIn('chunk=3', log)
        self.assertIn("text='Oh… attends...'", log)

    def test_wav_metrics_expose_leading_trailing_and_longest_silence(self):
        output = io.BytesIO()
        with wave.open(output, 'wb') as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(1000)
            frames = (
                (0).to_bytes(2, 'little', signed=True) * 200
                + (1200).to_bytes(2, 'little', signed=True) * 300
                + (0).to_bytes(2, 'little', signed=True) * 100
            )
            wav.writeframes(frames)
        metrics = app_module._wav_metrics(output.getvalue())
        self.assertAlmostEqual(metrics['duration_ms'], 600, delta=1)
        self.assertAlmostEqual(metrics['leading_silence_ms'], 200, delta=20)
        self.assertAlmostEqual(metrics['trailing_silence_ms'], 100, delta=20)
        self.assertAlmostEqual(metrics['longest_silence_ms'], 200, delta=20)

    def test_qwen_audio_retries_a_silent_wav_chunk(self):
        def wav_with_sample(sample: int) -> bytes:
            output = io.BytesIO()
            with wave.open(output, 'wb') as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(24000)
                wav.writeframes(sample.to_bytes(2, 'little', signed=True) * 2400)
            return output.getvalue()

        silent = wav_with_sample(0)
        audible = wav_with_sample(1200)
        responses = [silent, audible]

        class FakeClient:
            calls = 0

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                return None

            async def post(self, *_args, **_kwargs):
                content = responses[self.calls]
                self.calls += 1
                FakeClient.calls = self.calls
                return MagicMock(content=content, raise_for_status=MagicMock())

        with patch.object(app_module.httpx, 'AsyncClient', return_value=FakeClient()):
            result = asyncio.run(app_module._fetch_qwen_audio_async('Je suis là et je t’écoute.'))
        self.assertEqual(result, audible)
        self.assertEqual(FakeClient.calls, 2)

    def test_qwen_tts_request_uses_local_server_and_french_voice(self):
        request = build_qwen_tts_request('Bonjour François.', 'Parle avec joie.')
        self.assertEqual(request.full_url, 'http://127.0.0.1:15004/v1/audio/speech')
        payload = json.loads(request.data)
        self.assertEqual(payload['model'], 'qwen-tts')
        self.assertEqual(payload['voice'], 'Serena')
        self.assertEqual(payload['input'], 'Bonjour François.')
        self.assertEqual(payload['instructions'], 'Parle avec joie.')
        self.assertEqual(payload['response_format'], 'wav')
        self.assertNotIn('temperature', payload)
        self.assertNotIn('top_p', payload)
        self.assertNotIn('force_chunking', payload)
        self.assertNotIn('one_sentence_per_chunk', payload)

    def test_tts_plan_splits_reply_without_generating_audio(self):
        response = TestClient(app).post('/api/tts/plan', json={
            'text': '(Français) Oh. Première phrase assez longue pour être autonome. Deuxième phrase suffisamment longue.',
            'emotion': 'happy',
            'turn_id': 7,
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['chunks'], [
            'Oh. Première phrase assez longue pour être autonome.',
            'Deuxième phrase suffisamment longue.',
        ])

    def test_pwa_prefetches_only_one_streamed_audio_chunk(self):
        script = (ROOT / 'static' / 'app.js').read_text()
        self.assertIn('let pendingAudio=null', script)
        self.assertIn('if(cancelled||pendingAudio||!queue.length)return', script)
        self.assertIn("promise:fetchAudioChunk(item.text,item.emotion,'',turnId,item.chunkSeq)", script)
        self.assertIn('pendingAudio=null;\n      ensurePrefetch();', script)

    def test_pwa_starts_a_fresh_session_after_context_migration(self):
        script = (ROOT / 'static' / 'app.js').read_text()
        self.assertIn("const SESSION_GENERATION='4'", script)
        self.assertIn('const MAX_SESSION_TURNS=12', script)
        self.assertIn("localStorage.getItem('ani.session.generation')", script)
        self.assertIn("localStorage.removeItem('ani.session')", script)
        self.assertIn("localStorage.removeItem('ani.session.turns')", script)
        self.assertIn("localStorage.setItem('ani.session.generation',SESSION_GENERATION)", script)

    def test_failed_streaming_audio_chunk_is_skipped_without_stopping_later_chunks(self):
        script = (ROOT / 'static' / 'app.js').read_text()
        run_start = script.index('const run=async()=>{')
        run_block = script[run_start:run_start + 900]
        self.assertIn('catch(error)', run_block)
        self.assertIn("reportAudioTiming('tts.fetch.skipped'", run_block)
        self.assertIn('pendingAudio=null;', run_block)
        self.assertIn('ensurePrefetch();', run_block)
        self.assertIn('continue;', run_block)

    def test_pwa_uses_structured_reply_metadata(self):
        script = (ROOT / 'static' / 'app.js').read_text()
        self.assertIn('completed.actions', script)
        self.assertIn('setEmotion(completed.emotion)', script)
        self.assertIn('activeAssistantBubble.textContent=completed.reply', script)
        self.assertNotIn('motionForText(completed.reply)', script)

    def test_pwa_streams_reply_and_starts_sentence_audio_before_completion(self):
        script = (ROOT / 'static' / 'app.js').read_text()
        self.assertIn("fetch('/api/chat/stream'", script)
        self.assertIn('response.body.getReader()', script)
        self.assertIn("event.type==='delta'", script)
        self.assertIn("event.type==='speech'", script)
        self.assertIn('streamingSpeech?.push(event.text,event.emotion)', script)
        self.assertLess(
            script.index("event.type==='speech'"),
            script.index("event.type==='complete'"),
        )

    def test_disabling_voice_cancels_streaming_audio_queue(self):
        script = (ROOT / 'static' / 'app.js').read_text()
        self.assertIn("if(!voiceEnabled){streamingSpeech?.cancel();player.pause();stopStatusNotice()}", script)

    def test_stream_failure_stops_current_audio_and_lip_sync(self):
        script = (ROOT / 'static' / 'app.js').read_text()
        catch_start = script.index('streamingSpeech?.cancel();streamingSpeech=null;', script.index('form.addEventListener'))
        catch_block = script[catch_start:catch_start + 320]
        self.assertIn('player.pause()', catch_block)
        self.assertIn('stopLipSync()', catch_block)
        self.assertIn('stopLipSync()', catch_block)

    def test_pwa_displays_stream_error_message(self):
        script = (ROOT / 'static' / 'app.js').read_text()
        self.assertIn("throw new Error(event.message||'Ani ne répond pas')", script)

    def test_chat_stream_emits_text_and_speech_before_completion(self):
        class FakeStdin:
            def __init__(self):
                self.writes = []

            def write(self, data):
                self.writes.append(data)

            async def drain(self):
                return None

            def close(self):
                return None

        class FakeProcess:
            def __init__(self):
                self.stdin = FakeStdin()
                self.stdout = asyncio.StreamReader()
                self.stderr = asyncio.StreamReader()
                self.returncode = 0
                messages = [
                    {'jsonrpc': '2.0', 'method': 'event', 'params': {'type': 'gateway.ready'}},
                    {'jsonrpc': '2.0', 'id': '1', 'result': {
                        'session_id': 'runtime-1',
                        'stored_session_id': 'stored-1',
                    }},
                    {'jsonrpc': '2.0', 'id': '2', 'result': {'scope': 'session', 'value': 'ani-gemma4:latest'}},
                    {'jsonrpc': '2.0', 'method': 'event', 'params': {
                        'type': 'message.delta',
                        'session_id': 'runtime-1',
                        'payload': {'text': '(French) Bonjour François, je suis bien là. '},
                    }},
                    {'jsonrpc': '2.0', 'id': '3', 'result': {'status': 'streaming'}},
                    {'jsonrpc': '2.0', 'method': 'event', 'params': {
                        'type': 'message.delta',
                        'session_id': 'runtime-1',
                        'payload': {'text': 'Deuxième phrase'},
                    }},
                    {'jsonrpc': '2.0', 'method': 'event', 'params': {
                        'type': 'status.update',
                        'session_id': 'runtime-1',
                        'payload': {'kind': 'compacting', 'text': 'Compacting context'},
                    }},
                    {'jsonrpc': '2.0', 'method': 'event', 'params': {
                        'type': 'status.update',
                        'session_id': 'runtime-1',
                        'payload': {'kind': 'compacting', 'text': 'Still compacting'},
                    }},
                    {'jsonrpc': '2.0', 'method': 'event', 'params': {
                        'type': 'status.update',
                        'session_id': 'runtime-1',
                        'payload': {'kind': 'compacted', 'text': 'Compression complete'},
                    }},
                    {'jsonrpc': '2.0', 'method': 'event', 'params': {
                        'type': 'message.complete',
                        'session_id': 'runtime-1',
                        'payload': {'text': '(French) Bonjour François, je suis bien là. Deuxième phrase complète.'},
                    }},
                ]
                for message in messages:
                    self.stdout.feed_data((json.dumps(message) + '\n').encode())
                self.stdout.feed_eof()
                self.stderr.feed_eof()

            async def wait(self):
                return self.returncode

        fake_process = FakeProcess()
        with patch.object(
            app_module.asyncio,
            'create_subprocess_exec',
            new=AsyncMock(return_value=fake_process),
        ) as create_process:
            response = TestClient(app).post('/api/chat/stream', json={
                'message': 'Dis deux phrases.',
                'session_id': 'stored-1',
                'turn_id': 91,
            })
        self.assertEqual(response.status_code, 200)
        events = [json.loads(line) for line in response.text.splitlines()]
        event_types = [event['type'] for event in events]
        self.assertEqual(event_types, ['start', 'delta', 'speech', 'delta', 'phase', 'phase', 'delta', 'speech', 'complete'])
        self.assertLess(event_types.index('speech'), event_types.index('complete'))
        self.assertEqual(events[0]['session_id'], 'stored-1')
        self.assertEqual(events[2]['text'], 'Bonjour François, je suis bien là.')
        self.assertEqual(events[4], {'type': 'phase', 'phase': 'compression'})
        self.assertEqual(events[5], {'type': 'phase', 'phase': 'llm'})
        self.assertEqual(events[6]['text'], ' complète.')
        self.assertEqual(events[7]['text'], 'Deuxième phrase complète.')
        self.assertEqual(events[-1]['reply'], 'Bonjour François, je suis bien là. Deuxième phrase complète.')
        process_call = create_process.await_args_list[0]
        process_env = process_call.kwargs['env']
        self.assertEqual(process_call.kwargs['cwd'], app_module.HERMES_HOME)
        self.assertTrue(process_call.kwargs['start_new_session'])
        self.assertIn(app_module.HERMES_AGENT_ROOT, process_env['PYTHONPATH'].split(os.pathsep))
        self.assertEqual(process_env['HERMES_MODEL'], 'ani-gemma4:latest')
        self.assertEqual(process_env['HERMES_INFERENCE_PROVIDER'], 'custom')
        self.assertEqual(process_env['HERMES_TUI_TOOLSETS'], 'memory')
        requests = [json.loads(raw) for raw in fake_process.stdin.writes]
        self.assertEqual(requests[0]['method'], 'session.resume')
        self.assertEqual(requests[0]['params']['session_id'], 'stored-1')
        self.assertEqual(requests[1]['method'], 'config.set')
        self.assertEqual(requests[1]['params']['session_id'], 'runtime-1')
        self.assertEqual(requests[1]['params']['value'], 'ani-gemma4:latest --provider custom --session')
        self.assertEqual(requests[2]['method'], 'prompt.submit')
        expected_name = app_module.load_avatar_persona('francois')['display_name']
        self.assertEqual(requests[2]['params']['text'], app_module.build_streaming_prompt('Dis deux phrases.', expected_name))

    def test_gateway_stderr_drain_keeps_only_a_bounded_tail(self):
        async def scenario():
            stream = asyncio.StreamReader()
            stream.feed_data(b'a' * 20000 + b'end')
            stream.feed_eof()
            return await app_module._drain_gateway_stderr(stream, max_bytes=1024)

        tail = asyncio.run(scenario())
        self.assertEqual(len(tail), 1024)
        self.assertTrue(tail.endswith(b'end'))

    def test_gateway_complete_error_is_not_treated_as_assistant_text(self):
        with self.assertRaisesRegex(RuntimeError, 'provider-private-detail'):
            app_module.raise_for_gateway_completion({
                'status': 'error',
                'text': 'Error: provider-private-detail',
                'error': 'provider-private-detail',
            })
        app_module.raise_for_gateway_completion({'status': 'complete', 'text': 'Bonjour.'})

    def test_stream_errors_do_not_expose_gateway_exception_details(self):
        source = (ROOT / 'app.py').read_text()
        self.assertNotIn("message=f'Réponse Hermes indisponible: {str(exc)", source)
        self.assertIn("message='La réponse locale d’Ani a échoué.'", source)
        self.assertIn("logger.exception('Hermes streaming failed')", source)

    def test_cancelled_turns_clear_stale_session_leases(self):
        source = (ROOT / 'app.py').read_text()
        self.assertIn('def _clear_stale_turn_lease', source)
        self.assertIn('_clear_stale_turn_lease, payload.session_id', source)
        self.assertIn('ProcessLookupError', source)

    def test_failed_submits_log_their_status_for_diagnosis(self):
        source = (ROOT / 'app.py').read_text()
        self.assertIn("'Submit did not stream: status=%r result_keys=%s'", source)

    def test_decode_image_data_url_accepts_png_and_rejects_bad_input(self):
        import base64 as _base64
        from app import decode_image_data_url

        png_b64 = _base64.b64encode(b'\x89PNG\r\n\x1a\n' + b'x' * 64).decode()
        path, extension = decode_image_data_url(f'data:image/png;base64,{png_b64}')
        import tempfile as _tempfile
        try:
            self.assertTrue(path.startswith(_tempfile.gettempdir()))
            self.assertEqual(extension, '.png')
            self.assertTrue(Path(path).is_file())
        finally:
            Path(path).unlink(missing_ok=True)

    def test_decode_image_data_url_rejects_oversize_and_unknown(self):
        import base64 as _base64
        from app import decode_image_data_url
        from fastapi import HTTPException

        with self.assertRaises(HTTPException):
            decode_image_data_url('data:image/png;base64,' + 'A' * (12 * 1024 * 1024))
        with self.assertRaises(HTTPException):
            decode_image_data_url('data:image/png;base64,' + _base64.b64encode(b'not-an-image').decode())
        with self.assertRaises(HTTPException):
            decode_image_data_url('garbage')

    def test_chat_stream_attaches_image_before_submit(self):
        source = (ROOT / 'app.py').read_text()
        self.assertIn("'image.attach'", source)
        self.assertIn('decode_image_data_url, payload.image)', source)

    def test_pwa_offers_camera_and_screen_capture_buttons(self):
        html = (ROOT / 'static' / 'index.html').read_text()
        script = (ROOT / 'static' / 'app.js').read_text()
        self.assertIn('id="camera-button"', html)
        self.assertIn('id="screen-button"', html)
        self.assertIn('getUserMedia', script)
        self.assertIn('ani-image-preview', script)

    def test_screen_button_captures_ani_avatar_canvas(self):
        script = (ROOT / 'static' / 'app.js').read_text()
        self.assertIn("getElementById('avatar-canvas')", script)
        self.assertIn('captureAniCanvas', script)
        self.assertNotIn('getDisplayMedia', script)

    def test_camera_shows_live_view_before_sending(self):
        script = (ROOT / 'static' / 'app.js').read_text()
        self.assertIn('ani-camera-view', script)
        self.assertIn("video.playsInline=true", script)
        self.assertIn("input.value='Regarde-moi. '", script)
        css = (ROOT / 'static' / 'style.css').read_text()
        self.assertIn('#ani-camera-view', css)

    def test_capture_gives_flash_and_shutter_feedback(self):
        script = (ROOT / 'static' / 'app.js').read_text()
        self.assertIn('playShutterFeedback', script)
        self.assertIn('ani-capture-flash', script)
        avatar_source = (ROOT / 'src' / 'avatar-3d.js').read_text()
        self.assertIn('preserveDrawingBuffer: true', avatar_source)

    def test_avatar_models_endpoint_lists_vrm_and_glb(self):
        client = TestClient(app)
        response = client.get('/api/avatar-models')
        self.assertEqual(response.status_code, 200)
        models = response.json()['models']
        ids = {model['id'] for model in models}
        self.assertTrue(any(model_id.lower().endswith('.vrm') for model_id in ids))
        self.assertTrue(any(model_id.lower().endswith('.glb') for model_id in ids))
        self.assertTrue(all(model['type'] in ('vrm', 'glb') for model in models))

    def test_pwa_offers_avatar_model_dropdown(self):
        html = (ROOT / 'static' / 'index.html').read_text()
        script = (ROOT / 'static' / 'app.js').read_text()
        self.assertIn('id="avatar-selector"', html)
        self.assertIn("fetch('/api/avatar-models'", script)
        self.assertIn('ani.avatar.${currentProfile}', script)

    def test_avatar_runtime_loads_glb_with_animation_mixer(self):
        source = (ROOT / 'src' / 'avatar-3d.js').read_text()
        self.assertIn('AnimationMixer', source)
        self.assertIn('glbAnimations', source)
        self.assertIn('.glb', source)

    def test_persona_config_maps_profile_to_name_avatar_voice(self):
        configured = json.loads((ROOT / 'avatars.json').read_text())['francois']
        persona = app_module.load_avatar_persona('francois')
        self.assertEqual(persona['display_name'], configured['display_name'])
        self.assertEqual(persona['avatar'], configured['avatar'])
        self.assertEqual(persona['voice'], configured['voice'])
        fallback = app_module.load_avatar_persona('inconnu')
        self.assertEqual(fallback['display_name'], 'Ani')

    def test_persona_endpoint_returns_identity(self):
        client = TestClient(app)
        response = client.get('/api/persona', params={'profile': 'francois'})
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertIn('display_name', body)
        self.assertIn('voice', body)
        self.assertEqual(client.get('/api/persona', params={'profile': 'x'}).status_code, 422)

    def test_streaming_prompt_injects_alternate_identity(self):
        prompt = app_module.build_streaming_prompt('Salut.', 'Luna')
        self.assertIn("tu t'appelles Luna", prompt)
        self.assertIn('sans jamais dire Ani', prompt)
        default_prompt = app_module.build_streaming_prompt('Salut.')
        self.assertNotIn("tu t'appelles", default_prompt)

    def test_tts_uses_persona_voice_from_config(self):
        request = app_module.build_qwen_tts_request('Bonjour.', '', 'Vivian')
        self.assertEqual(json.loads(request.data)['voice'], 'Vivian')
        default_request = app_module.build_qwen_tts_request('Bonjour.')
        self.assertEqual(default_request.full_url, 'http://127.0.0.1:15004/v1/audio/speech')

    def test_reply_presentation_strips_markdown_latex_and_thinking(self):
        presentation = app_module.build_reply_presentation(
            '</think>Calcul intermédiaire. **Résultat** : $\\text{H}_2\\text{SO}_4$ = $2 \\times 1.008$ + 32.06, soit **98,08 g/mol**. <br>Voilà.'
        )
        self.assertEqual(
            presentation['reply'],
            'Calcul intermédiaire. Résultat : H2SO4 = 2 × 1.008 + 32.06, soit 98,08 g/mol. Voilà.'
        )
        self.assertIn('98,08 g/mol', presentation['speech'])
        self.assertNotIn('$', presentation['speech'])
        self.assertNotIn('**', presentation['speech'])

    def test_prepare_spoken_text_removes_html_tags_and_thinking_blocks(self):
        spoken = app_module.prepare_spoken_text(
            '</think>Analyse. <p>La réponse</p> est prête.'
        )
        self.assertEqual(spoken, 'Analyse. La réponse est prête.')

    def test_gateway_deadline_is_not_reset_by_malformed_output(self):
        class NoisyStdout:
            async def readline(self):
                await asyncio.sleep(0.002)
                return b'not-json\n'

        async def read_until_deadline():
            process = MagicMock(stdout=NoisyStdout())
            deadline = asyncio.get_running_loop().time() + 0.02
            await app_module._read_gateway_message(process, deadline)

        with self.assertRaises(asyncio.TimeoutError):
            asyncio.run(read_until_deadline())

    def test_chat_stream_has_an_absolute_generation_timeout(self):
        class NoisyStdout:
            def __init__(self):
                self.lines = [
                    {'jsonrpc': '2.0', 'method': 'event', 'params': {'type': 'gateway.ready', 'payload': {}}},
                    {'jsonrpc': '2.0', 'id': '1', 'result': {'session_id': 'runtime-timeout', 'stored_session_id': 'stored-timeout'}},
                    {'jsonrpc': '2.0', 'id': '2', 'result': {'status': 'streaming'}},
                ]

            async def readline(self):
                if self.lines:
                    return (json.dumps(self.lines.pop(0)) + '\n').encode()
                await asyncio.sleep(0.002)
                return b'{"jsonrpc":"2.0","method":"event","params":{"type":"session.stats","payload":{}}}\n'

        class FakeStdin:
            def write(self, _data):
                return None

            async def drain(self):
                return None

            def close(self):
                return None

        class FakeProcess:
            def __init__(self):
                self.stdin = FakeStdin()
                self.stdout = NoisyStdout()
                self.stderr = asyncio.StreamReader()
                self.stderr.feed_eof()
                self.returncode = 0

            async def wait(self):
                return 0

        async def create_process(*_args, **_kwargs):
            return FakeProcess()

        with (
            patch('app.asyncio.create_subprocess_exec', side_effect=create_process),
            patch('app.CHAT_TIMEOUT_SECONDS', 0.02),
        ):
            response = TestClient(app).post(
                '/api/chat/stream',
                json={'message': 'Continue à travailler', 'turn_id': 9091},
            )

        events = [json.loads(line) for line in response.text.splitlines()]
        self.assertEqual(events[-1]['type'], 'error')
        self.assertIn('délai', events[-1]['message'])

    def test_legacy_non_streaming_chat_route_is_not_exposed(self):
        client = TestClient(app)
        response = client.post('/api/chat', json={'message': 'test'})
        self.assertEqual(response.status_code, 405)

    def test_chat_timeout_allows_very_slow_local_model_to_finish(self):
        self.assertGreaterEqual(app_module.CHAT_TIMEOUT_SECONDS, 900)
        source = (ROOT / 'app.py').read_text()
        self.assertIn('deadline = asyncio.get_running_loop().time() + CHAT_TIMEOUT_SECONDS', source)

    def test_hidden_state_cannot_be_overridden_by_component_display(self):
        css = (ROOT / 'static' / 'style.css').read_text()
        self.assertIn('[hidden]{display:none!important}', css)

    def test_interface_uses_local_vrm_avatar(self):
        html = (ROOT / 'static' / 'index.html').read_text()
        script = (ROOT / 'static' / 'app.js').read_text()
        gitignore = (ROOT / '.gitignore').read_text()
        self.assertIn('id="avatar-canvas"', html)
        self.assertIn('/avatar-3d.bundle.js', html)
        self.assertNotIn('<svg viewBox="0 0 560 860"', html)
        self.assertIn('window.aniAvatar?.setEmotion', script)
        self.assertIn('window.aniAvatar?.setMouthOpen', script)
        self.assertIn('static/models/*.vrm', gitignore)
        self.assertTrue(any((ROOT / 'static' / 'models').glob('*.vrm')))

    def test_mouth_animation_follows_audio_amplitude(self):
        script = (ROOT / 'static' / 'app.js').read_text()
        css = (ROOT / 'static' / 'style.css').read_text()
        self.assertNotIn('createMediaElementSource', script)
        self.assertIn('decodeAudioData', script)
        self.assertIn('player.currentTime', script)
        self.assertIn('window.aniAvatar?.setMouthOpen', script)
        self.assertNotIn('animation:talk', css)

    def test_submit_hides_keyboard_and_unlocks_mobile_audio(self):
        script = (ROOT / 'static' / 'app.js').read_text()
        html = (ROOT / 'static' / 'index.html').read_text()
        self.assertIn('input.blur()', script)
        self.assertIn('unlockAudio()', script)
        self.assertIn('SILENT_WAV', script)
        self.assertIn('autocomplete="off"', html)
        self.assertIn('autocorrect="off"', html)
        self.assertIn('spellcheck="false"', html)

    def test_avatar_camera_uses_upper_body_framing(self):
        source = (ROOT / 'src' / 'avatar-3d.js').read_text()
        self.assertIn('UPPER_BODY_HEIGHT_RATIO = 0.38', source)
        self.assertIn('UPPER_BODY_VERTICAL_OFFSET = 0.2', source)
        self.assertIn('upperTargetY + UPPER_BODY_VERTICAL_OFFSET', source)

    def test_avatar_supports_touch_orbit_zoom_and_auto_return(self):
        source = (ROOT / 'src' / 'avatar-3d.js').read_text()
        css = (ROOT / 'static' / 'style.css').read_text()
        self.assertIn('OrbitControls', source)
        self.assertIn('scheduleCameraReturn', source)
        self.assertIn('getCameraState', source)
        self.assertIn("canvas.addEventListener('pointerup'", source)
        self.assertIn('touch-action:none', css)

    def test_microphone_permission_and_errors_are_handled(self):
        script = (ROOT / 'static' / 'app.js').read_text()
        self.assertIn('navigator.mediaDevices.getUserMedia', script)
        self.assertIn('new MediaRecorder', script)
        self.assertIn("fetch('/api/stt'", script)
        self.assertNotIn('SpeechRecognition', script)
        self.assertIn('Microphone refusé', script)

    def test_microphone_vad_interrupts_audio_without_cancelling_the_llm(self):
        script = (ROOT / 'static' / 'app.js').read_text()
        self.assertIn('const BARGE_IN_RMS_THRESHOLD=0.035', script)
        self.assertIn('const BARGE_IN_HOLD_MS=180', script)
        self.assertIn('if(assistantAudioPlaying)', script)
        self.assertIn('now-bargeInStarted>=BARGE_IN_HOLD_MS', script)
        self.assertIn('interruptAudioForBargeIn()', script)
        self.assertIn('startUtterance({preserveAniTurn:true})', script)

    def test_microphone_is_continuous_hands_free_with_local_vad(self):
        script = (ROOT / 'static' / 'app.js').read_text()
        self.assertIn('microphoneMode', script)
        self.assertIn('monitorVoiceActivity', script)
        self.assertIn('echoCancellation:true', script)
        self.assertIn('noiseSuppression:true', script)
        self.assertIn('stopMicrophoneMode', script)

    def test_false_pause_is_merged_before_voice_message_submission(self):
        script = (ROOT / 'static' / 'app.js').read_text()
        self.assertIn('END_OF_SPEECH_SILENCE_MS=1300', script)
        self.assertIn('TRANSCRIPT_COMMIT_GRACE_MS=500', script)
        self.assertIn('pendingTranscript', script)
        self.assertIn('transcriptionQueue', script)
        self.assertIn('scheduleTranscriptCommit', script)
        self.assertIn('appendTranscript', script)
        self.assertNotIn('microphoneMode||transcribing||utteranceRecorder', script)
        self.assertNotIn('!utteranceRecorder&&!transcribing', script)

    def test_resumed_speech_cancels_obsolete_ani_chat_tts_and_audio(self):
        script = (ROOT / 'static' / 'app.js').read_text()
        self.assertIn('new AbortController()', script)
        self.assertIn('cancelActiveAniTurn', script)
        self.assertIn("signal:chatController.signal", script)
        self.assertIn("signal:ttsController.signal", script)
        self.assertIn('if(turnId!==activeTurnId)return', script)
        self.assertIn('player.pause()', script)
        self.assertIn('cancelActiveAniTurn({removeBubble:true})', script)
        self.assertIn("fetch('/api/cancel'", script)
        self.assertIn("fetch('/api/tts/cancel'", script)
        self.assertIn('setTurnKey(activeTurnKey)', script)
        self.assertIn('turn_key:activeTurnKey', script)

    def test_cancel_endpoint_requires_the_server_turn_key(self):
        process = MagicMock()
        process.returncode = None
        process.wait = AsyncMock(return_value=0)
        app_module.ACTIVE_CHAT_PROCESSES['server-secret-key'] = process

        wrong = TestClient(app).post('/api/cancel', json={'turn_key': 'wrong-client-key'})
        self.assertEqual(wrong.status_code, 200)
        self.assertEqual(wrong.json(), {'cancelled': False})
        process.terminate.assert_not_called()

        response = TestClient(app).post('/api/cancel', json={'turn_key': 'server-secret-key'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'cancelled': True})
        process.terminate.assert_called_once_with()
        process.wait.assert_awaited_once_with()
        self.assertNotIn('server-secret-key', app_module.ACTIVE_CHAT_PROCESSES)

    def test_tts_can_be_cancelled_without_stopping_chat(self):
        async def scenario():
            task = asyncio.create_task(asyncio.sleep(60))
            app_module.ACTIVE_TTS_TASKS['server-tts-secret'] = task
            response = await app_module.cancel_tts(
                app_module.CancelRequest(turn_key='server-tts-secret')
            )
            return response, task.cancelled()

        response, cancelled = asyncio.run(scenario())
        self.assertEqual(response, {'cancelled': True})
        self.assertTrue(cancelled)
        self.assertNotIn('server-tts-secret', app_module.ACTIVE_TTS_TASKS)

    def test_tts_request_is_registered_for_turn_cancellation(self):
        source = (ROOT / 'app.py').read_text()
        self.assertIn('ACTIVE_TTS_TASKS', source)
        self.assertIn('turn_key: str | None', source)
        self.assertIn('audio_task.cancel()', source)
        self.assertIn('_fetch_qwen_audio_async', source)

    def test_iphone_restores_preferred_microphone_on_first_page_gesture(self):
        script = (ROOT / 'static' / 'app.js').read_text()
        self.assertIn("localStorage.getItem('ani.microphone')==='on'", script)
        self.assertIn('armPreferredMicrophone', script)
        self.assertIn("document.addEventListener('pointerdown',resumePreferredMicrophone", script)

    def test_avatar_uses_dark_lighting_and_lighter_emerald_irises(self):
        source = (ROOT / 'src' / 'avatar-3d.js').read_text()
        self.assertIn('renderer.toneMappingExposure = 0.82', source)
        self.assertIn("material.name.includes('EyeIris')", source)
        self.assertIn('0x6ee7b7', source)
        self.assertIn('material.emissive.setHex(0x34d399)', source)
        self.assertIn('material.emissiveIntensity = 0.16', source)
        self.assertIn('material.emissive.multiplyScalar(0.18)', source)
        self.assertIn('material.color.multiplyScalar(0.72)', source)

    def test_lip_sync_limits_wide_mouth_shapes(self):
        source = (ROOT / 'src' / 'avatar-3d.js').read_text()
        self.assertIn('MAX_MOUTH_OPEN = 0.40', source)
        self.assertIn("expression('ih', mouthOpen * 0.08)", source)
        self.assertIn("happy: ['happy', 0.72]", source)

    def test_avatar_moves_head_subtly_while_speaking(self):
        source = (ROOT / 'src' / 'avatar-3d.js').read_text()
        self.assertIn('function applySpeakingMotion', source)
        self.assertIn('mouthOpen > 0.025', source)
        self.assertIn('head.node.rotation.y', source)
        self.assertIn('head.node.rotation.x', source)

    def test_avatar_exposes_dance_spin_jump_and_sway_motions(self):
        source = (ROOT / 'src' / 'avatar-3d.js').read_text()
        self.assertIn('function playMotion', source)
        for motion in ("'dance'", "'spin'", "'jump'", "'sway'", "'tease'"):
            self.assertIn(motion, source)
        self.assertIn('window.aniAvatar = { setEmotion, setMouthOpen, playMotion', source)

    def test_large_avatar_motions_use_full_body_camera_framing(self):
        source = (ROOT / 'src' / 'avatar-3d.js').read_text()
        self.assertIn("['dance', 'spin', 'jump'].includes(name)", source)
        self.assertIn('const fullBodySpan = Math.max(size.y', source)
        self.assertIn('ACTION_CAMERA_VERTICAL_OFFSET = 0.25', source)
        self.assertIn('center.y + ACTION_CAMERA_VERTICAL_OFFSET', source)
        self.assertIn('fullBodySpan + 2 * ACTION_CAMERA_VERTICAL_OFFSET', source)
        self.assertIn('camera.position.lerp(actionCameraPosition', source)
        self.assertIn('camera.fov = THREE.MathUtils.lerp(camera.fov, actionCameraFov', source)

    def test_reply_cues_can_trigger_avatar_motions(self):
        script = (ROOT / 'static' / 'app.js').read_text()
        self.assertIn('function motionForText', script)
        self.assertIn("window.aniAvatar?.playMotion(replyMotion)", script)

    def test_conversation_shows_only_the_current_streaming_exchange(self):
        script = (ROOT / 'static' / 'app.js').read_text()
        html = (ROOT / 'static' / 'index.html').read_text()
        self.assertIn("input.value='';setEmotion('curious');setPhase('llm')", script)
        self.assertIn("if(isLandscapeLayout())pushLandscapeMessage(message,'user');", script)
        self.assertIn("else{history.replaceChildren();bubble(message,'user')}", script)
        self.assertIn("bubble(display,'ani')", script)
        self.assertNotIn('id="speech"', html)

    def test_phase_indicator_distinguishes_waiting_from_streaming_reply(self):
        script = (ROOT / 'static' / 'app.js').read_text()
        css = (ROOT / 'static' / 'style.css').read_text()
        self.assertIn("llm:'Ani réfléchit'", script)
        self.assertIn("answering:'Ani répond'", script)
        self.assertIn("setPhase('answering')", script)
        self.assertIn('.phase-indicator[data-phase="answering"]', css)
        self.assertIn('animation:phase-answer', css)

    def test_local_stt_endpoint_returns_whisper_transcript(self):
        client = TestClient(app)
        with patch.object(app_module, 'transcribe_local_audio', new=AsyncMock(return_value='Bonjour Ani.')):
            response = client.post('/api/stt', content=b'fake audio', headers={'content-type': 'audio/mp4'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'text': 'Bonjour Ani.'})

    def test_local_stt_endpoint_rejects_empty_audio(self):
        client = TestClient(app)
        response = client.post('/api/stt', content=b'', headers={'content-type': 'audio/mp4'})
        self.assertEqual(response.status_code, 422)

    def test_service_worker_precaches_avatar_runtime(self):
        worker = (ROOT / 'static' / 'sw.js').read_text()
        self.assertIn("const CACHE='ani-companion-v48'", worker)
        self.assertIn("'/avatar-3d.bundle.js?v=48'", worker)

    def test_service_worker_activates_pipeline_update_immediately(self):
        worker = (ROOT / 'static' / 'sw.js').read_text()
        self.assertIn('self.skipWaiting()', worker)
        self.assertIn('self.clients.claim()', worker)
        self.assertNotIn("client.navigate(client.url)", worker)

    def test_interface_assets_are_cache_busted_for_installed_pwa(self):
        html = (ROOT / 'static' / 'index.html').read_text()
        worker = (ROOT / 'static' / 'sw.js').read_text()
        self.assertIn('href="/style.css?v=33"', html)
        self.assertIn('src="/app.js?v=42"', html)
        self.assertIn('src="/avatar-3d.bundle.js?v=48"', html)
        self.assertIn("'/style.css?v=33'", worker)
        self.assertIn("'/app.js?v=42'", worker)

    def test_phase_timer_does_not_flood_accessibility_announcements(self):
        html = (ROOT / 'static' / 'index.html').read_text()
        css = (ROOT / 'static' / 'style.css').read_text()
        self.assertNotIn('role="status" aria-live="polite"', html)
        self.assertIn('<time aria-hidden="true">00:00</time>', html)
        self.assertIn('.phase-indicator i{animation:none!important}', css)

    def test_manifest_is_installable_pwa(self):
        manifest = json.loads((ROOT / 'static' / 'manifest.webmanifest').read_text())
        self.assertEqual(manifest['display'], 'standalone')
        self.assertEqual(manifest['name'], 'Ani Companion')
        self.assertTrue(any(icon['sizes'] == '512x512' for icon in manifest['icons']))
        html = (ROOT / 'static' / 'index.html').read_text()
        self.assertIn('rel="apple-touch-icon" href="/icons/ani-192.png"', html)
        self.assertIn('rel="icon" href="/icons/ani-192.png"', html)

    def test_interface_has_avatar_chat_voice_and_install_controls(self):
        html = (ROOT / 'static' / 'index.html').read_text()
        for required in ('ani-avatar', 'chat-form', 'mic-button', 'context-meter', 'install-button'):
            self.assertIn(f'id="{required}"', html)
        self.assertIn('serviceWorker.register', html)

    def test_profile_picker_offers_francois_and_salome(self):
        html = (ROOT / 'static' / 'index.html').read_text()
        script = (ROOT / 'static' / 'app.js').read_text()
        self.assertIn('id="profile-picker"', html)
        self.assertIn('data-profile="francois"', html)
        self.assertIn('data-profile="salome"', html)
        self.assertIn("localStorage.getItem('ani.profile')", script)
        self.assertIn('profile:currentProfile', script)
        self.assertIn('ani.session.${currentProfile}', script)

    def test_server_accepts_known_profiles_only(self):
        source = (ROOT / 'app.py').read_text()
        self.assertIn("'francois'", source)
        self.assertIn("'salome'", source)
        self.assertIn("if payload.profile not in HERMES_PROFILES", source)

    def test_models_catalog_lists_only_fast_companion_models(self):
        client = TestClient(app)
        response = client.get('/api/models')
        self.assertEqual(response.status_code, 200)
        catalog = response.json()
        ids = {model['id'] for model in catalog['models']}
        self.assertEqual(ids, {
            'ani-gemma4-vision:latest',
            'ani-gemma4:latest',
        })
        for model in catalog['models']:
            self.assertIsInstance(model['vision'], bool)

    def test_chat_stream_rejects_unknown_model(self):
        client = TestClient(app)
        response = client.post('/api/chat/stream', json={
            'message': 'Coucou.',
            'profile': 'francois',
            'model': 'modele-inexistant:test',
        })
        self.assertEqual(response.status_code, 422)

    def test_resumed_sessions_request_eager_agent_build_for_live_model_switch(self):
        source = (ROOT / 'app.py').read_text()
        self.assertIn("'eager_build': True", source)

    def test_chat_stream_accepts_vision_model_from_catalog(self):
        client = TestClient(app)
        response = client.post('/api/chat/stream', json={
            'message': 'Coucou.',
            'profile': 'francois',
            'model': 'ani-gemma4-vision:latest',
        })
        self.assertEqual(response.status_code, 200)
        self.assertTrue(any('"start"' in line for line in response.text.splitlines()))

    def test_selected_model_overrides_env_model_for_gateway(self):
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            self._run_selected_model_overrides_env_model_for_gateway()
        finally:
            asyncio.set_event_loop(None)
            loop.close()

    def _run_selected_model_overrides_env_model_for_gateway(self):
        class FakeStdin:
            def __init__(self):
                self.writes = []

            def write(self, _data):
                self.writes.append(_data)

            async def drain(self):
                return None

            def close(self):
                return None

        class FakeProcess:
            def __init__(self):
                self.stdin = FakeStdin()
                self.stdout = asyncio.StreamReader()
                self.stderr = asyncio.StreamReader()
                self.returncode = 0
                messages = [
                    {'jsonrpc': '2.0', 'method': 'event', 'params': {'type': 'gateway.ready'}},
                    {'jsonrpc': '2.0', 'id': '1', 'result': {
                        'session_id': 'runtime-model',
                        'stored_session_id': 'stored-model',
                    }},
                    {'jsonrpc': '2.0', 'id': '2', 'result': {'scope': 'session', 'value': 'ani-gemma4-vision:latest'}},
                    {'jsonrpc': '2.0', 'id': '3', 'result': {'status': 'streaming'}},
                    {'jsonrpc': '2.0', 'method': 'event', 'params': {
                        'type': 'message.complete',
                        'session_id': 'runtime-model',
                        'payload': {'text': '(French) Bonjour.'},
                    }},
                ]
                for message in messages:
                    self.stdout.feed_data((json.dumps(message) + '\n').encode())
                self.stdout.feed_eof()
                self.stderr.feed_eof()

            async def wait(self):
                return self.returncode

        fake_process = FakeProcess()
        with patch.object(
            app_module.asyncio,
            'create_subprocess_exec',
            new=AsyncMock(return_value=fake_process),
        ):
            response = TestClient(app).post('/api/chat/stream', json={
                'message': 'Dis bonjour.',
                'model': 'ani-gemma4-vision:latest',
            })

        self.assertEqual(response.status_code, 200)
        requests = [json.loads(raw) for raw in fake_process.stdin.writes]
        self.assertEqual(requests[1]['params']['value'], 'ani-gemma4-vision:latest --provider custom --session')

    def test_pwa_offers_a_model_selector_per_profile(self):
        script = (ROOT / 'static' / 'app.js').read_text()
        html = (ROOT / 'static' / 'index.html').read_text()
        self.assertIn('id="model-selector"', html)
        self.assertIn('ani.model.${currentProfile}', script)
        self.assertIn("fetch('/api/models'", script)
        self.assertIn('profile:currentProfile', script)

    def test_models_catalog_is_queried_at_startup(self):
        script = (ROOT / 'static' / 'app.js').read_text()
        self.assertIn('refreshModelSelector', script)
        self.assertIn('else{refreshModelSelector();refreshAvatarSelector();refreshVoiceSelector()}', script)


if __name__ == '__main__':
    unittest.main()
