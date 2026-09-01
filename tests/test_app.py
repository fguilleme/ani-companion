import json
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

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

    def test_build_hermes_command_resumes_known_session(self):
        command = build_hermes_command('session-123')
        self.assertIn('--resume', command)
        self.assertIn('session-123', command)
        self.assertEqual(command[-1], '-')

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

    def test_extract_tts_instructions_keeps_bracketed_emotions(self):
        instructions = app_module.extract_tts_instructions(
            '[sourit doucement] Bonjour François. [petit rire] Je suis là.'
        )
        self.assertEqual(
            instructions,
            'Interprète naturellement les indications suivantes sans les prononcer : sourit doucement ; petit rire.',
        )

    def test_prepare_spoken_text_normalizes_ellipses_and_removes_emoji(self):
        spoken = app_module.prepare_spoken_text(
            'Oh… attends... je termine cette phrase. 💙'
        )
        self.assertEqual(spoken, 'Oh, attends, je termine cette phrase.')

    def test_qwen_tts_request_uses_local_server_and_french_voice(self):
        request = build_qwen_tts_request('Bonjour François.', 'Parle avec joie.')
        self.assertEqual(request.full_url, 'http://127.0.0.1:15004/v1/audio/speech')
        payload = json.loads(request.data)
        self.assertEqual(payload['model'], 'qwen-tts')
        self.assertEqual(payload['voice'], 'Serena')
        self.assertEqual(payload['input'], 'Bonjour François.')
        self.assertEqual(payload['instructions'], 'Parle avec joie.')
        self.assertEqual(payload['response_format'], 'wav')
        self.assertIs(payload['force_chunking'], True)

    def test_chat_rejects_empty_message(self):
        client = TestClient(app)
        response = client.post('/api/chat', json={'message': ''})
        self.assertEqual(response.status_code, 422)

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
        self.assertTrue((ROOT / 'static' / 'models' / 'ani.vrm').is_file())

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

    def test_avatar_camera_uses_half_body_framing(self):
        source = (ROOT / 'src' / 'avatar-3d.js').read_text()
        self.assertIn('HEAD_SHOT_HEIGHT_RATIO = 0.23', source)

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

    def test_microphone_is_continuous_hands_free_with_local_vad(self):
        script = (ROOT / 'static' / 'app.js').read_text()
        self.assertIn('microphoneMode', script)
        self.assertIn('monitorVoiceActivity', script)
        self.assertIn('echoCancellation:true', script)
        self.assertIn('noiseSuppression:true', script)
        self.assertIn('stopMicrophoneMode', script)

    def test_iphone_restores_preferred_microphone_on_first_page_gesture(self):
        script = (ROOT / 'static' / 'app.js').read_text()
        self.assertIn("localStorage.getItem('ani.microphone')==='on'", script)
        self.assertIn('armPreferredMicrophone', script)
        self.assertIn("document.addEventListener('pointerdown',resumePreferredMicrophone", script)

    def test_avatar_uses_dark_lighting_and_blue_irises(self):
        source = (ROOT / 'src' / 'avatar-3d.js').read_text()
        self.assertIn('renderer.toneMappingExposure = 0.82', source)
        self.assertIn("material.name.includes('EyeIris')", source)
        self.assertIn('0x4f8fc4', source)
        self.assertIn('material.emissive.multiplyScalar(0.18)', source)
        self.assertIn('material.color.multiplyScalar(0.72)', source)

    def test_lip_sync_limits_wide_mouth_shapes(self):
        source = (ROOT / 'src' / 'avatar-3d.js').read_text()
        self.assertIn('MAX_MOUTH_OPEN = 0.40', source)
        self.assertIn("expression('ih', mouthOpen * 0.08)", source)
        self.assertIn("happy: ['happy', 0.45]", source)

    def test_assistant_reply_uses_single_line_ticker_not_history_bubble(self):
        script = (ROOT / 'static' / 'app.js').read_text()
        css = (ROOT / 'static' / 'style.css').read_text()
        self.assertNotIn("bubble(data.reply,'ani')", script)
        self.assertIn("ticker.className='speech-line'", script)
        self.assertIn('speech.replaceChildren(ticker)', script)
        self.assertIn('ticker.scrollWidth<=speech.clientWidth', script)
        self.assertIn("fill:'forwards'", script)
        self.assertIn('white-space:nowrap', css)

    def test_ticker_starts_with_audio_playback_and_uses_wav_duration(self):
        script = (ROOT / 'static' / 'app.js').read_text()
        self.assertNotIn('setEmotion(data.emotion);showSpeech(data.reply)', script)
        self.assertIn('await player.play();\n  showSpeech(text,player.duration);', script)
        self.assertIn('durationSeconds*1000', script)

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
        self.assertIn("const CACHE='ani-companion-v8'", worker)
        self.assertIn("'/avatar-3d.bundle.js'", worker)

    def test_manifest_is_installable_pwa(self):
        manifest = json.loads((ROOT / 'static' / 'manifest.webmanifest').read_text())
        self.assertEqual(manifest['display'], 'standalone')
        self.assertEqual(manifest['name'], 'Ani Companion')
        self.assertTrue(any(icon['sizes'] == '512x512' for icon in manifest['icons']))

    def test_interface_has_avatar_chat_voice_and_install_controls(self):
        html = (ROOT / 'static' / 'index.html').read_text()
        for required in ('ani-avatar', 'chat-form', 'mic-button', 'voice-toggle', 'install-button'):
            self.assertIn(f'id="{required}"', html)
        self.assertIn('serviceWorker.register', html)


if __name__ == '__main__':
    unittest.main()
