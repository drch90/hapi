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
OTHER = '0' * 64


def certificate(label='#1', digest=PIN):
    return f'Signer {label} certificate SHA-256 digest: {digest}\n'


class SignerTests(unittest.TestCase):
    def test_numbered_certificate(self):
        signing.verify_signers(certificate(digest=PIN.upper()), PIN)

    def test_sdk_range_certificate(self):
        signing.verify_signers(certificate('(minSdkVersion=28, maxSdkVersion=2147483647)'), PIN)

    def test_same_certificate_across_sdk_ranges(self):
        output = certificate('(minSdkVersion=33 (dev release=true), maxSdkVersion=2147483647)')
        output += certificate('(minSdkVersion=28, maxSdkVersion=32)')
        signing.verify_signers(output, PIN)

    def test_different_certificate_reports_actual_and_expected(self):
        with self.assertRaises(ValueError) as error:
            signing.verify_signers(certificate(digest=OTHER), PIN)
        self.assertIn(PIN, str(error.exception))
        self.assertIn(OTHER, str(error.exception))

    def test_rotation_to_another_key_is_rejected(self):
        output = certificate('(minSdkVersion=33, maxSdkVersion=2147483647)')
        output += certificate('(minSdkVersion=28, maxSdkVersion=32)', OTHER)
        with self.assertRaisesRegex(ValueError, 'does not match'):
            signing.verify_signers(output, PIN)

    def test_multiple_or_mixed_signers_are_rejected(self):
        for extra in (certificate('#2'), certificate('(minSdkVersion=28, maxSdkVersion=32)')):
            with self.subTest(extra=extra), self.assertRaisesRegex(ValueError, 'Expected one APK signer'):
                signing.verify_signers(certificate() + extra, PIN)

    def test_unrecognized_or_malformed_certificate_is_rejected(self):
        for line in (certificate('unknown'), certificate(digest=PIN[:-1])):
            with self.subTest(line=line), self.assertRaisesRegex(ValueError, 'Unrecognized'):
                signing.verify_signers(certificate() + line, PIN)

    def test_public_key_digest_does_not_count_as_certificate(self):
        with self.assertRaisesRegex(ValueError, 'No APK signer certificate'):
            signing.verify_signers(f'Signer #1 public key SHA-256 digest: {PIN}\n', PIN)

    def test_source_stamp_is_not_the_apk_signer(self):
        stamp = f'Source Stamp Signer certificate SHA-256 digest: {OTHER}\n'
        signing.verify_signers(certificate() + stamp, PIN)
        with self.assertRaisesRegex(ValueError, 'No APK signer certificate'):
            signing.verify_signers(stamp, PIN)


class ApkIdentityTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='hapi-signing-check-')
        self.addCleanup(self.directory.cleanup)
        self.apk = Path(self.directory.name) / 'sample.apk'
        self.apk.write_bytes(b'parser fixture only; not a real APK')
        self.report = self.apk.with_suffix('.json')

    def verify(self, package='run.hapi.companion', version=62, signer=PIN):
        badging = f"package: name='{package}' versionCode='{version}' versionName='0.34.6'\n"
        with patch.object(signing, 'build_tools', return_value=Path('/ci/build-tools/36.0.0')):
            with patch.object(signing, 'run', side_effect=[certificate(digest=signer).encode(), badging.encode()]):
                with contextlib.redirect_stdout(io.StringIO()):
                    signing.verify(self.apk, 62, 'a' * 40, self.report)

    def test_verified_identity_generates_public_report(self):
        self.verify()
        report = json.loads(self.report.read_text())
        self.assertEqual(report['certificateSha256'], PIN)
        self.assertEqual(report['versionCode'], 62)
        self.assertEqual(report['sourceSha'], 'a' * 40)
        self.assertEqual(report['packageName'], 'run.hapi.companion')

    def test_wrong_signer_never_generates_report(self):
        with self.assertRaisesRegex(ValueError, 'does not match'):
            self.verify(signer=OTHER)
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
        result = subprocess.CompletedProcess(['apksigner'], 1, b'', b'APK integrity check failed')
        with patch.object(signing.subprocess, 'run', return_value=result):
            with self.assertRaisesRegex(ValueError, 'APK integrity check failed'):
                signing.run(['/ci/apksigner', 'verify', 'app.apk'])

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
