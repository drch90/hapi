#!/usr/bin/env python3
"""Checks for CI signing glue; requires only Python, not Android tools."""

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('android_signing', Path(__file__).with_name('android-signing.py'))
signing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(signing)
PIN = signing.fingerprint()


class VerifierCompilationTests(unittest.TestCase):
    def test_compiles_against_the_sdk_library(self):
        with tempfile.TemporaryDirectory(prefix='hapi-verifier-check-') as directory:
            classes = Path(directory) / 'classes'
            with patch.object(signing, 'build_tools', return_value=Path('/ci/build-tools/36.0.0')):
                with patch.object(signing, 'run') as run:
                    signing.compile_verifier(classes)
            self.assertTrue(classes.is_dir())
            run.assert_called_once_with([
                'javac', '--class-path', '/ci/build-tools/36.0.0/lib/apksigner.jar',
                '-d', str(classes), str(signing.VERIFIER_SOURCE),
            ])


class ApkIdentityTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='hapi-signing-check-')
        self.addCleanup(self.directory.cleanup)
        self.apk = Path(self.directory.name) / 'sample.apk'
        self.apk.write_bytes(b'parser fixture only; not a real APK')
        self.report = self.apk.with_suffix('.json')

    def verify(self, package='run.hapi.companion', version=62, verification_error=None):
        badging = f"package: name='{package}' versionCode='{version}' versionName='0.34.6'\n"
        with patch.object(signing, 'build_tools', return_value=Path('/ci/build-tools/36.0.0')):
            with patch.object(signing, 'run', side_effect=[verification_error or b'', badging.encode()]) as run:
                with contextlib.redirect_stdout(io.StringIO()):
                    signing.verify(self.apk, 62, 'a' * 40, self.report, Path('/ci/verifier-classes'))
                return run.call_args_list

    def test_api_verification_needs_no_display_output(self):
        calls = self.verify()
        self.assertEqual(calls[0].args[0], [
            'java', '--class-path', '/ci/verifier-classes:/ci/build-tools/36.0.0/lib/apksigner.jar',
            'HapiApkVerifier', str(self.apk), PIN,
        ])
        report = json.loads(self.report.read_text())
        self.assertEqual(report['certificateSha256'], PIN)
        self.assertEqual(report['versionCode'], 62)
        self.assertEqual(report['sourceSha'], 'a' * 40)
        self.assertEqual(report['packageName'], 'run.hapi.companion')

    def test_wrong_signer_never_generates_report(self):
        with self.assertRaisesRegex(ValueError, 'certificate mismatch'):
            self.verify(verification_error=ValueError('APK certificate mismatch'))
        self.assertFalse(self.report.exists())

    def test_wrong_package_or_version_never_generates_report(self):
        for options in ({'package': 'other.app'}, {'version': 61}):
            with self.subTest(options=options), self.assertRaisesRegex(ValueError, 'package or version'):
                self.verify(**options)
            self.assertFalse(self.report.exists())


class FailureReportingTests(unittest.TestCase):
    def test_openssl_output_stays_private(self):
        result = subprocess.CompletedProcess(['openssl'], 1, b'private output', b'private error')
        with patch.object(signing.subprocess, 'run', return_value=result):
            with self.assertRaises(ValueError) as error:
                signing.run(['openssl', 'pkey'], b'private input')
        self.assertIn('exit 1', str(error.exception))
        self.assertNotIn('private', str(error.exception))

    def test_public_apk_tool_errors_are_visible(self):
        result = subprocess.CompletedProcess(['java'], 1, b'', b'APK integrity check failed')
        with patch.object(signing.subprocess, 'run', return_value=result):
            with self.assertRaisesRegex(ValueError, 'APK integrity check failed'):
                signing.run(['java', 'HapiApkVerifier', 'app.apk', PIN])

    def test_actions_annotation_escapes_workflow_commands(self):
        output = io.StringIO()
        with patch.dict(signing.os.environ, {'GITHUB_ACTIONS': 'true'}):
            with patch.object(sys, 'argv', ['android-signing.py', 'prepare', '--keystore', '/unused']):
                with patch.object(signing, 'prepare', side_effect=ValueError('bad%\n::notice::injected')):
                    with contextlib.redirect_stdout(output):
                        result = signing.main()
        self.assertEqual(result, 1)
        self.assertEqual(output.getvalue(), '::error::Android signing: bad%25%0A::notice::injected\n')


if __name__ == '__main__':
    unittest.main()
